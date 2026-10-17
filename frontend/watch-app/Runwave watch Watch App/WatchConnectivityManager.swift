import Combine
import Foundation
import WatchConnectivity

/// iPhone から届く目標値とセッション操作を Watch アプリに反映する。
final class WatchConnectivityManager: NSObject, ObservableObject, WCSessionDelegate {
    enum SessionState {
        case idle, running, paused, ended
    }

    @Published private(set) var sessionState: SessionState = .idle
    @Published private(set) var targetCadence = 160
    @Published private(set) var isReachable = false
    @Published private(set) var sessionStatus = "iPhone未接続"
    @Published private(set) var outputSettings = TempoOutputSettings.load()
    @Published private(set) var previewRequestID: UUID?

    private let session: WCSession
    private var outputRevision = UserDefaults.standard.double(forKey: "runwave.receivedOutputRevision")

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
                        self.targetCadence = Self.normalizedCadence(cadence)
                    }
                    self.previewRequestID = UUID()
                }
            case "target":
                if let value = payload["targetCadence"] as? Int {
                    self.targetCadence = Self.normalizedCadence(value)
                }
            case "workoutStart":
                self.sessionStatus = "セッション実行中"
                self.sessionState = .running
            case "workoutPause":
                self.sessionStatus = "一時停止中"
                self.sessionState = .paused
            case "workoutResume":
                self.sessionStatus = "セッション実行中"
                self.sessionState = .running
            case "workoutEnd":
                self.sessionStatus = "セッション終了"
                self.sessionState = .ended
            default: break
            }
        }
    }

    private static func normalizedCadence(_ value: Int) -> Int {
        let bounded = min(max(value, 120), 190)
        return min(max(Int((Double(bounded) / 5).rounded()) * 5, 120), 190)
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
