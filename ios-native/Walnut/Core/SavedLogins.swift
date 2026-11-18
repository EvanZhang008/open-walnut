import Foundation

/// One Walnut this phone has signed in to: enough to sign in again with one tap.
///
/// A device token cannot be recovered from the server (only its hash is kept there), so
/// before this list existed Disconnect deleted the only copy and the user had to scan a
/// new QR code to come back (2026-11-18). Now Disconnect keeps the login here and only
/// "Forget Login" deletes it.
struct SavedLogin: Codable, Equatable, Identifiable, Sendable {
    var id: String
    /// The origin the phone used last, normalized (`AppConfig.normalize`).
    var serverURL: String
    /// Every route the server listed (Wi-Fi, Tailscale, cloud) and the one the user typed.
    var routes: [ServerRoute]
    var token: String
    var deviceName: String?
    var lastUsedAt: Date
    /// The server refused this token on a route that named itself as this Walnut: the
    /// phone was removed there. Kept so the screen can say so; never retried on its own.
    var removedByServer: Bool
    /// What the box at the pairing origin called itself (`GET /api/v1/instance`), nil for
    /// a server older than the endpoint. With the routes' own instances, this is what tells
    /// two Walnuts at the same LAN address apart.
    var instance: String?

    init(id: String, serverURL: String, routes: [ServerRoute], token: String, deviceName: String?,
         lastUsedAt: Date, removedByServer: Bool, instance: String? = nil) {
        self.id = id
        self.serverURL = serverURL
        self.routes = routes
        self.token = token
        self.deviceName = deviceName
        self.lastUsedAt = lastUsedAt
        self.removedByServer = removedByServer
        self.instance = instance
    }

    private enum CodingKeys: String, CodingKey {
        case id, serverURL, routes, token, deviceName, lastUsedAt, removedByServer, instance
    }

    /// Lenient where a newer version may differ: a route of a kind this build does not know
    /// is skipped (as `ServerRoutesResponse` does), never the whole login.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        serverURL = try c.decode(String.self, forKey: .serverURL)
        token = try c.decode(String.self, forKey: .token)
        routes = ((try? c.decode([Lossy<ServerRoute>].self, forKey: .routes)) ?? []).compactMap(\.value)
        deviceName = try? c.decodeIfPresent(String.self, forKey: .deviceName)
        lastUsedAt = (try? c.decode(Date.self, forKey: .lastUsedAt)) ?? .distantPast
        removedByServer = (try? c.decode(Bool.self, forKey: .removedByServer)) ?? false
        instance = try? c.decodeIfPresent(String.self, forKey: .instance)
    }

    /// The host the row is named by (`wn.example.com`, `192.168.1.20:3456`).
    var title: String {
        guard let url = URL(string: serverURL), let host = url.host else { return serverURL }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    /// Where a reconnect may go, in order: the last origin used, then every other route,
    /// best first. Each is probed for its identity before it is sent the token.
    ///
    /// A route that names no instance (the origin the user typed) is held to the instance seen
    /// at pairing, when one was: the same address on another network may be someone else's box.
    var candidateRoutes: [ServerRoute] {
        let pinned: (ServerRoute) -> ServerRoute = { route in
            guard route.instance == nil, let instance else { return route }
            return ServerRoute(kind: route.kind, origin: route.origin, label: route.label, instance: instance)
        }
        let last = routes.first { ServerRoute.sameOrigin($0.origin, serverURL) } ?? .custom(serverURL)
        var out = [pinned(last)]
        for route in AppConfig.ordered(routes) where !out.contains(where: { $0.normalizedOrigin == route.normalizedOrigin }) {
            out.append(pinned(route))
        }
        return out
    }

    /// Every instance this login's Walnut is known by.
    var instances: Set<String> {
        Set(routes.compactMap(\.instance) + [instance].compactMap { $0 })
    }

    /// The same Walnut: the same token, or a shared instance; with no instance known on
    /// either side, a shared origin that is not a LAN address (one LAN address can be a
    /// different Walnut on another network).
    func isSameWalnut(as other: SavedLogin) -> Bool {
        if token == other.token { return true }
        let mine = instances, theirs = other.instances
        if !mine.isEmpty, !theirs.isEmpty { return !mine.isDisjoint(with: theirs) }
        return !wideOrigins.isDisjoint(with: other.wideOrigins)
    }

    /// The origins that name one Walnut wherever the phone is: every origin but a private
    /// one (a LAN address, `.local`, loopback), whatever kind of route carries it: a typed or
    /// scanned origin is a `custom` route even when it is `192.168.1.20`.
    private var wideOrigins: Set<String> {
        Set((routes.map(\.origin) + [serverURL]).filter { !Self.isPrivate($0) }.map(ServerRoute.normalizeOrigin))
    }

    /// An origin that names a different box on another network. Internal for WalnutTests.
    static func isPrivate(_ origin: String) -> Bool {
        guard let host = URL(string: AppConfig.normalize(origin))?.host?.lowercased() else { return true }
        if host == "localhost" || host.hasSuffix(".local") { return true }
        let v6 = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if v6.contains(":") {
            return v6 == "::1" || v6.hasPrefix("fc") || v6.hasPrefix("fd") || v6.hasPrefix("fe80")
        }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return false }
        switch (parts[0], parts[1]) {
        case (10, _), (127, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        default: return false
        }
    }
}

