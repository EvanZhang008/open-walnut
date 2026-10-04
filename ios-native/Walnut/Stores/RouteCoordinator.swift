import Foundation
import Network
import Observation

/// Keeps the app on the best reachable route to the paired Walnut, with no user
/// action: a direct route (custom > Wi-Fi > Tailscale) when one answers as the
/// right box, the cloud otherwise.
///
/// ```
///  trigger (foreground / path change / offline / 401 / Check now / routes learned)
///     │  debounced per kind (RouteSelector.shouldReselect)
///     ▼
///  probe every route in parallel: GET <origin>/api/v1/instance, NO token
///     │  results of a superseded selection are dropped (generation)
///     ▼
///  RouteSelector.choose ──▶ .stay | .none | .switchTo(route)
///                                              │
///     AppConfig.setActiveRoute (URL only) ◀────┘
///     ConnectionStore.serverURL, streams rebuilt (LifecycleHub), status refresh
/// ```
///
/// Owned by ConnectionStore. Everything that touches the world goes through
/// `Environment`, so the logic is driven in WalnutTests with scripted probes
/// and a fixed clock.
@Observable
@MainActor
final class RouteCoordinator {
    struct ProbeRecord: Equatable {
        let outcome: ProbeOutcome
        let at: Date
    }

    enum SelectionOutcome: Equatable {
        case decided(RouteSelector.Decision)
        /// A newer selection started before this one's probes came back.
        case superseded
        /// Not run: suspended, unpaired, pinned, or a single route.
        case skipped
    }

    struct Environment {
        var routes: @MainActor () -> [ServerRoute]
        var currentOrigin: @MainActor () -> String?
        var setActive: @MainActor (ServerRoute) -> Void
        var mergeServerRoutes: @MainActor ([ServerRoute]) -> Bool
        var probe: @Sendable (ServerRoute) async -> ProbeOutcome
        var fetchRoutes: @Sendable () async throws -> ServerRoutesResponse
        /// Rebuild every connection that captured the old origin.
        var restartStreams: @MainActor () -> Void
        var isEnabled: @MainActor () -> Bool
        var now: @Sendable () -> Date

        static var live: Environment {
            Environment(
                routes: { AppConfig.routes },
                currentOrigin: { AppConfig.serverURL?.absoluteString },
                setActive: { AppConfig.setActiveRoute($0) },
                mergeServerRoutes: { AppConfig.mergeRoutes(server: $0) },
                probe: { await InstanceProbe.probe($0) },
                fetchRoutes: { try await WalnutAPI().routes() },
                restartStreams: { LifecycleHub.shared.restartForRouteChange() },
                // A hosted test process is pinned to its blackhole and must
                // never probe or re-point anything; nothing runs before the app
                // is first in front of the user (LaunchGate, P0-2).
                isEnabled: { !AppConfig.routesArePinned && AppConfig.isConfigured && LaunchGate.shared.hasActivated },
                now: { Date() }
            )
        }
    }

    /// Mirror of the stored routes, best first (for Settings).
    private(set) var routes: [ServerRoute] = []
    /// Last probe per normalized origin.
    private(set) var probes: [String: ProbeRecord] = [:]
    private(set) var checking = false
    /// The Mac's own Tailscale state from the last route list that carried
    /// one (for the Connection screen's guidance). Never a reason to reselect.
    private(set) var tailscaleHint: TailscaleHint?

    @ObservationIgnored weak var connection: ConnectionStore?
    @ObservationIgnored private let env: Environment
    @ObservationIgnored private var active = true
    @ObservationIgnored private var generation: UInt64 = 0
    @ObservationIgnored private var inFlight: Task<SelectionOutcome, Never>?
    @ObservationIgnored private var lastRun: [RouteTrigger: Date] = [:]
    /// Origins whose token was refused (a confirmed 401), with when.
    @ObservationIgnored private var rejectedAt: [String: Date] = [:]
    @ObservationIgnored private var lastRoutesFetch: [String: Date] = [:]
    @ObservationIgnored private var routesMissing: Set<String> = []
    @ObservationIgnored private var routesFetchInFlight = false
    /// Bumped by reset(): work started for an earlier pairing is dropped.
    @ObservationIgnored private var pairingEpoch: UInt64 = 0
    @ObservationIgnored private nonisolated(unsafe) var pathMonitor: NWPathMonitor?
    @ObservationIgnored private var pathSignature: String?
    @ObservationIgnored private var pathDebounce: Task<Void, Never>?

