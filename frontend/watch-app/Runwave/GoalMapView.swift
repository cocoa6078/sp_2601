//
//  GoalMapView.swift
//  Runwave (RUNWAVE / JPHACKS)
//
//  終了地点（ゴール）を Apple Maps 上でタップして選ぶ画面と、ホームに出す小さなプレビュー。
//  Windows で作成（ビルド未確認）。
//
//  - 対象: iOS 17+（Map(position:) / MapReader / MapProxy / Marker を使用）
//  - 現在地と終了地点からAppleの徒歩経路を取得し、候補を選択する。
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

    /// 発表デモの出発地点（GeoJSONの1地点目）
    static let simulatorStart = GoalPoint(latitude: 43.0721852, longitude: 141.3490445)
    /// GeoJSONの2地点目にある信号。
    static let simulatorSignal = GoalPoint(latitude: 43.0713260, longitude: 141.3492470)
    /// ゴールへ曲がる手前の3地点目。
    static let simulatorTurn = GoalPoint(latitude: 43.0707589, longitude: 141.3493924)
    static let simulatorGoal = GoalPoint(latitude: 43.0706678, longitude: 141.3488368)

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
    var plannedRoute: MKRoute? = nil

    private var displayPosition: MapCameraPosition {
        guard let plannedRoute else { return .region(displayRegion) }
        var rect = plannedRoute.polyline.boundingMapRect
        if let currentLocation {
            let point = MKMapPoint(currentLocation)
            rect = rect.union(MKMapRect(x: point.x, y: point.y, width: 1, height: 1))
        }
        return .rect(rect)
    }

    private var displayRegion: MKCoordinateRegion {
        let fallback = GoalPoint.simulatorStart.coordinate
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
        Map(position: .constant(displayPosition)) {
            if let plannedRoute {
                MapPolyline(plannedRoute.polyline).stroke(.cyan, lineWidth: 5)
            }
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
    #if DEBUG && targetEnvironment(simulator)
    private var simulatorLocationSubscription: AnyCancellable?
    #endif

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        #if DEBUG && targetEnvironment(simulator)
        simulatorLocationSubscription = SimulatorWalkSource.shared.$location.sink { [weak self] location in
            self?.coordinate = location.coordinate
        }
        #endif
    }

    func start() {
        #if DEBUG && targetEnvironment(simulator)
        coordinate = SimulatorWalkSource.shared.location.coordinate
        isDenied = false
        return
        #else
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
        #endif
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
        #if DEBUG && targetEnvironment(simulator)
        return
        #else
        guard let location = locations.last,
              location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= 50,
              abs(location.timestamp.timeIntervalSinceNow) <= 30 else { return }
        coordinate = location.coordinate
        #endif
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
    let onDecide: (GoalPoint?, MKRoute?) -> Void
    let activityModeLabel: String?
    @ObservedObject private var locationObserver: CurrentLocationObserver

    @Environment(\.dismiss) private var dismiss
    @State private var position: MapCameraPosition
    @State private var pending: GoalPoint?
    @State private var centeredOnCurrentLocation: Bool
    @StateObject private var planner = WalkingRoutePlanner()
    @State private var routeSearchID = UUID()
    #if DEBUG && targetEnvironment(simulator)
    @ObservedObject private var simulatorSignalSystem = SimulatorSignalSystem.shared
    #endif

    init(
        initialGoal: GoalPoint?,
        locationObserver: CurrentLocationObserver,
        activityModeLabel: String? = nil,
        onDecide: @escaping (GoalPoint?, MKRoute?) -> Void
    ) {
        self.onDecide = onDecide
        self.activityModeLabel = activityModeLabel
        _locationObserver = ObservedObject(wrappedValue: locationObserver)
        let center = locationObserver.coordinate.map {
            GoalPoint(latitude: $0.latitude, longitude: $0.longitude)
        } ?? initialGoal ?? GoalPoint.simulatorStart
        _position = State(initialValue: MapCameraPosition.region(center.region(span: 0.02)))
        _pending = State(initialValue: initialGoal)
        _centeredOnCurrentLocation = State(initialValue: locationObserver.coordinate != nil)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            mapArea
            routeChoices
            buttons
        }
        .task(id: routeRequestKey) {
            planner.reset()
            guard let pending, let source = locationObserver.coordinate else { return }
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            await planner.calculate(from: source, to: pending)
            if let route = planner.selectedRoute {
                position = .rect(route.polyline.boundingMapRect)
                #if DEBUG && targetEnvironment(simulator)
                simulatorSignalSystem.prepare(route: route)
                #endif
            }
        }
        .onChange(of: planner.selectedIndex) { _, _ in
            if let route = planner.selectedRoute {
                position = .rect(route.polyline.boundingMapRect)
                #if DEBUG && targetEnvironment(simulator)
                simulatorSignalSystem.prepare(route: route)
                #endif
            }
        }
    }

    private var routeRequestKey: String {
        "\(pending?.latitude ?? 0),\(pending?.longitude ?? 0):\(locationObserver.coordinate != nil):\(routeSearchID)"
    }

    private var routeChoices: some View {
        VStack(alignment: .leading, spacing: 8) {
            if planner.isLoading {
                ProgressView("徒歩ルートを検索中…")
            } else if let message = planner.errorMessage {
                Text(message).font(.caption).foregroundStyle(.orange)
                Button("再検索") { routeSearchID = UUID() }
                    .buttonStyle(.bordered)
            } else if locationObserver.coordinate == nil {
                Text(locationObserver.isDenied ? "設定で位置情報を許可すると、現在地から経路を検索できます" : "経路検索のため現在地を取得中…")
                    .font(.caption).foregroundStyle(.secondary)
            } else if pending == nil {
                Text("終了地点をタップすると徒歩ルートを検索します")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("経路を選択・ランニングも徒歩ルートを使用")
                    .font(.caption).foregroundStyle(.secondary)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(planner.routes.indices, id: \.self) { index in
                            let route = planner.routes[index]
                            Button {
                                planner.selectedIndex = index
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Label("経路\(index + 1)", systemImage: planner.selectedIndex == index ? "checkmark.circle.fill" : "circle")
                                        .font(.headline)
                                    Text(route.distance.formattedRouteDistance).font(.subheadline.bold())
                                    Text("徒歩目安 \(max(1, Int((route.expectedTravelTime / 60).rounded())))分")
                                        .font(.caption)
                                }
                                .padding(12)
                                .background(planner.selectedIndex == index ? Color.cyan.opacity(0.18) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(planner.selectedIndex == index ? .isSelected : [])
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
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
                ForEach(planner.routes.indices, id: \.self) { index in
                    MapPolyline(planner.routes[index].polyline)
                        .stroke(planner.selectedIndex == index ? Color.cyan : Color.gray.opacity(0.6), lineWidth: planner.selectedIndex == index ? 6 : 3)
                }
                #if DEBUG && targetEnvironment(simulator)
                ForEach(simulatorSignalSystem.markers) { signal in
                    Marker(signal.title, systemImage: "mappin.circle.fill", coordinate: signal.coordinate)
                        .tint(signal.color == .green ? .green : .red)
                }
                #endif
                if let coordinate = locationObserver.coordinate {
                    Marker("現在地", systemImage: "location.fill", coordinate: coordinate)
                        .tint(.blue)
                }
                if let p = pending {
                    Marker("終了地点", coordinate: p.coordinate)
                }
            }
            .onChange(of: locationObserver.coordinate?.latitude) { _, _ in
                guard !centeredOnCurrentLocation,
                      let coordinate = locationObserver.coordinate else { return }
                let current = GoalPoint(latitude: coordinate.latitude, longitude: coordinate.longitude)
                position = .region(current.region(span: 0.02))
                centeredOnCurrentLocation = true
            }
            .onTapGesture { screenPoint in
                if let coordinate = proxy.convert(screenPoint, from: .local) {
                    let point = GoalPoint(
                        latitude: coordinate.latitude,
                        longitude: coordinate.longitude
                    )
                    if point.isValid, point != pending {
                        planner.reset()
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
                planner.reset()
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
                onDecide(pending, planner.selectedRoute)
                dismiss()
            } label: {
                Text("この経路")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(.green)
            .disabled(pending == nil || planner.selectedRoute == nil || planner.isLoading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
    }
}
