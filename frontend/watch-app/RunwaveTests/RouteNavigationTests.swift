import MapKit
import Testing
@testable import Runwave

struct RouteNavigationTests {
    private let origin = MKMapPoint(CLLocationCoordinate2D(latitude: 43, longitude: 141))

    private func path(_ vectors: [(Double, Double)]) -> NavigationPath {
        let points = vectors.map { MKMapPoint(x: origin.x + $0.0, y: origin.y + $0.1) }
        return NavigationPath(MKPolyline(points: points, count: points.count))
    }

    @Test func leftAndRightFromAllFourApproaches() {
        // MKMapPointのYは南向き。北・東・南・西の各方向からの左折を確認する。
        let approaches: [(Double, Double)] = [(0, -1000), (1000, 0), (0, 1000), (-1000, 0)]
        for (x, y) in approaches {
            let left = path([(-x, -y), (0, 0), (y, -x)])
            let right = path([(-x, -y), (0, 0), (-y, x)])
            #expect(left.turn(at: left.offsets[1]) == .left)
            #expect(right.turn(at: right.offsets[1]) == .right)
        }
    }

    @Test func reversingRouteReversesTurn() {
        let forward = path([(0, 1000), (0, 0), (-1000, 0)])
        let reverse = path([(-1000, 0), (0, 0), (0, 1000)])
        #expect(forward.turn(at: forward.offsets[1]) == .left)
        #expect(reverse.turn(at: reverse.offsets[1]) == .right)
    }

    @Test func geometryWinsOverOppositeOrAmbiguousWords() {
        let left = NavigationManeuver(offset: 50, nativeInstruction: "右側の建物を過ぎて左折", turn: .left)
        #expect(left?.instruction == "左方向です")
        #expect(left?.symbol == "arrow.turn.up.left")
        let right = NavigationManeuver(offset: 50, nativeInstruction: "左方向です", turn: .right)
        #expect(right?.instruction == "右方向です")
        #expect(right?.symbol == "arrow.turn.up.right")
        #expect(NavigationManeuver(offset: 50, nativeInstruction: "右方向です", turn: .straight) == nil)
        #expect(NavigationManeuver(offset: 50, nativeInstruction: "左方向です", turn: nil) == nil)
    }

    @Test func straightAndUTurnAreNotLeftOrRight() {
        let straight = path([(0, 1000), (0, 0), (0, -1000)])
        let uTurn = path([(0, 1000), (0, 0), (0, 1000)])
        #expect(straight.turn(at: straight.offsets[1]) == .straight)
        #expect(uTurn.turn(at: uTurn.offsets[1]) == .uTurn)
        #expect(straight.turn(at: 0) == nil)
        #expect(straight.turn(at: straight.length) == nil)
    }

    @Test func nearbyOppositeTurnsKeepTheirOwnDirection() {
        let route = path([(0, 1000), (0, 0), (-100, 0), (-100, -1000)])
        let between = route.offsets[2] - route.offsets[1]
        #expect(route.turn(at: route.offsets[1], after: min(12, between / 2)) == .left)
        #expect(route.turn(at: route.offsets[2], before: min(12, between / 2)) == .right)
    }

    @Test func roundaboutKeepsExitInstructions() {
        let instruction = "ロータリーの2番目の出口から出ます"
        let maneuver = NavigationManeuver(offset: 50, nativeInstruction: instruction, turn: .right)
        #expect(maneuver?.instruction == instruction)
        #expect(maneuver?.symbol == "arrow.up")
    }
}
