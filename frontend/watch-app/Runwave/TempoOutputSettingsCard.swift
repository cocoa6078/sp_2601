import SwiftUI

struct TempoOutputSettingsCard: View {
    @ObservedObject var store: SessionStore

    private var sessionIsActive: Bool {
        store.workoutState == .running || store.workoutState == .paused
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Watchのテンポ案内", systemImage: "applewatch")
                .font(.headline)

            Picker("案内方法", selection: Binding(
                get: { store.outputSettings.mode },
                set: { store.setOutputMode($0) }
            )) {
                ForEach(TempoOutputMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)

            if store.outputSettings.mode == .haptic {
                Text("振動の感じ方")
                    .font(.subheadline)
                Picker("振動の感じ方", selection: Binding(
                    get: { store.outputSettings.hapticStyle },
                    set: { store.setHapticStyle($0) }
                )) {
                    ForEach(TempoHapticStyle.allCases) { style in
                        Text(style.label).tag(style)
                    }
                }
                .pickerStyle(.segmented)
                Text("2連は1拍につき短いタップを2回送ります。振動そのものの強さはWatchの制約で変更できません。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if store.outputSettings.mode == .audio {
                HStack {
                    Text("ビープ音の音量")
                    Spacer()
                    Text("\(Int((store.outputSettings.volume * 100).rounded()))%")
                        .monospacedDigit()
                }
                .font(.subheadline)
                Slider(value: Binding(
                    get: { store.outputSettings.volume },
                    set: { store.setAudioVolume($0) }
                ), in: 0...1, step: 0.05) {
                    Text("Watchのビープ音量")
                } minimumValueLabel: {
                    Image(systemName: "speaker.fill")
                } maximumValueLabel: {
                    Image(systemName: "speaker.wave.3.fill")
                }
                .accessibilityValue("\(Int((store.outputSettings.volume * 100).rounded()))パーセント")
                Text("Watchから目標テンポに合わせて「ピッ」と鳴らします。実際の音量はWatch本体の音量にも影響されます。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(store.outputSyncMessage)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("outputSettingsSyncStatus")

            Button {
                store.previewOutput()
            } label: {
                Label("Watchで3拍試す", systemImage: "play.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(store.connectionState != .connected || store.outputSettings.mode == .off || sessionIsActive)

            Text(sessionIsActive
                 ? "セッション中も設定の変更をすぐに反映します。"
                 : "WatchのRUNWAVEを開いたままお試しください。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.secondary.opacity(0.12)))
    }
}
