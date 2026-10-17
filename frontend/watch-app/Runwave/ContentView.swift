//
//  ContentView.swift
//  Runwave (RUNWAVE / JPHACKS)
//
//  iPhone 側 UI（ホーム / セッション / 結果）を 1 ファイルにまとめたもの。
//  Windows で作成（ビルド未確認）。説明は frontend/iP実装メモ.md。
//  .pbxproj への登録を不要にするため、全ての型をこのファイルに入れている。
//
//  - 対象: iOS 16+（ObservableObject / @Published / @StateObject。@Observable・#Preview は使わない）
//  - WatchConnectivity は WatchConnectivityLink.swift に分離
//  - 信号・到着予測・目標ケイデンスの計算は書かない（目標は手動設定のみ）
//

import SwiftUI
import Foundation
import Combine

// MARK: - 基本の型

/// Apple Watch との接続状態。
enum WatchConnectionState: Equatable {
    case notConnected
    case connected

    var label: String {
        switch self {
        case .notConnected: return "未接続"
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

    /// 目標コマンドを Watch へ送る
    func send(_ command: TargetCommand)

    // ワークアウトの状態変化の通知
    func workoutDidStart(sessionID: UUID)
    func workoutDidPause()
    func workoutDidResume()
    func workoutDidEnd()
}

/// プレビューや通信未使用時の代役。常に未接続で、何もしない。
final class NoWatchLink: WatchLink {
    var connectionState: WatchConnectionState { .notConnected }
    var onMetrics: ((WatchMetrics) -> Void)?
    var onConnectionChange: ((WatchConnectionState) -> Void)?

    func send(_ command: TargetCommand) {}
    func workoutDidStart(sessionID: UUID) {}
    func workoutDidPause() {}
    func workoutDidResume() {}
    func workoutDidEnd() {}
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
    static let minCadence = 120
    static let maxCadence = 190
    static let defaultCadence = 160

    // MARK: 公開状態
    @Published private(set) var targetCadence: Int = SessionStore.defaultCadence
    @Published private(set) var connectionState: WatchConnectionState
    @Published private(set) var workoutState: WorkoutState = .idle
    @Published private(set) var latestMetrics: WatchMetrics?
    @Published private(set) var sessionID: UUID = UUID()
    @Published private(set) var screen: AppScreen = .home
    @Published private(set) var summary: SessionSummary?
    /// DEBUG ビルドでのみ true にできる（リリースでは常に false）
    @Published private(set) var isDemoMode: Bool = false

    // MARK: 経過時間（iPhone の時計で積算。一時停止中は増えない）
    private var accumulated: TimeInterval = 0
    private var runStartedAt: Date?

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

    /// 目標ケイデンスを変更する（120...190 にクランプ）。セッション中なら Watch へ送る。
    func setTargetCadence(_ value: Int) {
        let clamped = min(max(value, Self.minCadence), Self.maxCadence)
        guard clamped != targetCadence else { return }
        targetCadence = clamped
        // ホームでの変更は「開始時」にまとめて送る。セッション中だけ即時送信する。
        if workoutState == .running || workoutState == .paused {
            sendCurrentTarget()
        }
    }

    private func makeCommand() -> TargetCommand {
        TargetCommand(
            targetCadence: targetCadence,
            mode: .manual,
            issuedAt: Date(),
            sessionID: sessionID
        )
    }

    private func sendCurrentTarget() {
        link.send(makeCommand())
    }

    // MARK: ワークアウト操作

    func start() {
        guard workoutState == .idle || workoutState == .ended else { return }
        sessionID = UUID()
        accumulated = 0
        runStartedAt = Date()
        summary = nil
        resetMetrics()
        workoutState = .running
        screen = .session
        link.workoutDidStart(sessionID: sessionID)
        sendCurrentTarget()
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
            isDemo: isDemoMode
        )
        screen = .result
        link.workoutDidEnd()
    }

    /// 結果画面からホームへ戻る。
    func returnHome() {
        workoutState = .idle
        accumulated = 0
        runStartedAt = nil
        summary = nil
        resetMetrics()
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
private struct DemoBadge: View {
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
                .fill(state == .connected ? Color.green : Color.gray)
                .frame(width: 10, height: 10)
            Text("Watch：\(state.label)")
                .font(.subheadline.bold())
                .foregroundColor(state == .connected ? Color.green : Color.secondary)
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

/// 目標ケイデンスを 1 刻みで調整する Stepper。
private struct CadenceStepper: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        Stepper(
            value: Binding(
                get: { store.targetCadence },
                set: { store.setTargetCadence($0) }
            ),
            in: SessionStore.minCadence...SessionStore.maxCadence,
            step: 1
        ) {
            Text("目標を調整（1 歩/分刻み）")
                .font(.subheadline)
        }
    }
}

// MARK: - 画面 1: ホーム

private struct HomeView: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Text("RUNWAVE")
                    .font(.system(size: 40, weight: .heavy, design: .rounded))
                    .padding(.top, 24)

                ConnectionBadge(state: store.connectionState)

                VStack(alignment: .leading, spacing: 12) {
                    Text("目標ケイデンス")
                        .font(.subheadline)
                        .foregroundColor(.secondary)

                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(store.targetCadence)")
                            .font(.system(size: 80, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                        Text("歩/分（SPM）")
                            .font(.title3.bold())
                            .foregroundColor(.secondary)
                    }
                    .accessibilityElement(children: .combine)

                    CadenceStepper(store: store)

                    Text("範囲：\(SessionStore.minCadence)〜\(SessionStore.maxCadence) 歩/分")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
                .background(CardBackground())

                if store.connectionState == .notConnected {
                    Text("Watch未接続：目標値はこの iPhone 内で保持されます")
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
            Button {
                store.start()
            } label: {
                Text("セッション開始")
                    .font(.title3.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(.green)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial)
        }
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

// MARK: - 画面 2: セッション

private struct SessionView: View {
    @ObservedObject var store: SessionStore
    @State private var showEndConfirm = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // 画面上部: タイトル・接続状態・（デモ時のみ）デモ値バッジ
                HStack(spacing: 8) {
                    Text("RUNWAVE")
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
                    Text("結果")
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

    init(link: any WatchLink = WatchConnectivityLink()) {
        _store = StateObject(wrappedValue: SessionStore(link: link))
    }

    var body: some View {
        // NavigationStack は使わない。画面は store.screen で切り替えるので、
        // スワイプバックなどでセッションが壊れない。
        Group {
            switch store.screen {
            case .home:
                HomeView(store: store)
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
