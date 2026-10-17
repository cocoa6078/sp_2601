import Combine
import Foundation
import WatchConnectivity

/// iPhone から届く目標値とセッション操作を Watch アプリに反映する。
final class WatchConnectivityManager: NSObject, ObservableObject, WCSessionDelegate {
    enum SessionState {
        case idle, running, paused, ended
    }

    @Published private(set) var sessionState: SessionState = .idle
    @Published private(set) var targetCadence = 140
    @Published private(set) var guidedCadence = 140
    @Published private(set) var cadenceBaseline = 140
    @Published private(set) var cadenceAdjustment = 0
    @Published private(set) var activityMode = "running"
    @Published private(set) var workoutDistance: Double?
    @Published private(set) var workoutAverageCadence: Int?
    @Published private(set) var isReachable = false
    @Published private(set) var sessionStatus = "iPhone未接続"
    @Published private(set) var outputSettings = TempoOutputSettings.load()
    @Published private(set) var previewRequestID: UUID?

    private let session: WCSession
    private var outputRevision = UserDefaults.standard.double(forKey: "runwave.receivedOutputRevision")
    private var lastTargetIssuedAt = UserDefaults.standard.double(forKey: "runwave.receivedTargetIssuedAt")
    private var accumulatedWorkoutTime: TimeInterval = 0
    private var workoutStartedAt: Date?

    override convenience init() {
        self.init(session: .default)
    }

    init(session: WCSession) {
        self.session = session
        super.init()
        guard WCSession.isSupported() else { return }
        session.delegate = self
        session.activate()
    }

