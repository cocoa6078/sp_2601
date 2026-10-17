import Foundation
import WatchConnectivity

/// iPhone とペアリング済み Apple Watch の間をサーバーなしでつなぐ。
final class WatchConnectivityLink: NSObject, WatchLink, WCSessionDelegate {
    private let session: WCSession
    private(set) var connectionState: WatchConnectionState = .notConnected
    var onMetrics: ((WatchMetrics) -> Void)?
    var onConnectionChange: ((WatchConnectionState) -> Void)?

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
            Key.issuedAt: command.issuedAt.timeIntervalSince1970,
            Key.sessionID: command.sessionID.uuidString
        ])
    }

    func workoutDidStart(sessionID: UUID) { send([Key.type: "workoutStart", Key.sessionID: sessionID.uuidString]) }
    func workoutDidPause() { send([Key.type: "workoutPause"]) }
    func workoutDidResume() { send([Key.type: "workoutResume"]) }
    func workoutDidEnd() { send([Key.type: "workoutEnd"]) }

    private func send(_ payload: [String: Any]) {
        guard WCSession.isSupported(), session.activationState == .activated else { return }
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil) { [weak self] _ in
                self?.session.transferUserInfo(payload)
            }
        } else {
            session.transferUserInfo(payload)
        }
    }

    private func refreshConnectionState() {
        let next: WatchConnectionState = session.activationState == .activated && session.isReachable
            ? .connected : .notConnected
        guard next != connectionState else { return }
        connectionState = next
        DispatchQueue.main.async { [weak self] in self?.onConnectionChange?(next) }
    }

    private func receive(_ message: [String: Any]) {
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
        refreshConnectionState()
    }

    func sessionReachabilityDidChange(_ session: WCSession) { refreshConnectionState() }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) { receive(message) }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) { receive(userInfo) }
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) { receive(applicationContext) }

    func sessionDidBecomeInactive(_ session: WCSession) { refreshConnectionState() }
    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
        refreshConnectionState()
    }
}
