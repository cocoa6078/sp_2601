//
//  GoalMapView.swift
//  Runwave (RUNWAVE / JPHACKS)
//
//  終了地点（ゴール）を Apple Maps 上でタップして選ぶ画面と、ホームに出す小さなプレビュー。
//  Windows で作成（ビルド未確認）。
//
//  - 対象: iOS 17+（Map(position:) / MapReader / MapProxy / Marker を使用）
//  - 現在地（CLLocationManager）は使わない。位置情報の権限は要求しない。
//  - 終了地点は必須項目。未選択ではセッションを開始できない。
//

import SwiftUI
import MapKit
import Foundation
import CoreLocation
import Combine

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
    let goal: GoalPoint?
    let currentLocation: CLLocationCoordinate2D?

    private var displayRegion: MKCoordinateRegion {
        let fallback = GoalPoint.sapporoStation.coordinate
        guard let goal, let currentLocation else {
            let center = currentLocation ?? goal?.coordinate ?? fallback
            return MKCoordinateRegion(
                center: center,
                span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.02)
            )
        }

        let latitudeDelta = max(0.012, abs(goal.latitude - currentLocation.latitude) * 1.8)
        let longitudeDelta = max(0.02, abs(goal.longitude - currentLocation.longitude) * 1.8)
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(
                latitude: (goal.latitude + currentLocation.latitude) / 2,
                longitude: (goal.longitude + currentLocation.longitude) / 2
            ),
            span: MKCoordinateSpan(latitudeDelta: latitudeDelta, longitudeDelta: longitudeDelta)
        )
    }

    var body: some View {
        Map(position: .constant(MapCameraPosition.region(displayRegion))) {
            if let goal {
                Marker("終了地点", coordinate: goal.coordinate)
            }
            if let currentLocation {
                Marker("現在地", systemImage: "location.fill", coordinate: currentLocation)
                    .tint(.blue)
            }
        }
        .allowsHitTesting(false)
        .accessibilityLabel("現在地と終了地点の地図プレビュー")
    }
}

@MainActor
final class CurrentLocationObserver: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var coordinate: CLLocationCoordinate2D?
    @Published private(set) var isDenied = false

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func start() {
        isDenied = manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            manager.startUpdatingLocation()
        case .denied, .restricted:
            break
        @unknown default:
            break
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        isDenied = manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted
        if manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse {
            manager.startUpdatingLocation()
        }
    }

    func stop() {
        manager.stopUpdatingLocation()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last,
              location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= 100 else { return }
        coordinate = location.coordinate
    }
}

// MARK: - 終了地点を選ぶ sheet

/// 地図をタップしてピンを置き、「決定」で確定する画面。
///
/// - クリア: 画面内のピンを外す（この時点ではまだ確定しない）
/// - 決定: 選んだ地点を onDecide に渡して閉じる（未選択では決定できない）
/// - キャンセル: 何も変えずに閉じる
struct GoalMapView: View {
    /// 決定時に呼ばれる。nil はクリア操作中の未選択状態。
    let onDecide: (GoalPoint?) -> Void
    let activityModeLabel: String?

    @Environment(\.dismiss) private var dismiss
    @State private var position: MapCameraPosition
    @State private var pending: GoalPoint?

    init(initialGoal: GoalPoint?, activityModeLabel: String? = nil, onDecide: @escaping (GoalPoint?) -> Void) {
        self.onDecide = onDecide
        self.activityModeLabel = activityModeLabel
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
            Text(activityModeLabel.map { "\($0)の終了地点を選択" } ?? "地図をタップして終了地点を選択")
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

    // 下部: クリアをアイコンにし、戻る・決定のラベル幅を確保する。
    private var buttons: some View {
        HStack(spacing: 10) {
            Button {
                pending = nil
            } label: {
                Image(systemName: "trash")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(pending == nil)
            .accessibilityLabel("選択をクリア")

            Button {
                dismiss()
            } label: {
                Text("戻る")
                    .frame(maxWidth: .infinity)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .padding(.vertical, 8)
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
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(.green)
            .disabled(pending == nil)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
    }
}
