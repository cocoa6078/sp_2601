import Foundation

enum TempoOutputMode: String, Codable, CaseIterable, Identifiable {
    case haptic, audio, iphoneAudio, off
    var id: String { rawValue }
    var label: String {
        switch self {
        case .haptic: return "振動"
        case .audio: return "音"
        case .iphoneAudio: return "iPhone音"
        case .off: return "停止"
        }
    }
}

enum TempoHapticStyle: String, Codable, CaseIterable, Identifiable {
    case normal, doubleTap
    var id: String { rawValue }
    var label: String {
        switch self {
        case .normal: return "通常（1回）"
        case .doubleTap: return "くっきり（2連）"
        }
    }
}

/// One wire format shared by the iPhone and Watch targets.
struct TempoOutputSettings: Codable, Hashable {
    var mode: TempoOutputMode = .haptic
    var hapticStyle: TempoHapticStyle = .normal
    var volume: Double = 0.7
    var sound: TempoSound = .beep

    private enum CodingKeys: String, CodingKey { case mode, hapticStyle, volume, sound }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        mode = try values.decode(TempoOutputMode.self, forKey: .mode)
        hapticStyle = try values.decode(TempoHapticStyle.self, forKey: .hapticStyle)
        volume = try values.decode(Double.self, forKey: .volume)
        // 既存の設定データには音色がない。音量・出力先を維持したまま移行する。
        sound = try values.decodeIfPresent(TempoSound.self, forKey: .sound) ?? .beep
    }

    private static let storageKey = "runwave.tempoOutputSettings.v1"

    static func load() -> Self {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              var value = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        value.volume = value.volume.isFinite ? min(max(value.volume, 0), 1) : 0.7
        return value
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
    }

    var payload: [String: Any] {
        ["outputMode": mode.rawValue, "hapticStyle": hapticStyle.rawValue, "audioVolume": volume, "audioSound": sound.rawValue]
    }

    init() {}

    init?(payload: [String: Any]) {
        guard let modeString = payload["outputMode"] as? String,
              let mode = TempoOutputMode(rawValue: modeString),
              let styleString = payload["hapticStyle"] as? String,
              let style = TempoHapticStyle(rawValue: styleString),
              let volume = payload["audioVolume"] as? Double,
              volume.isFinite else { return nil }
        self.mode = mode
        self.hapticStyle = style
        self.volume = min(max(volume, 0), 1)
        self.sound = (payload["audioSound"] as? String).flatMap(TempoSound.init(rawValue:)) ?? .beep
    }
}