    private func receive(_ payload: [String: Any]) {
        guard let type = payload["type"] as? String else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch type {
            case "outputSettings", "outputPreview":
                guard let settings = TempoOutputSettings(payload: payload),
                      let revision = payload["revision"] as? Double,
                      revision.isFinite, revision >= self.outputRevision else { return }
                self.outputSettings = settings
                self.outputRevision = revision
                settings.save()
                UserDefaults.standard.set(revision, forKey: "runwave.receivedOutputRevision")
                self.acknowledgeOutputSettings()
                if type == "outputPreview", let requestedAt = payload["requestedAt"] as? Double,
                   abs(Date().timeIntervalSince1970 - requestedAt) < 10 {
                    if let cadence = payload["targetCadence"] as? Int {
                        let mode = payload["activityMode"] as? String ?? self.activityMode
                        self.activityMode = mode
                        self.targetCadence = Self.normalizedCadence(cadence, mode: mode)
                        self.guidedCadence = Self.normalizedCadence(payload["guidedCadence"] as? Int ?? cadence, mode: mode)
                        self.cadenceBaseline = payload["cadenceBaseline"] as? Int ?? cadence
                        self.cadenceAdjustment = payload["cadenceAdjustment"] as? Int ?? (cadence - self.cadenceBaseline)
                    }
                    self.previewRequestID = UUID()
                }
            case "target":
                if let value = payload["targetCadence"] as? Int {
                    if let issuedAt = payload["issuedAt"] as? Double {
                        // WCSession may deliver an older queued snapshot after a newer live update.
                        guard issuedAt > self.lastTargetIssuedAt else { return }
                        self.lastTargetIssuedAt = issuedAt
                        UserDefaults.standard.set(issuedAt, forKey: "runwave.receivedTargetIssuedAt")
                    }
                    let mode = payload["activityMode"] as? String ?? self.activityMode
                    self.activityMode = mode
                    self.targetCadence = Self.normalizedCadence(value, mode: mode)
                    self.guidedCadence = Self.normalizedCadence(payload["guidedCadence"] as? Int ?? value, mode: mode)
                    self.cadenceBaseline = payload["cadenceBaseline"] as? Int ?? value
                    self.cadenceAdjustment = payload["cadenceAdjustment"] as? Int ?? (value - self.cadenceBaseline)
                }
            case "workoutStart":
                self.accumulatedWorkoutTime = 0
                self.workoutStartedAt = Date()
                self.workoutDistance = nil
                self.workoutAverageCadence = nil
                self.sessionStatus = "セッション実行中"
                self.sessionState = .running
            case "workoutPause":
                self.freezeWorkoutClock()
                self.sessionStatus = "一時停止中"
                self.sessionState = .paused
            case "workoutResume":
                self.workoutStartedAt = Date()
                self.sessionStatus = "セッション実行中"
                self.sessionState = .running
            case "workoutEnd":
                self.freezeWorkoutClock()
                if let elapsed = payload["elapsed"] as? Double { self.accumulatedWorkoutTime = elapsed }
                self.workoutDistance = payload["distance"] as? Double
                self.workoutAverageCadence = payload["averageCadence"] as? Int
                if let mode = payload["activityMode"] as? String { self.activityMode = mode }
                self.sessionStatus = "セッション終了"
                self.sessionState = .ended
            default: break
            }
        }
    }

    private static func normalizedCadence(_ value: Int, mode: String) -> Int {
        let lowerBound = mode == "walking" ? 80 : 110
        let upperBound = mode == "walking" ? 140 : 190
        return min(max(value, lowerBound), upperBound)
    }

    func adjustTargetCadence(by delta: Int) {
        let lowerBound = activityMode == "walking" ? 80 : 110
        let upperBound = activityMode == "walking" ? 140 : 190
        let nextAdjustment = cadenceAdjustment + delta
        let updated = min(max(cadenceBaseline + nextAdjustment, lowerBound), upperBound)
        guard updated != targetCadence else { return }
        let guidanceOffset = guidedCadence - targetCadence
        guidedCadence = min(max(updated + guidanceOffset, lowerBound), upperBound)
        targetCadence = updated
        // Store the applied offset, not an unclamped value, or further crown
        // adjustments can drift past the activity's lower/upper limits.
        cadenceAdjustment = updated - cadenceBaseline
        sendToPhone([
            "type": "targetAdjust",
            "delta": delta
        ])
    }

    func elapsed(at now: Date) -> TimeInterval {
        guard let workoutStartedAt else { return accumulatedWorkoutTime }
        return accumulatedWorkoutTime + max(0, now.timeIntervalSince(workoutStartedAt))
    }

    private func freezeWorkoutClock() {
        if let started = workoutStartedAt {
            accumulatedWorkoutTime += max(0, Date().timeIntervalSince(started))
        }
        workoutStartedAt = nil
    }

    func endWorkout() {
        guard sessionState == .running || sessionState == .paused else { return }
        freezeWorkoutClock()
        sessionStatus = "セッション終了"
        sessionState = .ended
        var payload: [String: Any] = [
            "type": "workoutEnd",
            "elapsed": accumulatedWorkoutTime,
            "activityMode": activityMode
        ]
        if let workoutDistance { payload["distance"] = workoutDistance }
        if let workoutAverageCadence { payload["averageCadence"] = workoutAverageCadence }
        sendToPhone(payload)
    }

    func dismissSummary() {
        guard sessionState == .ended else { return }
        sessionState = .idle
        sessionStatus = isReachable ? "待機中" : "iPhone未接続"
        accumulatedWorkoutTime = 0
        workoutDistance = nil
        workoutAverageCadence = nil
    }

    func toggleWorkoutPause() {
        let action: String
        if sessionState == .running {
            action = "pause"
            sessionState = .paused
            sessionStatus = "一時停止中"
        } else if sessionState == .paused {
            action = "resume"
            sessionState = .running
            sessionStatus = "セッション実行中"
        } else {
            return
        }
        sendToPhone(["type": action == "pause" ? "workoutPause" : "workoutResume"])
    }

    private func sendToPhone(_ payload: [String: Any]) {
        guard session.activationState == .activated else { return }
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil) { [weak self] _ in
                self?.session.transferUserInfo(payload)
            }
        } else {
            session.transferUserInfo(payload)
        }
    }

    private func updateReachability() {
        let reachable = session.activationState == .activated && session.isReachable
        DispatchQueue.main.async { [weak self] in
            self?.isReachable = reachable
            if reachable { self?.acknowledgeOutputSettings() }
        }
    }

    private func acknowledgeOutputSettings() {
        guard session.activationState == .activated, session.isReachable else { return }
        let payload = outputSettings.payload.merging([
            "type": "outputSettingsApplied", "revision": outputRevision
        ]) { _, new in new }
        session.sendMessage(payload, replyHandler: nil, errorHandler: nil)
    }

    func requestGoalSetup(activityMode: String) {
        guard session.activationState == .activated, session.isReachable else {
            sessionStatus = "iPhoneでRUNWAVEを開いてください"
            return
        }
        sessionStatus = "iPhoneで目的地を設定してください"
        session.sendMessage([
            "type": "goalSetupRequest",
            "activityMode": activityMode
        ], replyHandler: nil) { [weak self] _ in
            DispatchQueue.main.async {
                self?.sessionStatus = "iPhoneでRUNWAVEを開き直してください"
            }
        }
    }

    func reportOutputError(_ message: String) {
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage([
            "type": "outputError", "message": message, "revision": outputRevision
        ], replyHandler: nil, errorHandler: nil)
    }

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        updateReachability()
        receive(session.receivedApplicationContext)
    }

    func sessionReachabilityDidChange(_ session: WCSession) { updateReachability() }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) { receive(message) }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) { receive(userInfo) }
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) { receive(applicationContext) }
}
