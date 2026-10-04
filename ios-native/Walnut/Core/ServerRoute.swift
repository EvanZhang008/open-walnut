import Foundation

/// One way to reach the paired Walnut: the same server (and the same device
/// token) at a different origin.
///
/// `lan` is the Mac on this Wi-Fi, `tailnet` the Mac over Tailscale, `cloud` the
/// HTTPS companion. `custom` is the origin the user paired with when the server's
/// own list does not contain it (an ssh forward, a reverse proxy of their own):
/// the user chose it, so it always ranks first.
struct ServerRoute: Codable, Equatable, Hashable, Sendable {
    enum Kind: String, Codable, CaseIterable, Sendable {
        case custom, lan, tailnet, cloud

        /// Preference order, lower wins: custom > lan > tailnet > cloud.
        var rank: Int {
            switch self {
            case .custom: return 0
            case .lan: return 1
            case .tailnet: return 2
            case .cloud: return 3
            }
        }

        /// What Settings calls the route ("Connected via Wi-Fi").
        var displayName: String {
            switch self {
            case .custom: return "Custom"
            case .lan: return "Wi-Fi"
            case .tailnet: return "Tailscale"
            case .cloud: return "Cloud"
            }
        }
    }

    var kind: Kind
    var origin: String
    var label: String
    /// Id of the box at `origin` (`GET /api/v1/instance`). nil = not known, which
    /// is only ever true of the route the user paired with by hand.
    var instance: String?

    init(kind: Kind, origin: String, label: String, instance: String? = nil) {
        self.kind = kind
        self.origin = origin
        self.label = label
        self.instance = instance
    }

    /// `label` is optional on the wire: a route without one is named by its kind.
    private enum CodingKeys: String, CodingKey { case kind, origin, label, instance }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(Kind.self, forKey: .kind)
        origin = try c.decode(String.self, forKey: .origin)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? kind.displayName
        let raw = try c.decodeIfPresent(String.self, forKey: .instance)
        instance = (raw?.isEmpty ?? true) ? nil : raw
    }

    /// The route for an origin the user paired with by hand.
    static func custom(_ origin: String) -> ServerRoute {
        ServerRoute(kind: .custom, origin: AppConfig.normalize(origin), label: Kind.custom.displayName)
    }

    var normalizedOrigin: String { Self.normalizeOrigin(origin) }

    /// Host (and a non-default port) for display: "192.168.1.20:3456".
    var displayHost: String {
        guard let c = URLComponents(string: AppConfig.normalize(origin)), let host = c.host, !host.isEmpty else {
            return origin
        }
        return c.port.map { "\(host):\($0)" } ?? host
    }

    /// Canonical spelling for comparing origins: scheme + host lowercased, the
    /// scheme's default port dropped, no trailing slash, no query or fragment. A
    /// path is kept on purpose (a reverse proxy may mount Walnut under one).
    static func normalizeOrigin(_ raw: String) -> String {
        let base = AppConfig.normalize(raw)
        guard var c = URLComponents(string: base), let scheme = c.scheme?.lowercased(),
              let host = c.percentEncodedHost, !host.isEmpty
        else { return base.lowercased() }
        c.scheme = scheme
        c.percentEncodedHost = host.lowercased()
        if (scheme == "http" && c.port == 80) || (scheme == "https" && c.port == 443) { c.port = nil }
        var path = c.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        c.percentEncodedPath = path
        c.query = nil
        c.fragment = nil
        return c.string ?? base
    }

    static func sameOrigin(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b else { return false }
        return normalizeOrigin(a) == normalizeOrigin(b)
    }
}

/// `GET /api/v1/routes`. Decoded leniently: a route of a kind this build does
/// not know (a newer server) is skipped instead of failing the whole list, and
/// the server never gets to name a `custom` route.
struct ServerRoutesResponse: Decodable, Sendable {
    let routes: [ServerRoute]
    let device: String?
    /// The Mac's Tailscale state (only the Mac sends it; see TailscaleHint).
    let tailscale: TailscaleHint?

    init(routes: [ServerRoute], device: String? = nil, tailscale: TailscaleHint? = nil) {
        self.routes = routes
        self.device = device
        self.tailscale = tailscale
    }

    private enum CodingKeys: String, CodingKey { case routes, device, tailscale }
    private struct Lossy: Decodable {
        let route: ServerRoute?
        init(from decoder: Decoder) throws { route = try? ServerRoute(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let lossy = try c.decodeIfPresent([Lossy].self, forKey: .routes) ?? []
        routes = lossy.compactMap(\.route).filter { $0.kind != .custom }
        device = try c.decodeIfPresent(String.self, forKey: .device)
        // A hint of the wrong shape, or one that says nothing, is no hint: it
        // must never cost the route list.
        let hint = (try? c.decodeIfPresent(TailscaleHint.self, forKey: .tailscale)) ?? nil
        tailscale = (hint?.isEmpty ?? true) ? nil : hint
    }
}

// MARK: - Persistence

extension AppConfig {
    static let routesKey = "walnut.routes"

    /// Every route known to reach the paired Walnut, best first.
    ///
    /// A hosted test process sees only its blackhole: the container's routes are
    /// the HUMAN's pairing, and a test process must neither read them (it would
    /// probe the human's real boxes) nor write them (see `processServerURLOverride`).
    static var routes: [ServerRoute] {
        #if DEBUG
        if let pinned = processServerURLOverride { return [.custom(pinned.absoluteString)] }
        #endif
        let current = UserDefaults.standard.string(forKey: urlKey)
        if urlPinnedByLaunchArguments { return current.map { [.custom($0)] } ?? [] }
        return routes(in: .standard, serverURL: current)
    }

