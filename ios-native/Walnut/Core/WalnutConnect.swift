import Foundation
import os
import Security
import UIKit
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
///
/// The token goes to the port only while this library holds it (`holds`): another app could
/// take a port the app is not listening on (before the connector starts, or after iOS
/// reclaimed a suspended app's listener, Apple TN2277) and would get every request. So
/// `WalnutConnectGuard` fails each URLSession request to the port while it is not held, the
/// loads outside URLSession ask `maySend(to:)`, and the listener is taken again the moment the
/// app returns to the foreground.
final class WalnutConnect: @unchecked Sendable {
    static let shared = WalnutConnect()

    static let keyAccount = "walnut.connect.key"
    static let portKey = "walnut.connect.port"
    /// Every port the routes ever named: a request to an old one is held back too (another app
    /// may hold it now).
    static let portsKey = "walnut.connect.ports"
    static let routeLabel = "Walnut Connect"
    /// Posted (main thread) when the connector had to move to another port: the app's routes
    /// name it already, and live streams on the old one restart (RouteCoordinator).
    static let portMoved = Notification.Name("WalnutConnectPortMoved")

    /// A build with the real library (false: the stub, built without Rust's iOS targets).
    let isAvailable: Bool

    /// Every call that starts, stops or rebinds runs here, one at a time, off Swift's
    /// cooperative pool (a start can take seconds).
    private let ffi = DispatchQueue(label: "dev.openwalnut.connect.ffi", qos: .userInitiated)
    private let lock = NSLock()
    private var running: (peer: ConnectPeer, key: String, port: Int)?
    private var starting: (peer: ConnectPeer, key: String, task: Task<Int?, Never>)?
    /// iOS reclaims a suspended app's listener, and the app gets no word when it is suspended
    /// or woken (a silent push, a background refresh). So a timer ticks while the app runs:
    /// a gap in its ticks means the app was suspended, and the listener is taken again before
    /// the next send. An app that runs in the background (music playing) keeps ticking and
    /// keeps its listener, so its open connections are never reset.
    private var needsRebind = false
    private var lastTick: UInt64 = 0
    private var ticker: DispatchSourceTimer?
    private static let suspendedGap: UInt64 = 3_000_000_000

