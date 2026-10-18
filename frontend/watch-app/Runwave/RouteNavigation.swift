import AVFoundation
import Combine
import CoreLocation
import MapKit
import SwiftUI

/// Appleから返された徒歩経路だけを候補として表示する。
@MainActor
final class WalkingRoutePlanner: ObservableObject {
    @Published private(set) var routes: [MKRoute] = []
    @Published var selectedIndex = 0
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    private var request: MKDirections?
    private var generation = UUID()

    var selectedRoute: MKRoute? { routes.indices.contains(selectedIndex) ? routes[selectedIndex] : nil }

    func reset() {
        generation = UUID()
        request?.cancel()
        request = nil
        routes = []
        selectedIndex = 0
        isLoading = false
        errorMessage = nil
    }

    func calculate(from source: CLLocationCoordinate2D, to goal: GoalPoint) async {
        reset()
        let token = generation
        let query = MKDirections.Request()
        query.source = MKMapItem(placemark: MKPlacemark(coordinate: source))
        query.destination = MKMapItem(placemark: MKPlacemark(coordinate: goal.coordinate))
        query.transportType = .walking
        query.requestsAlternateRoutes = true
        let directions = MKDirections(request: query)
        request = directions
        isLoading = true
        do {
            let response = try await directions.calculate()
            guard !Task.isCancelled, generation == token else { return }
            routes = response.routes.filter { $0.polyline.pointCount > 1 && $0.distance > 0 }
            if routes.isEmpty { errorMessage = "この地点までの徒歩ルートが見つかりません。近くの道路を選び直してください。" }
        } catch {
            guard !Task.isCancelled, generation == token else { return }
            errorMessage = "経路を取得できません。通信状況を確認して、地点を選び直してください。"
        }
        if generation == token { isLoading = false }
    }
}

/// ルート上の距離を求める。直線距離だけで隣の道路の曲がり角を案内しない。
struct NavigationPath {
    let points: [MKMapPoint]
    let offsets: [Double]
    var length: Double { offsets.last ?? 0 }

    init(_ polyline: MKPolyline) {
        points = (0..<polyline.pointCount).map { polyline.points()[$0] }
        var distances = [0.0]
        if points.count > 1 {
            for index in 1..<points.count {
                distances.append(distances[index - 1] + points[index - 1].distance(to: points[index]))
            }
        }
        offsets = points.isEmpty ? [] : distances
    }

    func point(at offset: Double) -> MKMapPoint? {
        guard offset.isFinite, offset >= 0, offset <= length, let first = points.first else { return nil }
        if offset == 0 { return first }
        for index in 0..<(points.count - 1) {
            let segmentLength = offsets[index + 1] - offsets[index]
            guard segmentLength > 0, offsets[index + 1] >= offset else { continue }
            let fraction = (offset - offsets[index]) / segmentLength
            let start = points[index], end = points[index + 1]
            return MKMapPoint(x: start.x + (end.x - start.x) * fraction,
                              y: start.y + (end.y - start.y) * fraction)
        }
        return nil
    }

    /// 案内文中の左右ではなく、進行方向に沿った経路の曲がり方を調べる。
    func turn(at offset: Double, before: Double = 12, after: Double = 12) -> NavigationTurn? {
        let beforeDistance = min(before, offset)
        let afterDistance = min(after, length - offset)
        guard beforeDistance >= 2, afterDistance >= 2,
              let previous = point(at: offset - beforeDistance),
              let corner = point(at: offset),
              let next = point(at: offset + afterDistance) else { return nil }
        let incoming = (x: corner.x - previous.x, y: corner.y - previous.y)
        let outgoing = (x: next.x - corner.x, y: next.y - corner.y)
        guard hypot(incoming.x, incoming.y) > 0, hypot(outgoing.x, outgoing.y) > 0 else { return nil }
        let cross = incoming.x * outgoing.y - incoming.y * outgoing.x
        let dot = incoming.x * outgoing.x + incoming.y * outgoing.y
        let angle = atan2(cross, dot) * 180 / .pi
        if abs(angle) < 20 { return .straight }
        if abs(angle) >= 155 { return .uTurn }
        // MKMapPointのY軸は南向きに増えるので、正の外積は右折。
        return angle > 0 ? .right : .left
    }

