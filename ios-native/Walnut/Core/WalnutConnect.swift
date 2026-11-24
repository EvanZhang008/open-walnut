import Foundation
import Security
@_implementationOnly import WalnutConnectFFI

/// Where the paired Mac is on Walnut Connect: its network id, the relay it is on, its
/// addresses (`GET /api/v1/routes`, route kind `connect`; docs/reference/walnut-connect.md).
struct ConnectPeer: Codable, Equatable, Hashable, Sendable {
    var id: String
    var relayMode: String
    var relays: [String]
    var relayRoots: [String]?
    var addrs: [String]

    init(id: String, relayMode: String = "public", relays: [String] = [], relayRoots: [String]? = nil, addrs: [String] = []) {
        self.id = id
        self.relayMode = relayMode
        self.relays = relays
        self.relayRoots = relayRoots
        self.addrs = addrs
    }

    private enum CodingKeys: String, CodingKey { case id, relayMode, relays, relayRoots, addrs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id).lowercased()
        guard id.count == 64, id.allSatisfy(\.isHexDigit) else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "not a network id")
        }
        relayMode = try c.decodeIfPresent(String.self, forKey: .relayMode) ?? "public"
        relays = try c.decodeIfPresent([String].self, forKey: .relays) ?? []
        relayRoots = try c.decodeIfPresent([String].self, forKey: .relayRoots)
        addrs = try c.decodeIfPresent([String].self, forKey: .addrs) ?? []
    }
}

/// Walnut Connect on this phone: the Rust library (native/walnut-connect) holds an iroh
/// endpoint with this phone's key and opens a port on 127.0.0.1 whose every connection is an
/// encrypted stream to the Mac. The app's routes treat `http://127.0.0.1:<port>` as one more
/// address of its Walnut, so every request, stream and probe works through it unchanged.
///
/// The key is this phone's alone (the Keychain, this device only). The Mac lets in only the
/// key's network id, and still asks for the device token on every request.
final class WalnutConnect: @unchecked Sendable {
    static let shared = WalnutConnect()

    static let keyAccount = "walnut.connect.key"
    static let portKey = "walnut.connect.port"
    static let routeLabel = "Walnut Connect"

    private let lock = NSLock()
    private var running: (peer: ConnectPeer, port: Int)?

    /// A build with the real library (false: the stub, built without Rust's iOS targets).
    lazy var isAvailable: Bool = {
        let status = Self.call { wc_status() }
        return status["stub"] as? Bool != true
    }()

    // MARK: - The phone's key

    /// This phone's secret key (64 hex), made on first use.
    func key() -> String {
        if let k = KeychainHelper.get(Self.keyAccount), k.count == 64, k.allSatisfy(\.isHexDigit) { return k }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return "" }
        let k = bytes.map { String(format: "%02x", $0) }.joined()
        KeychainHelper.set(k, forKey: Self.keyAccount, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        return k
    }

    /// The key a pairing QR carried for this phone (the Mac listed its id already).
    func adoptKey(_ hex: String) {
        let k = hex.lowercased()
        guard k.count == 64, k.allSatisfy(\.isHexDigit) else { return }
        KeychainHelper.set(k, forKey: Self.keyAccount, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        stop()
    }

    /// This phone's network id: what it registers with the Mac.
    func endpointID() -> String? {
        guard isAvailable else { return nil }
        let k = key()
        return k.isEmpty ? nil : Self.endpointID(ofKey: k)
    }

    /// The network id of a secret key (iroh's: the Ed25519 public key), from the library.
    static func endpointID(ofKey hex: String) -> String? {
        let out = hex.withCString { ptr in call { wc_endpoint_id(ptr) } }
        return out["ok"] as? Bool == true ? out["id"] as? String : nil
    }

    // MARK: - The local port

    /// The port the app's routes name; kept across launches so a stored address keeps working.
    var preferredPort: Int {
        let stored = UserDefaults.standard.integer(forKey: Self.portKey)
        if (20_000..<60_000).contains(stored) { return stored }
        let fresh = Int.random(in: 20_000..<60_000)
        UserDefaults.standard.set(fresh, forKey: Self.portKey)
        return fresh
    }

    var localOrigin: String { "http://127.0.0.1:\(preferredPort)" }

    /// Is `origin` this phone's Walnut Connect port?
    static func isLocalOrigin(_ origin: String) -> Bool {
        guard let c = URLComponents(string: AppConfig.normalize(origin)) else { return false }
        return c.host == "127.0.0.1" && c.port == UserDefaults.standard.integer(forKey: portKey)
    }

    /// Start (or keep) the connector for `peer`; the port it listens on, nil when it cannot.
    /// Blocking work runs off the caller's thread.
    func ensureRunning(_ peer: ConnectPeer) async -> Int? {
        guard isAvailable else { return nil }
        lock.lock()
        if let r = running, r.peer == peer { lock.unlock(); return r.port }
        lock.unlock()
        let key = key()
        guard !key.isEmpty else { return nil }
        var config: [String: Any] = [
            "key": key,
            "peer": ["id": peer.id, "relays": peer.relays, "addrs": peer.addrs],
            "relayMode": peer.relayMode,
            "port": preferredPort,
        ]
        if peer.relayMode == "custom" {
            config["relays"] = peer.relays
            if let roots = peer.relayRoots, !roots.isEmpty { config["relayRoots"] = roots }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: config),
              let text = String(data: data, encoding: .utf8) else { return nil }
        let out = await Task.detached(priority: .userInitiated) {
            text.withCString { ptr in Self.call { wc_start(ptr) } }
        }.value
        guard out["ok"] as? Bool == true, let port = out["port"] as? Int else {
            AppLog.info("connectivity", "walnut connect did not start", ["error": out["error"] as? String ?? "unknown"])
            return nil
        }
        if port != preferredPort {
            // The port was taken: the routes name the new one from now on.
            UserDefaults.standard.set(port, forKey: Self.portKey)
            AppConfig.moveConnectRoutes(toPort: port)
        }
        lock.lock()
        running = (peer, port)
        lock.unlock()
        return port
    }

    /// The network changed (another Wi-Fi, cellular, back from the background).
    func networkChanged() {
        guard isAvailable else { return }
        wc_network_changed()
    }

    func stop() {
        lock.lock()
        running = nil
        lock.unlock()
        guard isAvailable else { return }
        Task.detached { wc_stop() }
    }

    /// What the connector says now (Settings > Connection): path, round trip, last error.
    func status() async -> [String: Any] {
        guard isAvailable else { return ["running": false] }
        return await Task.detached { Self.call { wc_status() } }.value
    }

    /// One call into the library, its JSON answer parsed and its string freed.
    private static func call(_ body: () -> UnsafeMutablePointer<CChar>?) -> [String: Any] {
        guard let raw = body() else { return ["ok": false, "error": "no answer"] }
        defer { wc_free(raw) }
        let text = String(cString: raw)
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ["ok": false, "error": "unreadable answer"]
        }
        return obj
    }
}
