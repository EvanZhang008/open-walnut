import Foundation
import os

/// Connection configuration — server URL + device name in UserDefaults,
/// device token in the Keychain. Read synchronously by the API client.
struct AppConfig {
    private static let urlKey = "walnut.serverUrl"
    private static let nameKey = "walnut.deviceName"
    private static let tokenKey = "walnut.deviceToken"

    /// In-process token cache (audit IO-6): `token` is read on EVERY API
    /// request, every image load, and every SSE connect, and each read was a
    /// synchronous `SecItemCopyMatching` XPC round-trip to securityd
    /// (~0.1-2ms, worst-case seconds when securityd is busy at cold start) —
    /// often on the main thread. The token only changes through save()/
    /// clear() in this process, so one Keychain read per launch is enough.
    /// `.none` = not yet read; `.some(nil)` = read, no token stored.
    private static let cachedToken = OSAllocatedUnfairLock<String??>(initialState: .none)

    #if DEBUG
    /// Where a test process is pointed instead: the discard port (RFC 863) with
    /// nothing bound to it, so a loopback connect is REFUSED in microseconds.
    /// Fail-fast is the requirement — a blackhole that hangs would trade live
    /// writes for a 30s URLSession timeout per call and an unrunnable suite.
    static let testBlackholeURL = URL(string: "http://127.0.0.1:9")!

    /// True when this process is a HOSTED UNIT-TEST host (`xcodebuild test` for
    /// `WalnutTests`). xcodebuild puts `XCTestConfigurationFilePath` in the test
    /// host's environment before `main()`; the app under XCUITest does NOT get
    /// it (it gets a session identifier instead), which is the distinction we
    /// want: the UI-test layer pairs itself deliberately and must keep working.
    private static let isHostedUnitTestProcess =
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    /// Process-local connection override — IN MEMORY ONLY, never persisted.
    ///
    /// Exists for the hosted unit-test bundle. `WalnutTests` runs INSIDE the
    /// installed app, so it inherits the app container's pairing: a test that
    /// builds a real store and calls a mutating method fires live writes at
    /// whatever server the human is dogfooding against. Re-pointing the
    /// container (writing `walnut.serverUrl`) would fix the tests and break the
    /// human's app, so the redirect has to be process-local: nothing here reads
    /// the container for the URL, and nothing here writes to it at all.
    ///
    /// WHY THE DEFAULT DOES THE WORK, not the test bundle. The obvious place to
    /// install this is the test bundle's principal class, and that IS where the
    /// explicit install lives (`WalnutTests/TestProcessNetworkBlackhole.swift`)
    /// — but measured, it is too late: XCTest loads a hosted bundle only after
    /// `applicationDidFinishLaunching`, so the app's OWN startup traffic (a
    /// client-log POST, the events SSE subscribe, status/inbox/engine reads) had
    /// already gone out to the live server before any test code ran. These locks
    /// are `static let`s, so Swift initializes them at the FIRST read of
    /// `serverURL`/`token` in the process, which is upstream of every request the
    /// app can make. The principal class then re-asserts the same values.
    private static let processURL = OSAllocatedUnfairLock<URL?>(
        initialState: isHostedUnitTestProcess ? testBlackholeURL : nil
    )
    /// `""` keeps `isConfigured` true (stores keep their normal paired shape)
    /// while carrying no credential to send anywhere.
    private static let processToken = OSAllocatedUnfairLock<String?>(
        initialState: isHostedUnitTestProcess ? "" : nil
    )

    static var processServerURLOverride: URL? {
        get { processURL.withLock { $0 } }
        set { processURL.withLock { $0 = newValue } }
    }

    /// Companion to `processServerURLOverride`.
    static var processTokenOverride: String? {
        get { processToken.withLock { $0 } }
        set { processToken.withLock { $0 = newValue } }
    }
    #endif

    static var serverURL: URL? {
        #if DEBUG
        // Before UserDefaults on purpose: the override must beat the container's
        // real pairing, and reading it has no side effect worth preserving.
        if let pinned = processURL.withLock({ $0 }) { return pinned }
        #endif
        guard let raw = UserDefaults.standard.string(forKey: urlKey) else { return nil }
        return URL(string: raw)
    }

