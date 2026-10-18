#if DEBUG && targetEnvironment(simulator)
import Foundation

/// Values use simulated seconds. Playback speed never changes cadence or GPS speed.
struct SimulatorPaceModel {
    static let cadenceChangePerSecond = 2.0
    var currentCadence: Double
    var stride: Double

    var speed: Double { stride * currentCadence / 60 }

    mutating func advance(seconds: Double, targetCadence: Double) -> Double {
        guard seconds > 0, seconds.isFinite, stride > 0 else { return 0 }
        let rampTime = min(seconds, abs(targetCadence - currentCadence) / Self.cadenceChangePerSecond)
        let direction = targetCadence >= currentCadence ? 1.0 : -1.0
        let nextCadence = currentCadence + direction * Self.cadenceChangePerSecond * rampTime
        let meters = stride / 60 * ((currentCadence + nextCadence) / 2 * rampTime
            + nextCadence * (seconds - rampTime))
        currentCadence = nextCadence
        return max(0, meters)
    }

    /// Includes the distance travelled while gradually changing cadence.
    func arrivalTime(distance: Double, targetCadence: Double) -> Double {
        guard distance > 0 else { return 0 }
        guard targetCadence > 0, stride > 0 else { return .infinity }
        let rampTime = abs(targetCadence - currentCadence) / Self.cadenceChangePerSecond
        let rampDistance = stride / 60 * (currentCadence + targetCadence) / 2 * rampTime
        if distance >= rampDistance {
            return rampTime + (distance - rampDistance) / (stride * targetCadence / 60)
        }
        let acceleration = stride / 60 * Self.cadenceChangePerSecond * (targetCadence >= currentCadence ? 1 : -1)
        // The positive-time root, written to avoid cancellation for small distances.
        return 2 * distance / (speed + sqrt(max(0, speed * speed + 2 * acceleration * distance)))
    }
}

struct SimulatorSignalCycle {
    let id: Int
    let offset: Double
    let cycle: Double
    let greenDuration: Double
    var phaseOffset: Double

    func phase(at time: Double) -> Double {
        let value = (time + phaseOffset).truncatingRemainder(dividingBy: cycle)
        return value < 0 ? value + cycle : value
    }

    func isGreen(at time: Double) -> Bool { phase(at: time) < greenDuration }
    func remaining(at time: Double) -> Double {
        isGreen(at: time) ? greenDuration - phase(at: time) : cycle - phase(at: time)
    }

    func recommendedCadence(distance: Double, elapsed: Double, pace: SimulatorPaceModel, normalCadence: Int) -> Int {
        let remainingDistance = max(0, offset - distance)
        let normalArrival = pace.arrivalTime(distance: remainingDistance, targetCadence: Double(normalCadence))
        // If the normal pace already reaches green, there is no reason to speed up or slow down.
        let normalEntryLead = 1.5 / (pace.stride * Double(normalCadence) / 60)
        if isGreen(at: elapsed + normalArrival - normalEntryLead),
           isGreen(at: elapsed + normalArrival), remaining(at: elapsed + normalArrival) > 0.5 {
            return normalCadence
        }
        // Prefer the smallest reduction that reaches any upcoming green window.
        // A miss must fall back to the minimum pace, never back to the fast normal pace.
        for candidate in stride(from: normalCadence - 1, through: 80, by: -1) {
            let arrival = elapsed + pace.arrivalTime(distance: remainingDistance, targetCadence: Double(candidate))
            let entryLead = 1.5 / (pace.stride * Double(candidate) / 60)
            if isGreen(at: arrival), phase(at: arrival) >= entryLead + 0.5, remaining(at: arrival) > 0.5 {
                return candidate
            }
        }
        return min(normalCadence, 80)
    }

    /// Last line of defence in the movement integrator: a red crossing is never committed.
    func allowedTravel(distance: Double, proposed: Double, elapsed: Double,
                       pace: SimulatorPaceModel, targetCadence: Double) -> Double {
        guard proposed > 0, distance < offset else { return proposed }
        let stopLine = max(0, offset - 1.5)
        guard distance + proposed >= stopLine else { return proposed }
        let crossesSignal = distance + proposed >= offset
        if crossesSignal {
            let crossingTime = elapsed + pace.arrivalTime(distance: offset - distance, targetCadence: targetCadence)
            if !isGreen(at: crossingTime) { return max(0, stopLine - distance) }
        }
        if !isGreen(at: elapsed) { return max(0, stopLine - distance) }
        return proposed
    }
}
#endif
