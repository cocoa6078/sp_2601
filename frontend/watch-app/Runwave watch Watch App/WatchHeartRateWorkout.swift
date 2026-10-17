import HealthKit
import Foundation

/// Apple WatchのHealthKitワークアウトから心拍数を取得する。
@MainActor
final class WatchHeartRateWorkout: NSObject, HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    var onHeartRate: ((Int) -> Void)?
    var onError: ((String) -> Void)?

    private let healthStore = HKHealthStore()
    private var workoutSession: HKWorkoutSession?
    private var workoutBuilder: HKLiveWorkoutBuilder?
    private let heartRateType = HKQuantityType.quantityType(forIdentifier: .heartRate)!

    func start(activityMode: String) async {
        guard HKHealthStore.isHealthDataAvailable() else {
            onError?("このApple Watchでは心拍数を取得できません")
            return
        }
        guard workoutSession == nil else { return }

        do {
            try await healthStore.requestAuthorization(
                toShare: [HKObjectType.workoutType()],
                read: [heartRateType]
            )

            let configuration = HKWorkoutConfiguration()
            configuration.activityType = activityMode == "walking" ? .walking : .running
            configuration.locationType = .outdoor

            let session = try HKWorkoutSession(healthStore: healthStore, configuration: configuration)
            let builder = session.associatedWorkoutBuilder()
            builder.dataSource = HKLiveWorkoutDataSource(
                healthStore: healthStore,
                workoutConfiguration: configuration
            )
            session.delegate = self
            builder.delegate = self
            workoutSession = session
            workoutBuilder = builder
            session.startActivity(with: Date())
            builder.beginCollection(withStart: Date()) { [weak self] success, error in
                guard !success else { return }
                Task { @MainActor [weak self] in
                    self?.onError?(error?.localizedDescription ?? "心拍数の計測を開始できませんでした")
                }
            }
        } catch {
            onError?("ヘルスケアの許可を確認してください: \(error.localizedDescription)")
        }
    }

    func pause() { workoutSession?.pause() }
    func resume() { workoutSession?.resume() }

    func stop() {
        guard let session = workoutSession, let builder = workoutBuilder else { return }
        session.end()
        builder.endCollection(withEnd: Date()) { [weak self] _, _ in
            builder.finishWorkout { _, _ in
                Task { @MainActor [weak self] in
                    self?.workoutSession = nil
                    self?.workoutBuilder = nil
                }
            }
        }
    }

    func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didChangeTo toState: HKWorkoutSessionState,
        from fromState: HKWorkoutSessionState,
        date: Date
    ) { }

    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        onError?("心拍数を取得できません: \(error.localizedDescription)")
    }

    func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        guard collectedTypes.contains(heartRateType),
              let quantity = workoutBuilder.statistics(for: heartRateType)?.mostRecentQuantity() else { return }
        let value = Int(quantity.doubleValue(for: HKUnit.count().unitDivided(by: .minute())).rounded())
        guard value > 0 else { return }
        onHeartRate?(value)
    }

    func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) { }
}
