import Foundation

/// The built-in demo: the whole app running against an in-process fake server.
///
/// WHY A FAKE SERVER AND NOT FAKE STORES. The app normally pairs with the user's
/// own Walnut server, which an App Store reviewer (or a curious new user) does not
/// have. Demo mode pairs the app with a reserved address instead, and
/// `DemoURLProtocol` answers every request for that address from fixture data and a
/// small in-memory store (`DemoServer`). So the REAL code paths run: the stores, the
/// transports, the decoders, the SSE clients and their reconnect logic. Nothing in a
/// store or a view knows it is a demo, which is also why the demo stays honest as
/// the app changes: a store that stops decoding a fixture breaks here first.
///
/// HOW "DEMO" IS DECIDED. The app is in demo mode exactly when it is paired with
/// `baseURL`. Pairing goes through the ordinary `ConnectionStore.connect`, and
/// leaving goes through the ordinary `ConnectionStore.disconnect`, so the demo has
/// no second notion of "paired" that could disagree with the first.
///
/// THE NETWORK RULE. While the demo is active not a single request may leave the
/// phone. `DemoURLProtocol` claims every http(s) request for the demo host and, in
/// demo mode, every request for ANY other host too, which it answers locally with
/// a "not connected" error instead of letting it out. `.invalid` is a reserved
/// top-level domain (RFC 2606), so even a session the protocol were somehow not
/// installed on could never reach a real machine with this address.
enum DemoMode {
    /// Reserved, never resolvable (RFC 2606 `.invalid`).
    static let host = "demo.walnut.invalid"
    static let baseURLString = "https://demo.walnut.invalid"
    static var baseURL: URL { URL(string: baseURLString)! }
    /// Sent as the Bearer token. Carries no credential, it only keeps the app's
    /// "paired" shape (`AppConfig.isConfigured` needs a token).
    static let token = "walnut-demo-token"
    static let deviceName = "Demo"

    /// True while the app is paired with the demo server. Cheap: one UserDefaults
    /// read (an in-memory dictionary lookup) and a URL parse. Called from
    /// `DemoURLProtocol.canInit` on URLSession's own threads, which is safe because
    /// `AppConfig.serverURL` only reads thread-safe stores.
    static var isActive: Bool { isDemoURL(AppConfig.serverURL) }

    /// What Settings shows for the address: the demo is not a server, so it is
    /// not shown as one.
    static let addressLabel = "Demo with sample data, no server"

    /// What Settings shows for the status: not "Live", which would claim a server.
    static let statusLabel = "Demo"

    /// What the demo card says about changes. The demo keeps them in a scope of
    /// its own (`AppPrefs`, `LocalDataReset`), erased when the demo starts, at
    /// every launch in it and when you leave it; the in-memory demo server starts
    /// again from its sample data each time.
    static let changesNote = "Everything here is sample data. Changes stay in the demo and are reset when you leave the demo or the app restarts; nothing you do here changes the app outside it. To use Walnut for real, run the Walnut server on your computer and pair this phone with it."

    static func isDemoURL(_ url: URL?) -> Bool {
        url?.host?.lowercased() == host
    }

    static func isDemoURL(_ string: String) -> Bool {
        isDemoURL(URL(string: string))
    }

    /// Put the demo protocol FIRST on a session configuration. Every `URLSession`
    /// the app builds with a custom configuration calls this: `URLProtocol
    /// .registerClass` only reaches `URLSession.shared`, a custom configuration
    /// consults its own `protocolClasses` and nothing else.
    ///
    /// Installed unconditionally (not only in demo mode) on purpose: sessions are
    /// built long before the user taps "Try the demo" (every store owns one from
    /// app launch), and `DemoURLProtocol.canInit` decides per request. Outside the
    /// demo it answers false for every real server, so a paired app's traffic is
    /// untouched.
    static func install(on config: URLSessionConfiguration) {
        registerGlobally()
        var classes = config.protocolClasses ?? []
        if !classes.contains(where: { $0 == DemoURLProtocol.self }) {
            classes.insert(DemoURLProtocol.self, at: 0)
        }
        config.protocolClasses = classes
    }

    /// `install(on:)` for a call site that builds its configuration inline.
    static func configured(_ config: URLSessionConfiguration) -> URLSessionConfiguration {
        install(on: config)
        return config
    }

    /// `URLSession.shared` (the log uploader, the letter body download) only sees
    /// globally registered protocols. Swift runs a static initializer once,
    /// thread-safely, so this is idempotent from any thread.
    private static let globalRegistration: Void = {
        URLProtocol.registerClass(DemoURLProtocol.self)
    }()

    static func registerGlobally() {
        _ = globalRegistration
    }
}
