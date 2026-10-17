//
//  ContentView.swift
//  Runwave (RUNWAVE / JPHACKS)
//
//  iPhone 側 UI（ホーム / セッション / 結果）を 1 ファイルにまとめたもの。
//  Windows で作成（ビルド未確認）。説明は frontend/iP実装メモ.md。
//  .pbxproj への登録を不要にするため、全ての型をこのファイルに入れている。
//
//  - 対象: iOS 16+（ObservableObject / @Published / @StateObject。@Observable・#Preview は使わない）
//    ただし終了地点の地図（GoalMapView.swift）は iOS 17+ の MapKit API を使う（Deployment Target は 26.2）
//  - 終了地点（GoalMapView.swift）と信号のイラスト（SignalLightView.swift）は別ファイル
//  - WatchConnectivity は WatchConnectivityLink.swift に分離
//  - 信号・到着予測の計算は書かない（開始時の目標ケイデンスは測定値を使う）
//

import SwiftUI
import Foundation
import Combine

// MARK: - 基本の型

/// Apple Watch との接続状態。
enum WatchConnectionState: Equatable {
    case notConnected
    case notPaired
    case watchAppNotInstalled
    case waitingForReachability
    case connected

    var label: String {
        switch self {
        case .notConnected: return "未接続"
        case .notPaired: return "iPhoneと未ペアリング"
        case .watchAppNotInstalled: return "Watchアプリ未インストール"
        case .waitingForReachability: return "Watchアプリを開いてください"
        case .connected: return "接続中"
        }
    }
}

/// ワークアウトの状態。
enum WorkoutState: Equatable {
    case idle      // 待機
    case running   // 実行中
    case paused    // 一時停止
    case ended     // 終了

    var label: String {
        switch self {
        case .idle: return "待機"
        case .running: return "実行中"
        case .paused: return "一時停止"
        case .ended: return "終了"
        }
    }
}

/// 目標ケイデンスの決まり方。
/// 【要確認】Watch 側の enum と rawValue を合意すること（現状は "manual" のみ）。
enum TargetMode: String, Codable {
    case manual
}

/// iPhone -> Watch へ送る目標コマンド（将来 WatchConnectivity で送る）。
struct TargetCommand: Codable, Equatable {
    /// 目標ケイデンス（歩/分）
    var targetCadence: Int
    var mode: TargetMode
    var activityMode: ActivityMode
    var cadenceBaseline: Int
    var cadenceAdjustment: Int
    /// 信号制御が選んだ現在の案内ケイデンス。未設定なら通常の目標値を使う。
    var guidedCadence: Int?
    var issuedAt: Date
    var sessionID: UUID
}

/// Watch -> iPhone へ届く計測値（受け取る想定）。nil は「未取得」。
struct WatchMetrics: Codable, Equatable {
    /// 現在ケイデンス（歩/分）
    var currentCadence: Int?
    /// 心拍数（拍/分）。ケイデンスとは別の値。
    var heartRate: Int?
    /// 距離（m）
    var distance: Double?
    /// 平均ケイデンス（歩/分）
    var averageCadence: Int?
    var receivedAt: Date
}

// MARK: - Watch との通信口

/// Watch との通信の抽象。
protocol WatchLink: AnyObject {
    var connectionState: WatchConnectionState { get }
    /// Watch から計測値が届いたとき呼ばれる（呼び出しスレッドは不定。受け側でメインへ寄せる）
    var onMetrics: ((WatchMetrics) -> Void)? { get set }
    /// 接続状態が変わったとき呼ばれる（同上）
    var onConnectionChange: ((WatchConnectionState) -> Void)? { get set }
    var onGoalSetupRequested: ((String?) -> Void)? { get set }
    var onWorkoutControl: ((String) -> Void)? { get set }
    var onTargetCadenceAdjustment: ((Int) -> Void)? { get set }
    var onOutputSettingsApplied: ((TempoOutputSettings) -> Void)? { get set }
    var onOutputError: ((String) -> Void)? { get set }
    func updateOutputSettings(_ settings: TempoOutputSettings)
    func previewOutput(targetCadence: Int, activityMode: ActivityMode)

    /// 目標コマンドを Watch へ送る
    func send(_ command: TargetCommand)

    // ワークアウトの状態変化の通知
    func workoutDidStart(sessionID: UUID)
    func workoutDidPause()
    func workoutDidResume()
    func workoutDidEnd(elapsed: TimeInterval, distance: Double?, averageCadence: Int?, activityMode: ActivityMode)
}

