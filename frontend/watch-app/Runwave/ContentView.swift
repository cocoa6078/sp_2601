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
import Charts
import MapKit
import AVFoundation

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
        case .waitingForReachability: return "アプリ起動待ち"
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
    var onTargetCadenceChange: ((Int) -> Void)? { get set }
    var onOutputSettingsApplied: ((TempoOutputSettings) -> Void)? { get set }
    var onOutputError: ((String) -> Void)? { get set }
    func updateOutputSettings(_ settings: TempoOutputSettings)
    func previewOutput(targetCadence: Int, activityMode: ActivityMode)

    /// 目標コマンドを Watch へ送る
    func send(_ command: TargetCommand)

    // ワークアウトの状態変化の通知
    func workoutDidStart(sessionID: UUID, activityMode: ActivityMode)
    func workoutDidPause()
    func workoutDidResume()
    func workoutDidReachGoal(distanceToGoal: Double)
    func workoutDidContinueAfterGoal()
    func workoutDidEnd(elapsed: TimeInterval, distance: Double?, averageCadence: Int?, activityMode: ActivityMode)
}

/// プレビューや通信未使用時の代役。常に未接続で、何もしない。
final class NoWatchLink: WatchLink {
    var connectionState: WatchConnectionState { .notConnected }
    var onMetrics: ((WatchMetrics) -> Void)?
    var onConnectionChange: ((WatchConnectionState) -> Void)?
    var onGoalSetupRequested: ((String?) -> Void)?
    var onWorkoutControl: ((String) -> Void)?
    var onTargetCadenceChange: ((Int) -> Void)?
    var onOutputSettingsApplied: ((TempoOutputSettings) -> Void)?
    var onOutputError: ((String) -> Void)?
    func updateOutputSettings(_ settings: TempoOutputSettings) {}
    func previewOutput(targetCadence: Int, activityMode: ActivityMode) {}

    func send(_ command: TargetCommand) {}
    func workoutDidStart(sessionID: UUID, activityMode: ActivityMode) {}
    func workoutDidPause() {}
    func workoutDidResume() {}
    func workoutDidReachGoal(distanceToGoal: Double) {}
    func workoutDidContinueAfterGoal() {}
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
    var activityMode: ActivityMode
}

/// 端末内に保存するワークアウト履歴。
struct WorkoutRecord: Identifiable, Codable, Equatable {
    var id: UUID
    var date: Date
    var activityMode: ActivityMode
    var elapsed: TimeInterval
    var distance: Double?
    var averageCadence: Int?
    var route: [WorkoutCoordinate]
    var speedSamples: [WorkoutSpeedSample]
    var stopCount: Int

    init(summary: SessionSummary, date: Date = Date(), route: [WorkoutCoordinate] = [], speedSamples: [WorkoutSpeedSample] = [], stopCount: Int = 0) {
        id = UUID()
        self.date = date
        activityMode = summary.activityMode
        elapsed = summary.elapsed
        distance = summary.distance
        averageCadence = summary.averageCadence
        self.route = route
        self.speedSamples = speedSamples
        self.stopCount = stopCount
    }

    private enum CodingKeys: String, CodingKey { case id, date, activityMode, elapsed, distance, averageCadence, route, speedSamples, stopCount }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        date = try values.decode(Date.self, forKey: .date)
        activityMode = try values.decode(ActivityMode.self, forKey: .activityMode)
        elapsed = try values.decode(TimeInterval.self, forKey: .elapsed)
        distance = try values.decodeIfPresent(Double.self, forKey: .distance)
        averageCadence = try values.decodeIfPresent(Int.self, forKey: .averageCadence)
        route = try values.decodeIfPresent([WorkoutCoordinate].self, forKey: .route) ?? []
        speedSamples = try values.decodeIfPresent([WorkoutSpeedSample].self, forKey: .speedSamples) ?? []
        stopCount = try values.decodeIfPresent(Int.self, forKey: .stopCount) ?? 0
    }

    private static let storageKey = "runwave.workoutRecords.v1"

    static func load() -> [WorkoutRecord] {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let records = try? JSONDecoder().decode([WorkoutRecord].self, from: data) else { return [] }
        return records.sorted { $0.date > $1.date }
    }

    static func save(_ records: [WorkoutRecord]) {
        guard let data = try? JSONEncoder().encode(records) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }
}