    /// True when the route set cannot change in this process: a hosted test run
    /// (blackholed), or a launch that pinned `-walnut.serverUrl` on the command
    /// line (UI tests, diagnostics scripts). The argument domain outranks every
    /// write, so a route switch there would only rewrite the persistent pairing
    /// (the human's) underneath a URL that never changes.
    static var routesArePinned: Bool {
        #if DEBUG
        if processServerURLOverride != nil { return true }
        #endif
        return urlPinnedByLaunchArguments
    }

    /// Launch arguments are fixed for the life of the process.
    private static let urlPinnedByLaunchArguments =
        UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)[urlKey] != nil

    /// The server URL the stored routes were written for.
    static let routesAnchorKey = "walnut.routesAnchor"

    /// The stored routes, but only while they still belong to the current URL.
    ///
    /// `walnut.serverUrl` has writers that know nothing about routes: launch
    /// arguments (`-walnut.serverUrl`, every UI test and diagnostics script),
    /// `simctl defaults write`, an older build. Against such a URL the stored
    /// list describes ANOTHER pairing, and acting on it would carry the app off
    /// a test's throwaway server onto the real one. So the list counts only
    /// when the current URL is one of its routes or the URL it was stored for
    /// (the anchor: the server may have just dropped the current origin, which
    /// is exactly when the app must move to one it still lists). Otherwise, as
    /// on an install paired before routes existed, the current URL is the one
    /// (custom) route.
    static func routes(in defaults: UserDefaults, serverURL: String?) -> [ServerRoute] {
        guard let serverURL, !serverURL.isEmpty else { return [] }
        if let data = defaults.data(forKey: routesKey),
           let stored = try? JSONDecoder().decode([ServerRoute].self, from: data),
           !stored.isEmpty,
           stored.contains(where: { ServerRoute.sameOrigin($0.origin, serverURL) })
            || ServerRoute.sameOrigin(defaults.string(forKey: routesAnchorKey), serverURL) {
            return stored
        }
        return [.custom(serverURL)]
    }

    /// Store `routes` as the list for `anchor` (the current server URL).
    static func storeRoutes(_ routes: [ServerRoute], anchor: String?, in defaults: UserDefaults = .standard) {
        #if DEBUG
        if defaults === UserDefaults.standard, routesArePinned { return }
        #endif
        guard !routes.isEmpty, let data = try? JSONEncoder().encode(routes) else {
            clearRoutes(in: defaults)
            return
        }
        defaults.set(data, forKey: routesKey)
        if let anchor { defaults.set(normalize(anchor), forKey: routesAnchorKey) }
    }

    static func clearRoutes(in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: routesKey)
        defaults.removeObject(forKey: routesAnchorKey)
    }

    /// The route the app is talking through right now (nil when the current URL
    /// is not a known route, e.g. the server dropped it from its list).
    static var activeRoute: ServerRoute? {
        activeRoute(in: routes, serverURL: serverURL?.absoluteString)
    }

    static func activeRoute(in routes: [ServerRoute], serverURL: String?) -> ServerRoute? {
        guard let serverURL else { return nil }
        return routes.first { ServerRoute.sameOrigin($0.origin, serverURL) }
    }

    /// Point every client at `route`. Writes the server URL (and the routes'
    /// anchor with it) ONLY: the device token is the same on every route, and
    /// the disk cache describes the same Walnut, so neither is touched.
    static func setActiveRoute(_ route: ServerRoute) {
        if routesArePinned { return }
        setActiveRoute(route, in: .standard)
    }

    static func setActiveRoute(_ route: ServerRoute, in defaults: UserDefaults) {
        let origin = normalize(route.origin)
        defaults.set(origin, forKey: urlKey)
        defaults.set(origin, forKey: routesAnchorKey)
    }

    /// Fold the server's list into the stored one; returns whether it changed.
    @discardableResult
    static func mergeRoutes(server: [ServerRoute]) -> Bool {
        if routesArePinned { return false }
        let current = UserDefaults.standard.string(forKey: urlKey)
        let existing = routes(in: .standard, serverURL: current)
        let merged = mergeRoutes(existing, server: server)
        guard merged != existing else { return false }
        storeRoutes(merged, anchor: current)
        return true
    }

    /// Pure merge. The server's routes replace the stored ones of the same kind;
    /// a kind the server did not mention is KEPT (a box that was down when the
    /// list was built is not gone); the custom route survives only while its
    /// origin is not one the server lists. Result is ordered best first.
    static func mergeRoutes(_ existing: [ServerRoute], server: [ServerRoute]) -> [ServerRoute] {
        var seen = Set<String>()
        var fresh: [ServerRoute] = []
        for route in server where route.kind != .custom {
            if seen.insert(route.normalizedOrigin).inserted { fresh.append(route) }
        }
        guard !fresh.isEmpty else { return existing }
        let mentioned = Set(fresh.map(\.kind))
        var kept: [ServerRoute] = []
        for route in existing where !seen.contains(route.normalizedOrigin) {
            if route.kind == .custom || !mentioned.contains(route.kind) { kept.append(route) }
        }
        return ordered(kept + fresh)
    }

    /// Stable sort by kind preference (order within one kind is kept).
    static func ordered(_ routes: [ServerRoute]) -> [ServerRoute] {
        routes.enumerated()
            .sorted { ($0.element.kind.rank, $0.offset) < ($1.element.kind.rank, $1.offset) }
            .map(\.element)
    }
}
