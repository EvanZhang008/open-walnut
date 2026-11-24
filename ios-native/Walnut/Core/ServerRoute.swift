import Foundation

/// One way to reach the paired Walnut: the same server (and the same device
/// token) at a different origin.
///
/// `lan` is the Mac on this Wi-Fi, `tailnet` the Mac over Tailscale, `connect` the
/// Mac over Walnut Connect (from anywhere, through this phone's own 127.0.0.1 port:
/// WalnutConnect.swift), `cloud` the HTTPS companion. `custom` is the origin the user
/// paired with when the server's own list does not contain it (an ssh forward, a
/// reverse proxy of their own): the user chose it, so it always ranks first.
struct ServerRoute: Codable, Equatable, Hashable, Sendable {
    enum Kind: String, Codable, CaseIterable, Sendable {
        case custom, lan, tailnet, connect, cloud

        /// Preference order, lower wins: custom > lan > tailnet > connect > cloud. Walnut
        /// Connect reaches the Mac itself, so it beats the companion's copy while it answers.
        var rank: Int {
            switch self {
            case .custom: return 0
            case .lan: return 1
            case .tailnet: return 2
            case .connect: return 3
            case .cloud: return 4
            }
        }

        /// What Settings calls the route ("Connected via Wi-Fi").
        var displayName: String {
            switch self {
            case .custom: return "Custom"
            case .lan: return "Wi-Fi"
            case .tailnet: return "Tailscale"
            case .connect: return "Walnut Connect"
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
    /// `connect` only: where the Mac is on Walnut Connect. Its `origin` is this phone's
    /// own port (AppConfig.localizedConnectRoutes); the server names it `walnut-connect://<id>`.
    var connect: ConnectPeer?

    init(kind: Kind, origin: String, label: String, instance: String? = nil, connect: ConnectPeer? = nil) {
        self.kind = kind
        self.origin = origin
        self.label = label
        self.instance = instance
        self.connect = connect
    }

    /// `label` is optional on the wire: a route without one is named by its kind.
    private enum CodingKeys: String, CodingKey { case kind, origin, label, instance, connect }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(Kind.self, forKey: .kind)
        origin = try c.decode(String.self, forKey: .origin)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? kind.displayName
        let raw = try c.decodeIfPresent(String.self, forKey: .instance)
        instance = (raw?.isEmpty ?? true) ? nil : raw
        connect = try c.decodeIfPresent(ConnectPeer.self, forKey: .connect)
        // A Walnut Connect route says where the Mac is, or it is no route.
        if kind == .connect, connect == nil {
            throw DecodingError.dataCorruptedError(forKey: .connect, in: c, debugDescription: "a connect route without its peer")
        }
    }


    /// The route for an origin the user paired with by hand.
    static func custom(_ origin: String) -> ServerRoute {
        ServerRoute(kind: .custom, origin: AppConfig.normalize(origin), label: Kind.custom.displayName)
    }

    var normalizedOrigin: String { Self.normalizeOrigin(origin) }

    /// Host (and a non-default port) for display: "192.168.1.20:3456".
    var displayHost: String {
        // Walnut Connect's origin is this phone's own port: nothing a person reads as an address.
        if kind == .connect { return Self.connectAddressText }
        guard let c = URLComponents(string: AppConfig.normalize(origin)), let host = c.host, !host.isEmpty else {
            return origin
        }
        return c.port.map { "\(host):\($0)" } ?? host
    }

    static let connectAddressText = "encrypted, from anywhere"

    /// The address a route list shows: the origin, or what Walnut Connect is.
    var displayAddress: String { kind == .connect ? displayHost : origin }

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
    /// With a Walnut Connect route: the network id this phone registered on the Mac (nil:
    /// none yet, so it registers its own; WalnutAPI.registerConnect).
    let connectEndpoint: String?
    /// The Mac says Walnut Connect is off for sure: a stored connect route goes. Absent from
    /// a companion and from a Mac that cannot tell right now.
    let connectOff: Bool

    init(routes: [ServerRoute], device: String? = nil, tailscale: TailscaleHint? = nil, connectEndpoint: String? = nil, connectOff: Bool = false) {
        self.routes = routes
        self.device = device
        self.tailscale = tailscale
        self.connectEndpoint = connectEndpoint
        self.connectOff = connectOff
    }

    private enum CodingKeys: String, CodingKey { case routes, device, tailscale, connectEndpoint, connectOff }
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
        connectEndpoint = (try? c.decodeIfPresent(String.self, forKey: .connectEndpoint)) ?? nil
        connectOff = (try? c.decodeIfPresent(Bool.self, forKey: .connectOff)) ?? false
    }

    /// The Walnut Connect route the server listed, if any.
    var connectRoute: ServerRoute? { routes.first { $0.kind == .connect } }
}

// MARK: - Persistence

extension AppConfig {
    static let routesKey = "walnut.routes"
    /// Walnut Connect routes live apart from the rest: an older build decodes `routesKey`
    /// strictly and knows no `connect` kind, so mixing them in would cost it every route.
    static let connectRoutesKey = "walnut.routes.connect"

