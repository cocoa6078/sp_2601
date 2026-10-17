//
//  GoalMapView.swift
//  Runwave (RUNWAVE / JPHACKS)
//
//  終了地点（ゴール）を Apple Maps 上でタップして選ぶ画面と、ホームに出す小さなプレビュー。
//  Windows で作成（ビルド未確認）。
//
//  - 対象: iOS 17+（Map(position:) / MapReader / MapProxy / Marker を使用）
//  - 現在地（CLLocationManager）は使わない。位置情報の権限は要求しない。
//  - 終了地点は任意項目。未設定でもセッションは開始できる。
//

import SwiftUI
import MapKit
import Foundation

// MARK: - 型

/// 終了地点（緯度・経度）。
struct GoalPoint: Equatable {
    var latitude: Double
    var longitude: Double

    /// 初期表示の中心（札幌駅付近）
    static let sapporoStation = GoalPoint(latitude: 43.0687, longitude: 141.3508)

    /// 緯度経度として有効か（NaN / 範囲外を弾く）
    var isValid: Bool {
        latitude.isFinite && longitude.isFinite
            && (-90.0...90.0).contains(latitude)
            && (-180.0...180.0).contains(longitude)
    }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    /// 表示用（小数 5 桁）
    var coordinateText: String {
        String(format: "緯度 %.5f / 経度 %.5f", latitude, longitude)
    }

    /// この地点を中心にした表示範囲
    func region(span: Double = 0.02) -> MKCoordinateRegion {
        MKCoordinateRegion(
            center: coordinate,
            span: MKCoordinateSpan(latitudeDelta: span, longitudeDelta: span)
        )
    }
}

// MARK: - ホーム用プレビュー（操作不可）

/// 終了地点を小さく見せる地図。タップ・ドラッグは受け付けない。
struct GoalPreviewMap: View {
    let goal: GoalPoint

    var body: some View {
        // .constant なので goal が変わるたびに表示位置も追従する。
        Map(position: .constant(MapCameraPosition.region(goal.region(span: 0.01)))) {
            Marker("終了地点", coordinate: goal.coordinate)
        }
        .allowsHitTesting(false)
        .accessibilityLabel("終了地点の地図プレビュー")
    }
}

// MARK: - 終了地点を選ぶ sheet

/// 地図をタップしてピンを置き、「決定」で確定する画面。
///
/// - クリア: 画面内のピンを外す（この時点ではまだ確定しない）
/// - 決定: ピンがあればその地点を、なければ「未設定」を onDecide に渡して閉じる
/// - キャンセル: 何も変えずに閉じる
struct GoalMapView: View {
    /// 決定時に呼ばれる。nil は「未設定にする」。
    let onDecide: (GoalPoint?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var position: MapCameraPosition
    @State private var pending: GoalPoint?

    init(initialGoal: GoalPoint?, onDecide: @escaping (GoalPoint?) -> Void) {
        self.onDecide = onDecide
        let center = initialGoal ?? GoalPoint.sapporoStation
        _position = State(initialValue: MapCameraPosition.region(center.region(span: 0.02)))
        _pending = State(initialValue: initialGoal)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            mapArea
            buttons
        }
    }

    // 上部: 説明と選択中の座標
    private var header: some View {
        VStack(spacing: 4) {
            Text("地図をタップして終了地点を選択")
                .font(.headline)
            if let p = pending {
                Text(p.coordinateText)
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundColor(.secondary)
            } else {
                Text("未選択")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .padding(.horizontal, 16)
    }

    // 中央: 地図（タップ位置を緯度経度へ変換してピンを置く）
    private var mapArea: some View {
        MapReader { proxy in
            Map(position: $position) {
                if let p = pending {
                    Marker("終了地点", coordinate: p.coordinate)
                }
            }
            .onTapGesture { screenPoint in
                if let coordinate = proxy.convert(screenPoint, from: .local) {
                    let point = GoalPoint(
                        latitude: coordinate.latitude,
                        longitude: coordinate.longitude
                    )
                    if point.isValid {
                        pending = point
                    }
                }
            }
        }
    }

    // 下部: クリア / キャンセル / 決定
    private var buttons: some View {
        HStack(spacing: 12) {
            Button {
                pending = nil
            } label: {
                Text("クリア")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(pending == nil)

            Button {
                dismiss()
            } label: {
                Text("キャンセル")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)

            Button {
                onDecide(pending)
                dismiss()
            } label: {
                Text("決定")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(.green)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
    }
}
