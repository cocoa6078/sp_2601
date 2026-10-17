import Combine
import CoreLocation
import CoreMotion
import Foundation
import MapKit
import SwiftUI

struct WorkoutCoordinate: Codable, Equatable {
    var latitude: Double
    var longitude: Double

    init(_ coordinate: CLLocationCoordinate2D) {
        latitude = coordinate.latitude
        longitude = coordinate.longitude
    }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

struct WorkoutSpeedSample: Identifiable, Codable, Equatable {
    var id: UUID
    var elapsed: TimeInterval
    var distanceM: Double
    var speedMPS: Double

    var speedKPH: Double { speedMPS * 3.6 }
}

/// iPhoneでワークアウト中のGPS経路・距離・歩数ケイデンスを計測する。
@MainActor
final class WorkoutRouteTracker: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var distanceM = 0.0
    @Published private(set) var distanceToGoalM: Double?
    @Published private(set) var currentCadence: Int?
    @Published private(set) var averageCadence: Int?
    @Published private(set) var route: [CLLocationCoordinate2D] = []
    @Published private(set) var speedSamples: [WorkoutSpeedSample] = []
    @Published private(set) var stopCount = 0
    @Published private(set) var statusMessage: String?

    var onMetrics: ((Int?, Double, Int?) -> Void)?
    var onLocation: ((CLLocation) -> Void)?
    var goal: GoalPoint?

    private let locationManager = CLLocationManager()
    private let pedometer = CMPedometer()
    private var lastLocation: CLLocation?
    private var activeStartedAt: Date?
    private var activeDuration: TimeInterval = 0
    private var activeSteps = 0
    private var stepCountAtResume = 0
    private var isActive = false
    private var slowStartedAt: Date?
    private var isCurrentlyStopped = false
    private var lastSpeedSampleAt: TimeInterval = -10
    private var lastSpeedSample: Double?

