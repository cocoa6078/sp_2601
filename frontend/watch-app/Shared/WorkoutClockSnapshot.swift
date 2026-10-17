import Foundation

/// 経過時間の基準点。通信の到着時刻ではなくiPhoneの開始時刻から計算する。
struct WorkoutClockSnapshot {
    let sessionID: String
    let state: String
    let activityMode: String
    let accumulated: TimeInterval
    let startedAt: TimeInterval?
    let issuedAt: TimeInterval

    func elapsed(at date: Date) -> TimeInterval {
        accumulated + (startedAt.map { max(0, date.timeIntervalSince1970 - $0) } ?? 0)
    }

    var payload: [String: Any] {
        var value: [String: Any] = [
            "type": "workoutClock", "sessionID": sessionID, "state": state,
            "activityMode": activityMode, "accumulated": accumulated, "issuedAt": issuedAt
        ]
        if let startedAt { value["startedAt"] = startedAt }
        return value
    }

    init(sessionID: String, state: String, activityMode: String, accumulated: TimeInterval, startedAt: TimeInterval?, issuedAt: TimeInterval) {
        self.sessionID = sessionID
        self.state = state
        self.activityMode = activityMode
        self.accumulated = accumulated
        self.startedAt = startedAt
        self.issuedAt = issuedAt
    }

    init?(payload: [String: Any]) {
        guard let sessionID = payload["sessionID"] as? String, UUID(uuidString: sessionID) != nil,
              let state = payload["state"] as? String, ["running", "paused", "goalReached", "ended"].contains(state),
              let activityMode = payload["activityMode"] as? String,
              let accumulated = payload["accumulated"] as? Double, accumulated.isFinite, accumulated >= 0,
              let issuedAt = payload["issuedAt"] as? Double, issuedAt.isFinite else { return nil }
        let startedAt = payload["startedAt"] as? Double
        guard startedAt?.isFinite != false,
              !(state == "running" || state == "goalReached") || startedAt != nil else { return nil }
        self.init(sessionID: sessionID, state: state, activityMode: activityMode,
                  accumulated: accumulated, startedAt: startedAt, issuedAt: issuedAt)
    }
}
