import Foundation
import WatchConnectivity

/// iPhone とペアリング済み Apple Watch の間をサーバーなしでつなぐ。
final class WatchConnectivityLink: NSObject, WatchLink, WCSessionDelegate {
    private let session: WCSession
    private(set) var connectionState: WatchConnectionState = .notConnected
    var onMetrics: ((WatchMetrics) -> Void)?
    var onConnectionChange: ((WatchConnectionState) -> Void)?
    var onGoalSetupRequested: ((String?) -> Void)?
    var onWorkoutControl: ((String) -> Void)?
    var onTargetCadenceChange: ((Int) -> Void)?
    var onOutputSettingsApplied: ((TempoOutputSettings) -> Void)?
    var onOutputError: ((String) -> Void)?
    private var outputSettings = TempoOutputSettings.load()
    private var outputRevision = UserDefaults.standard.double(forKey: "runwave.outputRevision")
    private var pendingPayloads: [[String: Any]] = []
    private var latestNavigationPayload: [String: Any]?
    private var latestClockPayload: [String: Any]?
    private var lastCrownSessionStartedAt = UserDefaults.standard.double(forKey: "runwave.lastCrownSessionStartedAt")
    private var lastCrownSessionID = UserDefaults.standard.string(forKey: "runwave.lastCrownSessionID") ?? ""
    private var lastCrownSequence = UserDefaults.standard.integer(forKey: "runwave.lastCrownSequence")
    private var lastCrownIssuedAt = UserDefaults.standard.double(forKey: "runwave.lastCrownIssuedAt")

    private enum Key {
        static let type = "type"
        static let target = "targetCadence"
        static let mode = "mode"
        static let issuedAt = "issuedAt"
        static let sessionID = "sessionID"
    }

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

    func send(_ command: TargetCommand) {
        send([
            Key.type: "target",
            Key.target: command.targetCadence,
            Key.mode: command.mode.rawValue,
            "activityMode": command.activityMode.rawValue,
            "cadenceBaseline": command.cadenceBaseline,
            "cadenceAdjustment": command.cadenceAdjustment,
            "guidedCadence": command.guidedCadence ?? command.targetCadence,
            Key.issuedAt: command.issuedAt.timeIntervalSince1970,
            Key.sessionID: command.sessionID.uuidString
        ])
    }

    func workoutDidStart(sessionID: UUID, activityMode: ActivityMode) {
        send([Key.type: "workoutStart", Key.sessionID: sessionID.uuidString, "activityMode": activityMode.rawValue])
    }

    func updateNavigation(_ guidance: WatchRouteGuidance) {
        latestNavigationPayload = guidance.payload
        guard session.activationState == .activated else { return }
        try? updateSnapshot([:])
        if session.isReachable {
            // 経路案内は最新版だけを使う。過去の曲がり角をキューへ積まない。
            session.sendMessage(guidance.payload, replyHandler: nil, errorHandler: nil)
        }
    }

    func updateWorkoutClock(_ snapshot: WorkoutClockSnapshot) {
        latestClockPayload = snapshot.payload
        guard session.activationState == .activated else { return }
        try? updateSnapshot([:])
        if session.isReachable {
            session.sendMessage(snapshot.payload, replyHandler: nil, errorHandler: nil)
        }
    }

    private func updateSnapshot(_ payload: [String: Any]) throws {
        var snapshot = session.applicationContext
        snapshot.merge(payload) { _, new in new }
        if snapshot[Key.type] == nil { snapshot[Key.type] = "navigationSnapshot" }
        if let latestNavigationPayload { snapshot["navigationGuidance"] = latestNavigationPayload }
        if let latestClockPayload { snapshot["workoutClock"] = latestClockPayload }
        try session.updateApplicationContext(snapshot)
    }
    func workoutDidPause() { send([Key.type: "workoutPause"]) }
    func workoutDidResume() { send([Key.type: "workoutResume"]) }
    func workoutDidReachGoal(distanceToGoal: Double) {
        send([Key.type: "goalApproach", "distanceToGoal": distanceToGoal])
    }
    func workoutDidContinueAfterGoal() { send([Key.type: "goalContinue"]) }
    func workoutDidEnd(elapsed: TimeInterval, distance: Double?, averageCadence: Int?, activityMode: ActivityMode) {
        var payload: [String: Any] = [
            Key.type: "workoutEnd",
            "elapsed": elapsed,
            "activityMode": activityMode.rawValue
        ]
        if let distance { payload["distance"] = distance }
        if let averageCadence { payload["averageCadence"] = averageCadence }
        send(payload)
    }

    func updateOutputSettings(_ settings: TempoOutputSettings) {
        if settings != outputSettings || outputRevision == 0 {
            outputSettings = settings
            outputRevision = max(Date().timeIntervalSince1970, outputRevision + 0.001)
            UserDefaults.standard.set(outputRevision, forKey: "runwave.outputRevision")
        }
        pushOutputSettings()
    }

    private var outputPayload: [String: Any] {
        outputSettings.payload.merging([Key.type: "outputSettings", "revision": outputRevision]) { _, new in new }
    }