/// プレビューや通信未使用時の代役。常に未接続で、何もしない。
final class NoWatchLink: WatchLink {
    var connectionState: WatchConnectionState { .notConnected }
    var onMetrics: ((WatchMetrics) -> Void)?
    var onConnectionChange: ((WatchConnectionState) -> Void)?
    var onGoalSetupRequested: ((String?) -> Void)?
    var onWorkoutControl: ((String) -> Void)?
    var onTargetCadenceAdjustment: ((Int) -> Void)?
    var onOutputSettingsApplied: ((TempoOutputSettings) -> Void)?
    var onOutputError: ((String) -> Void)?
    func updateOutputSettings(_ settings: TempoOutputSettings) {}
    func previewOutput(targetCadence: Int, activityMode: ActivityMode) {}

    func send(_ command: TargetCommand) {}
    func workoutDidStart(sessionID: UUID) {}
    func workoutDidPause() {}
    func workoutDidResume() {}
    func workoutDidEnd(elapsed: TimeInterval, distance: Double?, averageCadence: Int?, activityMode: ActivityMode) {}
}

// MARK: - 表示用の小さな型

/// 画面の種類。NavigationStack の戻る操作でセッションが壊れないよう、状態で切り替える。
enum AppScreen: Equatable {
    case home
    case session
    case result
}

/// 結果画面に出すサマリ。
struct SessionSummary: Equatable {
    /// iPhone の時計で測った運動時間（一時停止中を除く）
    var elapsed: TimeInterval
    var distance: Double?
    var averageCadence: Int?
    /// デモ値から作られたサマリか
    var isDemo: Bool
    var activityMode: ActivityMode
}

/// 1 つの数値を画面に出すときの表示内容。
struct MetricDisplay {
    let text: String
    let unit: String
    /// 「未接続」「未計測」など、数値ではない表示か
    let isPlaceholder: Bool
    /// デモ値か
    let isDemo: Bool
}

// MARK: - 状態管理

final class SessionStore: ObservableObject {

    // 目標ケイデンスの範囲（歩/分）
    static let defaultCadence = 140

    // MARK: 公開状態
    @Published private(set) var targetCadence: Int = SessionStore.defaultCadence
    @Published private(set) var cadenceBaseline: Int = SessionStore.defaultCadence
    @Published private(set) var guidedCadence: Int?
    @Published private(set) var connectionState: WatchConnectionState
    @Published private(set) var workoutState: WorkoutState = .idle
    @Published private(set) var latestMetrics: WatchMetrics?
    @Published private(set) var sessionID: UUID = UUID()
    @Published private(set) var activityMode: ActivityMode = .running
    @Published private(set) var screen: AppScreen = .home
    @Published private(set) var summary: SessionSummary?
    /// DEBUG ビルドでのみ true にできる（リリースでは常に false）
    @Published private(set) var isDemoMode: Bool = false
    /// 終了地点。未設定の場合はセッションを開始できない。
    /// TODO(連携): 終了地点を送るかは Watch/シミュレーターと要合意（現状は iPhone 内のみで保持）
    @Published private(set) var outputSettings = TempoOutputSettings.load()
    @Published private(set) var outputSyncMessage = "Watch接続時に設定を反映します"
    @Published private(set) var goal: GoalPoint?
    @Published private(set) var goalSetupRequested = false
    @Published private(set) var goalSetupActivityMode: ActivityMode?
    /// 最後に受け取った信号情報。nil は未受信。iPhone では色を計算しない。
    @Published private(set) var latestSignal: SignalInfo?

    // MARK: 経過時間（iPhone の時計で積算。一時停止中は増えない）
    private var accumulated: TimeInterval = 0
    private var runStartedAt: Date?
    private var cadenceAdjustment = 0

    private let link: any WatchLink

    init(link: any WatchLink = NoWatchLink()) {
        self.link = link
        self.connectionState = link.connectionState

        link.onMetrics = { [weak self] metrics in
            DispatchQueue.main.async { self?.handleMetrics(metrics) }
        }
        link.onConnectionChange = { [weak self] state in
            DispatchQueue.main.async { self?.handleConnectionChange(state) }
        }
        link.onGoalSetupRequested = { [weak self] rawMode in
            DispatchQueue.main.async {
                self?.goalSetupActivityMode = rawMode.flatMap(ActivityMode.init(rawValue:))
                self?.goalSetupRequested = true
            }
        }
        link.onWorkoutControl = { [weak self] action in
            DispatchQueue.main.async {
                if action == "pause" { self?.pause() }
                else if action == "resume" { self?.resume() }
                else if action == "end" { self?.end() }
            }
        }
        link.onTargetCadenceAdjustment = { [weak self] delta in
            DispatchQueue.main.async {
                self?.adjustTargetCadence(by: delta)
            }
        }
        link.onOutputSettingsApplied = { [weak self] settings in
            DispatchQueue.main.async {
                guard let self, self.outputSettings == settings else { return }
                self.outputSyncMessage = "Watchへ反映済み"
            }
        }
        link.onOutputError = { [weak self] message in
            DispatchQueue.main.async { self?.outputSyncMessage = message }
        }
        link.updateOutputSettings(outputSettings)
    }

