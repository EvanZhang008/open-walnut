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
    /// The user turned Places on and Walnut has not put the Always question yet.
    /// Kept for this launch only: a While Using answer that arrives after
    /// `turnOn` stopped waiting still gets the question.
    private var alwaysOwed = false
    private let alwaysAsk = PlacesOneAtATime()

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
                recorder.askAlwaysIfOwed()
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
        AppLog.info("places", "turned on", ["access": access.rawValue, "askedAlways": String(PlacesSettings.askedAlways)])
        if manager.authorizationStatus == .notDetermined {
            // iOS has no answer (never asked, or an Allow Once ran out), so its
            // Always question is new again too.
            PlacesSettings.askedAlways = false
            alwaysOwed = true
            AppLog.info("places", "asking iOS for While Using")
            manager.requestWhenInUseAuthorization()
            let answer = await waitForAnswer(manager, from: .notDetermined)
            AppLog.info("places", "While Using answered", ["answer": answer.rawValue, "access": access.rawValue])
        }
        if manager.authorizationStatus == .authorizedWhenInUse, !PlacesSettings.askedAlways {
            alwaysOwed = true
            await askAlways(manager)
        }
        applyMonitoring()
        AppLog.info("places", "access after asking", ["access": access.rawValue])
        changed()
        syncSoon(reason: "turned-on")
    }

    func turnOff() {
        PlacesSettings.isEnabled = false
        alwaysOwed = false
        applyMonitoring()
        AppLog.info("places", "turned off")
        changed()
        syncSoon(reason: "turned-off")
    }

    /// Disconnect, or the visits on the Mac were deleted: stop and forget them here.
    func eraseLocalState() {
        PlacesSettings.isEnabled = false
        alwaysOwed = false
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

    // MARK: - The Always question

    /// Put the Always question if Walnut still owes it and iOS can show it.
    func askAlwaysIfOwed() {
        guard alwaysOwed, PlacesSettings.isEnabled, !PlacesSettings.askedAlways,
              let manager, manager.authorizationStatus == .authorizedWhenInUse else { return }
        Task { @MainActor in await self.askAlways(manager) }
    }

    /// `turnOn`, the access change and the return to the foreground can all get
    /// here for the same While Using answer: one asks, and one that waited asks
    /// only if the attempt before it could not (Walnut was not open).
    private func askAlways(_ manager: CLLocationManager) async {
        await alwaysAsk.run(stillWanted: { self.alwaysOwed }) { await self.askAlwaysNow(manager) }
    }

    /// Core Location answers only an app's first requestAlwaysAuthorization call,
    /// so a call iOS does not show is lost for good. On an iPhone the question did
    /// not come after While Using, and the cause was not seen: the simulator shows
    /// it even when asked while the first question is still closing. So the call
    /// waits until Walnut has been active for a moment, and each step is logged.
    private func askAlwaysNow(_ manager: CLLocationManager) async {
        guard await PlacesSettle.wait(isActive: { UIApplication.shared.applicationState == .active }) else {
            AppLog.info("places", "Always question waits for Walnut to be open", ["app": Self.appState()])
            return
        }
        guard alwaysOwed, PlacesSettings.isEnabled, !PlacesSettings.askedAlways,
              manager.authorizationStatus == .authorizedWhenInUse else { return }
        alwaysOwed = false
        PlacesSettings.askedAlways = true
        AppLog.info("places", "asking iOS for Always")
        manager.requestAlwaysAuthorization()
        let answer = await waitForAnswer(manager, from: .authorizedWhenInUse)
        AppLog.info("places", "Always answered", ["answer": answer.rawValue, "access": access.rawValue])
        changed()
    }

    enum Answer: String { case changed, closed, noQuestion = "no-question", timedOut = "timed-out" }

    /// iOS's location question is on screen until the user answers. Done when
    /// access changes, when Walnut comes back to the foreground after the
    /// question ("Keep Only While Using" changes nothing), or when no question
    /// appeared at all.
    private func waitForAnswer(_ manager: CLLocationManager, from status: CLAuthorizationStatus) async -> Answer {
        let started = Date()
        var sawInactive = false
        while Date().timeIntervalSince(started) < 120 {
            try? await Task.sleep(for: .milliseconds(250))
            if manager.authorizationStatus != status { return .changed }
            let state = UIApplication.shared.applicationState
            if state != .active { sawInactive = true }
            if sawInactive && state == .active { return .closed }
            if !sawInactive && Date().timeIntervalSince(started) > 2 { return .noQuestion }
        }
        return .timedOut
    }

    private static func appState() -> String {
        switch UIApplication.shared.applicationState {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "unknown"
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
            AppLog.info("places", "access changed", ["access": self.access.rawValue, "app": Self.appState()])
            self.applyMonitoring()
            self.changed()
            if PlacesSettings.isEnabled { self.syncSoon(reason: "access-changed") }
            self.askAlwaysIfOwed()
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
