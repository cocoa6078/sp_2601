#if DEBUG && targetEnvironment(simulator)
import MapKit
import Testing
@testable import Runwave

struct SimulatorWalkTests {
    private func path() -> NavigationPath {
        let origin = MKMapPoint(CLLocationCoordinate2D(latitude: 43, longitude: 141))
        let points = [origin,
                      MKMapPoint(x: origin.x, y: origin.y - 1000),
                      MKMapPoint(x: origin.x - 1000, y: origin.y - 1000)]
        return NavigationPath(MKPolyline(points: points, count: points.count))
    }

    @Test func walkingCoversFourteenMetersInTenSeconds() throws {
        var walk = SimulatedWalk(path: path())
        walk.advance(seconds: 10)
        #expect(abs(walk.distance - 14) < 0.001)
        let date = Date()
        let location = try #require(walk.location(at: date, moving: true))
        #expect(location.timestamp == date)
        #expect(location.horizontalAccuracy == 3)
        #expect(location.speed == 1.4)
        #expect(location.course < 1 || location.course > 359)
    }

    @Test func cornerFollowsPolylineAndFacesLeftAfterTurning() throws {
        let route = path()
        var walk = SimulatedWalk(path: route)
        walk.advance(seconds: (route.offsets[1] + 10) / walk.speed)
        let location = try #require(walk.location(at: Date(), moving: true))
        let expected = try #require(route.point(at: route.offsets[1] + 10))
        #expect(MKMapPoint(location.coordinate).distance(to: expected) < 0.01)
        #expect(abs(location.course - 270) < 0.01)
        #expect(route.turn(at: route.offsets[1]) == .left)
    }

    @Test func finishesAtGoalAndStopsInsteadOfLooping() throws {
        let route = path()
        var walk = SimulatedWalk(path: route)
        walk.advance(seconds: 1_000_000)
        #expect(walk.isFinished)
        #expect(walk.distance == route.length)
        let location = try #require(walk.location(at: Date(), moving: true))
        #expect(location.speed == 0)
        #expect(MKMapPoint(location.coordinate).distance(to: route.points.last!) < 0.01)
    }

    @Test func pauseDoesNotAdvancePositionAndInvalidTimeIsIgnored() throws {
        var walk = SimulatedWalk(path: path())
        walk.advance(seconds: 10)
        let location = try #require(walk.location(at: Date(), moving: false))
        #expect(location.speed == 0)
        walk.advance(seconds: 0)
        walk.advance(seconds: -1)
        walk.advance(seconds: .nan)
        #expect(abs(walk.distance - 14) < 0.001)
    }

    @Test func fastPlaybackStaysWithinTrackerSpeedLimit() throws {
        var walk = SimulatedWalk(path: path())
        walk.speed = 1.4 * 4
        walk.advance(seconds: 1)
        let location = try #require(walk.location(at: Date(), moving: true))
        #expect(abs(walk.distance - 5.6) < 0.001)
        #expect(location.speed < 8)
    }
}
#endif