/// One element decoded on its own, so one bad element does not fail its list.
private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// The saved logins, as one Keychain item (`KeychainHelper`, this device only: a backup
/// restored on another phone must not bring this phone's device identities with it). One
/// item means a fresh install's cleanup (`InstallMarker`) removes them all at once. Read on
/// the pairing screen and when a pairing starts or ends, never per request.
enum SavedLogins {
    static let key = "walnut.savedLogins"

    enum Loaded: Equatable {
        case list([SavedLogin])
        /// The Keychain would not give the item now (locked, busy): nothing may be written
        /// over it.
        case unreadable
        /// The item is there but is not a list this build reads (a future format, damage).
        case undecodable(String)
    }

    /// Where an undecodable list is moved aside before a fresh one is started, so a new login
    /// can be saved without destroying what an older or newer build wrote.
    static let setAsideKey = "walnut.savedLogins.setAside"

    static func load() -> Loaded {
        switch KeychainHelper.read(key) {
        case .missing:
            return .list([])
        case .unreadable:
            return .unreadable
        case .value(let raw):
            guard let data = raw.data(using: .utf8),
                  let list = try? decoder.decode([Lossy<SavedLogin>].self, from: data)
            else { return .undecodable(raw) }
            return .list(list.compactMap(\.value).sorted { $0.lastUsedAt > $1.lastUsedAt })
        }
    }

    static func all() -> [SavedLogin] {
        if case .list(let list) = load() { return list }
        return []
    }