    // MARK: 経過時間

    /// 指定時刻での経過時間（秒）。TimelineView から毎秒呼ばれる。
    func elapsed(at now: Date) -> TimeInterval {
        if let started = runStartedAt {
            return accumulated + max(0, now.timeIntervalSince(started))
        }
        return accumulated
    }

    // MARK: 目標ケイデンス

    var cadenceRange: ClosedRange<Int> {
        activityMode == .walking ? 80...140 : 110...190
    }

    /// 外部から届いた絶対値を設定する。
    func setTargetCadence(_ value: Int) {
        let range = cadenceRange
        let bounded = min(max(value, range.lowerBound), range.upperBound)
        guard bounded != targetCadence else { return }
        targetCadence = bounded
        cadenceAdjustment = bounded - cadenceBaseline
        // ホームでの変更は「開始時」にまとめて送る。セッション中だけ即時送信する。
        if workoutState == .running || workoutState == .paused {
            sendCurrentTarget()
        }
    }

    /// 測定した自然なケイデンスを基準に±5する。上限で一時的に丸めても基準からの差を保つ。
    func adjustTargetCadence(by delta: Int) {
        guard delta != 0, abs(delta) <= 40 else { return }
        let range = cadenceRange
        let nextAdjustment = cadenceAdjustment + delta
        let next = min(max(cadenceBaseline + nextAdjustment, range.lowerBound), range.upperBound)
        guard next != targetCadence else { return }
        cadenceAdjustment = next - cadenceBaseline
        targetCadence = next
        if workoutState == .running || workoutState == .paused { sendCurrentTarget() }
    }

    /// 信号制御が選んだ案内値をWatchへ反映する。nilなら通常目標に戻す。
    func setSignalGuidanceCadence(_ value: Int?) {
        if let value {
            let range = cadenceRange
            guidedCadence = min(max(value, range.lowerBound), range.upperBound)
        } else {
            guidedCadence = nil
        }
        if workoutState == .running || workoutState == .paused { sendCurrentTarget() }
    }

    // MARK: Watch のテンポ出力

    func setOutputMode(_ mode: TempoOutputMode) {
        var settings = outputSettings
        settings.mode = mode
        updateOutputSettings(settings)
    }

    func setHapticStyle(_ style: TempoHapticStyle) {
        var settings = outputSettings
        settings.hapticStyle = style
        updateOutputSettings(settings)
    }

    func setAudioVolume(_ volume: Double) {
        guard volume.isFinite else { return }
        var settings = outputSettings
        settings.volume = min(max(volume, 0), 1)
        updateOutputSettings(settings)
    }

    private func updateOutputSettings(_ settings: TempoOutputSettings) {
        guard settings != outputSettings else { return }
        outputSettings = settings
        settings.save()
        outputSyncMessage = connectionState == .connected ? "Watchへ反映中…" : "Watch接続時に設定を反映します"
        link.updateOutputSettings(settings)
    }

    func previewOutput() {
        guard connectionState == .connected else { return }
        link.previewOutput(targetCadence: targetCadence, activityMode: activityMode)
    }

    // MARK: 終了地点

    /// 終了地点を設定する。緯度経度が不正な値なら無視する。
    func setGoal(_ point: GoalPoint) {
        guard point.isValid else { return }
        goal = point
    }

    /// 終了地点を未設定に戻す。
    func clearGoal() {
        goal = nil
    }

    func clearGoalSetupRequest() {
        goalSetupRequested = false
        goalSetupActivityMode = nil
    }

    // MARK: 信号

    /// 信号情報を受け取る。
    /// TODO(連携): シミュレーター/Watch から受け取る経路は未実装
    func receiveSignal(_ info: SignalInfo?) {
        // デモ値表示中は実際の受信値で上書きしない（見分けがつかなくなるため）
        guard !isDemoMode else { return }
        latestSignal = info
    }

    /// デモ用に信号の色を切り替える（DEBUG 限定。デモモード中のみ有効）。
    func setDemoSignal(_ color: SignalColor) {
        #if DEBUG
        guard isDemoMode else { return }
        latestSignal = Self.makeDemoSignal(color)
        #endif
    }

    private static func makeDemoSignal(_ color: SignalColor) -> SignalInfo {
        SignalInfo(color: color, remainingS: color == .flashing ? 5 : 12)
    }

    /// 信号を初期状態に戻す（デモ中はデモ値、そうでなければ nil）。
    private func resetSignal() {
        latestSignal = isDemoMode ? Self.makeDemoSignal(.green) : nil
    }

