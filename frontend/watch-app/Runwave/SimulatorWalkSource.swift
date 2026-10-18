#if DEBUG && targetEnvironment(simulator)
import Combine
import CoreLocation
import MapKit
import SwiftUI

/// 選択した実際の徒歩経路を距離で補間する。UIの数値を直接書き換えない。
struct SimulatedWalk {
    let path: NavigationPath
    private(set) var distance = 0.0
    var speed = 1.4

    var isFinished: Bool { distance >= path.length }

    mutating func advance(seconds: Double, maximumDistance: Double? = nil) -> Bool {
        guard seconds.isFinite, seconds > 0, speed.isFinite, speed > 0 else { return false }
        let previousDistance = distance
        distance = min(path.length, distance + min(seconds * speed, maximumDistance ?? .infinity))
        return distance > previousDistance
    }

    func location(at date: Date, moving: Bool) -> CLLocation? {
        guard let point = path.point(at: distance) else { return nil }
        let ahead = path.point(at: min(path.length, distance + 2)) ?? point
        let behind = path.point(at: max(0, distance - 2)) ?? point
        let course = (atan2(ahead.x - behind.x, behind.y - ahead.y) * 180 / .pi + 360)
            .truncatingRemainder(dividingBy: 360)
        return CLLocation(coordinate: point.coordinate, altitude: 0,
                          horizontalAccuracy: 3, verticalAccuracy: 3, course: course,
                          speed: moving && !isFinished ? speed : 0, timestamp: date)
    }
}

/// Macのシミュレーターだけで使う仮想GPS。受信後は実機と同じ位置処理へ流す。
@MainActor
final class SimulatorWalkSource: ObservableObject {
    static let shared = SimulatorWalkSource()
    @Published private(set) var location = CLLocation(coordinate: GoalPoint.simulatorStart.coordinate,
        altitude: 0, horizontalAccuracy: 3, verticalAccuracy: 3, timestamp: Date())
    @Published private(set) var isRunning = false
    @Published private(set) var distance = 0.0
    @Published private(set) var length = 0.0
    @Published private(set) var elapsed = 0.0
    @Published private(set) var simulatedCadence = 0
    @Published private(set) var isPedestrianForcedStopped = false
    @Published private(set) var isWaitingAtSignal = false
    @Published var rate = 1.0 {
        didSet { refreshSimulatedCadence(moving: isRunning && !isWaitingAtSignal) }
    }
    private var walk: SimulatedWalk?
    private var task: Task<Void, Never>?
    private var pace = SimulatorPaceModel(currentCadence: 120, stride: 0.76)
    private var paceCadence = 120
    private var activityMode: ActivityMode = .walking
    var currentPaceCadence: Double { pace.currentCadence }
    private var lastTickAt: Date?

    func prepare(_ route: MKRoute) {
        pause()
        walk = SimulatedWalk(path: NavigationPath(route.polyline))
        distance = 0
        length = walk?.path.length ?? 0
        elapsed = 0
        isPedestrianForcedStopped = false
        isWaitingAtSignal = false
        publish(moving: false)
    }

