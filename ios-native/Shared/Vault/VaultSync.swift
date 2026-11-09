import Foundation

/// Where this phone's Walnut answers, and its device token: the app's own pairing, mirrored into
/// the app group for the AutoFill extension (VaultServerMirror).
struct VaultServer: Equatable, Sendable {
    var baseURL: URL
    var token: String

    /// This phone's own view of the link: https, this machine (a simulator's Mac), or Tailscale.
    /// The server's `privateLink` is its view; both must agree before a key derived from the
    /// master password leaves the phone, so a plain http reply cannot claim a private link.
    var transportIsPrivate: Bool {
        if baseURL.scheme?.lowercased() == "https" { return true }
        guard baseURL.scheme?.lowercased() == "http", let host = baseURL.host?.lowercased() else { return false }
        if host == "localhost" || host == "::1" || host.hasPrefix("127.") { return true }
        if host.hasSuffix(".ts.net") { return true }
        if host.hasPrefix("fd7a:115c:a1e0:") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 100 && (64...127).contains(parts[1])
    }
}

/// The copy the app keeps for its extension: the address it last reached Walnut at, in the app
/// group's defaults, and the token in the shared Keychain group.
enum VaultServerMirror {
    private static let urlKey = "walnut.vault.serverURL"

    static func save(_ server: VaultServer) {
        VaultShared.defaults.set(server.baseURL.absoluteString, forKey: urlKey)
        if VaultKeychain.getPlain(account: VaultKeychain.tokenAccount) != Data(server.token.utf8) {
            try? VaultKeychain.setPlain(Data(server.token.utf8), account: VaultKeychain.tokenAccount, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        }
    }

    /// A new pairing: the extension's copy follows it at once, when Passwords keeps one.
    static func updateIfKept(_ server: VaultServer) {
        guard VaultShared.defaults.string(forKey: urlKey) != nil else { return }
        save(server)
    }

    static func load() -> VaultServer? {
        guard let raw = VaultShared.defaults.string(forKey: urlKey), let url = URL(string: raw),
              let t = VaultKeychain.getPlain(account: VaultKeychain.tokenAccount), let token = String(data: t, encoding: .utf8), !token.isEmpty
        else { return nil }
        return VaultServer(baseURL: url, token: token)
    }

    static func clear() {
        VaultShared.defaults.removeObject(forKey: urlKey)
        VaultKeychain.delete(account: VaultKeychain.tokenAccount)
    }
}

enum VaultSyncError: Error, Equatable {
    /// Passwords are not set up on the Mac yet.
    case noVault
    /// The Mac does not answer (the cloud companion keeps no vault).
    case macAway
    case notPaired
    case unsupported
    case server(Int, String)
    case network(String)

    var message: String {
        switch self {
        case .noVault: return "Passwords are not set up in Walnut on your Mac yet."
        case .macAway: return "Your Mac is not reachable right now, so this list is from the last update."
        case .notPaired: return "This iPhone is not connected to Walnut."
        case .unsupported: return "Your Mac's Walnut keeps passwords in a newer format. Update the Walnut app."
        case .server(_, let m): return m
        case .network: return "Walnut could not be reached, so this list is from the last update."
        }
    }
}

/// The two read-only routes that carry the vault's ciphertext (src/web/routes/vault-sealed-v1.ts),
/// and the three this phone uses once on a private link to learn the Secret Key.
struct VaultClient: Sendable {
    var server: VaultServer
    var session: URLSession = .shared
    var timeout: TimeInterval = 20

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil, headers: [String: String] = [:]) async throws -> [String: Any] {
        var url = server.baseURL
        if !url.path.hasSuffix("/") { url.appendPathComponent("") }
        guard let full = URL(string: "api/v1\(path)", relativeTo: url) else { throw VaultSyncError.network("bad address") }
        var req = URLRequest(url: full, timeoutInterval: timeout)
        req.httpMethod = method
        req.authorizeForWalnut(token: server.token)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw VaultSyncError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if (200..<300).contains(status) { return json }
        let code = json["code"] as? String ?? ""
        if code == "vault_not_set_up" { throw VaultSyncError.noVault }
        if code == "vault_not_here" || status == 502 || status == 503 || status == 504 { throw VaultSyncError.macAway }
        if status == 401 && code.isEmpty { throw VaultSyncError.notPaired }
        throw VaultSyncError.server(status, json["error"] as? String ?? "Walnut answered \(status).")
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: Any?) throws -> T {
        guard let value else { throw VaultSyncError.server(0, "Walnut's answer was missing a part.") }
        let data = try JSONSerialization.data(withJSONObject: value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// The header and every item's tag, across pages.
    func index() async throws -> (VaultHeader, [String: String]) {
        var tags: [String: String] = [:]
        var header: VaultHeader?
        var after: String?
        for _ in 0..<1000 {
            var path = "/vault/sealed"
            if let after, let q = after.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { path += "?after=\(q)" }
            let page = try await request("GET", path)
            header = try decode(VaultHeader.self, page["vault"])
            let pageTags = try decode([String: String].self, page["items"] ?? [String: String]())
            tags.merge(pageTags) { _, b in b }
            guard let next = page["next"] as? String, !next.isEmpty else { break }
            after = next
        }
        guard let header else { throw VaultSyncError.server(0, "Walnut sent no vault header.") }
        guard header.supported else { throw VaultSyncError.unsupported }
        return (header, tags)
    }

    /// The sealed items with these ids, in as many answers as the server's page allows.
    func items(_ ids: [String]) async throws -> [String: VaultStoredItem] {
        var out: [String: VaultStoredItem] = [:]
        var want = ids
        while !want.isEmpty {
            let chunk = Array(want.prefix(4000))
            let page = try await request("POST", "/vault/sealed/items", body: ["ids": chunk])
            let got = try decode([String: VaultStoredItem].self, page["items"] ?? [String: Any]())
            out.merge(got) { _, b in b }
            let missing = Set(page["missing"] as? [String] ?? [])
            let done = Set(got.keys).union(missing)
            // Nothing new in an answer means nothing more will come: stop rather than loop.
            if done.isEmpty { break }
            want.removeAll { done.contains($0) }
        }
        return out
    }

    // MARK: - The Secret Key over a private link

    /// Whether this link is one nobody else reads (this Mac, https, Tailscale): the server says.
    func privateLink() async -> Bool {
        (try? await request("GET", "/vault/status"))?["privateLink"] as? Bool ?? false
    }

    /// The Secret Key, read with the master password's key over a private link: an unlock, the
    /// Secret Key route, and a lock of that one window again.
    func secretKey(passwordKey: Data) async throws -> String {
        let pk = passwordKey.base64EncodedString()
        let unlocked = try await request("POST", "/vault/unlock", body: ["passwordKey": pk, "client": "Walnut iPhone setup"])
        guard let session = (unlocked["session"] as? [String: Any])?["token"] as? String else {
            throw VaultSyncError.server(0, "Walnut did not open a session.")
        }
        defer { Task { _ = try? await request("POST", "/vault/lock", body: [:], headers: ["x-walnut-vault-session": session]) } }
        let r = try await request("POST", "/vault/secret-key", body: ["passwordKey": pk], headers: ["x-walnut-vault-session": session])
        guard let sk = r["secretKey"] as? String else { throw VaultSyncError.server(0, "Walnut did not send the Secret Key.") }
        return sk
    }
}
