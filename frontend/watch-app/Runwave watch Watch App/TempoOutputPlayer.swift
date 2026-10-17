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

/// Foreground-only demo output; no HealthKit workout or background entitlement is claimed.
@MainActor
final class TempoOutputPlayer: ObservableObject {
    @Published private(set) var isPlaying = false
    @Published private(set) var errorMessage: String?
    private var generation = UUID()
    private var activeConfiguration: TempoPlaybackConfiguration?

    func updateConfiguration(_ configuration: TempoPlaybackConfiguration) {
        activeConfiguration = configuration
    }

    func run(_ configuration: TempoPlaybackConfiguration) async {
        let token = UUID()
        generation = token
        activeConfiguration = configuration
        errorMessage = nil
        let initialSettings = configuration.settings
        let audioSession = AVAudioSession.sharedInstance()
        var player: AVAudioPlayer?

        defer {
            player?.stop()
            if generation == token {
                isPlaying = false
                if initialSettings.mode == .audio {
                    try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                }
            }
        }

        if initialSettings.mode == .audio {
            do {
                guard let url = Bundle.main.url(forResource: "tempo-tick", withExtension: "wav") else {
                    throw CocoaError(.fileNoSuchFile)
                }
                // A short sound with the default route policy also supports the Watch speaker.
                try audioSession.setCategory(.playback, mode: .default, policy: .default)
                try audioSession.setActive(true)
                let prepared = try AVAudioPlayer(contentsOf: url)
                prepared.volume = Float(initialSettings.volume)
                guard prepared.prepareToPlay() else { throw CocoaError(.fileReadUnknown) }
                player = prepared
            } catch {
                if generation == token {
                    errorMessage = "音を再生できません：\(error.localizedDescription)"
                }
                return
            }
        } else {
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
                    player?.volume = Float(settings.volume)
                    player?.currentTime = 0
                    guard player?.play() == true else {
                        errorMessage = "音の再生が中断されました。音を選び直してください。"
                        return
                    }
                case .off:
                    return
                case .iphoneAudio:
                    return
                }

                beats += 1
                if currentConfiguration.previewID != nil, beats >= 3 {
                    // Let the last short beep finish before releasing the player.
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
            // Cancellation stops both audio and paired haptic pulses on pause/mode changes.
        }
    }
}