    private init() {
        isAvailable = Self.call { wc_status() }["stub"] as? Bool != true
        guard isAvailable else { return }
        // Back in front after a suspend: listen again before the first request asks.
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.tick()
            self.lock.lock(); let again = self.running != nil && self.needsRebind; self.lock.unlock()
            if again { _ = self.listenAgain() }
        }
    }

    /// One tick of the timer that notices a suspend (a gap since the last tick).
    private func tick() {
        let now = Self.now()
        lock.lock()
        if lastTick > 0, now &- lastTick > Self.suspendedGap { needsRebind = true }
        lastTick = now
        lock.unlock()
    }

    private func startTicking() {
        lock.lock(); defer { lock.unlock() }
        guard ticker == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "dev.openwalnut.connect.tick", qos: .utility))
        t.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(500))
        t.setEventHandler { [weak self] in self?.tick() }
        lastTick = Self.now()
        ticker = t
        t.resume()
    }

    /// Nanoseconds on a clock that keeps counting while the phone sleeps.
    private static func now() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) }

    // MARK: - The phone's key

    /// This phone's secret key (64 hex), made on first use; "" while the Keychain cannot be
    /// read (before the first unlock): a new key then would orphan the one the Mac lists.
    func key() -> String {
        switch KeychainHelper.read(Self.keyAccount) {
        case let .value(k) where Self.isKey(k): return k.lowercased()
        case .unreadable: return ""
        default: break
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return "" }
        let k = bytes.map { String(format: "%02x", $0) }.joined()
        KeychainHelper.set(k, forKey: Self.keyAccount, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        return k
    }

    /// Keep the key a pairing QR carried, once that pairing worked (the Mac listed its id
    /// already). Until then the key this phone had stays, so a failed pairing breaks nothing.
    func commitKey(_ hex: String) {
        guard Self.isKey(hex) else { return }
        KeychainHelper.set(hex.lowercased(), forKey: Self.keyAccount, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    }

    private static func isKey(_ s: String) -> Bool { s.count == 64 && s.allSatisfy(\.isHexDigit) }

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
        let stored = connectPort
        if (20_000..<60_000).contains(stored) { return stored }
        let fresh = Int.random(in: 20_000..<60_000)
        Self.remember(fresh)
        return fresh
    }

    private static func remember(_ port: Int) {
        let d = UserDefaults.standard
        d.set(port, forKey: portKey)
        let known = (d.array(forKey: portsKey) as? [Int]) ?? []
        d.set(Array((known.filter { $0 != port } + [port]).suffix(16)), forKey: portsKey)
    }

    /// The port stored for the routes; 0 when this phone never used Walnut Connect.
    var connectPort: Int { UserDefaults.standard.integer(forKey: Self.portKey) }

    var localOrigin: String { "http://127.0.0.1:\(preferredPort)" }

    /// Does this library hold `port` right now? Cheap: the guard asks it per request. After a
    /// suspend it takes the listener again first (a fraction of a millisecond).
    func holds(_ port: Int) -> Bool {
        guard isAvailable, port > 0 else { return false }
        let now = Self.now()
        lock.lock()
        let recheck = running != nil && (needsRebind || (lastTick > 0 && now &- lastTick > Self.suspendedGap))
        lock.unlock()
        if recheck, !listenAgain() { return false }
        return Int(wc_listening()) == port
    }

    /// May a request to `url`, a Walnut Connect address, go now? Only to 127.0.0.1, where the
    /// library listens, on the port it holds: `localhost` and `[::1]` name the same port on
    /// an address this app never listens on.
    func holds(url: URL?) -> Bool {
        guard let url, url.host == "127.0.0.1", let port = url.port else { return false }
        return holds(port)
    }

    private static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "::1", "[::1]"]

    /// Is `url` a Walnut Connect port of this phone (now or before), on any loopback name? Then
    /// the token goes there only while this library holds it (`holds(url:)`).
    func isConnectURL(_ url: URL?) -> Bool {
        guard isAvailable, let url, let host = url.host?.lowercased(), Self.loopbackHosts.contains(host),
              let port = url.port, port > 0 else { return false }
        if port == connectPort { return true }
        return ((UserDefaults.standard.array(forKey: Self.portsKey) as? [Int]) ?? []).contains(port)
    }

    /// May a load outside URLSession (AVPlayer, a web view) send its credential to `url` now?
    /// False only for the Walnut Connect port while this library does not hold it; the
    /// connector is woken then, and the load tried again later.
    func maySend(to url: URL?) -> Bool {
        guard isConnectURL(url) else { return true }
        if holds(url: url) { return true }
        wake()
        return false
    }

    /// Start (or keep) the connector for `peer`; the port it listens on, nil when it cannot.
    /// `key`: a pairing's key not kept yet (commitKey after the pairing worked). One start at a
    /// time: a second call for the same peer waits for the first.
    func ensureRunning(_ peer: ConnectPeer, key pending: String? = nil) async -> Int? {
        guard isAvailable else { return nil }
        let key = (pending ?? key()).lowercased()
        guard !key.isEmpty else { return nil }
        lock.lock()
        if let r = running, r.peer == peer, r.key == key, !needsRebind, Int(wc_listening()) == r.port {
            lock.unlock()
            return r.port
        }
        if let s = starting, s.peer == peer, s.key == key {
            lock.unlock()
            return await s.task.value
        }
        let task = Task<Int?, Never> { [weak self] in await self?.start(peer, key: key) ?? nil }
        starting = (peer, key, task)
        lock.unlock()
        let port = await task.value
        lock.lock()
        if starting?.task == task { starting = nil }
        lock.unlock()
        return port
    }

    /// `ensureRunning` that gives up after `seconds` (the start goes on): a route probe must not
    /// hold back the switch to another route while the Mac is unreachable.
    func ensureRunning(_ peer: ConnectPeer, within seconds: Double) async -> Int? {
        // A task group would wait for the start it gave up on; the first answer wins here.
        let answered = OSAllocatedUnfairLock(initialState: false)
        return await withCheckedContinuation { (k: CheckedContinuation<Int?, Never>) in
            let answer: @Sendable (Int?) -> Void = { port in
                if answered.withLock({ done in defer { done = true }; return !done }) { k.resume(returning: port) }
            }
            Task { answer(await self.ensureRunning(peer)) }
            Task { try? await Task.sleep(for: .seconds(seconds)); answer(nil) }
        }
    }

    private func start(_ peer: ConnectPeer, key: String) async -> Int? {
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
        lock.lock(); let rebindFirst = needsRebind; lock.unlock()
        let out = await onFFI {
            var out = text.withCString { ptr in Self.call { wc_start(ptr) } }
            // Back from the background: a kept client's listener may be one iOS reclaimed.
            if rebindFirst, out["ok"] as? Bool == true, out["kept"] as? Bool == true {
                let again = Self.call { wc_rebind() }
                if again["ok"] as? Bool == true { out["port"] = again["port"] }
            }
            return out
        }
        guard out["ok"] as? Bool == true, let port = out["port"] as? Int else {
            AppLog.info("connectivity", "walnut connect did not start", ["error": out["error"] as? String ?? "unknown"])
            return nil
        }
        lock.lock()
        running = (peer, key, port)
        needsRebind = false
        lastTick = Self.now()
        lock.unlock()
        startTicking()
        if port != connectPort { await movePort(to: port) }
        return port
    }

    /// The connector listens on another port now: the stored routes and the current URL name it.
    @MainActor private func movePort(to port: Int) {
        Self.remember(port)
        AppConfig.moveConnectRoutes(toPort: port)
        NotificationCenter.default.post(name: Self.portMoved, object: nil)
    }

    /// Take the listener again (the same port while it is free): on the way back to the
    /// foreground and before a send after a suspend. Never waits (any thread,
    /// the main one included): a start or stop under way answers false, and that start
    /// listens anew itself.
    private func listenAgain() -> Bool {
        let out = Self.call { wc_rebind() }
        guard out["ok"] as? Bool == true, let port = out["port"] as? Int else {
            if out["busy"] as? Bool != true {
                AppLog.info("connectivity", "walnut connect could not listen again", ["error": out["error"] as? String ?? "unknown"])
            }
            return false
        }
        lock.lock()
        if let r = running { running = (r.peer, r.key, port) }
        needsRebind = false
        lastTick = Self.now()
        lock.unlock()
        if port != connectPort {
            // Another app took the port while this one slept: everything moves to the new one,
            // and nothing is sent to the old (holds answers false for it).
            if Thread.isMainThread { MainActor.assumeIsolated { movePort(to: port) } }
            else { DispatchQueue.main.async { self.movePort(to: port) } }
        }
        return true
    }

    /// A request found the port not held: start (or listen again) for the stored route.
    func wake() {
        guard isAvailable else { return }
        lock.lock(); let busy = starting != nil; lock.unlock()
        guard !busy, let peer = AppConfig.storedConnectPeer() else { return }
        Task { _ = await ensureRunning(peer) }
    }

    /// The network changed (another Wi-Fi, cellular, back from the background).
    func networkChanged() {
        guard isAvailable else { return }
        wc_network_changed()
    }

    func stop() async {
        lock.lock(); running = nil; let t = ticker; ticker = nil; lock.unlock()
        t?.cancel()
        guard isAvailable else { return }
        await onFFI { wc_stop() }
    }

    /// What the connector says now (Settings > Connection): path, round trip, last error.
    func status() async -> [String: Any] {
        guard isAvailable else { return ["running": false] }
        return await onFFI { Self.call { wc_status() } }
    }

    /// Run `body` on the library's own queue and wait for it.
    private func onFFI<T>(_ body: @escaping () -> T) async -> T {
        await withCheckedContinuation { (k: CheckedContinuation<T, Never>) in
            ffi.async { k.resume(returning: body()) }
        }
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
