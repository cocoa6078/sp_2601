import AVFoundation
import Combine
import Foundation
import WatchKit

struct TempoPlaybackConfiguration: Hashable {
    var cadence: Int
    var settings: TempoOutputSettings
    var previewID: UUID?
    var activityMode: String
}

/// Watchのテンポ音と振動を管理する。ワークアウト中の音は周期音声として再生し、消灯中も継続する。
@MainActor
final class TempoOutputPlayer: ObservableObject {
    @Published private(set) var isPlaying = false
    @Published private(set) var errorMessage: String?
    private var generation = UUID()
    private var backgroundAudioGeneration = UUID()
    private var activeConfiguration: TempoPlaybackConfiguration?
    private var backgroundAudioPlayer: AVAudioPlayer?

    func updateConfiguration(_ configuration: TempoPlaybackConfiguration?) {
        let previous = activeConfiguration
        activeConfiguration = configuration
        guard let configuration,
              configuration.settings.mode == .audio,
              configuration.previewID == nil else {
            backgroundAudioGeneration = UUID()
            backgroundAudioPlayer?.stop()
            backgroundAudioPlayer = nil
            if previous?.settings.mode == .audio {
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
            return
        }
        guard previous?.cadence != configuration.cadence
                || previous?.settings.sound != configuration.settings.sound
                || previous?.settings.volume != configuration.settings.volume
                || backgroundAudioPlayer?.isPlaying != true else { return }
        let token = UUID()
        backgroundAudioGeneration = token
        Task { await startBackgroundAudio(configuration, previous: previous, token: token) }
    }

    func run(_ configuration: TempoPlaybackConfiguration) async {
        let token = UUID()
        generation = token
        updateConfiguration(configuration)
        errorMessage = nil

        // Let the media player continue its loop even if SwiftUI cancels this task while the display dims.
        if configuration.settings.mode == .audio, configuration.previewID == nil {
            isPlaying = backgroundAudioPlayer?.isPlaying == true
            defer { if generation == token { isPlaying = false } }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3600))
                if Task.isCancelled { break }
            }
            return
        }

        let initialSettings = configuration.settings
        let audioSession = AVAudioSession.sharedInstance()
        var previewPlayer: AVAudioPlayer?
        defer {
            previewPlayer?.stop()
            if generation == token {
                isPlaying = false
                backgroundAudioPlayer?.stop()
                backgroundAudioPlayer = nil
                if initialSettings.mode == .audio {
                    try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                }
            }
        }

        if initialSettings.mode == .audio {
            do {
                let data = try initialSettings.sound.wavData()
                try audioSession.setCategory(.playback, mode: .default, policy: .default, options: [.mixWithOthers])
                try audioSession.setActive(true)
                let prepared = try AVAudioPlayer(data: data)
                prepared.volume = Float(initialSettings.volume)
                guard prepared.prepareToPlay() else { throw CocoaError(.fileReadUnknown) }
                previewPlayer = prepared
            } catch {
                if generation == token { errorMessage = "音を再生できません：\(error.localizedDescription)" }
                return
            }
        } else {
            backgroundAudioPlayer?.stop()
            backgroundAudioPlayer = nil
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        }

        guard !Task.isCancelled, initialSettings.mode != .off else { return }
        isPlaying = true
        let clock = ContinuousClock()
        var nextBeat = clock.now
        var beats = 0

        do {
            while !Task.isCancelled {
                guard let currentConfiguration = activeConfiguration else { return }
                let settings = currentConfiguration.settings
                switch settings.mode {
                case .haptic:
                    WKInterfaceDevice.current().play(.click)
                    if settings.hapticStyle == .doubleTap {
                        try await clock.sleep(until: nextBeat.advanced(by: .milliseconds(120)))
                        try Task.checkCancellation()
                        WKInterfaceDevice.current().play(.click)
                    }
                case .audio:
                    previewPlayer?.volume = Float(settings.volume)
                    previewPlayer?.currentTime = 0
                    guard previewPlayer?.play() == true else {
                        errorMessage = "音の試聴を再生できません。音を選び直してください。"
                        return
                    }
                case .off, .iphoneAudio:
                    return
                }

                beats += 1
                if currentConfiguration.previewID != nil, beats >= 3 {
                    try await clock.sleep(for: .milliseconds(100))
                    return
                }
                let lowerBound = currentConfiguration.activityMode == "walking" ? 80 : 110
                let upperBound = currentConfiguration.activityMode == "walking" ? 140 : 190
                let cadence = min(max(currentConfiguration.cadence, lowerBound), upperBound)
                let interval = Duration.seconds(60.0 / Double(cadence))
                nextBeat += interval
                if nextBeat <= clock.now { nextBeat = clock.now.advanced(by: interval) }
                try await clock.sleep(until: nextBeat)
            }
        } catch {
            // 一時停止や出力先切り替え時は試聴音・振動を止める。
        }
    }

    private func startBackgroundAudio(
        _ configuration: TempoPlaybackConfiguration,
        previous: TempoPlaybackConfiguration?,
        token: UUID
    ) async {
        do {
            let source = try configuration.settings.sound.wavData()
            let sampleRate = 22_050
            guard source.count > 44 else { throw CocoaError(.fileReadCorruptFile) }
            let tick = source.subdata(in: 44..<source.count)
            let frames = max(tick.count / 2, Int((Double(sampleRate) * 60 / Double(max(1, configuration.cadence))).rounded()))
            let firstBeatDelay: TimeInterval
            if let previous, let backgroundAudioPlayer, backgroundAudioPlayer.isPlaying {
                let oldInterval = 60.0 / Double(max(1, previous.cadence))
                let phase = backgroundAudioPlayer.currentTime.truncatingRemainder(dividingBy: oldInterval)
                firstBeatDelay = max(0, oldInterval - phase)
            } else {
                firstBeatDelay = 0
            }
            let firstFrame = min(max(0, Int((firstBeatDelay * Double(sampleRate)).rounded())), frames - tick.count / 2)
            var samples = Data(count: frames * 2)
            samples.replaceSubrange((firstFrame * 2)..<(firstFrame * 2 + tick.count), with: tick)
            var wav = Data()
            wav.append(contentsOf: Array("RIFF".utf8)); wav.appendLittleEndian(UInt32(36 + samples.count))
            wav.append(contentsOf: Array("WAVEfmt ".utf8)); wav.appendLittleEndian(UInt32(16))
            wav.appendLittleEndian(UInt16(1)); wav.appendLittleEndian(UInt16(1))
            wav.appendLittleEndian(UInt32(sampleRate)); wav.appendLittleEndian(UInt32(sampleRate * 2))
            wav.appendLittleEndian(UInt16(2)); wav.appendLittleEndian(UInt16(16))
            wav.append(contentsOf: Array("data".utf8)); wav.appendLittleEndian(UInt32(samples.count))
            wav.append(samples)

            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, policy: .longFormAudio, options: [.mixWithOthers])
            try await session.activate()
            guard backgroundAudioGeneration == token, activeConfiguration == configuration else { return }
            let replacement = try AVAudioPlayer(data: wav)
            replacement.numberOfLoops = -1
            replacement.volume = Float(min(max(configuration.settings.volume, 0), 1))
            guard replacement.prepareToPlay() else { throw CocoaError(.fileReadUnknown) }
            backgroundAudioPlayer?.stop()
            backgroundAudioPlayer = replacement
            guard replacement.play() else { throw CocoaError(.fileReadUnknown) }
            isPlaying = true
            errorMessage = nil
        } catch {
            if backgroundAudioGeneration == token {
                errorMessage = "音を再生できません：\(error.localizedDescription)"
            }
        }
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}