    private func makeCommand() -> TargetCommand {
        TargetCommand(
            targetCadence: targetCadence,
            mode: .manual,
            activityMode: activityMode,
            cadenceBaseline: cadenceBaseline,
            cadenceAdjustment: cadenceAdjustment,
            guidedCadence: guidedCadence,
            issuedAt: Date(),
            sessionID: sessionID
        )
    }

    private func sendCurrentTarget() {
        link.send(makeCommand())
    }

    // MARK: ワークアウト操作

    func start(mode: ActivityMode, measuredCadence: Int) {
        guard workoutState == .idle || workoutState == .ended else { return }
        guard goal?.isValid == true else { return }
        activityMode = mode
        cadenceBaseline = normalizedCadence(measuredCadence)
        cadenceAdjustment = 0
        targetCadence = cadenceBaseline
        guidedCadence = nil
        sessionID = UUID()
        accumulated = 0
        runStartedAt = Date()
        summary = nil
        resetMetrics()
        resetSignal()
        workoutState = .running
        screen = .session
        link.updateOutputSettings(outputSettings)
        sendCurrentTarget()
        link.workoutDidStart(sessionID: sessionID)
    }

    private func normalizedCadence(_ value: Int) -> Int {
        let range = activityMode == .walking ? 80...140 : 110...190
        return min(max(value, range.lowerBound), range.upperBound)
    }

    func pause() {
        guard workoutState == .running else { return }
        freezeElapsed()
        workoutState = .paused
        link.workoutDidPause()
    }

    func resume() {
        guard workoutState == .paused else { return }
        runStartedAt = Date()
        workoutState = .running
        link.workoutDidResume()
    }

    func end() {
        guard workoutState == .running || workoutState == .paused else { return }
        freezeElapsed()
        workoutState = .ended
        summary = SessionSummary(
            elapsed: accumulated,
            distance: latestMetrics?.distance,
            averageCadence: latestMetrics?.averageCadence,
            isDemo: isDemoMode,
            activityMode: activityMode
        )
        screen = .result
        link.workoutDidEnd(
            elapsed: summary?.elapsed ?? accumulated,
            distance: summary?.distance,
            averageCadence: summary?.averageCadence,
            activityMode: activityMode
        )
    }

    /// 結果画面からホームへ戻る。
    func returnHome() {
        workoutState = .idle
        accumulated = 0
        runStartedAt = nil
        summary = nil
        resetMetrics()
        resetSignal()
        screen = .home
    }

    /// 動いている時計を止めて accumulated に取り込む。
    private func freezeElapsed() {
        if let started = runStartedAt {
            accumulated += max(0, Date().timeIntervalSince(started))
        }
        runStartedAt = nil
    }

    // MARK: Watch からの入力

    private func handleMetrics(_ metrics: WatchMetrics) {
        // デモ値表示中は実測値で上書きしない（見分けがつかなくなるため）
        guard !isDemoMode else { return }
        latestMetrics = metrics
    }

    private func handleConnectionChange(_ state: WatchConnectionState) {
        connectionState = state
        outputSyncMessage = state == .connected ? "Watchへ反映中…" : "Watch接続時に設定を反映します"
        if state == .connected { link.updateOutputSettings(outputSettings) }
        // セッション中に再接続したら、現在の目標を送り直す
        if state == .connected, workoutState == .running || workoutState == .paused {
            sendCurrentTarget()
        }
    }

    // MARK: デモ値（DEBUG 限定）

    /// 固定のデモ値。実測と見分けられるよう、表示側で必ず「デモ値」バッジを付ける。
    private static func makeDemoMetrics() -> WatchMetrics {
        WatchMetrics(
            currentCadence: 158,
            heartRate: 142,
            distance: 3200,
            averageCadence: 156,
            receivedAt: Date()
        )
    }

    func setDemoMode(_ on: Bool) {
        #if DEBUG
        isDemoMode = on
        resetMetrics()
        resetSignal()
        #endif
    }

    /// 計測値を初期状態に戻す（デモ中はデモ値、そうでなければ nil）。
    private func resetMetrics() {
        latestMetrics = isDemoMode ? Self.makeDemoMetrics() : nil
    }

    // MARK: 表示ルール

    /// 値の表示規則:
    ///   未接続 -> 「未接続」 / 接続中だが nil -> 「未計測」 / それ以外は数値。
    ///   ケイデンス・心拍が nil や 0 以下のとき 0 とは表示しない（「未計測」にする）。
    func metricDisplay(_ value: Int?, unit: String) -> MetricDisplay {
        if !isDemoMode && connectionState == .notConnected {
            return MetricDisplay(text: "未接続", unit: unit, isPlaceholder: true, isDemo: false)
        }
        guard let v = value, v > 0 else {
            return MetricDisplay(text: "未計測", unit: unit, isPlaceholder: true, isDemo: false)
        }
        return MetricDisplay(text: "\(v)", unit: unit, isPlaceholder: false, isDemo: isDemoMode)
    }
}

