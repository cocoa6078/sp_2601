import Combine
import Foundation
import WatchConnectivity

/// iPhone から届く目標値とセッション操作を Watch アプリに反映する。
final class WatchConnectivityManager: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var targetCadence = 160
    @Published private(set) var isReachable = false
    @Published private(set) var sessionStatus = "iPhone未接続"

    private let session: WCSession

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
            case "target":
                if let value = payload["targetCadence"] as? Int {
                    self.targetCadence = min(max(value, 120), 190)
                }
            case "workoutStart": self.sessionStatus = "セッション実行中"
            case "workoutPause": self.sessionStatus = "一時停止中"
            case "workoutResume": self.sessionStatus = "セッション実行中"
            case "workoutEnd": self.sessionStatus = "セッション終了"
            default: break
            }
        }
    }

    private func updateReachability() {
        let reachable = session.activationState == .activated && session.isReachable
        DispatchQueue.main.async { [weak self] in self?.isReachable = reachable }
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