    override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager.distanceFilter = kCLDistanceFilterNone
        locationManager.activityType = .fitness
        locationManager.pausesLocationUpdatesAutomatically = false
    }

    func start() {
        distanceM = 0
        distanceToGoalM = nil
        currentCadence = nil
        averageCadence = nil
        route = []
        speedSamples = []
        stopCount = 0
        slowStartedAt = nil
        isCurrentlyStopped = false
        lastSpeedSampleAt = -10
        lastSpeedSample = nil
        activeSteps = 0
        activeDuration = 0
        lastLocation = nil
        statusMessage = nil
        resume()
    }

    func reset() {
        pause()
        distanceM = 0
        distanceToGoalM = nil
        currentCadence = nil
        averageCadence = nil
        route = []
        speedSamples = []
        stopCount = 0
        slowStartedAt = nil
        isCurrentlyStopped = false
        lastSpeedSampleAt = -10
        lastSpeedSample = nil
        activeSteps = 0
        activeDuration = 0
        lastLocation = nil
        statusMessage = nil
        publishMetrics()
    }

    func pause() {
        guard isActive else { return }
        if let activeStartedAt { activeDuration += Date().timeIntervalSince(activeStartedAt) }
        activeStartedAt = nil
        isActive = false
        locationManager.stopUpdatingLocation()
        #if os(iOS)
        locationManager.allowsBackgroundLocationUpdates = false
        #endif
        pedometer.stopUpdates()
    }

    func resume() {
        guard !isActive else { return }
        isActive = true
        #if os(iOS)
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.showsBackgroundLocationIndicator = true
        #endif
        activeStartedAt = Date()
        stepCountAtResume = activeSteps
        switch locationManager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            locationManager.startUpdatingLocation()
        case .notDetermined:
            locationManager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            statusMessage = "位置情報を許可すると距離と経路を記録できます"
        @unknown default:
            statusMessage = "位置情報を確認できません"
        }
        guard CMPedometer.isStepCountingAvailable() else {
            statusMessage = "このiPhoneでは歩数を取得できません"
            return
        }
        pedometer.startUpdates(from: Date()) { [weak self] data, _ in
            guard let data else { return }
            Task { @MainActor [weak self] in
                guard let self, self.isActive else { return }
                self.activeSteps = self.stepCountAtResume + data.numberOfSteps.intValue
                // Core Motion reports cadence in steps/second; RUNWAVE displays steps/minute.
                self.currentCadence = data.currentCadence.map {
                    Int(($0.doubleValue * 60).rounded()).clamped(to: 0...300)
                }
                let elapsed = max(1, self.activeDuration + (Date().timeIntervalSince(self.activeStartedAt ?? Date())))
                if self.activeSteps > 0 { self.averageCadence = Int((Double(self.activeSteps) / elapsed * 60).rounded()) }
                self.publishMetrics()
            }
        }
    }

    func finish() -> (distance: Double?, averageCadence: Int?) {
        pause()
        locationManager.stopUpdatingLocation()
        let average = averageCadence ?? currentCadence
        averageCadence = average
        publishMetrics()
        return (distanceM > 0 ? distanceM : nil, average)
    }

    private func publishMetrics() { onMetrics?(currentCadence, distanceM, averageCadence) }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard isActive else { return }
        if manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse {
            manager.startUpdatingLocation()
            statusMessage = nil
        } else if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
            statusMessage = "位置情報を許可すると距離と経路を記録できます"
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard isActive else { return }
        for location in locations where location.horizontalAccuracy >= 0 && location.horizontalAccuracy <= 25
            && abs(location.timestamp.timeIntervalSinceNow) <= 15 {
            if let goal {
                distanceToGoalM = location.distance(from: CLLocation(latitude: goal.latitude, longitude: goal.longitude))
            }
            onLocation?(location)
            let previous = lastLocation
            lastLocation = location
            guard let activeStartedAt else { continue }
            let elapsed = activeDuration + location.timestamp.timeIntervalSince(activeStartedAt)
            guard elapsed >= 0 else { continue }

            var segment = 0.0
            var seconds = 0.0
            if let previous {
                segment = location.distance(from: previous)
                seconds = location.timestamp.timeIntervalSince(previous.timestamp)
                if seconds > 0, segment >= 1, segment / seconds <= 8 {
                    distanceM += segment
                    route.append(location.coordinate)
                    publishMetrics()
                }
            } else {
                route.append(location.coordinate)
            }

            let speed: Double
            if location.speed >= 0, location.speed.isFinite {
                speed = location.speed
            } else if seconds > 0 {
                speed = segment / seconds
            } else {
                continue
            }
            guard speed.isFinite, speed <= 8 else { continue }
            recordSpeed(speed, at: location.timestamp, elapsed: elapsed)
        }
    }

    private func recordSpeed(_ speed: Double, at date: Date, elapsed: TimeInterval) {
        if speed <= 0.5 {
            if slowStartedAt == nil { slowStartedAt = date }
            if !isCurrentlyStopped, let slowStartedAt,
               date.timeIntervalSince(slowStartedAt) >= 3 {
                stopCount += 1
                isCurrentlyStopped = true
            }
        } else if speed >= 0.9 {
            slowStartedAt = nil
            isCurrentlyStopped = false
        }

        let enteredStop = speed <= 0.5 && (lastSpeedSample ?? 1) > 0.5
        let leftStop = speed >= 0.9 && (lastSpeedSample ?? 0) <= 0.5
        guard elapsed - lastSpeedSampleAt >= 3 || abs(speed - (lastSpeedSample ?? speed)) >= 0.5 || enteredStop || leftStop else {
            return
        }
        speedSamples.append(WorkoutSpeedSample(
            id: UUID(),
            elapsed: elapsed,
            distanceM: distanceM,
            speedMPS: speed
        ))
        lastSpeedSampleAt = elapsed
        lastSpeedSample = speed
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        statusMessage = "GPSを取得できません。屋外で位置情報を確認してください。"
    }
}

private extension Int {
    func clamped(to range: ClosedRange<Int>) -> Int { Swift.min(Swift.max(self, range.lowerBound), range.upperBound) }
}

struct WorkoutRouteMap: View {
    let route: [CLLocationCoordinate2D]
    let goal: GoalPoint?
    var plannedRoute: MKRoute? = nil

    var body: some View {
        Map {
            if let plannedRoute {
                MapPolyline(plannedRoute.polyline).stroke(.cyan.opacity(0.65), lineWidth: 7)
            }
            if route.count > 1 {
                MapPolyline(coordinates: route).stroke(.blue, lineWidth: 5)
            }
            if let first = route.first { Marker("スタート", coordinate: first).tint(.green) }
            if let last = route.last { Marker("現在地", coordinate: last).tint(.blue) }
            if let goal { Marker("ゴール", coordinate: goal.coordinate).tint(.red) }
        }
        .mapStyle(.standard(elevation: .flat))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityLabel("選択した徒歩ルートと実際に移動した経路")
    }
}
