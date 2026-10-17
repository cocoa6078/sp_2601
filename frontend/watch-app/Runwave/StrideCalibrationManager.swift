import Combine
import CoreLocation
import CoreMotion
import Foundation

enum ActivityMode: String, CaseIterable, Identifiable, Codable {
    case walking
    case running

    var id: String { rawValue }
    var label: String { self == .walking ? "ウォーキング" : "ランニング" }
    var icon: String { self == .walking ? "figure.walk" : "figure.run" }
    var strideKey: String { "runwave.calibration.\(rawValue).strideM" }
    var cadenceKey: String { "runwave.calibration.\(rawValue).naturalCadence" }
}

/// GPS距離と歩数から、ウォーキング／ランニング別の歩幅と自然なケイデンスを測る。
@MainActor
final class StrideCalibrationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var isMeasuring = false
    @Published private(set) var measuringMode: ActivityMode = .walking
    @Published private(set) var distanceM = 0.0
    @Published private(set) var steps = 0
    @Published private(set) var elapsedS = 0.0
    @Published private(set) var walkingStrideM: Double?
    @Published private(set) var runningStrideM: Double?
    @Published private(set) var walkingCadence: Int?
    @Published private(set) var runningCadence: Int?
    @Published private(set) var errorMessage: String?

    var hasAnyStride: Bool { walkingStrideM != nil || runningStrideM != nil }
    func stride(for mode: ActivityMode) -> Double? { mode == .walking ? walkingStrideM : runningStrideM }
    func cadence(for mode: ActivityMode) -> Int? { mode == .walking ? walkingCadence : runningCadence }

    private let locationManager = CLLocationManager()
    private let pedometer = CMPedometer()
    private var startedAt: Date?
    private var lastLocation: CLLocation?
    private var timerTask: Task<Void, Never>?

    override init() {
        let defaults = UserDefaults.standard
        var savedWalkingStride = defaults.object(forKey: ActivityMode.walking.strideKey) as? Double
        let savedRunningStride = defaults.object(forKey: ActivityMode.running.strideKey) as? Double
        var savedWalkingCadence = Self.savedCadence(for: .walking)
        let savedRunningCadence = Self.savedCadence(for: .running)
        // Migrate the previous single profile to walking so an existing setup is retained.
        if savedWalkingStride == nil, let oldStride = defaults.object(forKey: "runwave.calibration.strideM") as? Double {
            savedWalkingStride = oldStride
            defaults.set(oldStride, forKey: ActivityMode.walking.strideKey)
            if let oldCadence = defaults.object(forKey: "runwave.calibration.naturalCadence") as? Int {
                savedWalkingCadence = oldCadence
                defaults.set(oldCadence, forKey: ActivityMode.walking.cadenceKey)
            }
        }
        super.init()
        walkingStrideM = savedWalkingStride
        runningStrideM = savedRunningStride
        walkingCadence = savedWalkingCadence
        runningCadence = savedRunningCadence
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager.distanceFilter = 1
    }

    private static func savedCadence(for mode: ActivityMode) -> Int? {
        let value = UserDefaults.standard.integer(forKey: mode.cadenceKey)
        return value > 0 ? value : nil
    }

    func start(mode: ActivityMode) {
        guard !isMeasuring else { return }
        guard CLLocationManager.locationServicesEnabled() else {
            errorMessage = "位置情報サービスをオンにしてください。"
            return
        }
        guard CMPedometer.isStepCountingAvailable() else {
            errorMessage = "このiPhoneでは歩数を計測できません。"
            return
        }

        measuringMode = mode
        errorMessage = nil
        distanceM = 0
        steps = 0
        elapsedS = 0
        lastLocation = nil
        let start = Date()
        startedAt = start
        isMeasuring = true
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self, let startedAt = self.startedAt else { return }
                self.elapsedS = Date().timeIntervalSince(startedAt)
            }
        }

        switch locationManager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            locationManager.startUpdatingLocation()
        case .notDetermined:
            locationManager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            fail("歩幅測定には位置情報の許可が必要です。設定から許可してください。")
        @unknown default:
            fail("位置情報の状態を確認できません。")
        }

        pedometer.startUpdates(from: start) { [weak self] data, error in
            Task { @MainActor [weak self] in
                guard let self, self.isMeasuring else { return }
                if let error {
                    self.fail("歩数を計測できません：\(error.localizedDescription)")
                    return
                }
                self.steps = data?.numberOfSteps.intValue ?? 0
            }
        }
    }

    func finish() {
        guard isMeasuring, let startedAt else { return }
        let duration = Date().timeIntervalSince(startedAt)
        guard distanceM >= 30, steps >= 20, duration >= 20 else {
            errorMessage = "歩幅を出すには、屋外で30m以上・20歩以上歩いてから完了してください。"
            return
        }

        let stride = distanceM / Double(steps)
        guard (0.3...2.2).contains(stride) else {
            errorMessage = "距離または歩数が安定しませんでした。iPhoneを携帯して、もう一度測定してください。"
            return
        }

        let cadence = Int((Double(steps) / duration * 60).rounded())
        UserDefaults.standard.set(stride, forKey: measuringMode.strideKey)
        UserDefaults.standard.set(cadence, forKey: measuringMode.cadenceKey)
        if measuringMode == .walking {
            walkingStrideM = stride
            walkingCadence = cadence
        } else {
            runningStrideM = stride
            runningCadence = cadence
        }
        stopSensors()
    }

    func cancel() {
        guard isMeasuring else { return }
        errorMessage = nil
        stopSensors()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard isMeasuring else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: manager.startUpdatingLocation()
        case .denied, .restricted: fail("歩幅測定には位置情報の許可が必要です。設定から許可してください。")
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard isMeasuring else { return }
        for location in locations where location.horizontalAccuracy >= 0 && location.horizontalAccuracy <= 20 {
            guard let previous = lastLocation else { lastLocation = location; continue }
            let segment = location.distance(from: previous)
            let interval = location.timestamp.timeIntervalSince(previous.timestamp)
            lastLocation = location
            guard interval > 0, segment >= 0.8, segment / interval <= 6.0 else { continue }
            distanceM += segment
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard isMeasuring else { return }
        errorMessage = "位置情報を取得できません：\(error.localizedDescription)"
    }

    private func fail(_ message: String) {
        errorMessage = message
        stopSensors()
    }

    private func stopSensors() {
        timerTask?.cancel()
        timerTask = nil
        locationManager.stopUpdatingLocation()
        pedometer.stopUpdates()
        startedAt = nil
        isMeasuring = false
    }
}
