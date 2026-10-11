import Foundation
import Observation

/// What the Places screen shows, and its actions. Recording runs in
/// `PlacesRecorder`; sending in `PlacesSyncEngine`. This store only reflects them.
@Observable
@MainActor
final class PlacesStore {
    static let shared = PlacesStore()

    enum Busy: Equatable { case turningOn, deleting }

    private(set) var isEnabled = false
    private(set) var access: PlacesPhoneState.Access = .notDetermined
    /// iOS's location question is up (`PlacesRecorder.askingIOS`).
    private(set) var askingIOS = false
    private(set) var preciseOff = false
    /// iOS can still ask the user itself, so the screen offers that before Settings.
    private(set) var iosCanAsk = false
    /// The latest visits kept on this iPhone, newest first.
    private(set) var recent: [PlaceVisitRecord] = []
    private(set) var unsent = 0
    private(set) var lastSyncAt: Date?
    private(set) var lastOutcome: PlacesRunOutcome?
    /// From GET /places/status; nil until it answered once.
    private(set) var macVisitCount: Int?
    private(set) var busy: Busy?
    private(set) var errorMessage: String?

    private let transport: PlacesTransport
    private var observer: NSObjectProtocol?

    init(transport: PlacesTransport = WalnutPlacesTransport()) {
        self.transport = transport
        reload()
        observer = NotificationCenter.default.addObserver(forName: .walnutPlacesChanged, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { PlacesStore.shared.reload() }
        }
    }

    /// iOS records visits only with Always. In the demo the switch alone says
    /// it: the demo asks iOS for no location access and records nothing.
    var recording: Bool { isEnabled && (isDemo || access == .always) }

    var isDemo: Bool { DemoMode.isActive }

    func reload() {
        isEnabled = PlacesSettings.isEnabled
        access = PlacesRecorder.shared.access
        askingIOS = PlacesRecorder.shared.askingIOS
        preciseOff = isEnabled && !isDemo && PlacesRecorder.shared.preciseOff
        iosCanAsk = PlacesAccessDecision.iosCanAsk(access: access, askedAlways: PlacesSettings.askedAlways)
        let snapshot = PlacesQueueStore.shared.read()
        recent = Array(snapshot.visits.sorted { $0.lastMoment > $1.lastMoment }.prefix(10))
        unsent = snapshot.visits.filter(\.needsSend).count
        lastSyncAt = snapshot.lastSyncAt
        lastOutcome = snapshot.lastOutcome.flatMap { PlacesRunOutcome(rawValue: $0) }
    }

    /// The Mac's count. Called when the screen opens and on pull to refresh.
    func refresh() async {
        reload()
        guard AppConfig.serverURL != nil else { return }
        if isEnabled { await PlacesSyncEngine.shared.run(reason: "screen") }
        reload()
        if let status = try? await transport.placesStatus(timeout: 20) {
            macVisitCount = status.visitCount
        }
    }

    func turnOn() async {
        guard busy == nil else { return }
        busy = .turningOn
        defer { busy = nil }
        errorMessage = nil
        await PlacesRecorder.shared.turnOn()
        reload()
    }

    func turnOff() {
        PlacesRecorder.shared.turnOff()
        reload()
    }

    /// Delete every visit on the Mac and here, and turn Places off.
    @discardableResult
    func deleteOnMac() async -> Bool {
        guard busy == nil else { return false }
        busy = .deleting
        defer { busy = nil }
        errorMessage = nil
        do {
            _ = try await transport.placesDeleteData()
        } catch {
            errorMessage = "Your Mac can't be reached right now, so nothing was deleted."
            return false
        }
        PlacesRecorder.shared.eraseLocalState()
        macVisitCount = 0
        AppLog.info("places", "visits on the Mac deleted, turned off")
        reload()
        return true
    }
}
