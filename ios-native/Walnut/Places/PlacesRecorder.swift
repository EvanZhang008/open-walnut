import CoreLocation
import UIKit

/// The Places switch. Off until the user turns it on; nothing is recorded before.
enum PlacesSettings {
    static let enabledKey = "walnut.places.enabled"
    /// iOS shows its "Change to Always Allow" question once per app, so Walnut asks once.
    static let askedAlwaysKey = "walnut.places.askedAlways"

    static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    static var askedAlways: Bool {
        get { UserDefaults.standard.bool(forKey: askedAlwaysKey) }
        set { UserDefaults.standard.set(newValue, forKey: askedAlwaysKey) }
    }

    /// The switch was ever touched (on, or on and then off again).
    static var everTurnedOn: Bool { UserDefaults.standard.object(forKey: enabledKey) != nil }
}

extension Notification.Name {
    /// The queue, the switch or location access changed.
    static let walnutPlacesChanged = Notification.Name("walnut.places.changed")
}

/// Owns iOS visit monitoring. Started at every launch, before anything else
/// waits on activation: iOS relaunches Walnut in the background to deliver a
/// visit, and the visit reaches only a location manager that already exists.
@MainActor
final class PlacesRecorder: NSObject, CLLocationManagerDelegate {
    static let shared = PlacesRecorder()

    private var manager: CLLocationManager?
    private var started = false
    private(set) var monitoring = false

    static var isHostedUnitTestProcess: Bool { HealthBackground.isHostedUnitTestProcess }

    func start() {
        guard !started, !Self.isHostedUnitTestProcess else { return }
        started = true
        #if DEBUG
        PlacesDebugVisit.resetIfAsked()
        #endif
        // A manager only for a user who turned Places on at some point: a fresh
        // install never touches location. One who turned it off again gets one too,
        // so the visit monitoring iOS keeps across launches is surely stopped.
        if PlacesSettings.isEnabled || PlacesSettings.everTurnedOn { applyMonitoring() }
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                let recorder = PlacesRecorder.shared
                if PlacesSettings.isEnabled { recorder.applyMonitoring() }
                recorder.syncSoon(reason: "active")
            }
        }
        #if DEBUG
        PlacesDebugVisit.injectIfAsked()
        #endif
    }

    // MARK: - State

    var access: PlacesPhoneState.Access {
        Self.access(for: manager?.authorizationStatus ?? CLLocationManager().authorizationStatus)
    }

    /// Precise Location off: iOS may record fewer visits.
    var preciseOff: Bool {
        (manager ?? CLLocationManager()).accuracyAuthorization == .reducedAccuracy
    }

    func phoneState() -> PlacesPhoneState {
        PlacesPhoneState(enabled: PlacesSettings.isEnabled, access: access)
    }

    static func access(for status: CLAuthorizationStatus) -> PlacesPhoneState.Access {
        switch status {
        case .authorizedAlways: return .always
        case .authorizedWhenInUse: return .whenInUse
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
    }

    // MARK: - Actions

    /// Turn Places on: ask iOS for location (While Using, then Always, the order
    /// iOS requires), start recording if Always was given, and tell the Mac.
    /// Places stays on whatever the answer: it starts by itself once access is Always.
    func turnOn() async {
        PlacesSettings.isEnabled = true
        let manager = ensureManager()
        AppLog.info("places", "turned on", ["access": access.rawValue])
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
            await waitForAnswer(manager, from: .notDetermined)
        }
        if manager.authorizationStatus == .authorizedWhenInUse, !PlacesSettings.askedAlways {
            PlacesSettings.askedAlways = true
            manager.requestAlwaysAuthorization()
            await waitForAnswer(manager, from: .authorizedWhenInUse)
        }
        applyMonitoring()
        AppLog.info("places", "access after asking", ["access": access.rawValue])
        changed()
        syncSoon(reason: "turned-on")
    }

    func turnOff() {
        PlacesSettings.isEnabled = false
        applyMonitoring()
        AppLog.info("places", "turned off")
        changed()
        syncSoon(reason: "turned-off")
    }

    /// Disconnect, or the visits on the Mac were deleted: stop and forget them here.
    func eraseLocalState() {
        PlacesSettings.isEnabled = false
        manager?.stopMonitoringVisits()
        monitoring = false
        PlacesQueueStore.shared.erase()
        changed()
    }

    func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        AppLog.info("places", "opening Settings for location")
        UIApplication.shared.open(url)
    }

    // MARK: - Recording

    private func ensureManager() -> CLLocationManager {
        if let manager { return manager }
        let made = CLLocationManager()
        made.delegate = self
        manager = made
        return made
    }

    private func applyMonitoring() {
        let manager = ensureManager()
        let want = PlacesSettings.isEnabled && manager.authorizationStatus == .authorizedAlways
        if want && !monitoring {
            manager.startMonitoringVisits()
            monitoring = true
            AppLog.info("places", "recording started")
        } else if !want && monitoring {
            manager.stopMonitoringVisits()
            monitoring = false
            AppLog.info("places", "recording stopped", ["access": access.rawValue])
        } else if !want && !PlacesSettings.isEnabled {
            // iOS keeps visit monitoring across launches; a switch turned off
            // in an earlier launch must stop it too.
            manager.stopMonitoringVisits()
        }
    }

    /// A visit from iOS (or the debug injector).
    func handle(_ event: PlaceVisitEvent, source: String) {
        // iOS can still hand over a visit it held while Places was being turned off.
        guard PlacesSettings.isEnabled else {
            AppLog.info("places", "visit dropped: Places is off", ["source": source])
            return
        }
        guard let record = PlacesQueueStore.shared.record(event) else { return }
        AppLog.info("places", "visit recorded", [
            "source": source, "arrival": String(record.arrival != nil), "departure": String(record.departure != nil),
            "version": String(record.version),
        ])
        changed()
        syncSoon(reason: "visit")
    }

    /// Keep the Mac current, with a little background time if Walnut is not open.
    func syncSoon(reason: String) {
        guard !Self.isHostedUnitTestProcess else { return }
        let token = PlacesBackgroundToken()
        token.id = UIApplication.shared.beginBackgroundTask(withName: "places-sync") {
            MainActor.assumeIsolated {
                token.work?.cancel()
                token.end()
            }
        }
        token.work = Task { @MainActor in
            await PlacesSyncEngine.shared.run(reason: reason)
            self.changed()
            token.end()
        }
    }

    private func changed() {
        NotificationCenter.default.post(name: .walnutPlacesChanged, object: nil)
    }

    /// iOS's location question is on screen until the user answers. Done when
    /// access changes, when Walnut comes back to the foreground after the
    /// question ("Keep Only While Using" changes nothing), or when no question
    /// appeared at all.
    private func waitForAnswer(_ manager: CLLocationManager, from status: CLAuthorizationStatus) async {
        let started = Date()
        var sawInactive = false
        while Date().timeIntervalSince(started) < 120 {
            try? await Task.sleep(for: .milliseconds(250))
            if manager.authorizationStatus != status { return }
            let state = UIApplication.shared.applicationState
            if state != .active { sawInactive = true }
            if sawInactive && state == .active { return }
            if !sawInactive && Date().timeIntervalSince(started) > 2 { return }
        }
    }

    // MARK: - CLLocationManagerDelegate (called on the main thread: the manager was made there)

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let event = PlaceVisitEvent(visit)
        MainActor.assumeIsolated { self.handle(event, source: "ios") }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            guard self.started else { return }
            self.applyMonitoring()
            self.changed()
            if PlacesSettings.isEnabled { self.syncSoon(reason: "access-changed") }
        }
    }
}

