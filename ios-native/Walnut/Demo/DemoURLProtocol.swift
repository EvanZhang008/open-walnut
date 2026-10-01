import Foundation
import os

/// Answers the app's requests for the demo server, in process.
///
/// Claims (see `DemoMode` for why):
///  - every http(s) request whose host is `DemoMode.host`, always;
///  - while the demo is active, every OTHER http(s) request too. Those are not
///    served: they fail with `notConnectedToInternet` and are counted in
///    `blockedRequests`, so a test can prove that nothing left the phone.
///
/// Plain requests get one response after a short, realistic delay. Server-sent
/// event routes keep the response open and receive frames from `DemoStreams`
/// until the client cancels, exactly like a long-lived HTTP stream.
///
/// THREADING. URLSession calls `startLoading` on its protocol thread and expects
/// every client callback on that same thread, so the run loop is captured there
/// and every callback is posted back onto it.
final class DemoURLProtocol: URLProtocol, @unchecked Sendable {
    // MARK: - Request log (tests and diagnostics)

    struct LoggedRequest: Equatable, Sendable {
        let method: String
        let host: String
        let path: String
        let status: Int
        let blocked: Bool
    }

    private static let log = OSAllocatedUnfairLock(initialState: [LoggedRequest]())
    private static let logCap = 2_000

    /// Every request this protocol answered, oldest first (capped).
    static var requestLog: [LoggedRequest] { log.withLock { $0 } }
    /// Requests for a host other than the demo server, refused while in demo mode.
    static var blockedRequests: [LoggedRequest] { requestLog.filter(\.blocked) }

    static func resetLog() { log.withLock { $0.removeAll() } }

    private static func record(_ entry: LoggedRequest) {
        log.withLock {
            $0.append(entry)
            if $0.count > logCap { $0.removeFirst($0.count - logCap) }
        }
    }

    // MARK: - URLProtocol

    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url,
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return false }
        if DemoMode.isDemoURL(url) { return true }
        return DemoMode.isActive
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override class func requestIsCacheEquivalent(_ a: URLRequest, to b: URLRequest) -> Bool {
        false
    }

    private let state = OSAllocatedUnfairLock(initialState: LoadState())
    private struct LoadState {
        var stopped = false
        var subscription: DemoStreams.Subscription?
    }

    private var clientRunLoop: CFRunLoop?

    override func startLoading() {
        clientRunLoop = CFRunLoopGetCurrent()
        let request = self.request
        guard let url = request.url else {
            fail(URLError(.badURL))
            return
        }
        let method = (request.httpMethod ?? "GET").uppercased()
        guard DemoMode.isDemoURL(url) else {
            // Demo mode is on and this request names some other machine. It is
            // refused HERE so it never reaches the network.
            Self.record(LoggedRequest(
                method: method, host: url.host ?? "", path: url.path, status: -1, blocked: true
            ))
            AppLog.warn("demo", "refused a request to a non-demo host", ["host": url.host ?? "?"])
            fail(URLError(.notConnectedToInternet))
            return
        }
        let body = Self.bodyData(of: request)
        let incoming = DemoRequest(
            method: method,
            url: url,
            headers: request.allHTTPHeaderFields ?? [:],
            body: body
        )
        let reply = DemoServer.shared.handle(incoming)
        Self.record(LoggedRequest(
            method: method, host: url.host ?? "", path: url.path,
            status: reply.status, blocked: false
        ))
        switch reply.body {
        case .stream(let channel, let lastEventID):
            beginStream(url: url, channel: channel, lastEventID: lastEventID)
        default:
            let delay = DemoServer.shared.latency(for: incoming)
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.deliver(reply, url: url)
            }
        }
    }

    override func stopLoading() {
        let subscription = state.withLock { s -> DemoStreams.Subscription? in
            s.stopped = true
            let sub = s.subscription
            s.subscription = nil
            return sub
        }
        subscription?.cancel()
    }

    // MARK: - Delivery

    private var isStopped: Bool { state.withLock { $0.stopped } }

    /// Run `work` on the thread URLSession started this load on.
    private func onClientThread(_ work: @escaping @Sendable () -> Void) {
        guard let loop = clientRunLoop else { return }
        CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue, work)
        CFRunLoopWakeUp(loop)
    }

    private func deliver(_ reply: DemoReply, url: URL) {
        onClientThread { [weak self] in
            guard let self, !self.isStopped else { return }
            var headers = reply.headers
            let data: Data
            switch reply.body {
            case .json(let payload):
                headers["Content-Type"] = headers["Content-Type"] ?? "application/json; charset=utf-8"
                data = payload
            case .bytes(let payload, let contentType):
                headers["Content-Type"] = contentType
                data = payload
            case .empty:
                data = Data()
            case .stream:
                return
            }
            headers["Content-Length"] = String(data.count)
            guard let response = HTTPURLResponse(
                url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers
            ) else {
                self.client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
                return
            }
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !data.isEmpty { self.client?.urlProtocol(self, didLoad: data) }
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    private func fail(_ error: Error) {
        onClientThread { [weak self] in
            guard let self, !self.isStopped else { return }
            self.client?.urlProtocol(self, didFailWithError: error)
        }
    }

    private func beginStream(url: URL, channel: DemoStreams.Channel, lastEventID: Int?) {
        onClientThread { [weak self] in
            guard let self, !self.isStopped else { return }
            let headers = [
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
            ]
            guard let response = HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers
            ) else { return }
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            // Subscribe only after the response is out: the hub may replay frames
            // synchronously, and a frame before the response would be dropped.
            let subscription = DemoServer.shared.streams.subscribe(
                channel: channel, lastEventID: lastEventID,
                send: { [weak self] chunk in
                    self?.onClientThread { [weak self] in
                        guard let self, !self.isStopped else { return }
                        self.client?.urlProtocol(self, didLoad: chunk)
                    }
                },
                close: { [weak self] in
                    self?.onClientThread { [weak self] in
                        guard let self, !self.isStopped else { return }
                        self.client?.urlProtocolDidFinishLoading(self)
                    }
                }
            )
            let alreadyStopped = self.state.withLock { s -> Bool in
                if s.stopped { return true }
                s.subscription = subscription
                return false
            }
            if alreadyStopped { subscription.cancel() }
        }
    }

    // MARK: - Body

    /// URLSession hands a protocol the body as a STREAM, not `httpBody`, for
    /// every request that carries one, so both are read.
    static func bodyData(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let chunk = 16_384
        var buffer = [UInt8](repeating: 0, count: chunk)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: chunk)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
