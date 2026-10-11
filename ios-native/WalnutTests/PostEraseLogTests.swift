import Foundation
import XCTest
@testable import Walnut

/// After Disconnect (or Leave demo) erases the app's data, the app keeps logging
/// into a fresh log. Those lines must name nothing of the pairing just erased
/// (App Store gate, 2026-10-01): the unregister result carried a 12-character
/// push token prefix, and the heartbeat kept the old screen name, crumb trail
/// and main-thread work trail.
@MainActor
final class PostEraseLogTests: XCTestCase {
    override func tearDown() async throws {
        FreezeContext.shared.eraseHistory()
    }

    func testTheEraseClearsWhatTheHeartbeatSamples() throws {
        let context = FreezeContext.shared
        context.setScreen("tasks")
        context.setScreen("session:s-crash1")
        context.note("send", 42)
        context.setHistoryRows(549)
        context.setDraftChars(17)
        let started = context.beginWork("tasks.loadSessions", count: 549)
        _ = context.endWork(startedAt: started)
        _ = context.beginWork("tasks.load", count: 66)
        let before = context.snapshotMeta()
        XCTAssertTrue(before["ctxScreen"]?.contains("s-crash1") == true, "the setup did not take")

        let scratch = try LocalDataResetTests.scratchLocations()
        defer { try? FileManager.default.removeItem(at: scratch.root) }
        let saved = LocalDataReset.registrationForTesting
        defer { LocalDataReset.registrationForTesting = saved }
        LocalDataReset.registrationForTesting = (nil, nil, nil, nil, nil)
        LocalDataReset.eraseAll(reason: "test", locations: scratch.locations)

        let after = context.snapshotMeta()
        XCTAssertEqual(after["ctxScreen"], "?")
        XCTAssertEqual(after["ctxTrail"], "-")
        XCTAssertEqual(after["ctxMainWork"], "-")
        XCTAssertEqual(after["ctxHistoryRows"], "0")
        XCTAssertEqual(after["ctxDraftChars"], "0")
        for value in after.values {
            XCTAssertFalse(value.contains("s-crash1") || value.contains("549") || value.contains("tasks."), value)
        }
        // A screen left after the erase does not bring the old one back.
        context.clearScreen("session:s-crash1")
        XCTAssertEqual(context.snapshotMeta()["ctxScreen"], "?")
    }

    /// The pairing screen that replaces the tab view is the screen while it is
    /// up. On a real Leave demo the retained tabs ran their appear and leave
    /// hooks after it had appeared, and the heartbeat kept naming the Inbox.
    func testThePairingScreenStaysTheScreenWhileTheTabsGoAway() {
        let context = FreezeContext.shared
        defer { context.clearRoot("setup") }
        context.setScreen("inbox")
        context.setScreen("settings")
        context.eraseHistory()

        context.setRoot("setup")
        context.setScreen("inbox")
        context.setScreen("settings")
        context.clearScreen("settings")
        XCTAssertEqual(context.snapshotMeta()["ctxScreen"], "setup")
        context.clearScreen("inbox")
        XCTAssertEqual(context.snapshotMeta()["ctxScreen"], "setup")

        // Pairing again: the pairing screen leaves and the new tab view's tab counts.
        context.setScreen("chat")
        context.clearRoot("setup")
        XCTAssertEqual(context.snapshotMeta()["ctxScreen"], "chat")
        // Leaving a root that is not up changes nothing.
        context.clearRoot("setup")
        XCTAssertEqual(context.snapshotMeta()["ctxScreen"], "chat")
    }

    // MARK: - Loads still running at the erase

    private func erase() throws {
        let scratch = try LocalDataResetTests.scratchLocations()
        defer { try? FileManager.default.removeItem(at: scratch.root) }
        let saved = LocalDataReset.registrationForTesting
        defer { LocalDataReset.registrationForTesting = saved }
        LocalDataReset.registrationForTesting = (nil, nil, nil, nil, nil)
        LocalDataReset.eraseAll(reason: "test", locations: scratch.locations)
    }