/// The background time one sync holds, ended exactly once.
@MainActor
private final class PlacesBackgroundToken {
    var id: UIBackgroundTaskIdentifier = .invalid
    var work: Task<Void, Never>?

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

#if DEBUG
/// Simulators do not deliver visits. `-walnut.debugPlacesVisit "<arrived>/<left>[/<lat>,<lon>]"`
/// hands the recorder one as iOS would, through the same path. Each end is minutes
/// ago, or a Unix time (so two launches can send one visit's two ends), or `-`.
enum PlacesDebugVisit {
    static let argument = "-walnut.debugPlacesVisit"
    /// `-walnut.debugPlacesReset 1` starts the launch as a fresh install would: Places
    /// off, the Always question not asked yet, no visits kept. Editing the preferences
    /// file from outside does not stick, because cfprefsd keeps its own copy.
    static let resetArgument = "-walnut.debugPlacesReset"

    @MainActor
    static func resetIfAsked() {
        guard ProcessInfo.processInfo.arguments.contains(resetArgument) else { return }
        UserDefaults.standard.removeObject(forKey: PlacesSettings.enabledKey)
        UserDefaults.standard.removeObject(forKey: PlacesSettings.askedAlwaysKey)
        PlacesQueueStore.shared.erase()
    }

    @MainActor
    static func injectIfAsked() {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: argument), i + 1 < args.count, let event = parse(args[i + 1], now: Date()) else { return }
        PlacesRecorder.shared.handle(event, source: "debug")
    }

    static func parse(_ spec: String, now: Date) -> PlaceVisitEvent? {
        let parts = spec.split(separator: "/").map(String.init)
        guard parts.count >= 2 else { return nil }
        func moment(_ text: String) -> Date? {
            Double(text).map { $0 > 1_000_000_000 ? Date(timeIntervalSince1970: $0) : now.addingTimeInterval(-$0 * 60) }
        }
        let arrival = moment(parts[0])
        let departure = moment(parts[1])
        var lat = 37.3349, lon = -122.0090
        if parts.count >= 3 {
            let coord = parts[2].split(separator: ",").compactMap { Double($0) }
            if coord.count == 2 { lat = coord[0]; lon = coord[1] }
        }
        return PlaceVisitEvent(arrival: arrival, departure: departure, latitude: lat, longitude: lon, accuracyM: 35)
    }
}
#endif
