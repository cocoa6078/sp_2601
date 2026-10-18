#if DEBUG && targetEnvironment(simulator)
import Testing
@testable import Runwave

struct SimulatorPaceControlTests {
    @Test func lowerCadenceReducesActualDisplacementGradually() {
        var pace = SimulatorPaceModel(currentCadence: 160, stride: 1)
        let firstDistance = pace.advance(seconds: 5, targetCadence: 100)
        #expect(pace.currentCadence == 150)
        #expect(pace.speed == 2.5)
        let secondDistance = pace.advance(seconds: 5, targetCadence: 100)
        #expect(secondDistance < firstDistance)
    }

    @Test func arrivalPredictionIncludesGradualDeceleration() {
        var pace = SimulatorPaceModel(currentCadence: 160, stride: 0.76)
        let arrival = pace.arrivalTime(distance: 60, targetCadence: 100)
        #expect(abs(pace.advance(seconds: arrival, targetCadence: 100) - 60) < 0.00001)
    }

    @Test func impossibleGreenUsesMinimumCadenceInsteadOfNormalPace() {
        let signal = SimulatorSignalCycle(id: 1, offset: 10, cycle: 120, greenDuration: 6, phaseOffset: 20)
        let pace = SimulatorPaceModel(currentCadence: 160, stride: 1)
        #expect(signal.recommendedCadence(distance: 0, elapsed: 0, pace: pace, normalCadence: 160) == 80)
    }

    @Test func redSignalStopsBeforeLineAndGreenAllowsResume() {
        let signal = SimulatorSignalCycle(id: 1, offset: 80, cycle: 120, greenDuration: 6, phaseOffset: 0)
        let pace = SimulatorPaceModel(currentCadence: 80, stride: 1)
        #expect(signal.allowedTravel(distance: 78, proposed: 4, elapsed: 20,
                                    pace: pace, targetCadence: 80) == 0.5)
        #expect(signal.allowedTravel(distance: 78.5, proposed: 0.1, elapsed: 20,
                                    pace: pace, targetCadence: 80) == 0)
        #expect(signal.allowedTravel(distance: 78.5, proposed: 2, elapsed: 120,
                                    pace: pace, targetCadence: 80) == 2)
    }

    @Test func greenChangingToRedDuringFastPlaybackCannotBeCrossed() {
        let signal = SimulatorSignalCycle(id: 1, offset: 80, cycle: 120, greenDuration: 6, phaseOffset: 0)
        let pace = SimulatorPaceModel(currentCadence: 160, stride: 1)
        #expect(signal.allowedTravel(distance: 78, proposed: 10, elapsed: 5.9,
                                    pace: pace, targetCadence: 160) == 0.5)
    }
}
#endif