    /// A refused token is given another chance on that origin after this long
    /// (the server may have re-copied the token's hash there by then).
    static let rejectionTTL: TimeInterval = 30 * 60
    /// Network path updates settle for this long before a selection.
    static let pathDebounceSeconds: Double = 1

    init(environment: Environment = .live, monitorsNetworkPath: Bool = true) {
        env = environment
        routes = environment.routes()
        if monitorsNetworkPath {
            // First activation only: no network work in a prewarm launch (P0-2).
            // A cold launch gets no scene-phase CHANGE, so this is also where its
            // first selection comes from.
            LaunchGate.shared.whenActive { [weak self] in
                self?.startPathMonitor()
                self?.trigger(.foreground)
            }
        }
    }

    deinit {
        pathMonitor?.cancel()
    }

    // MARK: - Triggers

    /// Fire-and-forget selection, debounced per trigger kind. Returns the
    /// selection it started (nil when debounced or not runnable) for tests.
    @discardableResult
    func trigger(_ trigger: RouteTrigger) -> Task<SelectionOutcome, Never>? {
        guard active, env.isEnabled(), env.routes().count > 1 else { return nil }
        let now = env.now()
        guard RouteSelector.shouldReselect(trigger: trigger, lastRunAt: lastRun, now: now) else { return nil }
        lastRun[trigger] = now
        return startSelection(trigger)
    }

    /// Settings → Check now. Probes even a single route, so the list shows a
    /// fresh reading; switching still needs a second route to go to.
    func checkNow() async {
        refreshRoutes()
        let now = env.now()
        guard active, env.isEnabled(),
              RouteSelector.shouldReselect(trigger: .manual, lastRunAt: lastRun, now: now)
        else { return }
        lastRun[.manual] = now
        _ = await settle(startSelection(.manual, probeSingleRoute: true))
    }

    /// Run a selection now (no debounce) and wait for the newest one to settle.
    @discardableResult
    func select(_ trigger: RouteTrigger) async -> SelectionOutcome {
        lastRun[trigger] = env.now()
        return await settle(startSelection(trigger))
    }

    /// A confirmed 401 on `origin` (ConnectionStore.handleUnauthorized). Returns
    /// true when the app is now on another route, i.e. the token must NOT be
    /// wiped; false sends the caller down its existing disconnect.
    func recoverFromRejectedToken(origin: String?) async -> Bool {
        guard let origin else { return false }
        let key = ServerRoute.normalizeOrigin(origin)
        let now = env.now()
        rejectedAt[key] = now
        probes[key] = ProbeRecord(outcome: .rejected401, at: now)
        guard env.isEnabled(), env.routes().count > 1 else { return false }
        // Already moved on (a selection switched while the 401 was being
        // confirmed): the new route earns its own verdict.
        if !ServerRoute.sameOrigin(env.currentOrigin(), origin) { return true }
        _ = await select(.unauthorized)
        return !ServerRoute.sameOrigin(env.currentOrigin(), origin)
    }

    /// A successful `GET /status` on the current route: read the server's
    /// route list when due, merge it, and reselect if it taught us something.
    func statusSucceeded() {
        refreshRoutes()
        guard env.isEnabled(), !routesFetchInFlight, let origin = env.currentOrigin() else { return }
        let key = ServerRoute.normalizeOrigin(origin)
        let now = env.now()
        guard RouteSelector.routesFetchDue(
            lastFetchAt: lastRoutesFetch[key],
            serverLacksRoutes: routesMissing.contains(key),
            routeCount: env.routes().count,
            now: now
        ) else { return }
        lastRoutesFetch[key] = now
        routesFetchInFlight = true
        let fetch = env.fetchRoutes
        let epoch = pairingEpoch
        Task { [weak self] in
            let result: Result<ServerRoutesResponse, Error>
            do { result = .success(try await fetch()) } catch { result = .failure(error) }
            // A list read for a pairing that has since been replaced (disconnect,
            // re-pair) describes another Walnut: never merge it.
            guard let self, epoch == self.pairingEpoch else { return }
            self.routesFetched(result, origin: key)
        }
    }