    private func waitFor(_ timeout: TimeInterval, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(25))
        }
        return condition()
    }

    /// An image download still running at Disconnect used to finish after the
    /// erase and leave its response in the HTTP cache (App Store gate,
    /// 2026-10-02). The erase cancels it, so it never lands.
    func testADownloadStillRunningAtTheEraseIsCancelledAndCachesNothing() async throws {
        URLProtocol.registerClass(SlowImageProtocol.self)
        defer { URLProtocol.unregisterClass(SlowImageProtocol.self) }
        SlowImageProtocol.stopped = false
        SlowImageProtocol.started = false
        let url = URL(string: "https://slow-image.walnut.invalid/photo-\(UUID().uuidString).png")!
        let request = URLRequest(url: url)
        final class Outcome: @unchecked Sendable { var error: URLError?; var done = false }
        let outcome = Outcome()
        let task = URLSession.shared.dataTask(with: request) { _, _, error in
            outcome.error = error as? URLError
            outcome.done = true
        }
        task.resume()
        let started = await waitFor(3) { SlowImageProtocol.started }
        XCTAssertTrue(started, "the stub never saw the download")

        try erase()

        let finished = await waitFor(3) { outcome.done }
        XCTAssertTrue(finished)
        XCTAssertEqual(outcome.error?.code, .cancelled, "the download was not cancelled by the erase")
        XCTAssertTrue(SlowImageProtocol.stopped)
        // Past the moment the stub would have answered: still nothing cached.
        try? await Task.sleep(for: .milliseconds(Int(SlowImageProtocol.answerAfter * 1000) + 300))
        XCTAssertNil(URLCache.shared.cachedResponse(for: request))
    }

    /// A response written just after the erase (a transfer that finished as it
    /// was cancelled) is cleared by the erase's later pass.
    func testAResponseCachedJustAfterTheEraseIsClearedToo() async throws {
        let url = URL(string: "https://late.walnut.invalid/api/v1/tasks?probe=\(UUID().uuidString)")!
        try erase()
        URLCache.shared.storeCachedResponse(
            CachedURLResponse(
                response: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                data: Data("late".utf8)
            ),
            for: URLRequest(url: url)
        )
        let gone = await waitFor(LocalDataReset.lateCacheClearDelay + 2) {
            URLCache.shared.cachedResponse(for: URLRequest(url: url)) == nil
        }
        XCTAssertTrue(gone, "a response cached right after the erase survived it")
    }

    func testTheUnregisterResultNamesNoTokenAndNoServer() {
        let success = PushRegistration.unregisterOutcome(.success(()))
        XCTAssertEqual(success.meta, [:])

        let failingURL = "https://walnut.old-server.example/api/push/register"
        let refused = URLError(.cannotConnectToHost, userInfo: [NSURLErrorFailingURLStringErrorKey: failingURL])
        let unreachable = PushRegistration.unregisterOutcome(.failure(APIError.network(underlying: refused)))
        XCTAssertEqual(unreachable.meta, ["error": "network -1004"])

        XCTAssertEqual(PushRegistration.unregisterOutcome(.failure(APIError.cancelled)).meta, ["error": "cancelled"])
        XCTAssertEqual(PushRegistration.unregisterOutcome(.failure(CancellationError())).meta, ["error": "cancelled"])
        let server = APIError.server(status: 500, code: "x", message: "token 61d9d74bfddc at \(failingURL)",
                                     serverHash: nil, serverContent: nil)
        XCTAssertEqual(PushRegistration.unregisterOutcome(.failure(server)).meta, ["error": "http 500"])
        for outcome in [success, unreachable] {
            XCTAssertNil(outcome.meta["tokenPrefix"])
            XCTAssertFalse(outcome.meta.values.contains { $0.contains("old-server") })
        }
    }
}

/// A cacheable image that takes a moment to arrive, for the in-flight erase test.
final class SlowImageProtocol: URLProtocol {
    static var started = false
    static var stopped = false
    static let answerAfter: TimeInterval = 0.6
    private var cancelled = false

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "slow-image.walnut.invalid"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.started = true
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.answerAfter) { [weak self] in
            guard let self, !self.cancelled, let url = self.request.url else { return }
            let response = HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "image/png", "Cache-Control": "max-age=3600"]
            )!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .allowed)
            self.client?.urlProtocol(self, didLoad: DemoImage.png)
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {
        cancelled = true
        Self.stopped = true
    }
}
