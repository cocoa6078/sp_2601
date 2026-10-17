import AVFoundation
import Combine
import Foundation

/// iPhone側のテンポ音。ambientカテゴリで他の音楽を止めずに重ねて鳴らす。
@MainActor
final class IPhoneTempoOutputPlayer: ObservableObject {
    @Published private(set) var errorMessage: String?

    private struct Configuration {
        var cadence: Int
        var volume: Double
    }

    private var configuration: Configuration?
    private var player: AVAudioPlayer?
    private var playbackTask: Task<Void, Never>?
    private var previewTask: Task<Void, Never>?
    private var playbackGeneration = UUID()
    private let audioSession = AVAudioSession.sharedInstance()

    func update(isRunning: Bool, mode: TempoOutputMode, cadence: Int, volume: Double) {
        guard isRunning, mode == .iphoneAudio else {
            configuration = nil
            playbackGeneration = UUID()
            playbackTask?.cancel()
            playbackTask = nil
            previewTask?.cancel()
            previewTask = nil
            player?.stop()
            player = nil
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
            return
        }

        configuration = Configuration(cadence: cadence, volume: volume)
        previewTask?.cancel()
        previewTask = nil
        guard playbackTask == nil else { return }
        let token = UUID()
        playbackGeneration = token
        playbackTask = Task { [weak self] in
            await self?.playWorkoutTempo(token: token)
        }
    }

    func preview(cadence: Int, volume: Double) {
        errorMessage = nil
        playbackTask?.cancel()
        playbackTask = nil
        configuration = nil
        let token = UUID()
        playbackGeneration = token
        previewTask?.cancel()
        previewTask = Task { [weak self] in
            await self?.playPreview(cadence: cadence, volume: volume, token: token)
        }
    }

    private func prepareAudio(volume: Double) throws {
        guard let url = Bundle.main.url(forResource: "tempo-tick", withExtension: "wav") else {
            throw CocoaError(.fileNoSuchFile)
        }
        try audioSession.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        try audioSession.setActive(true)
        let prepared = try AVAudioPlayer(contentsOf: url)
        prepared.volume = Float(min(max(volume, 0), 1))
        guard prepared.prepareToPlay() else { throw CocoaError(.fileReadUnknown) }
        player = prepared
    }

    private func playWorkoutTempo(token: UUID) async {
        defer {
            if playbackGeneration == token {
                player?.stop()
                player = nil
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                playbackTask = nil
            }
        }

        do {
            try prepareAudio(volume: configuration?.volume ?? 0.7)
            let clock = ContinuousClock()
            var nextBeat = clock.now.advanced(by: .milliseconds(500))
            while !Task.isCancelled {
                guard configuration != nil else { return }
                try await clock.sleep(until: nextBeat)
                try Task.checkCancellation()
                guard let current = configuration else { return }
                player?.volume = Float(min(max(current.volume, 0), 1))
                player?.currentTime = 0
                guard player?.play() == true else {
                    errorMessage = "iPhoneでテンポ音を再生できませんでした。"
                    return
                }
                let interval = Duration.seconds(60.0 / Double(max(1, current.cadence)))
                nextBeat += interval
                if nextBeat <= clock.now { nextBeat = clock.now.advanced(by: interval) }
            }
        } catch is CancellationError {
            // 一時停止・終了・出力先切替で停止する。
        } catch {
            errorMessage = "iPhoneの音声を再生できません：\(error.localizedDescription)"
        }
    }

    private func playPreview(cadence: Int, volume: Double, token: UUID) async {
        defer {
            if playbackGeneration == token {
                player?.stop()
                player = nil
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                previewTask = nil
            }
        }
        do {
            try prepareAudio(volume: volume)
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