/// 1 つの数値を画面に出すときの表示内容。
struct MetricDisplay {
    let text: String
    let unit: String
    /// 「未接続」「未計測」など、数値ではない表示か
    let isPlaceholder: Bool
}

// MARK: - 状態管理

@MainActor
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
    @Published private(set) var workoutRecords = WorkoutRecord.load()
    /// 終了地点。未設定の場合はセッションを開始できない。
    /// TODO(連携): 終了地点を送るかは Watch/シミュレーターと要合意（現状は iPhone 内のみで保持）
    @Published private(set) var outputSettings = TempoOutputSettings.load()
    @Published private(set) var outputSyncMessage = "Watch接続時に設定を反映します"
    @Published private(set) var goal: GoalPoint?
    @Published private(set) var showGoalApproach = false
    @Published private(set) var goalApproachDistanceM = 20.0
    @Published private(set) var goalSetupRequested = false
    @Published private(set) var goalSetupActivityMode: ActivityMode?
    /// 最後に受け取った信号情報。nil は未受信。iPhone では色を計算しない。
    @Published private(set) var latestSignal: SignalInfo?
    let routeTracker = WorkoutRouteTracker()
    let navigation = RouteNavigation()
    private let iphoneTempoOutputPlayer = IPhoneTempoOutputPlayer()
    private let goalSpeechSynthesizer = AVSpeechSynthesizer()
    private let goalAudioSession = AVAudioSession.sharedInstance()
    private var goalApproachPresentedThisSession = false

    // MARK: 経過時間（iPhone の時計で積算。一時停止中は増えない）
    private var accumulated: TimeInterval = 0
    private var runStartedAt: Date?
    private var cadenceAdjustment = 0

    private let link: any WatchLink

    init(link: any WatchLink = NoWatchLink()) {
        self.link = link
        self.connectionState = link.connectionState

        routeTracker.onMetrics = { [weak self] cadence, distance, averageCadence in
            guard let self else { return }
            let old = self.latestMetrics
            self.latestMetrics = WatchMetrics(
                currentCadence: cadence ?? old?.currentCadence,
                heartRate: old?.heartRate,
                distance: distance > 0 ? distance : old?.distance,
                averageCadence: averageCadence ?? old?.averageCadence,
                receivedAt: Date()
            )
        }
        routeTracker.onLocation = { [weak self] location in
            guard let self else { return }
            self.navigation.update(location)
            self.checkGoalApproach(self.routeTracker.distanceToGoalM)
        }

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
        link.onTargetCadenceChange = { [weak self] cadence in
            DispatchQueue.main.async {
                self?.applyWatchTargetCadence(cadence)
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
        guidedCadence = nil
        // ホームでの変更は「開始時」にまとめて送る。セッション中だけ即時送信する。
        if workoutState == .running || workoutState == .paused {
            sendCurrentTarget()
        }
        updateIPhoneTempoOutput()
    }

    /// Watchから受けた値はiPhone表示へ反映し、Watchへ送り返さない。
    private func applyWatchTargetCadence(_ value: Int) {
        let range = cadenceRange
        let bounded = min(max(value, range.lowerBound), range.upperBound)
        targetCadence = bounded
        cadenceAdjustment = bounded - cadenceBaseline
        guidedCadence = nil
        updateIPhoneTempoOutput()
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
        guidedCadence = nil
        if workoutState == .running || workoutState == .paused { sendCurrentTarget() }
        updateIPhoneTempoOutput()
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
        updateIPhoneTempoOutput()
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
        updateIPhoneTempoOutput()
    }

    func previewOutput() {
        guard outputSettings.mode != .off else { return }
        if outputSettings.mode == .iphoneAudio {
            iphoneTempoOutputPlayer.preview(cadence: guidedCadence ?? targetCadence, volume: outputSettings.volume)
            return
        }
        guard connectionState == .connected else { return }
        link.previewOutput(targetCadence: targetCadence, activityMode: activityMode)
    }

    private func updateIPhoneTempoOutput() {
        iphoneTempoOutputPlayer.update(
            isRunning: workoutState == .running,
            mode: outputSettings.mode,
            cadence: guidedCadence ?? targetCadence,
            volume: outputSettings.volume
        )
    }

    func refreshIPhoneTempoOutput() {
        guard workoutState == .running, outputSettings.mode == .iphoneAudio else { return }
        iphoneTempoOutputPlayer.resumeIfNeeded()
    }

    // MARK: 終了地点

    /// 終了地点を設定する。緯度経度が不正な値なら無視する。
    func setGoal(_ point: GoalPoint, route: MKRoute? = nil) {
        guard point.isValid else { return }
        navigation.select(route)
        goal = point
    }

    /// 終了地点を未設定に戻す。
    func clearGoal() {
        navigation.select(nil)
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
        latestSignal = info
    }

    /// 信号を初期状態に戻す。
    private func resetSignal() {
        latestSignal = nil
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
        guard goal?.isValid == true, navigation.selectedRoute != nil else { return }
        activityMode = mode
        cadenceBaseline = normalizedCadence(measuredCadence)
        cadenceAdjustment = 0
        targetCadence = cadenceBaseline
        guidedCadence = nil
        sessionID = UUID()
        accumulated = 0
        runStartedAt = Date()
        summary = nil
        showGoalApproach = false
        goalApproachPresentedThisSession = false
        resetMetrics()
        resetSignal()
        workoutState = .running
        screen = .session
        routeTracker.goal = goal
        navigation.start(goal: goal)
        updateIPhoneTempoOutput()
        routeTracker.start()
        link.updateOutputSettings(outputSettings)
        sendCurrentTarget()
        link.workoutDidStart(sessionID: sessionID, activityMode: activityMode)
    }

    private func normalizedCadence(_ value: Int) -> Int {
        let range = activityMode == .walking ? 80...140 : 110...190
        return min(max(value, range.lowerBound), range.upperBound)
    }

    func pause() {
        guard workoutState == .running else { return }
        freezeElapsed()
        workoutState = .paused
        updateIPhoneTempoOutput()
        routeTracker.pause()
        navigation.pause()
        link.workoutDidPause()
    }

    func resume() {
        guard workoutState == .paused else { return }
        runStartedAt = Date()
        workoutState = .running
        updateIPhoneTempoOutput()
        routeTracker.resume()
        navigation.resume()
        link.workoutDidResume()
    }

    func end() {
        guard workoutState == .running || workoutState == .paused else { return }
        freezeElapsed()
        let measured = routeTracker.finish()
        navigation.stop()
        workoutState = .ended
        updateIPhoneTempoOutput()
        let finishedSummary = SessionSummary(
            elapsed: accumulated,
            distance: measured.distance ?? latestMetrics?.distance,
            averageCadence: measured.averageCadence ?? latestMetrics?.averageCadence,
            activityMode: activityMode
        )
        summary = finishedSummary
        workoutRecords.insert(WorkoutRecord(
            summary: finishedSummary,
            route: routeTracker.route.map(WorkoutCoordinate.init),
            speedSamples: routeTracker.speedSamples,
            stopCount: routeTracker.stopCount
        ), at: 0)
        WorkoutRecord.save(workoutRecords)
        screen = .result
        showGoalApproach = false
        link.workoutDidEnd(
            elapsed: summary?.elapsed ?? accumulated,
            distance: summary?.distance,
            averageCadence: summary?.averageCadence,
            activityMode: activityMode
        )
    }

    /// ゴールまで20m以内に入ったとき、セッション中に一度だけ音声と案内画面を出す。
    func checkGoalApproach(_ distance: Double?) {
        guard workoutState == .running,
              !goalApproachPresentedThisSession,
              !navigation.isOffRoute,
              (navigation.remainingDistance ?? .infinity) <= 30,
              let distance, distance.isFinite, distance <= 20 else { return }
        navigation.pause()
        goalApproachPresentedThisSession = true
        goalApproachDistanceM = max(0, distance)
        showGoalApproach = true
        link.workoutDidReachGoal(distanceToGoal: goalApproachDistanceM)
        announceGoal()
    }

    func dismissGoalApproach() {
        guard showGoalApproach else { return }
        showGoalApproach = false
        if workoutState == .running {
            navigation.resume()
            link.workoutDidContinueAfterGoal()
        }
    }

    private func announceGoal() {
        // mixWithOthers keeps the user's music playing under the spoken goal cue.
        try? goalAudioSession.setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers])
        try? goalAudioSession.setActive(true)
        let utterance = AVSpeechUtterance(string: "ゴール")
        utterance.voice = AVSpeechSynthesisVoice(language: "ja-JP")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        goalSpeechSynthesizer.speak(utterance)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self else { return }
            // Restore background-capable, non-interrupting playback after the short cue.
            try? self.goalAudioSession.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        }
    }

    /// 結果画面からホームへ戻る。
    func returnHome() {
        workoutState = .idle
        updateIPhoneTempoOutput()
        accumulated = 0
        runStartedAt = nil
        summary = nil
        resetMetrics()
        routeTracker.reset()
        resetSignal()
        screen = .home
    }

    func deleteWorkoutRecord(_ id: UUID) {
        workoutRecords.removeAll { $0.id == id }
        WorkoutRecord.save(workoutRecords)
    }

    func deleteWorkoutRecords(_ ids: Set<UUID>) {
        guard !ids.isEmpty else { return }
        workoutRecords.removeAll { ids.contains($0.id) }
        WorkoutRecord.save(workoutRecords)
    }

    func clearWorkoutRecords() {
        workoutRecords.removeAll()
        WorkoutRecord.save(workoutRecords)
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
        let previous = latestMetrics
        latestMetrics = WatchMetrics(
            currentCadence: metrics.currentCadence ?? previous?.currentCadence,
            heartRate: metrics.heartRate ?? previous?.heartRate,
            distance: metrics.distance ?? previous?.distance,
            averageCadence: metrics.averageCadence ?? previous?.averageCadence,
            receivedAt: metrics.receivedAt
        )
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

    /// 計測値を初期状態に戻す。
    private func resetMetrics() {
        latestMetrics = nil
    }

    // MARK: 表示ルール

    /// 値の表示規則:
    ///   未接続 -> 「未接続」 / 接続中だが nil -> 「未計測」 / それ以外は数値。
    ///   ケイデンス・心拍が nil や 0 以下のとき 0 とは表示しない（「未計測」にする）。
    func metricDisplay(_ value: Int?, unit: String) -> MetricDisplay {
        if connectionState == .notConnected {
            return MetricDisplay(text: "未接続", unit: unit, isPlaceholder: true)
        }
        guard let v = value, v > 0 else {
            return MetricDisplay(text: "未計測", unit: unit, isPlaceholder: true)
        }
        return MetricDisplay(text: "\(v)", unit: unit, isPlaceholder: false)
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

private struct CompactConnectionStatus: View {
    let state: WatchConnectionState

    private var color: Color {
        state == .connected ? .green : (state == .waitingForReachability ? .orange : .secondary)
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(statusText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    private var statusText: String {
        switch state {
        case .connected: "Watch 接続中"
        case .waitingForReachability: "Watch アプリ起動待ち"
        case .watchAppNotInstalled: "Watch アプリ未インストール"
        case .notPaired: "Watch 未ペアリング"
        case .notConnected: "Watch 未接続"
        }
    }
}

/// カードの背景。
struct CardBackground: View {
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
        VStack(spacing: 8) {
            HStack(spacing: 22) {
                Button { store.adjustTargetCadence(by: -5) } label: {
                    Image(systemName: "minus")
                        .font(.title2.bold())
                        .foregroundStyle(.primary)
                        .frame(width: 58, height: 58)
                        .background(Circle().fill(Color.secondary.opacity(0.13)))
                }
                .buttonStyle(.plain)
                .disabled(store.targetCadence <= store.cadenceRange.lowerBound)
                .opacity(store.targetCadence <= store.cadenceRange.lowerBound ? 0.45 : 1)

                Text("\(store.targetCadence) 歩/分")
                    .font(.title3.bold().monospacedDigit())
                    .contentTransition(.numericText())
                    .frame(minWidth: 122)
                    .multilineTextAlignment(.center)

                Button { store.adjustTargetCadence(by: 5) } label: {
                    Image(systemName: "plus")
                        .font(.title2.bold())
                        .foregroundStyle(.primary)
                        .frame(width: 58, height: 58)
                        .background(Circle().fill(Color.secondary.opacity(0.13)))
                }
                .buttonStyle(.plain)
                .disabled(store.targetCadence >= store.cadenceRange.upperBound)
                .opacity(store.targetCadence >= store.cadenceRange.upperBound ? 0.45 : 1)
            }
            .frame(maxWidth: .infinity)

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
    @StateObject private var currentLocation = CurrentLocationObserver()

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                HStack(spacing: 14) {
                    Image("RunwaveLogo")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 88, height: 56)
                    VStack(alignment: .leading, spacing: 5) {
                        Image("RunwaveWordmark")
                            .resizable()
                            .renderingMode(.template)
                            .scaledToFit()
                            .foregroundStyle(.primary)
                            .frame(width: 155, height: 25, alignment: .leading)
                        CompactConnectionStatus(state: store.connectionState)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 24)

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
                    .disabled(store.goal == nil || store.navigation.selectedRoute == nil || calibration.stride(for: mode) == nil || calibration.cadence(for: mode) == nil)
                    .accessibilityLabel("\(mode.label)を開始")
                    .accessibilityHint(store.goal == nil ? "先に終了地点を設定してください" : "")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial)
        }
        .sheet(isPresented: $showGoalMap) {
            GoalMapView(
                initialGoal: store.goal,
                locationObserver: currentLocation,
                activityModeLabel: store.goalSetupActivityMode?.label
            ) { newGoal, route in
                if let point = newGoal {
                    store.setGoal(point, route: route)
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
            currentLocation.start()
            if store.goalSetupRequested { showGoalMap = true }
        }
        .onDisappear { currentLocation.stop() }
    }

    /// 終了地点カード（必須項目）。
    private var goalCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("終了地点（必須）")
                .font(.subheadline)
                .foregroundColor(.secondary)

            GoalPreviewMap(goal: store.goal, currentLocation: currentLocation.coordinate, plannedRoute: store.navigation.selectedRoute)
                .frame(height: 140)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            if currentLocation.coordinate == nil {
                Label(
                    currentLocation.isDenied ? "位置情報を許可すると現在地を表示します" : "現在地を取得中",
                    systemImage: "location"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            if let goal = store.goal {
                Text(store.navigation.selectedRoute.map { "徒歩ルート \($0.distance.formattedRouteDistance)・曲がり角を音声で案内" } ?? goal.coordinateText)
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundColor(.secondary)
            } else {
                Text(currentLocation.coordinate == nil ? "現在地を取得中・終了地点は未設定です" : "終了地点は未設定です")
                    .font(.subheadline.bold())
                    .foregroundColor(.secondary)
            }

            Button {
                showGoalMap = true
            } label: {
                Label("地図で終了地点・経路を設定", systemImage: "map")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(CardBackground())
    }

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
                    measurementValue("距離", value: String(format: "%.1f m", calibration.distanceM))
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

private struct RecordsView: View {
    fileprivate static let rowDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy/MM/dd HH:mm"
        return formatter
    }()

    @ObservedObject var store: SessionStore
    @State private var showClearConfirmation = false
    @State private var editMode: EditMode = .inactive
    @State private var selectedRecordIDs = Set<UUID>()

    var body: some View {
        NavigationStack {
            Group {
                if store.workoutRecords.isEmpty {
                    ContentUnavailableView(
                        "記録はまだありません",
                        systemImage: "figure.run",
                        description: Text("ワークアウトを終了すると、ここに記録されます。")
                    )
                } else {
                    List(selection: $selectedRecordIDs) {
                        ForEach(store.workoutRecords) { record in
                            NavigationLink {
                                WorkoutRecordDetailView(record: record)
                            } label: {
                                recordRow(record)
                            }
                                .swipeActions {
                                    Button(role: .destructive) {
                                        store.deleteWorkoutRecord(record.id)
                                    } label: {
                                        Label("削除", systemImage: "trash")
                                    }
                                }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .environment(\.editMode, $editMode)
                }
            }
            .navigationTitle("記録")
            .toolbar {
                if !store.workoutRecords.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(editMode.isEditing ? "完了" : "編集") {
                            withAnimation {
                                editMode = editMode.isEditing ? .inactive : .active
                                if !editMode.isEditing { selectedRecordIDs.removeAll() }
                            }
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if editMode.isEditing {
                            Button("削除 (\(selectedRecordIDs.count))", role: .destructive) {
                                store.deleteWorkoutRecords(selectedRecordIDs)
                                selectedRecordIDs.removeAll()
                                editMode = .inactive
                            }
                            .disabled(selectedRecordIDs.isEmpty)
                        } else {
                            Button("すべて削除", role: .destructive) {
                                showClearConfirmation = true
                            }
                        }
                    }
                }
            }
            .confirmationDialog("すべての記録を削除しますか？", isPresented: $showClearConfirmation, titleVisibility: .visible) {
                Button("すべて削除", role: .destructive) { store.clearWorkoutRecords() }
                Button("キャンセル", role: .cancel) {}
            }
        }
    }

    private func recordRow(_ record: WorkoutRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(record.activityMode.label, systemImage: record.activityMode.icon)
                    .font(.headline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .layoutPriority(1)
                Spacer()
                Text(Self.rowDateFormatter.string(from: record.date))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            HStack(spacing: 14) {
                Label(formatElapsed(record.elapsed), systemImage: "clock")
                Label(formatDistance(record.distance), systemImage: "figure.run")
                if let cadence = record.averageCadence, cadence > 0 {
                    Label("\(cadence)歩/分", systemImage: "metronome")
                }
            }
            .font(.subheadline.monospacedDigit())
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 5)
    }
}

private struct WorkoutRecordDetailView: View {
    let record: WorkoutRecord

    private var routeCoordinates: [CLLocationCoordinate2D] { record.route.map(\.coordinate) }
    private var averageSpeedKPH: Double? {
        guard let distance = record.distance, record.elapsed > 0 else { return nil }
        return distance / record.elapsed * 3.6
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 8) {
                    Label(record.activityMode.label, systemImage: record.activityMode.icon)
                        .font(.headline)
                    Spacer()
                }
                Text(RecordsView.rowDateFormatter.string(from: record.date))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                if routeCoordinates.count > 1 {
                    WorkoutRouteMap(route: routeCoordinates, goal: nil)
                        .frame(height: 260)
                } else {
                    ContentUnavailableView(
                        "経路データがありません",
                        systemImage: "map",
                        description: Text("位置情報が取得できたワークアウトでは、ここに走行経路が表示されます。")
                    )
                    .frame(height: 220)
                }

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    metric("距離", formatDistance(record.distance), icon: "figure.run")
                    metric("時間", formatElapsed(record.elapsed), icon: "clock")
                    metric("平均速度", averageSpeedKPH.map { String(format: "%.1f km/h", $0) } ?? "未計測", icon: "speedometer")
                    metric("停止回数", "\(record.stopCount)回", icon: "pause.circle")
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("速度の推移").font(.headline)
                    if record.speedSamples.count > 1 {
                        Chart(record.speedSamples) { sample in
                            AreaMark(
                                x: .value("経過時間", sample.elapsed),
                                y: .value("速度", sample.speedKPH)
                            )
                            .foregroundStyle(.blue.opacity(0.12))
                            LineMark(
                                x: .value("経過時間", sample.elapsed),
                                y: .value("速度", sample.speedKPH)
                            )
                            .foregroundStyle(.blue)
                            .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        }
                        .chartYAxisLabel("km/h")
                        .chartXAxisLabel("経過時間")
                        .frame(height: 210)
                    } else {
                        Text("速度データはまだありません。次回のワークアウトから記録します。")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 100, alignment: .leading)
                    }
                    Text("停止回数は、GPS速度が0.5 m/s以下で3秒以上続いた回数です。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(16)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .padding(16)
        }
        .navigationTitle("記録の詳細")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func metric(_ title: String, _ value: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(title, systemImage: icon).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.bold().monospacedDigit()).lineLimit(1).minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, minHeight: 66, alignment: .leading)
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
    @ObservedObject var routeTracker: WorkoutRouteTracker
    @ObservedObject var navigation: RouteNavigation
    @State private var showEndConfirm = false

    init(store: SessionStore) {
        self.store = store
        self.routeTracker = store.routeTracker
        self.navigation = store.navigation
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // 画面上部: タイトル・接続状態
                HStack(spacing: 8) {
                    Label(store.activityMode.label, systemImage: store.activityMode.icon)
                        .font(.system(size: 22, weight: .heavy, design: .rounded))
                    Spacer()
                    ConnectionBadge(state: store.connectionState)
                }
                .padding(.top, 8)

                // 目標ケイデンス
                VStack(alignment: .leading, spacing: 8) {
                    Text("目標ケイデンス")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    HStack(alignment: .center) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(store.targetCadence)")
                                .font(.system(size: 52, weight: .bold, design: .rounded))
                                .monospacedDigit()
                            Text("歩/分")
                                .font(.headline)
                                .foregroundColor(.secondary)
                        }
                        Spacer(minLength: 8)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("現在")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(store.latestMetrics?.currentCadence.map(String.init) ?? "--")
                                .font(.system(size: 28, weight: .semibold, design: .rounded))
                                .monospacedDigit()
                                .foregroundStyle(.cyan)
                            Text("歩/分")
                                .font(.caption2)
                                .foregroundStyle(.cyan)
                        }
                    }
                    CadenceStepper(store: store)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(CardBackground())

                // 心拍数はWatchのHealthKitワークアウトで取得する。
                MetricCard(
                    title: "心拍数",
                    display: store.metricDisplay(store.latestMetrics?.heartRate, unit: "拍/分")
                )

                // 信号のイラスト（受け取った値を描くだけ）
                VStack(alignment: .leading, spacing: 12) {
                    SignalLightView(signal: store.latestSignal)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(CardBackground())

                NavigationInstructionCard(navigation: navigation)
                WorkoutRouteMap(route: routeTracker.route, goal: store.goal, plannedRoute: navigation.selectedRoute)
                    .frame(height: 210)
                HStack {
                    Label("距離", systemImage: "figure.run")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(formatDistance(store.latestMetrics?.distance))
                        .font(.headline.monospacedDigit())
                }
                .padding(.horizontal, 4)
                if let message = routeTracker.statusMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

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
        .fullScreenCover(isPresented: Binding(
            get: { store.showGoalApproach },
            set: { if !$0 { store.dismissGoalApproach() } }
        )) {
            GoalApproachView(store: store)
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

private struct GoalApproachView: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "flag.checkered")
                .font(.system(size: 76, weight: .medium))
                .foregroundStyle(.green)
                .accessibilityHidden(true)

            VStack(spacing: 8) {
                Text("ゴール")
                    .font(.system(size: 42, weight: .heavy, design: .rounded))
                Text("ゴールまで約\(Int(store.goalApproachDistanceM.rounded()))mです")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }

            Spacer()
            VStack(spacing: 12) {
                Button {
                    store.end()
                } label: {
                    Text("ゴールして終了")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(.green)

                Button("走り続ける") {
                    store.dismissGoalApproach()
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            LinearGradient(
                colors: [Color.green.opacity(0.12), Color(uiColor: .systemBackground)],
                startPoint: .top,
                endPoint: .bottom
            ).ignoresSafeArea()
        }
        .interactiveDismissDisabled()
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
    @Environment(\.scenePhase) private var scenePhase

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
                        RecordsView(store: store)
                            .tabItem { Label("記録", systemImage: "clock.arrow.circlepath") }
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
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.refreshIPhoneTempoOutput() }
        }
    }
}

// MARK: - プレビュー（iOS 16 / Xcode 14 でも動く PreviewProvider 方式）

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView(link: NoWatchLink())
    }
}
