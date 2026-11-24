import Foundation

/// Keeps the device token off a Walnut Connect port this app does not hold (WalnutConnect.swift):
/// a URLSession request to `http://127.0.0.1:<the connect port>` while the library holds no
/// listener there (before the connector started, or when iOS reclaimed it and another app may
/// have taken the port) fails at once, in process, with no byte sent, and the connector is
/// woken. While the port is held the guard steps aside and the request goes as any other.
///
/// Installed on every session the app builds, beside the demo's protocol (`DemoMode.install`,
/// the one place every URLSessionConfiguration passes), and globally for `URLSession.shared`.
/// Loads outside URLSession (AVPlayer, web views) ask `WalnutConnect.shared.maySend(to:)`.
final class WalnutConnectGuard: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        let connect = WalnutConnect.shared
        guard connect.isConnectURL(request.url) else { return false }
        return !connect.holds(url: request.url)
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        WalnutConnect.shared.wake()
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost, userInfo: [
            NSLocalizedDescriptionKey: "Walnut Connect is getting ready",
        ]))
    }

    override func stopLoading() {}
}
