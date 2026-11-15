import Foundation

/// The app keeps no HTTP cache. Every answer it loads is a paired server's (API replies, letter
/// bodies, recordings, session files, attachments), and what it keeps it keeps in its own stores,
/// which Disconnect erases (`LocalDataReset`). A response in `URLCache` was one more copy for the
/// erase to chase: a transfer that finished around the erase wrote its response after it, and on
/// the iOS 26.0 simulator `removeAllCachedResponses()` left such a response readable (2026-11-15,
/// `PostEraseLogTests`). `tests/web/ios-no-http-cache-guard.test.ts` keeps every session here.
extension URLSessionConfiguration {
    /// No cache to write to, and no cached answer read for a request.
    func keepingNoHTTPCache() -> URLSessionConfiguration {
        urlCache = nil
        requestCachePolicy = .reloadIgnoringLocalCacheData
        return self
    }
}

enum AppHTTP {
    /// The session for the loads that used `URLSession.shared` (the log upload, letter bodies,
    /// recordings, session media): the same defaults, keeping no cache, with the demo's protocol.
    static let session = URLSession(configuration: DemoMode.configured(URLSessionConfiguration.default.keepingNoHTTPCache()))
}