    // MARK: - Lifecycle

    func suspend() {
        active = false
        pathDebounce?.cancel()
        pathDebounce = nil
        // Drop whatever is in flight: a background process must not re-point
        // the app or publish probe results.
        generation &+= 1
        checking = false
    }

    func resume() {
        active = true
        refreshRoutes()
        trigger(.foreground)
    }

    /// Pairing changed (new pairing, or disconnect): forget everything learned
    /// about the previous one. Both happen in the foreground, and disconnect's
    /// teardown fan-out has just suspended us, so this is also the way back to
    /// active (the same thing ConnectionStore.disconnect does for itself).
    func reset() {
        active = true
        generation &+= 1
        pairingEpoch &+= 1
        routesFetchInFlight = false
        inFlight = nil
        checking = false
        probes = [:]
        tailscaleHint = nil
        rejectedAt = [:]
        lastRun = [:]
        lastRoutesFetch = [:]
        routesMissing = []
        refreshRoutes()
    }

    func refreshRoutes() {
        let next = env.routes()
        if next != routes { routes = next }
    }

    /// Origins whose token was refused within `rejectionTTL`.
    func rejectedOrigins(now: Date? = nil) -> Set<String> {
        let at = now ?? env.now()
        return Set(rejectedAt.filter { at.timeIntervalSince($0.value) < Self.rejectionTTL }.keys)
    }

    // MARK: - Selection

    private func startSelection(_ trigger: RouteTrigger, probeSingleRoute: Bool = false) -> Task<SelectionOutcome, Never> {
        generation &+= 1
        let gen = generation
        let task = Task { [weak self] () -> SelectionOutcome in
            guard let self else { return .skipped }
            return await self.runSelection(trigger, generation: gen, probeSingleRoute: probeSingleRoute)
        }
        inFlight = task
        return task
    }

    /// Wait for `task`, and when it was superseded, for the selection that
    /// superseded it: the caller wants the answer, not a stale non-answer.
    private func settle(_ task: Task<SelectionOutcome, Never>) async -> SelectionOutcome {
        var current = task
        var outcome = await current.value
        while outcome == .superseded, let next = inFlight, next != current {
            current = next
            outcome = await next.value
        }
        return outcome
    }

    private func runSelection(_ trigger: RouteTrigger, generation gen: UInt64, probeSingleRoute: Bool) async -> SelectionOutcome {
        refreshRoutes()
        let candidates = env.routes()
        guard active, env.isEnabled(), candidates.count > (probeSingleRoute ? 0 : 1) else {
            // A superseded selection may have left the spinner up for this one.
            if gen == generation { checking = false }
            return .skipped
        }
        checking = true
        let started = env.now()
        let results = await Self.probeAll(candidates, probe: env.probe)
        guard gen == generation else { return .superseded }
        checking = false
        guard active else { return .skipped }
        let at = env.now()
        let rejected = rejectedOrigins(now: at)
        for (origin, outcome) in results {
            // A refused token outranks "the box answered": the probe carries no
            // token, so it cannot see the refusal.
            probes[origin] = ProbeRecord(outcome: rejected.contains(origin) ? .rejected401 : outcome, at: at)
        }
        let routesNow = env.routes()
        let from = AppConfig.activeRoute(in: routesNow, serverURL: env.currentOrigin())
        let decision = RouteSelector.choose(
            routes: routesNow, probes: results, current: env.currentOrigin(), rejected: rejected
        )
        AppLog.debug("connectivity", "route selection", [
            "trigger": trigger.rawValue,
            "routes": String(routesNow.count),
            "decision": Self.describe(decision),
            "probeMs": String(Int(at.timeIntervalSince(started) * 1_000)),
        ])
        if case let .switchTo(route) = decision {
            apply(route, from: from, trigger: trigger)
        }
        return .decided(decision)
    }

    private func apply(_ route: ServerRoute, from: ServerRoute?, trigger: RouteTrigger) {
        env.setActive(route)
        refreshRoutes()
        connection?.serverURL = env.currentOrigin() ?? AppConfig.normalize(route.origin)
        AppLog.info("connectivity", "route switched \(from?.kind.rawValue ?? "none") -> \(route.kind.rawValue)", [
            "trigger": trigger.rawValue,
            "to": route.displayHost,
        ])
        Breadcrumbs.note("route-switch")
        env.restartStreams()
        if let connection {
            Task { await connection.refreshStatus() }
        }
    }

