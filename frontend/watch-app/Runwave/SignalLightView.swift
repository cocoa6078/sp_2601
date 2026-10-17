//
//  SignalLightView.swift
//  Runwave (RUNWAVE / JPHACKS)
//
//  歩行者用信号（赤・青）のイラスト。iPhone では信号の色を計算せず、受け取った値を描くだけ。
//  Windows で作成（ビルド未確認）。
//
//  - 色だけで判別させない: 赤は「立っている人」、青は「歩いている人」のアイコン＋テキスト
//  - 点灯中は明るく、消灯中は薄く（opacity 0.15）
//  - 青点滅は約 0.5 秒周期（0.25 秒ごとに点灯 / 消灯を切り替え）
//

import SwiftUI
import Foundation

// MARK: - 型

/// 信号の色。core の state.signal.color と同じ値。
enum SignalColor: String, CaseIterable {
    case green
    case flashing
    case red

    /// 画面に出す名前
    var label: String {
        switch self {
        case .red: return "赤（止まれ）"
        case .green: return "青（進め）"
        case .flashing: return "青点滅"
        }
    }

    /// Picker 用の短い名前
    var shortLabel: String {
        switch self {
        case .red: return "赤"
        case .green: return "青"
        case .flashing: return "青点滅"
        }
    }
}

/// 受け取った信号情報。remainingS は残り秒数（不明なら nil）。
struct SignalInfo: Equatable {
    var color: SignalColor
    var remainingS: Double?
}

// MARK: - 灯火 1 つ

private struct SignalLamp: View {
    let color: Color
    let symbol: String
    let isOn: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(color.opacity(isOn ? 1.0 : 0.15))
            Image(systemName: symbol)
                .font(.system(size: 30, weight: .bold))
                .foregroundColor(isOn ? Color.white : Color.white.opacity(0.2))
        }
        .frame(width: 60, height: 60)
        .shadow(color: isOn ? color.opacity(0.7) : Color.clear, radius: 8)
    }
}

// MARK: - 信号のイラスト

struct SignalLightView: View {
    let signal: SignalInfo?

    private static let redColor = Color.red
    private static let blueColor = Color(red: 0.0, green: 0.62, blue: 0.9)

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                Text("信号")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                Spacer()
            }

            VStack(spacing: 10) {
                housing
                statusTexts
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
        }
    }

    // 筐体と灯火（青点滅のときだけ TimelineView で点滅させる）
    @ViewBuilder
    private var housing: some View {
        if signal?.color == .flashing {
            TimelineView(.periodic(from: Date(timeIntervalSinceReferenceDate: 0), by: 0.25)) { context in
                let step = Int((context.date.timeIntervalSinceReferenceDate / 0.25).rounded())
                housingBody(blueOn: step % 2 == 0)
            }
        } else {
            housingBody(blueOn: signal?.color == .green)
        }
    }

    private func housingBody(blueOn: Bool) -> some View {
        let redOn = (signal?.color == .red)
        return VStack(spacing: 14) {
            // 上: 赤（立っている人）
            SignalLamp(color: Self.redColor, symbol: "figure.stand", isOn: redOn)
            // 下: 青（歩いている人）
            SignalLamp(color: Self.blueColor, symbol: "figure.walk", isOn: blueOn)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(white: 0.12))
        )
    }

    // 下のテキスト（色だけに頼らない）
    private var statusTexts: some View {
        VStack(spacing: 4) {
            Text(signal?.color.label ?? "信号情報なし（未受信）")
                .font(.title3.bold())
                .foregroundColor(signal == nil ? Color.secondary : Color.primary)
            if let seconds = remainingText {
                Text(seconds)
                    .font(.headline)
                    .monospacedDigit()
                    .foregroundColor(.secondary)
            }
        }
    }

    /// 「残り n 秒」。値がない・不正なときは nil。
    private var remainingText: String? {
        guard let r = signal?.remainingS, r.isFinite, r >= 0 else { return nil }
        return "残り \(Int(r.rounded(.up))) 秒"
    }

    private var accessibilityText: String {
        var text = "信号：" + (signal?.color.label ?? "信号情報なし（未受信）")
        if let seconds = remainingText {
            text += "、" + seconds
        }
        return text
    }
}
