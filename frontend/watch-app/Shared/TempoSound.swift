import Foundation

enum TempoSound: String, Codable, CaseIterable, Identifiable {
    case beep, click, wood, bell
    var id: String { rawValue }
    var label: String {
        switch self {
        case .beep: "ビープ"
        case .click: "クリック"
        case .wood: "ウッド"
        case .bell: "ベル"
        }
    }

    /// 両端末で同じ短い音を使う。1拍分のループを作る処理と形式を統一する。
    func wavData() throws -> Data {
        if self == .beep {
            guard let url = Bundle.main.url(forResource: "tempo-tick", withExtension: "wav") else {
                throw CocoaError(.fileNoSuchFile)
            }
            return try Data(contentsOf: url)
        }
        let sampleRate = 22_050
        let duration = self == .click ? 0.025 : (self == .wood ? 0.065 : 0.14)
        let count = Int(Double(sampleRate) * duration)
        var pcm = Data(capacity: count * 2)
        var seed: UInt32 = 17
        for frame in 0..<count {
            let t = Double(frame) / Double(sampleRate)
            let attack = min(1, t / 0.0015)
            let release = min(1, (duration - t) / 0.005)
            let wave: Double
            switch self {
            case .click:
                seed = seed &* 1_664_525 &+ 1_013_904_223
                let noise = Double(seed) / Double(UInt32.max) * 2 - 1
                wave = noise * exp(-t * 230)
            case .wood:
                wave = (sin(2 * .pi * 760 * t) + 0.35 * sin(2 * .pi * 1_630 * t)) * exp(-t * 70) / 1.35
            case .bell:
                wave = (sin(2 * .pi * 1_046.5 * t) + 0.3 * sin(2 * .pi * 2_810 * t)) * exp(-t * 24) / 1.3
            case .beep: wave = 0
            }
            pcm.appendSoundInteger(Int16((wave * attack * release * 0.7 * Double(Int16.max)).rounded()))
        }
        var wav = Data()
        wav.append(contentsOf: "RIFF".utf8); wav.appendSoundInteger(UInt32(36 + pcm.count))
        wav.append(contentsOf: "WAVEfmt ".utf8); wav.appendSoundInteger(UInt32(16))
        wav.appendSoundInteger(UInt16(1)); wav.appendSoundInteger(UInt16(1))
        wav.appendSoundInteger(UInt32(sampleRate)); wav.appendSoundInteger(UInt32(sampleRate * 2))
        wav.appendSoundInteger(UInt16(2)); wav.appendSoundInteger(UInt16(16))
        wav.append(contentsOf: "data".utf8); wav.appendSoundInteger(UInt32(pcm.count))
        wav.append(pcm)
        return wav
    }
}

private extension Data {
    mutating func appendSoundInteger<T: FixedWidthInteger>(_ value: T) {
        var encoded = value.littleEndian
        Swift.withUnsafeBytes(of: &encoded) { append(contentsOf: $0) }
    }
}