    func projection(of coordinate: CLLocationCoordinate2D, minimum: Double = 0, maximum: Double = .infinity) -> (offset: Double, separation: Double)? {
        guard points.count > 1 else { return nil }
        let point = MKMapPoint(coordinate)
        var best: (offset: Double, separation: Double)?
        for index in 0..<(points.count - 1) {
            guard offsets[index + 1] >= minimum, offsets[index] <= maximum else { continue }
            let start = points[index], end = points[index + 1]
            let dx = end.x - start.x, dy = end.y - start.y
            let squaredLength = dx * dx + dy * dy
            guard squaredLength > 0 else { continue }
            let segmentLength = offsets[index + 1] - offsets[index]
            guard segmentLength > 0 else { continue }
            let lower = max(0, (minimum - offsets[index]) / segmentLength)
            let upper = min(1, (maximum - offsets[index]) / segmentLength)
            guard lower <= upper else { continue }
            let fraction = min(upper, max(lower, ((point.x - start.x) * dx + (point.y - start.y) * dy) / squaredLength))
            let projected = MKMapPoint(x: start.x + dx * fraction, y: start.y + dy * fraction)
            let offset = offsets[index] + (offsets[index + 1] - offsets[index]) * fraction
            guard offset >= minimum, offset <= maximum else { continue }
            let separation = point.distance(to: projected)
            if best == nil || separation < best!.separation { best = (offset, separation) }
        }
        return best
    }
}

enum NavigationTurn: Equatable {
    case straight, left, right, uTurn
}

/// 全画面・音声・Watchで共通に使う、曲がり角に対応した案内。
struct NavigationManeuver {
    let offset: Double
    let instruction: String
    let symbol: String

    init?(offset: Double, nativeInstruction: String, turn: NavigationTurn?) {
        self.offset = offset
        let text = nativeInstruction.lowercased()
        // ロータリーの出口番号などは、単純な左右に置き換えない。
        if text.contains("ロータリー") || text.contains("環状交差点") || text.contains("roundabout") {
            instruction = nativeInstruction
            symbol = "arrow.up"
            return
        }
        switch turn {
        case .left:
            instruction = "左方向です"
            symbol = "arrow.turn.up.left"
        case .right:
            instruction = "右方向です"
            symbol = "arrow.turn.up.right"
        case .uTurn:
            instruction = "折り返してください"
            symbol = "arrow.uturn.backward"
        case .straight, nil:
            // 文章に別の曲がり角や道路の左右が含まれても、曲がる向きと決めつけない。
            let mentionsDirection = ["左", "右", "left", "right", "turn", "折り返"].contains { text.contains($0) }
            guard !mentionsDirection else { return nil }
            instruction = nativeInstruction
            symbol = "arrow.up"
        }
    }
}

@MainActor
final class RouteNavigation: ObservableObject {
    @Published private(set) var selectedRoute: MKRoute?
    @Published private(set) var instruction = "経路を選択してください"
    @Published private(set) var instructionSymbol = "arrow.up"
    @Published private(set) var distanceToManeuver: Double?
    @Published private(set) var remainingDistance: Double?
    @Published private(set) var isOffRoute = false
    @Published private(set) var isRecalculating = false
    private var path: NavigationPath?
    private var maneuvers: [NavigationManeuver] = []
    private var announced = Set<Int>()
    private var progress = 0.0
    private var lastLocation: CLLocation?
    private var offRouteSince: Date?
    private var lastRecalculation = Date.distantPast
    private var isActive = false
    private var destination: GoalPoint?
    private var recalculationTask: Task<Void, Never>?
    private var directions: MKDirections?
    private let speech = AVSpeechSynthesizer()

    func select(_ route: MKRoute?) {
        selectedRoute = route
        path = route.map { NavigationPath($0.polyline) }
        progress = 0
        announced = []
        maneuvers = []
        remainingDistance = path?.length
        distanceToManeuver = nil
        isOffRoute = false
        offRouteSince = nil
        instruction = route == nil ? "経路を選択してください" : "経路に沿って進んでください"
        instructionSymbol = "arrow.up"
        guard let route, let path else { return }
        var minimum = 0.0
        var steps: [(offset: Double, instruction: String)] = []
        for step in route.steps where !step.instructions.isEmpty && step.polyline.pointCount > 0 {
            let coordinate = step.polyline.points()[0].coordinate
            guard let point = path.projection(of: coordinate, minimum: minimum) else { continue }
            minimum = point.offset
            // 出発・到着の案内は既存の開始画面とゴール画面に任せる。
            guard point.offset > 3, point.offset < path.length - 10 else { continue }
            // 同じ交差点を複数のステップが共有する場合は一つにまとめる。
            if let last = steps.last, point.offset - last.offset < 1 { continue }
            steps.append((offset: point.offset, instruction: step.instructions))
        }
        for (index, step) in steps.enumerated() {
            let previousOffset = index > 0 ? steps[index - 1].offset : 0
            let nextOffset = index + 1 < steps.count ? steps[index + 1].offset : path.length
            // 近接する次の曲がり角を混ぜず、この曲がり角の前後だけで判定する。
            let turn = path.turn(at: step.offset,
                                 before: min(12, (step.offset - previousOffset) / 2),
                                 after: min(12, (nextOffset - step.offset) / 2))
            if let maneuver = NavigationManeuver(offset: step.offset, nativeInstruction: step.instruction, turn: turn) {
                maneuvers.append(maneuver)
            }
        }
    }