    private func routesFetched(_ result: Result<ServerRoutesResponse, Error>, origin key: String) {
        routesFetchInFlight = false
        switch result {
        case let .success(response):
            routesMissing.remove(key)
            guard env.isEnabled() else { return }
            // Kept across a list without one (a replica, a Mac still checking):
            // the last word from the Mac beats no word.
            if let hint = response.tailscale, hint != tailscaleHint { tailscaleHint = hint }
            if env.mergeServerRoutes(response.routes) {
                refreshRoutes()
                AppLog.info("connectivity", "routes learned", ["routes": String(env.routes().count)])
                trigger(.routesLearned)
            }
        case let .failure(error):
            // 404 = a server older than the endpoint: keep the paired route and
            // ask again only on the slow interval. Anything else is transient.
            if case let APIError.server(status, _, _, _, _) = error, status == 404 {
                routesMissing.insert(key)
            }
        }
    }

    private nonisolated static func probeAll(
        _ routes: [ServerRoute],
        probe: @escaping @Sendable (ServerRoute) async -> ProbeOutcome
    ) async -> [String: ProbeOutcome] {
        await withTaskGroup(of: (String, ProbeOutcome).self) { group in
            for route in routes {
                group.addTask {
                    (route.normalizedOrigin, RouteSelector.classify(await probe(route), expected: route.instance))
                }
            }
            var out: [String: ProbeOutcome] = [:]
            for await (origin, outcome) in group { out[origin] = outcome }
            return out
        }
    }

    private static func describe(_ decision: RouteSelector.Decision) -> String {
        switch decision {
        case .stay: return "stay"
        case .none: return "none"
        case let .switchTo(route): return "switch:\(route.kind.rawValue)"
        }
    }

    // MARK: - Network path

    private func startPathMonitor() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let signature = Self.signature(of: path)
            Task { @MainActor in self?.pathUpdated(signature) }
        }
        monitor.start(queue: DispatchQueue(label: "dev.openwalnut.route-path", qos: .utility))
        pathMonitor = monitor
    }

    /// What counts as a path change: satisfied or not, and which interfaces.
    nonisolated static func signature(of path: NWPath) -> String {
        let interfaces = path.availableInterfaces.map { "\($0.type)/\($0.name)" }.sorted().joined(separator: ",")
        return "\(path.status == .satisfied ? "up" : "down")|\(interfaces)"
    }

    /// Internal for WalnutTests. The first sample is the baseline, not a change.
    func pathUpdated(_ signature: String) {
        defer { pathSignature = signature }
        guard let previous = pathSignature, previous != signature else { return }
        pathDebounce?.cancel()
        pathDebounce = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.pathDebounceSeconds))
            guard !Task.isCancelled else { return }
            self?.trigger(.pathChanged)
        }
    }
}

// MARK: - Participants that rebuild a connection on a route switch

extension ChatStore: RouteRestartable {
    /// `connectStream()` replaces the SSE client with one built from the new
    /// URL (it is a no-op on an inactive store) and drains the send queue; the
    /// reload catches up on anything the old route missed. Deliberately NOT
    /// closeStream(): that cancels in-flight sends, which a healthy old route
    /// (an upgrade from cloud to Wi-Fi) would otherwise have delivered.
    func restartForRouteChange() {
        connectStream()
        if let id = activeID {
            Task { [weak self] in await self?.loadMessages(id) }
        }
    }
}

/// `restartForRouteChange()` lives in SessionConversationStore.swift: it resets
/// the stream's private replay state.
extension SessionConversationStore: RouteRestartable {}

extension TasksStore: RouteRestartable {
    /// The events feed captured its URL; a suspend/resume pair rebuilds it from
    /// the new one and refreshes the board (both synchronous on the main actor,
    /// so nothing observes the brief inactive state).
    func restartForRouteChange() {
        guard isActive else { return }
        suspendForBackground()
        resumeForForeground()
    }
}

extension InboxStore: RouteRestartable {
    /// No stream; a switch usually follows an outage, so refresh once.
    func restartForRouteChange() {
        resumeForForeground()
    }
}
