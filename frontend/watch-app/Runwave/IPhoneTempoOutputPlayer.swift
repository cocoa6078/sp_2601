import AVFoundation
import Combine
import Foundation

/// iPhone側のテンポ音。バックグラウンド再生を維持し、他の音楽にも重ねて鳴らす。
@MainActor
final class IPhoneTempoOutputPlayer: ObservableObject {
    @Published private(set) var errorMessage: String?

    private struct Configuration {
        var cadence: Int
        var volume: Double
    }

    private var configuration: Configuration?
    private var player: AVAudioPlayer?
    private var previewTask: Task<Void, Never>?
    private var previewGeneration = UUID()
    private let audioSession = AVAudioSession.sharedInstance()
    private var interruptionObserver: NSObjectProtocol?
    private var resetObserver: NSObjectProtocol?

    init() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: audioSession,
            queue: .main
        ) { [weak self] notification in
            guard let rawValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: rawValue) == .ended else { return }
            Task { @MainActor [weak self] in self?.resumeIfNeeded() }
        }
        resetObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: audioSession,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.resumeIfNeeded(force: true) }
        }
    }

    func update(isRunning: Bool, mode: TempoOutputMode, cadence: Int, volume: Double) {
        guard isRunning, mode == .iphoneAudio else {
            stop()
            return
        }

        let previous = configuration
        configuration = Configuration(cadence: cadence, volume: volume)
        previewGeneration = UUID()
        previewTask?.cancel()
        previewTask = nil
        if previous?.cadence == cadence, player?.isPlaying == true {
            player?.volume = Float(min(max(volume, 0), 1))
            return
        }
        startWorkoutLoop(preservingPhaseFrom: previous)
    }

    func stop() {
        configuration = nil
        previewGeneration = UUID()
        previewTask?.cancel()
        previewTask = nil
        player?.stop()
        player = nil
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
    }

    func resumeIfNeeded(force: Bool = false) {
        guard configuration != nil else { return }
        if force || player?.isPlaying != true { startWorkoutLoop(preservingPhaseFrom: nil) }
    }

    func preview(cadence: Int, volume: Double) {
        errorMessage = nil
        configuration = nil
        player?.stop()
        player = nil
        previewGeneration = UUID()
        let token = previewGeneration
        previewTask?.cancel()
        previewTask = Task { [weak self] in
            await self?.playPreview(cadence: cadence, volume: volume, token: token)
        }
    }

    private func startWorkoutLoop(preservingPhaseFrom previous: Configuration?) {
        guard let configuration else { return }
        let firstBeatDelay: TimeInterval
        if let previous, let player, player.isPlaying {
            let oldInterval = 60.0 / Double(max(1, previous.cadence))
            let phase = player.currentTime.truncatingRemainder(dividingBy: oldInterval)
            firstBeatDelay = max(0, oldInterval - phase)
        } else {
            firstBeatDelay = 0
        }

        do {
            let replacement = try makeLoopingPlayer(
                cadence: configuration.cadence,
                volume: configuration.volume,
                firstBeatDelay: firstBeatDelay
            )
            player?.stop()
            player = replacement
            guard replacement.play() else { throw CocoaError(.fileReadUnknown) }
            errorMessage = nil
        } catch {
            errorMessage = "iPhoneの音声を再生できません：\(error.localizedDescription)"
        }
    }

    /// 効果音と無音を1周期にまとめてループし、画面消灯中も音声再生を継続する。
    private func makeLoopingPlayer(cadence: Int, volume: Double, firstBeatDelay: TimeInterval) throws -> AVAudioPlayer {
        guard let url = Bundle.main.url(forResource: "tempo-tick", withExtension: "wav") else {
            throw CocoaError(.fileNoSuchFile)
        }
        let source = try Data(contentsOf: url)
        let sampleRate = 22_050
        guard source.count > 44 else { throw CocoaError(.fileReadCorruptFile) }
        let tick = source.subdata(in: 44..<source.count)
        let frames = max(tick.count / 2, Int((Double(sampleRate) * 60 / Double(max(1, cadence))).rounded()))
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

        try audioSession.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try audioSession.setActive(true)
        let loop = try AVAudioPlayer(data: wav)
        loop.numberOfLoops = -1
        loop.volume = Float(min(max(volume, 0), 1))
        guard loop.prepareToPlay() else { throw CocoaError(.fileReadUnknown) }
        return loop
    }

    private func playPreview(cadence: Int, volume: Double, token: UUID) async {
        defer {
            if previewGeneration == token {
                player?.stop()
                player = nil
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                previewTask = nil
            }
        }
        do {
            guard let url = Bundle.main.url(forResource: "tempo-tick", withExtension: "wav") else {
                throw CocoaError(.fileNoSuchFile)
            }
            try audioSession.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try audioSession.setActive(true)
            let prepared = try AVAudioPlayer(contentsOf: url)
            prepared.volume = Float(min(max(volume, 0), 1))
            guard prepared.prepareToPlay() else { throw CocoaError(.fileReadUnknown) }
            player = prepared

            let clock = ContinuousClock()
            let interval = Duration.seconds(60.0 / Double(max(1, cadence)))
            var nextBeat = clock.now
            for _ in 0..<3 {
                try Task.checkCancellation()
                try await clock.sleep(until: nextBeat)
                player?.currentTime = 0
                guard player?.play() == true else { throw CocoaError(.fileReadUnknown) }
                nextBeat += interval
            }
            try await clock.sleep(for: .milliseconds(150))
        } catch is CancellationError {
            // プレビューを中断した。
        } catch {
            errorMessage = "iPhoneでテンポ音を再生できません：\(error.localizedDescription)"
        }
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}
