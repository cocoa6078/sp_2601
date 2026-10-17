//
//  ContentView.swift
//  Runwave watch Watch App
//

import SwiftUI

struct ContentView: View {
    @StateObject private var connectivity = WatchConnectivityManager()
    @State private var isDemoRunning = false
    @State private var isPaused = false
    @State private var isWorkoutComingSoonPresented = false

    var body: some View {
        Group {
            if isDemoRunning {
                demoView
            } else {
                homeView
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isDemoRunning)
        .alert("ランニング計測は準備中です", isPresented: $isWorkoutComingSoonPresented) {
            Button("OK", role: .cancel) { }
        } message: {
            Text("次の実装段階でHealthKitのワークアウト計測を追加します。")
        }
    }

    private var homeView: some View {
        ScrollView {
            VStack(spacing: 12) {
                VStack(spacing: 3) {
                    Text("RUNWAVE")
                        .font(.system(size: 19, weight: .bold, design: .rounded))
                        .tracking(1.5)
                    Text("走るリズムを、手首に。")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 5) {
                    Circle()
                        .fill(connectivity.isReachable ? .green : .gray)
                        .frame(width: 6, height: 6)
                    Text(connectivity.isReachable ? "iPhone接続中" : "iPhone未接続")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 2) {
                    Text("目標ケイデンス")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("\(connectivity.targetCadence) 歩/分")
                        .font(.system(.title3, design: .rounded, weight: .semibold))
                        .monospacedDigit()
                        .accessibilityLabel("目標 \(connectivity.targetCadence) 歩/分")
                }

                VStack(spacing: 8) {
                    Button {
                        isPaused = false
                        isDemoRunning = true
                    } label: {
                        Label("デモ開始", systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .tint(.blue)

                    Button {
                        isWorkoutComingSoonPresented = true
                    } label: {
                        Label("ランニング開始", systemImage: "figure.run")
                            .frame(maxWidth: .infinity)
                    }
                    .tint(.green)
                }

                Text("デモ値を使った画面確認です")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
    }

    private var demoView: some View {
        VStack(spacing: 8) {
            HStack(spacing: 4) {
                Circle()
                    .fill(isPaused ? .orange : .blue)
                    .frame(width: 6, height: 6)
                Text(isPaused ? "一時停止中" : "デモ中")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 0) {
                Text("目標")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("\(connectivity.targetCadence)")
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text("歩/分")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 5) {
                Text("現在")
                    .foregroundStyle(.secondary)
                Text("未計測")
                    .fontWeight(.medium)
            }
            .font(.caption)

            Text("\(connectivity.sessionStatus) · テンポ出力：未接続")
                .font(.caption2)
                .foregroundStyle(.secondary)

            HStack(spacing: 8) {
                Button {
                    isPaused.toggle()
                } label: {
                    Image(systemName: isPaused ? "play.fill" : "pause.fill")
                        .frame(maxWidth: .infinity)
                }
                .tint(.blue)
                .accessibilityLabel(isPaused ? "再開" : "一時停止")

                Button(role: .destructive) {
                    isDemoRunning = false
                    isPaused = false
                } label: {
                    Image(systemName: "stop.fill")
                        .frame(maxWidth: .infinity)
                }
                .accessibilityLabel("デモ終了")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }
}

#Preview {
    ContentView()
}