// MARK: - 書式

private func formatElapsed(_ interval: TimeInterval) -> String {
    let total = max(0, Int(interval))
    let h = total / 3600
    let m = (total % 3600) / 60
    let s = total % 60
    if h > 0 {
        return String(format: "%d:%02d:%02d", h, m, s)
    }
    return String(format: "%02d:%02d", m, s)
}

/// 距離（m）の表示。1000m 以上は km も併記。nil / 不正値は「未取得」。
private func formatDistance(_ meters: Double?) -> String {
    guard let d = meters, d.isFinite, d >= 0 else { return "未取得" }
    let m = String(format: "%.0f m", d)
    if d >= 1000 {
        return m + String(format: "（%.2f km）", d / 1000)
    }
    return m
}

// MARK: - 共通パーツ

/// デモ値を示すバッジ。実測値と見分けるため、デモ表示のときは必ず出す。
struct DemoBadge: View {
    var body: some View {
        Text("デモ値")
            .font(.caption2.bold())
            .foregroundColor(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.orange))
            .accessibilityLabel("デモ値")
    }
}

/// Watch 接続状態の表示。
private struct ConnectionBadge: View {
    let state: WatchConnectionState

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(state == .connected ? Color.green : (state == .waitingForReachability ? Color.orange : Color.gray))
                .frame(width: 10, height: 10)
            Text("Watch：\(state.label)")
                .font(.subheadline.bold())
                .foregroundColor(state == .connected ? Color.green : (state == .waitingForReachability ? Color.orange : Color.secondary))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Capsule().fill(Color.secondary.opacity(0.12)))
    }
}

/// カードの背景。
private struct CardBackground: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(Color.secondary.opacity(0.12))
    }
}

/// 数値 1 つを表示するカード。
private struct MetricCard: View {
    let title: String
    let display: MetricDisplay

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                if display.isDemo {
                    DemoBadge()
                }
                Spacer()
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(display.text)
                    .font(.system(size: display.isPlaceholder ? 28 : 52, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(display.isPlaceholder ? Color.secondary : Color.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                if !display.isPlaceholder {
                    Text(display.unit)
                        .font(.headline)
                        .foregroundColor(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(CardBackground())
        .accessibilityElement(children: .combine)
    }
}

/// 自然な測定値を基準に、目標ケイデンスを5歩/分刻みで調整する。
private struct CadenceStepper: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 12) {
                Button { store.adjustTargetCadence(by: -5) } label: {
                    Image(systemName: "minus.circle.fill")
                        .font(.title2)
                }
                .opacity(store.targetCadence <= store.cadenceRange.lowerBound ? 0.45 : 1)

                Text("\(store.targetCadence) 歩/分")
                    .font(.title3.bold().monospacedDigit())
                    .contentTransition(.numericText())
                    .frame(minWidth: 112)
                    .multilineTextAlignment(.center)

                Button { store.adjustTargetCadence(by: 5) } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.title2)
                }
                .opacity(store.targetCadence >= store.cadenceRange.upperBound ? 0.45 : 1)
            }
            .buttonStyle(.plain)

            Text("目標を調整（5 歩/分刻み）")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - 画面 1: ホーム

private struct HomeView: View {
    @ObservedObject var store: SessionStore
    @ObservedObject var calibration: StrideCalibrationManager
    @State private var showGoalMap = false

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Text("RUNWAVE")
                    .font(.system(size: 40, weight: .heavy, design: .rounded))
                    .padding(.top, 24)

                ConnectionBadge(state: store.connectionState)

                goalCard

