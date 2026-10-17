//
//  ContentView.swift
//  Runwave watch Watch App
//

import SwiftUI
import WatchKit

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var connectivity = WatchConnectivityManager()
    @StateObject private var output = TempoOutputPlayer()
    @State private var previewID: UUID?
    @State private var isDemoRunning = false
    @State private var isPaused = false
    @State private var showEndConfirmation = false
    @State private var crownCadence = 140.0

    var body: some View {
        Group {
            if connectivity.sessionState == .ended {
                workoutSummaryView
            } else if isDemoRunning {
                demoView
            } else {
                homeView
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isDemoRunning)
        .onReceive(connectivity.$sessionState) { state in
            switch state {
            case .idle:
                break
            case .running:
                previewID = nil
                isPaused = false
                isDemoRunning = true
            case .paused:
                isPaused = true
            case .ended:
                previewID = nil
                isDemoRunning = false
                isPaused = false
            }
        }
        .onReceive(connectivity.$previewRequestID) { request in
            guard let request, !isDemoRunning else { return }
            previewID = request
            isPaused = false
            isDemoRunning = true
        }
        .onChange(of: playbackConfiguration) { _, configuration in
            guard let configuration else { return }
            output.updateConfiguration(configuration)
        }
        .onChange(of: output.errorMessage) { _, message in
            if let message { connectivity.reportOutputError(message) }
        }
        .onChange(of: connectivity.targetCadence) { _, cadence in
            // Keep the crown's own position in sync with iPhone updates. The
            // crown binding itself must remain stable while it is being turned.
            crownCadence = Double(cadence)
        }
        .onChange(of: crownCadence) { _, value in
            guard isDemoRunning else { return }
            let cadence = Int(value.rounded())
            if cadence != connectivity.targetCadence {
                connectivity.setTargetCadenceFromCrown(cadence)
            }
        }
        .task(id: playbackTaskKey) {
            guard let configuration = playbackConfiguration else { return }
            await output.run(configuration)
            if !Task.isCancelled, let request = configuration.previewID, previewID == request {
                previewID = nil
                isDemoRunning = false
            }
        }
    }

    private var playbackTaskKey: String {
        [
            isDemoRunning ? "running" : "idle",
            isPaused ? "paused" : "active",
            scenePhase == .active ? "foreground" : "background",
            connectivity.outputSettings.mode.rawValue,
            previewID?.uuidString ?? ""
        ].joined(separator: ":")
    }

    private var playbackConfiguration: TempoPlaybackConfiguration? {
        guard isDemoRunning, !isPaused, scenePhase == .active,
              connectivity.outputSettings.mode == .haptic || connectivity.outputSettings.mode == .audio else { return nil }
        return TempoPlaybackConfiguration(
            cadence: connectivity.guidedCadence,
            settings: connectivity.outputSettings,
            previewID: previewID,
            activityMode: connectivity.activityMode
        )
    }

    private var homeView: some View {
        VStack(spacing: 6) {
            Label(connectivity.isReachable ? "待機中" : "接続待ち", systemImage: "applewatch")
                .font(.headline)
                .lineLimit(1)
                .minimumScaleFactor(0.8)

            Text(connectivity.sessionStatus == "iPhoneで目的地を設定してください"
                 ? connectivity.sessionStatus
                 : (connectivity.isReachable ? "目的地はiPhoneで設定できます" : "iPhoneでRUNWAVEを開いてください"))
                .font(.caption2)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .minimumScaleFactor(0.8)

        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
    }

    private var demoView: some View {
        VStack(spacing: 2) {
            VStack(spacing: 0) {
                Text("\(connectivity.targetCadence)")
                    .font(.system(size: 29, weight: .bold, design: .rounded))
                    .foregroundStyle(connectivity.guidedCadence == connectivity.targetCadence ? .white : .gray)
                    .contentTransition(.numericText())
                    .accessibilityLabel("基準目標 \(connectivity.targetCadence) 歩/分")

                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text("\(connectivity.guidedCadence)")
                        .font(.system(size: 24, weight: .semibold, design: .rounded))
                        .foregroundStyle(connectivity.guidedCadence == connectivity.targetCadence ? .gray : .cyan)
                        .contentTransition(.numericText())
                    Text("歩/分")
                        .font(.caption2)
                        .foregroundStyle(connectivity.guidedCadence == connectivity.targetCadence ? .gray : .cyan)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("現在の案内 \(connectivity.guidedCadence) 歩/分")
            }
            .focusable()
            .digitalCrownRotation(
                $crownCadence,
                from: Double(connectivity.activityMode == "walking" ? 80 : 110),
                through: Double(connectivity.activityMode == "walking" ? 140 : 190),
                by: 1,
                sensitivity: .medium,
                isContinuous: false,
                isHapticFeedbackEnabled: true
            )

            if connectivity.sessionState == .running || connectivity.sessionState == .paused {
                TimelineView(.periodic(from: Date(), by: 1)) { context in
                    Text(formatDuration(connectivity.elapsed(at: context.date)))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            if let message = output.errorMessage {
                Text(message)
                    .font(.system(size: 9))
                    .foregroundStyle(.orange)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            } else if !connectivity.crownSyncStatus.isEmpty {
                Text(connectivity.crownSyncStatus)
                    .font(.system(size: 9))
                    .foregroundStyle(connectivity.crownSyncStatus == "iPhone同期済み" ? .green : .secondary)
                    .lineLimit(1)
            }

            HStack(spacing: 8) {
                Button {
                    if connectivity.sessionState == .running || connectivity.sessionState == .paused {
                        connectivity.toggleWorkoutPause()
                        isPaused = connectivity.sessionState == .paused
                    } else {
                        isPaused.toggle()
                    }
                } label: {
                    Image(systemName: isPaused ? "play.fill" : "pause.fill")
                        .frame(maxWidth: .infinity, minHeight: 26)
                }
                .tint(isPaused ? .green : .orange)
                .controlSize(.small)
                .accessibilityLabel(isPaused ? "再開" : "一時停止")

                Button(role: .destructive) {
                    if connectivity.sessionState == .running || connectivity.sessionState == .paused {
                        showEndConfirmation = true
                    } else {
                        previewID = nil
                        isDemoRunning = false
                        isPaused = false
                    }
                } label: {
                    Image(systemName: "stop.fill")
                        .frame(maxWidth: .infinity, minHeight: 26)
                }
                .accessibilityLabel("ワークアウト終了")
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 0)
        .confirmationDialog("ワークアウトを終了しますか？", isPresented: $showEndConfirmation, titleVisibility: .visible) {
            Button("ワークアウトを終了", role: .destructive) {
                connectivity.endWorkout()
            }
            Button("キャンセル", role: .cancel) {}
        }
    }

    private var workoutSummaryView: some View {
        VStack(spacing: 5) {
            Text(connectivity.activityMode == "walking" ? "ウォーキング終了" : "ランニング終了")
                .font(.headline)
                .lineLimit(1)
                .minimumScaleFactor(0.75)

            TimelineView(.periodic(from: Date(), by: 1)) { context in
                Text(formatDuration(connectivity.elapsed(at: context.date)))
                    .font(.system(size: 25, weight: .bold, design: .rounded))
                    .monospacedDigit()
            }

            Text(distanceLabel)
                .font(.caption)
                .lineLimit(1)

            if let cadence = connectivity.workoutAverageCadence {
                Text("平均 \(cadence) 歩/分")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Button("完了") { connectivity.dismissSummary() }
                .controlSize(.small)
        }
        .padding(.horizontal, 4)
    }

    private var distanceLabel: String {
        guard let distance = connectivity.workoutDistance else { return "距離 未取得" }
        if distance >= 1_000 { return String(format: "距離 %.2f km", distance / 1_000) }
        return String(format: "距離 %.0f m", distance)
    }

}

private func formatDuration(_ duration: TimeInterval) -> String {
    let seconds = max(0, Int(duration))
    return String(format: "%02d:%02d:%02d", seconds / 3_600, (seconds % 3_600) / 60, seconds % 60)
}

#Preview {
    ContentView()
}