    func resume() {
        guard !isRunning, let walk, !walk.isFinished else { return }
        isRunning = true
        lastTickAt = Date()
        refreshSimulatedCadence(moving: true)
        publish(moving: true)
        task = Task { [weak self] in
            var lastUpdate = Date()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                guard let self, self.isRunning else { return }
                let now = Date()
                // Macがスリープした後に位置が急に飛ばないよう、一回の進行を制限する。
                let seconds = min(2, max(0, now.timeIntervalSince(lastUpdate)))
                lastUpdate = now
                // Integrate position, cadence and signal time together. Small steps
                // prevent 4x playback from jumping over a red stop line.
                self.advanceSimulation(seconds: seconds * min(4, max(1, self.rate)))
                self.lastTickAt = now
                self.publish(moving: self.isRunning && !self.isPedestrianForcedStopped && !self.isWaitingAtSignal)
                if !self.isRunning { return }
            }
        }
    }

    func elapsed(at date: Date) -> TimeInterval {
        guard isRunning, let lastTickAt else { return elapsed }
        let sinceTick = min(2, max(0, date.timeIntervalSince(lastTickAt)))
        return elapsed + sinceTick * min(4, max(1, rate))
    }

    func pause() {
        if isRunning {
            elapsed = elapsed(at: Date())
        }
        task?.cancel()
        task = nil
        isRunning = false
        lastTickAt = nil
        refreshSimulatedCadence(moving: false)
    }

    func setPace(mode: ActivityMode, cadence: Int) {
        activityMode = mode
        pace.stride = mode == .walking ? 0.76 : 1.0
        paceCadence = cadence
        if !isRunning { pace.currentCadence = Double(cadence) }
        refreshSimulatedCadence(moving: isRunning && !isWaitingAtSignal)
    }

    /// Cadence changes alter the actual route displacement, not only the label.
    /// The signal planner always receives the user's normal target separately.
    func advanceSimulation(seconds: Double) {
        var remaining = seconds
        let signals = SimulatorSignalSystem.shared
        while remaining > 0.000001 {
            let step = min(0.1, remaining)
            remaining -= step
            if !isPedestrianForcedStopped && pace.currentCadence == 0 {
                pace.currentCadence = min(80, Double(paceCadence))
            }
            signals.update(distance: distance, elapsed: elapsed, mode: activityMode,
                           cadence: paceCadence, isForcedStopped: isPedestrianForcedStopped,
                           currentCadence: pace.currentCadence)
            if isPedestrianForcedStopped {
                pace.currentCadence = 0
                walk?.speed = 0
                isWaitingAtSignal = false
            } else {
                let target = Double(signals.recommendedCadence ?? paceCadence)
                let before = pace
                let proposed = pace.advance(seconds: step, targetCadence: target)
                let allowed = signals.allowedTravel(distance: distance, proposed: proposed,
                                                    elapsed: elapsed, pace: before, targetCadence: target)
                isWaitingAtSignal = allowed + 0.000001 < proposed
                walk?.speed = proposed / step
                _ = walk?.advance(seconds: step, maximumDistance: allowed)
                distance = walk?.distance ?? 0
                if isWaitingAtSignal {
                    pace.currentCadence = 0
                    walk?.speed = 0
                } else {
                    walk?.speed = pace.speed
                }
            }
            elapsed += step
            if walk?.isFinished == true {
                isRunning = false
                break
            }
        }
    }

    /// デモ用に位置だけを止める。仮想時計と信号周期は進み続ける。
    func setPedestrianForcedStopped(_ stopped: Bool) {
        guard isPedestrianForcedStopped != stopped else { return }
        isPedestrianForcedStopped = stopped
        if stopped {
            pace.currentCadence = 0
            walk?.speed = 0
        }
        publish(moving: isRunning && !stopped && !isWaitingAtSignal)
    }

    private func publish(moving: Bool) {
        refreshSimulatedCadence(moving: moving)
        if let next = walk?.location(at: Date(), moving: moving) { location = next }
    }

    private func refreshSimulatedCadence(moving: Bool) {
        simulatedCadence = moving && !isPedestrianForcedStopped && !isWaitingAtSignal
            ? Int(pace.currentCadence.rounded()) : 0
    }
}

struct SimulatorWalkCard: View {
    @ObservedObject private var source = SimulatorWalkSource.shared
    let isSession: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("歩行シミュレーション", systemImage: "location.circle")
                .font(.headline).foregroundStyle(.cyan)
            if isSession {
                Text("\(source.isPedestrianForcedStopped ? "強制停止中" : (source.isWaitingAtSignal ? "赤信号で停止中" : (source.isRunning ? "移動中" : "停止中"))) · \(Int(source.distance)) / \(Int(source.length)) m")
                    .font(.subheadline.monospacedDigit())
            } else {
                Text("信号機1基を通過するデモルートです。「歩いて開始」で道路に沿って現在地が動きます。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Picker("移動速度", selection: $source.rate) {
                Text("歩く速さ").tag(1.0)
                Text("2倍速").tag(2.0)
                Text("4倍速").tag(4.0)
            }
            .pickerStyle(.segmented)
            Text("歩幅・開始時のケイデンスは検証用の値です。歩数・現在ケイデンス・心拍数は実測しません。")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CardBackground())
    }
}
#endif