    static var deviceName: String? {
        UserDefaults.standard.string(forKey: nameKey)
    }

    static var token: String? {
        // The real chain runs FIRST, then a process override replaces the value
        // it produced. Ordering is deliberate and the opposite of `serverURL`:
        // the chain's one-Keychain-read-per-process is itself a measured
        // invariant (audit IO-6, LifecycleHygieneTests counts the reads), so a
        // test process has to keep exercising it. The override only changes what
        // callers are handed, and adds no Keychain traffic of its own.
        let resolved = storedToken
        #if DEBUG
        if let pinned = processToken.withLock({ $0 }) { return pinned }
        #endif
        return resolved
    }

    private static var storedToken: String? {
        #if DEBUG
        // Diagnostics harness (DEBUG only): `-walnut.deviceToken <tok>` on the
        // launch command line pairs the app against a throwaway server with no
        // UI driving and no Keychain write. The server URL needs no hook —
        // UserDefaults already exposes launch args as NSArgumentDomain, so
        // `-walnut.serverUrl <url>` is picked up by `serverURL` above for free;
        // only the token lives outside UserDefaults. Used by
        // scripts/ios-client-log-e2e.sh to prove the flight-recorder upload
        // path end to end against an isolated server.
        if let injected = UserDefaults.standard.string(forKey: tokenKey), !injected.isEmpty {
            return injected
        }
        #endif
        if let cached = cachedToken.withLock({ $0 }) { return cached }
        // First read of the process — the one real securityd XPC. Timed into
        // LaunchTrace (audit TMR-2): it can run before the first frame (via
        // ConnectionStore.init → isConfigured) and can block for seconds when
        // securityd is busy at cold boot, yet was invisible to the first-frame
        // budget proof, which only counted DiskCache reads.
        let t0 = Date()
        let read = KeychainHelper.get(tokenKey)
        let elapsedMs = Date().timeIntervalSince(t0) * 1000
        LaunchTrace.mark(String(format: "keychain token read %.1fms", elapsedMs))
        cachedToken.withLock { $0 = .some(read) }
        return read
    }

    static var isConfigured: Bool {
        serverURL != nil && token != nil
    }

    static func save(serverURL: String, token: String, deviceName: String?) {
        UserDefaults.standard.set(normalize(serverURL), forKey: urlKey)
        if let deviceName, !deviceName.isEmpty {
            UserDefaults.standard.set(deviceName, forKey: nameKey)
        }
        KeychainHelper.set(token, forKey: tokenKey)
        cachedToken.withLock { $0 = .some(token) }
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: urlKey)
        UserDefaults.standard.removeObject(forKey: nameKey)
        KeychainHelper.delete(tokenKey)
        cachedToken.withLock { $0 = .some(nil) }
    }

    #if DEBUG
    /// Tests only — force the next `token` read back to the Keychain.
    static func resetTokenCacheForTesting() {
        cachedToken.withLock { $0 = .none }
    }
    #endif

    /// Normalize a user-entered server URL: add https scheme, strip trailing slashes.
    static func normalize(_ input: String) -> String {
        var url = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") { url.removeLast() }
        if !url.isEmpty, !url.lowercased().hasPrefix("http://"), !url.lowercased().hasPrefix("https://") {
            url = "https://\(url)"
        }
        return url
    }

    /// Parse a `wn://pair?name=<device>&token=<token>[&server=<url>]` pairing
    /// URI. `server` is optional — when present, setup becomes one tap.
    static func parsePairingURI(_ text: String) -> (name: String?, token: String, server: String?)? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("wn://pair?"),
              let components = URLComponents(string: trimmed),
              let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty
        else { return nil }
        let name = components.queryItems?.first(where: { $0.name == "name" })?.value
        let server = components.queryItems?.first(where: { $0.name == "server" })?.value
        return (name, token, server)
    }
}
