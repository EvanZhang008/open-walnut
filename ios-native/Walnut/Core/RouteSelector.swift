import Foundation

/// What one unauthenticated `GET <origin>/api/v1/instance` said.
enum ProbeOutcome: Equatable, Sendable {
    /// A Walnut answered. `instance` is nil for a server older than the endpoint.
    case ok(instance: String?, latencyMs: Int)
    /// Something answered, but it is not the box this route names.
    case mismatch(instance: String?)
    /// No answer worth trusting: refused, timed out, not Walnut's JSON.
    case unreachable
    /// The box refused this device's token (a confirmed 401 on the route, or a
    /// box that will not even say who it is without one).
    case rejected401
}

/// Why a route selection runs.
enum RouteTrigger: String, CaseIterable, Sendable {
    case foreground
    case pathChanged
    case offline
    case unauthorized
    case manual
    /// The server's route list changed what this phone knows.
    case routesLearned
}

/// Pure route choice: which of the known routes the app should talk through,
/// given what the probes saw. No network, no clock, no globals.
enum RouteSelector {
    enum Decision: Equatable, Sendable {
        case stay
        case switchTo(ServerRoute)
        /// Nothing qualifies: leave the current URL alone and let the existing
        /// recovery probe keep trying it.
        case none
    }

    /// At most one selection per trigger kind in this window.
    static let debounceInterval: TimeInterval = 2
    /// How often the server's route list is re-read per origin.
    static let routesRefreshInterval: TimeInterval = 600

    /// A route qualifies when its probe is `.ok`, the box that answered is the
    /// one the route names (a route without a known instance takes whoever
    /// answers: that is only ever the origin the user typed), and its token has
    /// not been refused there.
    static func qualifies(_ route: ServerRoute, probe: ProbeOutcome?, rejected: Set<String>) -> Bool {
        guard !rejected.contains(route.normalizedOrigin) else { return false }
        guard case let .ok(instance, _)? = probe else { return false }
        if let expected = route.instance { return instance == expected }
        return true
    }

    /// `probes` and `rejected` are keyed by origin (any spelling; normalized here).
    static func choose(
        routes: [ServerRoute],
        probes: [String: ProbeOutcome],
        current: String?,
        rejected: Set<String>
    ) -> Decision {
        var byOrigin: [String: ProbeOutcome] = [:]
        for (origin, outcome) in probes { byOrigin[ServerRoute.normalizeOrigin(origin)] = outcome }
        let refused = Set(rejected.map(ServerRoute.normalizeOrigin))
        let ok: (ServerRoute) -> Bool = { qualifies($0, probe: byOrigin[$0.normalizedOrigin], rejected: refused) }

        // Best = lowest kind rank, then list order (so two Wi-Fi origins keep
        // the server's order instead of flipping between them).
        let best = routes.enumerated()
            .filter { ok($0.element) }
            .min { ($0.element.kind.rank, $0.offset) < ($1.element.kind.rank, $1.offset) }?
            .element
        guard let best else { return .none }

        if let current, let here = routes.first(where: { ServerRoute.sameOrigin($0.origin, current) }), ok(here) {
            // Only a strictly better KIND is worth a switch: a same-kind sibling
            // is not an upgrade, and switching to it would only churn streams.
            return best.kind.rank < here.kind.rank ? .switchTo(best) : .stay
        }
        return .switchTo(best)
    }

    /// Debounce per trigger kind (one selection per `debounceInterval`).
    static func shouldReselect(trigger: RouteTrigger, lastRunAt: [RouteTrigger: Date], now: Date) -> Bool {
        guard let last = lastRunAt[trigger] else { return true }
        return now.timeIntervalSince(last) >= debounceInterval
    }

    /// Turn a raw `.ok` into `.mismatch` when the box that answered is not the
    /// one the route names.
    static func classify(_ outcome: ProbeOutcome, expected: String?) -> ProbeOutcome {
        guard case let .ok(instance, _) = outcome, let expected, instance != expected else { return outcome }
        return .mismatch(instance: instance)
    }

    /// Floor between two reads while the phone still knows a single route, so
    /// the launch burst of status refreshes asks once, not three times.
    static let singleRouteRefetchFloor: TimeInterval = 30

    /// Should the server's route list be read again now? Right away while this
    /// phone knows a single route (a fresh pairing), else every
    /// `routesRefreshInterval`. A server that answered 404 (no endpoint) is
    /// asked again only on the slow interval, so an old server is not asked on
    /// every status refresh.
    static func routesFetchDue(lastFetchAt: Date?, serverLacksRoutes: Bool, routeCount: Int, now: Date) -> Bool {
        guard let lastFetchAt else { return true }
        let elapsed = now.timeIntervalSince(lastFetchAt)
        if routeCount <= 1, !serverLacksRoutes { return elapsed >= singleRouteRefetchFloor }
        return elapsed >= routesRefreshInterval
    }
}