                VStack(alignment: .leading, spacing: 12) {
                    Text("測定した自然なケイデンス")
                        .font(.subheadline)
                        .foregroundColor(.secondary)

                    ForEach(ActivityMode.allCases) { mode in
                        HStack {
                            Label(mode.label, systemImage: mode.icon)
                            Spacer()
                            if let cadence = calibration.cadence(for: mode) {
                                Text("\(cadence) 歩/分")
                                    .font(.title3.bold().monospacedDigit())
                            } else {
                                Text("未測定").foregroundStyle(.secondary)
                            }
                        }
                    }
                    Text("開始時に選んだ運動の測定値を目標にします。セッション中は5歩/分刻みで調整できます。")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
                .background(CardBackground())

                if store.connectionState != .connected {
                    Text("Watch：\(store.connectionState.label)。WatchでRUNWAVEを開いてください。")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }

                #if DEBUG
                demoToggle
                #endif
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 10) {
                ForEach(ActivityMode.allCases) { mode in
                    Button {
                        guard let cadence = calibration.cadence(for: mode) else { return }
                        store.start(mode: mode, measuredCadence: cadence)
                    } label: {
                        Label(mode == .walking ? "歩いて開始" : "走って開始", systemImage: mode.icon)
                            .font(.subheadline.bold())
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .tint(mode == .running ? .green : .blue)
                    .disabled(store.goal == nil || calibration.stride(for: mode) == nil || calibration.cadence(for: mode) == nil)
                    .accessibilityLabel("\(mode.label)を開始")
                    .accessibilityHint(store.goal == nil ? "先に終了地点を設定してください" : "")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial)
        }
        .safeAreaInset(edge: .top) {
            HStack(spacing: 12) {
                ForEach(ActivityMode.allCases) { mode in
                    Label(mode.label, systemImage: mode.icon)
                        .font(.caption.bold())
                        .foregroundStyle(calibration.stride(for: mode) == nil ? .secondary : .primary)
                    if let stride = calibration.stride(for: mode) {
                        Text(String(format: "%.2fm", stride)).font(.caption.monospacedDigit())
                    } else {
                        Text("歩幅未測定").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial)
        }
        .sheet(isPresented: $showGoalMap) {
            GoalMapView(initialGoal: store.goal, activityModeLabel: store.goalSetupActivityMode?.label) { newGoal in
                if let point = newGoal {
                    store.setGoal(point)
                } else {
                    store.clearGoal()
                }
            }
            .onDisappear { store.clearGoalSetupRequest() }
        }
        .onChange(of: store.goalSetupRequested) { _, requested in
            if requested { showGoalMap = true }
        }
        .onAppear {
            if store.goalSetupRequested { showGoalMap = true }
        }
    }

    /// 終了地点カード（必須項目）。
    private var goalCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("終了地点（必須）")
                .font(.subheadline)
                .foregroundColor(.secondary)

            if let goal = store.goal {
                GoalPreviewMap(goal: goal)
                    .frame(height: 140)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                Text(goal.coordinateText)
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundColor(.secondary)
            } else {
                Text("未設定：開始前に地図で設定してください")
                    .font(.subheadline.bold())
                    .foregroundColor(.secondary)
            }

            Button {
                showGoalMap = true
            } label: {
                Label("地図で設定", systemImage: "map")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(CardBackground())
    }

    #if DEBUG
    private var demoToggle: some View {
        HStack(spacing: 8) {
            Toggle(isOn: Binding(
                get: { store.isDemoMode },
                set: { store.setDemoMode($0) }
            )) {
                HStack(spacing: 8) {
                    Text("デモ値で表示（DEBUG）")
                        .font(.subheadline)
                    if store.isDemoMode {
                        DemoBadge()
                    }
                }
            }
        }
        .padding(16)
        .background(CardBackground())
    }
    #endif
}

/// 選択した運動種別の歩幅を測定するカード。
private struct StrideCalibrationCard: View {
    @ObservedObject var store: SessionStore
    @ObservedObject var calibration: StrideCalibrationManager
    let mode: ActivityMode

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("\(mode.label)の歩幅", systemImage: mode.icon).font(.headline)
            if calibration.isMeasuring && calibration.measuringMode == mode {
                HStack(spacing: 12) {
                    measurementValue("距離", value: String(format: "%.0f m", calibration.distanceM))
                    measurementValue("歩数", value: "\(calibration.steps) 歩")
                    measurementValue("時間", value: elapsedText)
                }
                Button { calibration.finish() } label: {
                    Label("測定を完了", systemImage: "checkmark.circle").frame(maxWidth: .infinity)
                }.buttonStyle(.borderedProminent)
                Button("キャンセル", role: .cancel) { calibration.cancel() }.frame(maxWidth: .infinity)
            } else {
                if let stride = calibration.stride(for: mode) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(String(format: "%.2f", stride)).font(.system(size: 36, weight: .bold, design: .rounded)).monospacedDigit()
                        Text("m / 歩").font(.headline).foregroundStyle(.secondary)
                    }
                    if let cadence = calibration.cadence(for: mode) {
                        Text("測定中の平均ケイデンス：\(cadence) 歩/分").font(.subheadline).foregroundStyle(.secondary)
                    }
                } else {
                    Text("屋外でiPhoneを携帯し、\(mode == .walking ? "歩いて" : "走って")30m以上進むと測定できます。")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Button { calibration.start(mode: mode) } label: {
                    Label(calibration.stride(for: mode) == nil ? "測定を開始" : "測り直す", systemImage: "location.north.line").frame(maxWidth: .infinity)
                }.buttonStyle(.borderedProminent).disabled(calibration.isMeasuring)
            }
            if let message = calibration.errorMessage {
                Text(message).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            Text("GPS距離とiPhoneの歩数から計算します。測定中はアプリを開いたままにしてください。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(16).background(CardBackground())
    }

    private var elapsedText: String {
        let seconds = Int(calibration.elapsedS)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
    private func measurementValue(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.subheadline.bold()).monospacedDigit().lineLimit(1).minimumScaleFactor(0.75)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 運動種別ごとのラベル長に左右されない、同じ幅の切替ボタン。
private struct ActivityModePicker: View {
    @Binding var selection: ActivityMode
    var isDisabled = false

    var body: some View {
        HStack(spacing: 8) {
            ForEach(ActivityMode.allCases) { mode in
                Button {
                    selection = mode
                } label: {
                    Label(mode.label, systemImage: mode.icon)
                        .font(.subheadline.bold())
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(selection == mode ? Color.green.opacity(0.16) : Color.secondary.opacity(0.10))
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(selection == mode ? Color.green.opacity(0.55) : .clear, lineWidth: 1)
                        }
                        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isDisabled)
                .accessibilityAddTraits(selection == mode ? .isSelected : [])
            }
        }
        .frame(maxWidth: .infinity)
    }
}

private struct SettingsView: View {
    @ObservedObject var store: SessionStore
    @ObservedObject var calibration: StrideCalibrationManager
    @State private var calibrationMode: ActivityMode = .walking

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Text("設定").font(.largeTitle.bold()).frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .leading, spacing: 12) {
                    Text("マイ歩幅").font(.headline)
                    ActivityModePicker(selection: $calibrationMode, isDisabled: calibration.isMeasuring)
                    StrideCalibrationCard(store: store, calibration: calibration, mode: calibrationMode)
                }
                TempoOutputSettingsCard(store: store)
            }
            .padding(16)
        }
    }
}