    private func pushOutputSettings() {
        guard session.activationState == .activated else { return }
        do {
            // Keep just the newest settings when the Watch is temporarily unavailable.
            try updateSnapshot(outputPayload)
        } catch {
            DispatchQueue.main.async { [weak self] in self?.onOutputError?("Watchへの設定保存に失敗しました") }
        }
        if session.isReachable {
            session.sendMessage(outputPayload, replyHandler: nil) { _ in
                // The application context remains queued for the next connection.
            }
        }
    }

    func previewOutput(targetCadence: Int, activityMode: ActivityMode) {
        guard session.activationState == .activated, session.isReachable else { return }
        let upperBound = activityMode == .walking ? 140 : 190
        let payload = outputPayload.merging([
            Key.type: "outputPreview", "requestedAt": Date().timeIntervalSince1970,
            Key.target: min(max(targetCadence, activityMode == .walking ? 80 : 110), upperBound),
            "activityMode": activityMode.rawValue
        ]) { _, new in new }
        // A preview is never queued: it must not unexpectedly play after a later reconnect.
        session.sendMessage(payload, replyHandler: nil) { [weak self] _ in
            DispatchQueue.main.async { self?.onOutputError?("Watchを開いて、もう一度お試しください") }
        }
    }

    private func send(_ originalPayload: [String: Any]) {
        var payload = originalPayload
        if payload[Key.issuedAt] == nil { payload[Key.issuedAt] = Date().timeIntervalSince1970 }
        guard WCSession.isSupported() else { return }
        guard session.activationState == .activated else {
            pendingPayloads.append(payload)
            return
        }
        // Retain the newest cadence as a state snapshot so it is available after reconnection.
        if payload[Key.type] as? String == "target" {
            do {
                try updateSnapshot(payload)
            } catch {
                DispatchQueue.main.async { [weak self] in
                    self?.onOutputError?("Watchへ目標ケイデンスを保存できませんでした")
                }
            }
        }
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil) { [weak self] _ in
                self?.session.transferUserInfo(payload)
            }
        } else {
            session.transferUserInfo(payload)
        }
    }

    private func refreshConnectionState() {
        let next: WatchConnectionState
        if session.activationState != .activated {
            next = .notConnected
        } else if !session.isPaired {
            next = .notPaired
        } else if !session.isWatchAppInstalled {
            next = .watchAppNotInstalled
        } else if session.isReachable {
            next = .connected
        } else {
            next = .waitingForReachability
        }
        guard next != connectionState else { return }
        connectionState = next
        DispatchQueue.main.async { [weak self] in self?.onConnectionChange?(next) }
    }

    private func receive(_ message: [String: Any]) {
        if message[Key.type] as? String == "goalSetupRequest" {
            let mode = message["activityMode"] as? String
            DispatchQueue.main.async { [weak self] in self?.onGoalSetupRequested?(mode) }
            return
        }
        if message[Key.type] as? String == "workoutPause" {
            DispatchQueue.main.async { [weak self] in self?.onWorkoutControl?("pause") }
            return
        }
        if message[Key.type] as? String == "workoutResume" {
            DispatchQueue.main.async { [weak self] in self?.onWorkoutControl?("resume") }
            return
        }
        if message[Key.type] as? String == "workoutEnd" {
            DispatchQueue.main.async { [weak self] in self?.onWorkoutControl?("end") }
            return
        }
        if message[Key.type] as? String == "targetSet",
           let cadence = message[Key.target] as? Int,
           let issuedAt = message["crownIssuedAt"] as? Double {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard issuedAt > self.lastCrownIssuedAt else { return }
                self.lastCrownIssuedAt = issuedAt
                UserDefaults.standard.set(issuedAt, forKey: "runwave.lastCrownIssuedAt")
                self.onTargetCadenceChange?(cadence)
            }
            return
        }
        if message[Key.type] as? String == "outputSettingsApplied",
           let settings = TempoOutputSettings(payload: message),
           message["revision"] as? Double == outputRevision,
           settings == outputSettings {
            DispatchQueue.main.async { [weak self] in self?.onOutputSettingsApplied?(settings) }
            return
        }
        if message[Key.type] as? String == "outputError",
           message["revision"] as? Double == outputRevision,
           let text = message["message"] as? String {
            DispatchQueue.main.async { [weak self] in self?.onOutputError?(text) }
            return
        }
        guard message[Key.type] as? String == "metrics" else { return }
        let metrics = WatchMetrics(
            currentCadence: message["currentCadence"] as? Int,
            heartRate: message["heartRate"] as? Int,
            distance: message["distance"] as? Double,
            averageCadence: message["averageCadence"] as? Int,
            receivedAt: Date(timeIntervalSince1970: message["receivedAt"] as? Double ?? Date().timeIntervalSince1970)
        )
        DispatchQueue.main.async { [weak self] in self?.onMetrics?(metrics) }
    }

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        let queued = pendingPayloads
        pendingPayloads.removeAll()
        queued.forEach(send)
        pushOutputSettings()
        refreshConnectionState()
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        pushOutputSettings()
        refreshConnectionState()
    }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) { receive(message) }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        receive(message)
        if message[Key.type] as? String == "targetSet" {
            replyHandler(["type": "targetSetAck", Key.target: message[Key.target] ?? 0])
        } else {
            replyHandler(["type": "ack"])
        }
    }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) { receive(userInfo) }
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) { receive(applicationContext) }

    func sessionDidBecomeInactive(_ session: WCSession) { refreshConnectionState() }
    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
        refreshConnectionState()
    }
}
