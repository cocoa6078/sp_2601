#if DEBUG && targetEnvironment(simulator)
import Combine
import CoreLocation
import MapKit
import SwiftUI

struct SimulatorSignalMarker: Identifiable {
    let id: Int
    let title: String
    let coordinate: CLLocationCoordinate2D
    let color: SignalColor
}

private struct VirtualTrafficSignal {
    let id: Int
    let offset: Double
    let coordinate: CLLocationCoordinate2D
    let cycle: TimeInterval
    let greenDuration: TimeInterval
    var phaseOffset: TimeInterval

    var title: String {
        "実信号 \(id)"
    }

    var timing: SimulatorSignalCycle {
        SimulatorSignalCycle(id: id, offset: offset, cycle: cycle,
                             greenDuration: greenDuration, phaseOffset: phaseOffset)
    }

    func isGreen(at time: TimeInterval) -> Bool { timing.isGreen(at: time) }
    func remaining(at time: TimeInterval) -> TimeInterval { timing.remaining(at: time) }

}

/// 実信号の位置を使い、色と周期だけをデモ用に再現するシミュレーター専用の歩行者信号。
@MainActor
final class SimulatorSignalSystem: ObservableObject {
    static let shared = SimulatorSignalSystem()

    @Published private(set) var markers: [SimulatorSignalMarker] = []
    @Published private(set) var activeSignal: SignalInfo?
    @Published private(set) var activeSignalID: Int?
    @Published private(set) var activeSignalTitle = "信号なし"
    @Published private(set) var distanceToSignal: Double?
    @Published private(set) var arrivalSeconds: Double?
    @Published private(set) var recommendedCadence: Int?
    @Published private(set) var guidanceMessage = ""

    private var signals: [VirtualTrafficSignal] = []
    private var path: NavigationPath?
    private var timingInitialized = false
    private var cadencePlan: (signalID: Int, normal: Int, cadence: Int)?

    /// 新しいGeoJSONの2地点目。信号は1基だけ配置する。
    private let demoSignalCoordinates = [GoalPoint.simulatorSignal.coordinate]

    func prepare(route: MKRoute) {
        path = NavigationPath(route.polyline)
        timingInitialized = false
        guard let path, path.length > 90 else {
            signals = []
            markers = []
            clearGuidance()
            return
        }

        // 実際に信号機がある2地点目だけを使う。ルートから離れている地点は
        // 信号通過の判定に使わず、地図上の別道路で誤案内しないようにする。
        signals = demoSignalCoordinates.enumerated().compactMap { index, coordinate in
            guard let projection = path.projection(of: coordinate),
                  projection.separation <= 80,
                  projection.offset >= 20,
                  projection.offset <= path.length - 20 else { return nil }
            return VirtualTrafficSignal(
                id: index + 1,
                offset: projection.offset,
                coordinate: coordinate,
                // デモの歩行者信号。青40秒・赤60秒で一定周期を繰り返す。
                cycle: 100,
                greenDuration: 40,
                phaseOffset: 0
            )
        }.sorted { $0.offset < $1.offset }
#if DEBUG
        print("RUNWAVE_SIM_SIGNAL_COORDINATES_BEGIN")
        print("let virtualSignalLocations: [(name: String, latitude: Double, longitude: Double)] = [")
        for signal in signals {
            print(String(format: "    (name: \"%@\", latitude: %.7f, longitude: %.7f),", signal.title, signal.coordinate.latitude, signal.coordinate.longitude))
        }
        print("]")
        print("RUNWAVE_SIM_SIGNAL_COORDINATES_END")
#endif
        markers = signals.map {
            SimulatorSignalMarker(id: $0.id, title: $0.title, coordinate: $0.coordinate, color: .red)
        }
        clearGuidance()
    }

    func update(distance: Double, elapsed: TimeInterval, mode: ActivityMode, cadence: Int,
                isForcedStopped: Bool = false, currentCadence: Double? = nil) {
        // Read the signal AFTER configuring its phase. A copied pre-configuration
        // signal uses the wrong colour and timing on the first update.
        if !timingInitialized {
            configureDemoTiming(distance: distance, elapsed: elapsed, mode: mode, cadence: cadence)
        }
        guard let signal = signals.first(where: { $0.offset > distance + 0.000001 }) else {
            clearGuidance()
            activeSignalTitle = "次の信号なし"
            guidanceMessage = "経路上の信号を通過しました"
            refreshMarkers(at: elapsed)
            return
        }
        let pace = SimulatorPaceModel(currentCadence: currentCadence ?? Double(cadence),
                                      stride: mode == .walking ? 0.76 : 1.0)
        var chosen = signal.timing.recommendedCadence(distance: distance, elapsed: elapsed,
                                                     pace: pace, normalCadence: cadence)
        if !isForcedStopped, let plan = cadencePlan, plan.signalID == signal.id, plan.normal == cadence {
            let arrival = elapsed + pace.arrivalTime(distance: max(0, signal.offset - distance),
                                                     targetCadence: Double(plan.cadence))
            // Keep a reduction only while its arrival is still green. A forced stop
            // or a timing mismatch invalidates it immediately.
            if signal.isGreen(at: arrival), signal.remaining(at: arrival) > 0.2 {
                chosen = plan.cadence
            }
        }
        cadencePlan = !isForcedStopped && chosen < cadence ? (signal.id, cadence, chosen) : nil
        let remainingDistance = max(0, signal.offset - distance)
        activeSignal = SignalInfo(color: signal.isGreen(at: elapsed) ? .green : .red,
                                  remainingS: signal.remaining(at: elapsed))
        activeSignalID = signal.id
        activeSignalTitle = signal.title
        distanceToSignal = remainingDistance
        arrivalSeconds = pace.arrivalTime(distance: remainingDistance, targetCadence: Double(chosen))
        recommendedCadence = chosen == cadence ? nil : chosen
        if isForcedStopped {
            guidanceMessage = "強制停止中。再開時の位置と信号時刻からペースを再計算します"
        } else if remainingDistance <= 1.6 && !signal.isGreen(at: elapsed) {
            guidanceMessage = "最低ペースでも青に合わせられないため、信号手前で停止しています"
        } else if chosen == cadence {
            guidanceMessage = "このペースなら青信号の間に通過できます"
        } else {
            guidanceMessage = "次の青の間に通過するため\(chosen)歩/分へ徐々に減速します。間に合わなければ信号手前で停止します"
        }
        refreshMarkers(at: elapsed)
    }