    /// Read, change, write back; nothing is written over an item that could not be read.
    private static func update(_ change: (inout [SavedLogin]) -> Void) {
        var list: [SavedLogin]
        switch load() {
        case .list(let loaded):
            list = loaded
        case .unreadable:
            AppLog.warn("auth", "saved logins unreadable now; left as they are", [:])
            return
        case .undecodable(let raw):
            // Not a format this build reads: kept aside (once), and a fresh list starts, so
            // Disconnect can still keep the login in use.
            if case .missing = KeychainHelper.read(setAsideKey) {
                KeychainHelper.set(raw, forKey: setAsideKey, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
            }
            AppLog.warn("auth", "saved logins not readable by this build; set aside", [:])
            list = []
        }
        change(&list)
        store(list)
    }

    private static func store(_ list: [SavedLogin]) {
        guard !list.isEmpty else {
            KeychainHelper.delete(key)
            return
        }
        guard let data = try? encoder.encode(list), let raw = String(data: data, encoding: .utf8) else { return }
        KeychainHelper.set(raw, forKey: key, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    }

    /// Save (or refresh) a login, first in the list. The same Walnut (`isSameWalnut`) is
    /// replaced in place: a new QR code for it replaces the old token. The demo is never
    /// saved: it is not a server. Returns the saved login.
    @discardableResult
    static func remember(
        serverURL: String, routes: [ServerRoute], token: String, deviceName: String?,
        instance: String? = nil, removedByServer: Bool = false, now: Date = Date()
    ) -> SavedLogin? {
        let origin = AppConfig.normalize(serverURL)
        guard !origin.isEmpty, !token.isEmpty, !DemoMode.isDemoURL(origin) else { return nil }
        var saved = SavedLogin(
            id: UUID().uuidString, serverURL: origin, routes: routes, token: token,
            deviceName: deviceName?.isEmpty == false ? deviceName : nil,
            lastUsedAt: now, removedByServer: removedByServer, instance: instance
        )
        update { list in
            let matches = list.indices.filter { list[$0].isSameWalnut(as: saved) }
            if let first = matches.first {
                saved.id = list[first].id
                if saved.deviceName == nil { saved.deviceName = list[first].deviceName }
                // The pairing's instance carries over only on a match by identity (the same
                // token, or a shared instance): a match by origin alone may be another box.
                let old = list[first]
                let byIdentity = old.token == saved.token || !old.instances.isDisjoint(with: saved.instances)
                if saved.instance == nil, byIdentity { saved.instance = old.instance }
            }
            for index in matches.reversed() { list.remove(at: index) }
            list.insert(saved, at: 0)
        }
        return saved
    }

    /// The pairing in use now, saved before Disconnect clears it. nil when there is none.
    @discardableResult
    static func rememberCurrentPairing(removedByServer: Bool = false) -> SavedLogin? {
        guard let current = currentPairing() else { return nil }
        return remember(
            serverURL: current.serverURL, routes: current.routes, token: current.token,
            deviceName: current.deviceName, removedByServer: removedByServer
        )
    }

    static func markRemovedByServer(id: String) {
        update { list in
            if let index = list.firstIndex(where: { $0.id == id }) { list[index].removedByServer = true }
        }
    }

    static func forget(id: String) {
        update { $0.removeAll { $0.id == id } }
    }

    /// Forget the current pairing's Walnut, every row of it (Disconnect and Forget Login).
    static func forgetCurrentPairing() {
        guard let current = currentPairing() else { return }
        update { $0.removeAll { $0.isSameWalnut(as: current) } }
    }

    private static func currentPairing() -> SavedLogin? {
        guard let url = AppConfig.serverURL?.absoluteString, let token = AppConfig.token, !token.isEmpty
        else { return nil }
        return SavedLogin(id: "", serverURL: AppConfig.normalize(url), routes: AppConfig.routes, token: token,
                          deviceName: AppConfig.deviceName, lastUsedAt: Date(), removedByServer: false)
    }

    static func removeAll() {
        KeychainHelper.delete(key)
        KeychainHelper.delete(setAsideKey)
    }

    #if DEBUG
    /// UI tests start with no saved login (`UITestLaunch`), whatever an earlier test saved
    /// in the test Keychain namespace; a test of the list across a relaunch keeps them.
    static let freshArgument = "walnut.uiTestFreshSavedLogins"

    static func applyFreshArgument(defaults: UserDefaults = .standard) {
        guard defaults.bool(forKey: freshArgument), KeychainHelper.namespace == .tests else { return }
        removeAll()
    }

    /// Tests only: write raw text where the list lives.
    static func storeRawForTesting(_ raw: String) {
        KeychainHelper.set(raw, forKey: key)
    }
    #endif

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }()
}

/// Which of a saved login's routes may be sent its token, from the identity probes
/// (`RouteCoordinator.probeAll`): only a route whose box named itself as this Walnut, or a
/// route that names no instance (the origin the user typed, as at pairing). Pure.
enum ReconnectPlan {
    /// A refusal counts as the server removing the phone only from a route whose box said
    /// which Walnut it is: a box that never named itself may be someone else's.
    static func refusalIsVerified(_ route: ServerRoute) -> Bool { route.instance != nil }

    static func routes(for login: SavedLogin, probes: [String: ProbeOutcome]) -> [ServerRoute] {
        login.candidateRoutes.filter { route in
            RouteSelector.qualifies(route, probe: probes[route.normalizedOrigin], rejected: [])
        }
    }
}