private struct FirstStrideSetupView: View {
    @ObservedObject var store: SessionStore
    @ObservedObject var calibration: StrideCalibrationManager
    @State private var mode: ActivityMode = .walking

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Image(systemName: "figure.walk.motion").font(.system(size: 52)).foregroundStyle(.green)
                    Text("まずはマイ歩幅を測定").font(.title2.bold())
                    Text("RUNWAVEを使う前に、歩幅を1種類測定してください。ランニングとウォーキングは、あとからそれぞれ別に登録できます。")
                        .multilineTextAlignment(.center).foregroundStyle(.secondary)
                    ActivityModePicker(selection: $mode, isDisabled: calibration.isMeasuring)
                    StrideCalibrationCard(store: store, calibration: calibration, mode: mode)
                    Text("初回測定後にメイン画面が使えるようになります。未測定の運動は開始できません。")
                        .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }.padding(20)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .principal) { Text("初回設定").font(.headline) } }
        }
    }
}

// MARK: - 画面 2: セッション

private struct SessionView: View {
    @ObservedObject var store: SessionStore
    @State private var showEndConfirm = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // 画面上部: タイトル・接続状態・（デモ時のみ）デモ値バッジ
                HStack(spacing: 8) {
                    Label(store.activityMode.label, systemImage: store.activityMode.icon)
                        .font(.system(size: 22, weight: .heavy, design: .rounded))
                    if store.isDemoMode {
                        DemoBadge()
                    }
                    Spacer()
                    ConnectionBadge(state: store.connectionState)
                }
                .padding(.top, 8)

                // 目標ケイデンス
                VStack(alignment: .leading, spacing: 8) {
                    Text("目標ケイデンス")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(store.targetCadence)")
                            .font(.system(size: 52, weight: .bold, design: .rounded))
                            .monospacedDigit()
                        Text("歩/分")
                            .font(.headline)
                            .foregroundColor(.secondary)
                    }
                    CadenceStepper(store: store)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(CardBackground())