    /// Every stored route, best first. Lossy: a route this build cannot read is skipped,
    /// never the whole list.
    static func storedRoutes(in defaults: UserDefaults) -> [ServerRoute] {
        let main = decodeRoutes(defaults.data(forKey: routesKey)).filter { $0.kind != .connect }
        // An older build re-pairing clears only the main list: a connect route of another
        // Walnut than the main list's is that old pairing's, never this one's.
        let paired = Set(main.compactMap(\.instance))
        let connect = decodeRoutes(defaults.data(forKey: connectRoutesKey)).filter {
            $0.kind == .connect && (paired.isEmpty || $0.instance.map(paired.contains) == true)
        }
        return connect.isEmpty ? main : ordered(main + connect)
    }

    private struct LossyRoute: Decodable {
        let route: ServerRoute?
        init(from decoder: Decoder) throws { route = try? ServerRoute(from: decoder) }
    }

    private static func decodeRoutes(_ data: Data?) -> [ServerRoute] {
        guard let data, let list = try? JSONDecoder().decode([LossyRoute].self, from: data) else { return [] }
        return list.compactMap(\.route)
    }

    /// The Mac's Walnut Connect peer, from the stored routes (nil: none, or a pinned run).
    static func storedConnectPeer() -> ConnectPeer? {
        routes.first { $0.kind == .connect }?.connect
    }

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
        let stored = storedRoutes(in: defaults)
        if !stored.isEmpty,
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
        let main = routes.filter { $0.kind != .connect }
        let connect = routes.filter { $0.kind == .connect }
        guard !routes.isEmpty,
              let mainData = try? JSONEncoder().encode(main),
              let connectData = try? JSONEncoder().encode(connect) else {
            clearRoutes(in: defaults)
            return
        }
        defaults.set(mainData, forKey: routesKey)
        if connect.isEmpty { defaults.removeObject(forKey: connectRoutesKey) } else { defaults.set(connectData, forKey: connectRoutesKey) }
        if let anchor { defaults.set(normalize(anchor), forKey: routesAnchorKey) }
    }

    static func clearRoutes(in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: routesKey)
        defaults.removeObject(forKey: connectRoutesKey)
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

    /// Fold the server's list into the stored one; returns whether it changed. `connectOff`: the
    /// Mac said Walnut Connect is off for sure, so a stored connect route goes.
    @discardableResult
    static func mergeRoutes(server: [ServerRoute], connectOff: Bool = false) -> Bool {
        if routesArePinned { return false }
        let current = UserDefaults.standard.string(forKey: urlKey)
        let existing = routes(in: .standard, serverURL: current)
        // A build without Walnut Connect (the stub library) keeps no route it cannot use.
        let usable = WalnutConnect.shared.isAvailable
            ? localizedConnectRoutes(server, origin: WalnutConnect.shared.localOrigin)
            : server.filter { $0.kind != .connect }
        let merged = mergeRoutes(existing, server: usable, dropUnlisted: connectOff ? [.connect] : [])
        guard merged != existing else { return false }
        storeRoutes(merged, anchor: current)
        return true
    }

    /// Pure merge. The server's routes replace the stored ones of the same kind;
    /// a kind the server did not mention is KEPT (a box that was down when the
    /// list was built is not gone); the custom route survives only while its
    /// origin is not one the server lists. A kind in `dropUnlisted` goes when the server did
    /// not list it. Result is ordered best first.
    static func mergeRoutes(_ existing: [ServerRoute], server: [ServerRoute], dropUnlisted: Set<ServerRoute.Kind> = []) -> [ServerRoute] {
        var seen = Set<String>()
        var fresh: [ServerRoute] = []
        for route in server where route.kind != .custom {
            if seen.insert(route.normalizedOrigin).inserted { fresh.append(route) }
        }
        guard !fresh.isEmpty else { return existing }
        let mentioned = Set(fresh.map(\.kind))
        var kept: [ServerRoute] = []
        for route in existing where !seen.contains(route.normalizedOrigin) {
            if route.kind == .custom || (!mentioned.contains(route.kind) && !dropUnlisted.contains(route.kind)) { kept.append(route) }
        }
        return ordered(kept + fresh)
    }

    /// Walnut Connect routes as this phone dials them: through its own port. Pure.
    static func localizedConnectRoutes(_ routes: [ServerRoute], origin: String) -> [ServerRoute] {
        routes.map { route in
            guard route.kind == .connect else { return route }
            var r = route
            r.origin = normalize(origin)
            return r
        }
    }

    /// The connector had to listen on another port: the stored Walnut Connect routes, and the
    /// current URL when it was one, name the new one.
    static func moveConnectRoutes(toPort port: Int) {
        if routesArePinned { return }
        let origin = "http://127.0.0.1:\(port)"
        let current = UserDefaults.standard.string(forKey: urlKey)
        let stored = routes(in: .standard, serverURL: current)
        guard stored.contains(where: { $0.kind == .connect }) else { return }
        let wasConnect = stored.contains { $0.kind == .connect && ServerRoute.sameOrigin($0.origin, current) }
        let moved = localizedConnectRoutes(stored, origin: origin)
        storeRoutes(moved, anchor: wasConnect ? origin : current)
        if wasConnect { UserDefaults.standard.set(normalize(origin), forKey: urlKey) }
    }

    /// Stable sort by kind preference (order within one kind is kept).
    static func ordered(_ routes: [ServerRoute]) -> [ServerRoute] {
        routes.enumerated()
            .sorted { ($0.element.kind.rank, $0.offset) < ($1.element.kind.rank, $1.offset) }
            .map(\.element)
    }
}
