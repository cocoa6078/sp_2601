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

    var body: some View {
        Group {
            if isDemoRunning {
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
        .onChange(of: output.errorMessage) { _, message in
            if let message { connectivity.reportOutputError(message) }
        }
        .task(id: playbackConfiguration) {
            guard let configuration = playbackConfiguration else { return }
            await output.run(configuration)
            if !Task.isCancelled, let request = configuration.previewID, previewID == request {
                previewID = nil
                isDemoRunning = false
            }
        }
    }

    private var playbackConfiguration: TempoPlaybackConfiguration? {
        guard isDemoRunning, !isPaused, scenePhase == .active,
              connectivity.outputSettings.mode != .off else { return nil }
        return TempoPlaybackConfiguration(
            cadence: connectivity.targetCadence,
            settings: connectivity.outputSettings,
            previewID: previewID
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

            HStack(spacing: 6) {
                goalSetupButton(title: "歩く", mode: "walking")
                goalSetupButton(title: "走る", mode: "running")
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
    }

    private func goalSetupButton(title: String, mode: String) -> some View {
        Button {
            connectivity.requestGoalSetup(activityMode: mode)
        } label: {
            Text(title)
                .font(.caption.bold())
                .frame(maxWidth: .infinity, minHeight: 30)
                .lineLimit(1)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .disabled(!connectivity.isReachable)
        .accessibilityLabel("\(title)の目的地をiPhoneで設定")
    }

    private var demoView: some View {
        VStack(spacing: 2) {
            HStack(spacing: 4) {
                Circle()
                    .fill(isPaused ? .orange : .blue)
                    .frame(width: 6, height: 6)
                Text(isPaused ? "一時停止中" : "案内中")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Text("\(connectivity.targetCadence) 歩/分")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .contentTransition(.numericText())
                .accessibilityLabel("目標 \(connectivity.targetCadence) 歩/分")

            if let message = output.errorMessage {
                Text(message)
                    .font(.system(size: 9))
                    .foregroundStyle(.orange)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }

            HStack(spacing: 8) {
                Button {
                    isPaused.toggle()
                } label: {
                    Image(systemName: isPaused ? "play.fill" : "pause.fill")
                        .frame(maxWidth: .infinity, minHeight: 26)
                }
                .tint(.blue)
                .controlSize(.small)
                .accessibilityLabel(isPaused ? "再開" : "一時停止")

                Button(role: .destructive) {
                    previewID = nil
                    isDemoRunning = false
                    isPaused = false
                } label: {
                    Image(systemName: "stop.fill")
                        .frame(maxWidth: .infinity, minHeight: 26)
                }
                .accessibilityLabel("デモ終了")
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 0)
    }
}

#Preview {
    ContentView()
}
