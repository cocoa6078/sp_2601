import Foundation

/// 最新の経路案内をiPhoneからWatchへ送る。古いセッションの案内は混在させない。
struct WatchRouteGuidance {
    let sessionID: String
    let instruction: String
    let symbol: String
    let maneuverDistance: Double?
    let remainingDistance: Double?
    let issuedAt: TimeInterval
    let isOffRoute: Bool
    let isRecalculating: Bool

    var payload: [String: Any] {
        var value: [String: Any] = [
            "type": "navigation", "sessionID": sessionID,
            "instruction": instruction, "symbol": symbol, "issuedAt": issuedAt,
            "offRoute": isOffRoute, "recalculating": isRecalculating
        ]
        if let maneuverDistance { value["maneuverDistance"] = maneuverDistance }
        if let remainingDistance { value["remainingDistance"] = remainingDistance }
        return value
    }

    init(sessionID: String, instruction: String, symbol: String, maneuverDistance: Double?, remainingDistance: Double?, issuedAt: TimeInterval, isOffRoute: Bool, isRecalculating: Bool) {
        self.sessionID = sessionID
        self.instruction = instruction
        self.symbol = symbol
        self.maneuverDistance = maneuverDistance
        self.remainingDistance = remainingDistance
        self.issuedAt = issuedAt
        self.isOffRoute = isOffRoute
        self.isRecalculating = isRecalculating
    }

    init?(payload: [String: Any]) {
        guard let sessionID = payload["sessionID"] as? String, UUID(uuidString: sessionID) != nil,
              let instruction = payload["instruction"] as? String,
              let symbol = payload["symbol"] as? String,
              let issuedAt = payload["issuedAt"] as? Double, issuedAt.isFinite else { return nil }
        func distance(_ key: String) -> Double? {
            guard let value = payload[key] as? Double, value.isFinite, value >= 0 else { return nil }
            return value
        }
        self.init(sessionID: sessionID, instruction: instruction, symbol: symbol,
                  maneuverDistance: distance("maneuverDistance"), remainingDistance: distance("remainingDistance"),
                  issuedAt: issuedAt, isOffRoute: payload["offRoute"] as? Bool ?? false,
                  isRecalculating: payload["recalculating"] as? Bool ?? false)
    }
}