                // 信号のイラスト（受け取った値を描くだけ）
                VStack(alignment: .leading, spacing: 12) {
                    SignalLightView(signal: store.latestSignal, isDemo: store.isDemoMode)
                    #if DEBUG
                    if store.isDemoMode {
                        Picker("信号（デモ）", selection: Binding<SignalColor>(
                            get: { store.latestSignal?.color ?? SignalColor.green },
                            set: { store.setDemoSignal($0) }
                        )) {
                            Text("赤").tag(SignalColor.red)
                            Text("青").tag(SignalColor.green)
                            Text("青点滅").tag(SignalColor.flashing)
                        }
                        .pickerStyle(.segmented)
                    }
                    #endif
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(CardBackground())

                // 必須の終了地点の設定状況
                HStack(spacing: 8) {
                    Image(systemName: "mappin.and.ellipse")
                        .foregroundColor(.secondary)
                    Text(store.goal == nil ? "終了地点：未設定" : "終了地点：設定済み")
                        .font(.subheadline)
                        .foregroundColor(store.goal == nil ? Color.secondary : Color.primary)
                    Spacer()
                }
                .padding(.horizontal, 4)
                .accessibilityElement(children: .combine)

                // 現在ケイデンス
                MetricCard(
                    title: "現在ケイデンス",
                    display: store.metricDisplay(store.latestMetrics?.currentCadence, unit: "歩/分")
                )

                // 心拍数（ケイデンスとは別の値）
                MetricCard(
                    title: "心拍数",
                    display: store.metricDisplay(store.latestMetrics?.heartRate, unit: "拍/分")
                )

                // ワークアウト状態・経過時間
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("ワークアウト状態")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        Text(store.workoutState.label)
                            .font(.title2.bold())
                            .foregroundColor(stateColor)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("経過時間")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        // 毎秒再描画。一時停止中は elapsed(at:) が増えない。
                        TimelineView(.periodic(from: Date(), by: 1.0)) { context in
                            Text(formatElapsed(store.elapsed(at: context.date)))
                                .font(.system(size: 34, weight: .bold, design: .rounded))
                                .monospacedDigit()
                        }
                    }
                }
                .padding(16)
                .background(CardBackground())
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .safeAreaInset(edge: .bottom) {
            controls
        }
        .confirmationDialog(
            "ワークアウトを終了しますか？",
            isPresented: $showEndConfirm,
            titleVisibility: .visible
        ) {
            Button("終了する", role: .destructive) {
                store.end()
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("終了すると結果画面に移動します。")
        }
    }

    private var stateColor: Color {
        switch store.workoutState {
        case .running: return Color.green
        case .paused: return Color.orange
        case .idle, .ended: return Color.secondary
        }
    }

    private var controls: some View {
        HStack(spacing: 12) {
            if store.workoutState == .paused {
                Button {
                    store.resume()
                } label: {
                    Text("再開")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(.green)
            } else {
                Button {
                    store.pause()
                } label: {
                    Text("一時停止")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(.orange)
                .disabled(store.workoutState != .running)
            }

            Button {
                showEndConfirm = true
            } label: {
                Text("終了")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(.red)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
    }
}

// MARK: - 画面 3: 結果

private struct ResultView: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                HStack(spacing: 8) {
                    Label(store.summary?.activityMode.label ?? "結果", systemImage: store.summary?.activityMode.icon ?? "checkmark.circle")
                        .font(.system(size: 32, weight: .heavy, design: .rounded))
                    if store.summary?.isDemo == true {
                        DemoBadge()
                    }
                    Spacer()
                }
                .padding(.top, 24)

                resultCard(
                    title: "運動時間",
                    value: formatElapsed(store.summary?.elapsed ?? 0),
                    note: "iPhone で計測",
                    isPlaceholder: false
                )

                let distanceText = formatDistance(store.summary?.distance)
                resultCard(
                    title: "距離",
                    value: distanceText,
                    note: nil,
                    isPlaceholder: distanceText == "未取得"
                )

                let averageText = averageCadenceText
                resultCard(
                    title: "平均ケイデンス",
                    value: averageText,
                    note: nil,
                    isPlaceholder: averageText == "未取得"
                )
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .safeAreaInset(edge: .bottom) {
            Button {
                store.returnHome()
            } label: {
                Text("ホームへ戻る")
                    .font(.title3.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial)
        }
    }

    /// 平均ケイデンスの表示。nil / 0 以下は「未取得」（0 とは表示しない）。
    private var averageCadenceText: String {
        guard let v = store.summary?.averageCadence, v > 0 else { return "未取得" }
        return "\(v) 歩/分"
    }

    private func resultCard(title: String, value: String, note: String?, isPlaceholder: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline)
                .foregroundColor(.secondary)
            Text(value)
                .font(.system(size: isPlaceholder ? 28 : 40, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundColor(isPlaceholder ? Color.secondary : Color.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            if let note = note {
                Text(note)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(CardBackground())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - ルート

struct ContentView: View {
    @StateObject private var store: SessionStore
    @StateObject private var calibration = StrideCalibrationManager()

    init(link: any WatchLink = WatchConnectivityLink()) {
        _store = StateObject(wrappedValue: SessionStore(link: link))
    }

    var body: some View {
        Group {
            switch store.screen {
            case .home:
                if !calibration.hasAnyStride {
                    FirstStrideSetupView(store: store, calibration: calibration)
                } else {
                    TabView {
                        HomeView(store: store, calibration: calibration)
                            .tabItem { Label("メイン", systemImage: "figure.run") }
                        SettingsView(store: store, calibration: calibration)
                            .tabItem { Label("設定", systemImage: "slider.horizontal.3") }
                    }
                    .tint(.green)
                }
            case .session:
                SessionView(store: store)
            case .result:
                ResultView(store: store)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: store.screen)
    }
}

// MARK: - プレビュー（iOS 16 / Xcode 14 でも動く PreviewProvider 方式）

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView(link: NoWatchLink())
    }
}