    func start(goal: GoalPoint?) {
        stop()
        destination = goal
        let route = selectedRoute
        select(route)
        lastLocation = nil
        lastRecalculation = .distantPast
        isActive = true
    }

    func pause() {
        isActive = false
        speech.stopSpeaking(at: .immediate)
        cancelRecalculation()
    }

    func resume() { isActive = true }

    func stop() {
        pause()
        offRouteSince = nil
    }

    func update(_ location: CLLocation) {
        guard isActive, location.horizontalAccuracy >= 0, location.horizontalAccuracy <= 25,
              abs(location.timestamp.timeIntervalSinceNow) <= 15, let path else { return }
        let elapsed = lastLocation.map { max(0, location.timestamp.timeIntervalSince($0.timestamp)) } ?? 0
        lastLocation = location
        // 周回・折り返しで、近くを通る後半のルートへ飛ばないよう探索範囲を絞る。
        let maximum = progress + max(70, min(300, elapsed * 8 + 25))
        guard let projection = path.projection(of: location.coordinate, minimum: max(0, progress - 20), maximum: maximum) else { return }
        if projection.separation > 35 {
            isOffRoute = true
            distanceToManeuver = nil
            instruction = "経路から外れています"
            instructionSymbol = "arrow.triangle.turn.up.right.diamond"
            if offRouteSince == nil { offRouteSince = location.timestamp }
            if let offRouteSince, location.timestamp.timeIntervalSince(offRouteSince) >= 8 {
                recalculate(from: location)
            }
            return
        }
        isOffRoute = false
        offRouteSince = nil
        progress = max(progress, projection.offset)
        remainingDistance = max(0, path.length - progress)
        guard let next = maneuvers.enumerated().first(where: { $0.element.offset >= progress - 5 }) else {
            instruction = "ゴールへ進んでください"
            instructionSymbol = "flag.checkered"
            distanceToManeuver = remainingDistance
            return
        }
        let distance = max(0, next.element.offset - progress)
        instruction = next.element.instruction
        instructionSymbol = next.element.symbol
        distanceToManeuver = distance
        guard distance <= 20, projection.separation <= 20, !announced.contains(next.offset) else { return }
        announced.insert(next.offset)
        speak("まもなく、\(instruction)")
    }

    private func recalculate(from location: CLLocation) {
        guard !isRecalculating, let destination,
              Date().timeIntervalSince(lastRecalculation) >= 30 else { return }
        lastRecalculation = Date()
        isRecalculating = true
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: location.coordinate))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: destination.coordinate))
        request.transportType = .walking
        let query = MKDirections(request: request)
        directions = query
        recalculationTask = Task { [weak self] in
            do {
                let response = try await query.calculate()
                guard !Task.isCancelled, let self, self.isActive,
                      let route = response.routes.first else { return }
                self.select(route)
                self.instruction = "新しい経路に沿って進んでください"
            } catch {
                guard !Task.isCancelled else { return }
                self?.instruction = "経路を再取得できません。通信状況を確認してください"
            }
            if !Task.isCancelled { self?.isRecalculating = false }
        }
    }

    private func cancelRecalculation() {
        recalculationTask?.cancel()
        directions?.cancel()
        recalculationTask = nil
        directions = nil
        isRecalculating = false
    }

    private func speak(_ text: String) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: "ja-JP")
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate
            speech.speak(utterance)
        } catch {
            // 画面の案内は、音声出力が使えない場合も継続する。
        }
    }

}

struct NavigationInstructionCard: View {
    @ObservedObject var navigation: RouteNavigation

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: navigation.instructionSymbol)
                .font(.system(size: 32, weight: .bold))
                .foregroundStyle(navigation.isOffRoute ? Color.orange : Color.cyan)
                .frame(width: 42)
            VStack(alignment: .leading, spacing: 5) {
                if navigation.isRecalculating {
                    Text("経路を再検索中").font(.headline)
                } else if let distance = navigation.distanceToManeuver {
                    Text(distance < 5 ? "まもなく" : "約\(Int((distance / 5).rounded() * 5))m先")
                        .font(.title3.bold().monospacedDigit())
                }
                Text(navigation.instruction).font(.headline).fixedSize(horizontal: false, vertical: true)
                if let remaining = navigation.remainingDistance {
                    Text("ゴールまで経路に沿って \(remaining.formattedRouteDistance)")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(CardBackground())
        .accessibilityElement(children: .combine)
    }
}

extension Double {
    var formattedRouteDistance: String {
        self >= 1000 ? String(format: "%.2f km", self / 1000) : "\(Int(self.rounded())) m"
    }
}