    /// Called BEFORE moving the simulated pedestrian, at every integration step.
    func allowedTravel(distance: Double, proposed: Double, elapsed: Double,
                       pace: SimulatorPaceModel, targetCadence: Double) -> Double {
        guard let signal = signals.first(where: { $0.offset > distance + 0.000001 }) else { return proposed }
        return signal.timing.allowedTravel(distance: distance, proposed: proposed, elapsed: elapsed,
                                           pace: pace, targetCadence: targetCadence)
    }

    func reset() {
        clearGuidance()
        markers = []
        signals = []
        path = nil
        timingInitialized = false
    }

    private func clearGuidance() {
        cadencePlan = nil
        activeSignal = nil
        activeSignalID = nil
        activeSignalTitle = "信号なし"
        distanceToSignal = nil
        arrivalSeconds = nil
        recommendedCadence = nil
        guidanceMessage = ""
    }

    /// 信号の60m手前で、基準テンポの到着が赤、30歩/分下げた到着が青の中ほどに
    /// なるよう初期位相を設定する。周期は100秒（青40秒・赤60秒）で固定。
    private func configureDemoTiming(distance: Double, elapsed: TimeInterval, mode: ActivityMode, cadence: Int) {
        let stride = mode == .walking ? 0.76 : 1.0
        let speed = max(0.5, stride * Double(cadence) / 60)
        let range = mode == .walking ? 80...140 : 80...190
        let reducedCadence = max(range.lowerBound, cadence - 30)
        let reducedSpeed = max(0.5, stride * Double(reducedCadence) / 60)
        for index in signals.indices {
            let signal = signals[index]
            let approachDistance = min(60, max(0, signal.offset - distance - 1.5))
            let approachTime = max(0, signal.offset - distance - approachDistance) / speed
            let approachAt = elapsed + approachTime
            let timeFromApproachToGreen = approachDistance / reducedSpeed
            // 青の3秒後を目安にする。青を長くしても、初期位相の設定で
            // 通常ペースの到着は赤、減速後の到着は青になるようにする。
            let arrivalMargin = min(3, signal.greenDuration / 2)
            let phaseOffset = (signal.cycle + arrivalMargin
                - timeFromApproachToGreen
                - approachAt.truncatingRemainder(dividingBy: signal.cycle))
                .truncatingRemainder(dividingBy: signal.cycle)
            signals[index].phaseOffset = phaseOffset
        }
        timingInitialized = true
    }

    private func refreshMarkers(at elapsed: TimeInterval) {
        markers = signals.map {
            SimulatorSignalMarker(
                id: $0.id,
                title: $0.title,
                coordinate: $0.coordinate,
                color: $0.isGreen(at: elapsed) ? .green : .red
            )
        }
    }
}

struct SimulatorSignalCard: View {
    @ObservedObject var system: SimulatorSignalSystem

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("信号シミュレーション", systemImage: "light.beacon.max.fill")
                .font(.headline).foregroundStyle(.cyan)
            if let signal = system.activeSignal {
                HStack(spacing: 10) {
                    Circle()
                        .fill(signal.color == .green ? Color.green : Color.red)
                        .frame(width: 20, height: 20)
                        .shadow(color: (signal.color == .green ? Color.green : Color.red).opacity(0.5), radius: 5)
                    Text(signal.color.shortLabel).font(.subheadline.bold())
                    if let remaining = signal.remainingS {
                        Text("切替まで \(Int(remaining.rounded()))秒")
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Text(system.activeSignalTitle).font(.caption.bold())
                }
                if let distance = system.distanceToSignal {
                    Text("約\(Int(distance.rounded()))m先 · 到着予測 \(Int((system.arrivalSeconds ?? 0).rounded()))秒")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text(system.activeSignalTitle).font(.subheadline)
            }
            if !system.guidanceMessage.isEmpty {
                Text(system.guidanceMessage).font(.caption).foregroundStyle(.secondary)
            }
            Text("デモ信号：青40秒・赤60秒（実際の信号情報ではありません）")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CardBackground())
    }
}
#endif
