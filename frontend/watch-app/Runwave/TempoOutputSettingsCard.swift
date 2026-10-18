import SwiftUI

struct TempoOutputSettingsCard: View {
    @ObservedObject var store: SessionStore

    private var sessionIsActive: Bool {
        store.workoutState == .running || store.workoutState == .paused
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("テンポ案内の出力", systemImage: "metronome")
                .font(.headline)

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(TempoOutputMode.allCases) { mode in
                    Button {
                        store.setOutputMode(mode)
                    } label: {
                        Label(mode.label, systemImage: icon(for: mode))
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 42)
                            .background(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(store.outputSettings.mode == mode ? Color.green.opacity(0.18) : Color.secondary.opacity(0.1))
                            )
                            .overlay {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .stroke(store.outputSettings.mode == mode ? Color.green : Color.clear, lineWidth: 1.5)
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(store.outputSettings.mode == mode ? .isSelected : [])
                }
            }

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

            if store.outputSettings.mode == .audio || store.outputSettings.mode == .iphoneAudio {
                Picker("テンポ音の音色", selection: Binding(
                    get: { store.outputSettings.sound },
                    set: { store.setTempoSound($0) }
                )) {
                    ForEach(TempoSound.allCases) { sound in
                        Text(sound.label).tag(sound)
                    }
                }
                .pickerStyle(.menu)
                HStack {
                    Text("テンポ音の音量")
                    Spacer()
                    Text("\(Int((store.outputSettings.volume * 100).rounded()))%")
                        .monospacedDigit()
                }
                .font(.subheadline)
                Slider(value: Binding(
                    get: { store.outputSettings.volume },
                    set: { store.setAudioVolume($0) }
                ), in: 0...1, step: 0.05) {
                    Text("テンポ音の音量")
                } minimumValueLabel: {
                    Image(systemName: "speaker.fill")
                } maximumValueLabel: {
                    Image(systemName: "speaker.wave.3.fill")
                }
                .accessibilityValue("\(Int((store.outputSettings.volume * 100).rounded()))パーセント")
                    Text(store.outputSettings.mode == .iphoneAudio
                         ? "iPhoneまたは接続中のイヤホンから鳴らします。ほかの音楽を止めずに重ねて再生します。"
                         : "Watchから選んだ音色で鳴らします。実際の音量はWatch本体の音量にも影響されます。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if store.outputSettings.mode != .iphoneAudio {
                Text(store.outputSyncMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("outputSettingsSyncStatus")
            }

            Button {
                store.previewOutput()
            } label: {
                Label(store.outputSettings.mode == .iphoneAudio ? "iPhoneで3拍試す" : "Watchで3拍試す", systemImage: "play.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(store.outputSettings.mode == .off || sessionIsActive ||
                      (store.outputSettings.mode != .iphoneAudio && store.connectionState != .connected))

            Text(sessionIsActive
                 ? "セッション中も設定の変更をすぐに反映します。"
                 : (store.outputSettings.mode == .iphoneAudio ? "音楽を再生中でもテンポ音を重ねて鳴らします。" : "WatchのRUNWAVEを開いたままお試しください。"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.secondary.opacity(0.12)))
    }

    private func icon(for mode: TempoOutputMode) -> String {
        switch mode {
        case .haptic: "waveform.path"
        case .audio: "applewatch"
        case .iphoneAudio: "iphone"
        case .off: "speaker.slash"
        }
    }
}
