import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// `suspend()` pauses automatic send retries and never abandons them: a bubble
/// whose attempt the app's going away cut short keeps its waiting notice, and the
/// page coming back re-arms it under the same message id.
///
/// App Store gate r8, Q1r: an automatic retry's POST was in flight when the app went
/// to the background. `cancelRetryTasks` cancelled it, its catch settled the bubble
/// as the terminal "Not sent" (no notice), so `rearmPendingRetries` skipped it and
/// the message the server had taken stayed on the page as a second, failed copy.
/// The probe is adopted here as a shipped test, with the neighbouring cases.
@MainActor
final class SessionRetryPausedTests: XCTestCase {

    private func transcript(_ rows: [(String, String)]) -> SessionTranscript {
        SessionTranscript(
            sessionId: "paused", exportedAt: "2026-10-06T16:40:00Z", truncated: false,
            messages: rows.enumerated().map { i, row in
                SessionTranscript.Message(role: row.0, text: row.1,
                                          timestamp: String(format: "2026-10-06T16:%02d:00Z", i), kind: nil)
            }
        )
    }

    func testAnOfflineBannerKeepsItsFullHeightUnderVerticalCompression() {
        let banner = OfflineBanner(text: "Mac unreachable. Showing the last synced transcript.")
            .environment(\.dynamicTypeSize, .accessibility5)
        let host = UIHostingController(rootView: banner)
        let width: CGFloat = 402
        let natural = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
        let compressed = host.sizeThatFits(in: CGSize(width: width, height: 80))
        XCTAssertGreaterThan(natural.height, 80)
        XCTAssertEqual(compressed.height, natural.height, accuracy: 1)
        host.view.removeFromSuperview()
    }

    private let before = [("user", "Run the tests"), ("assistant", "All green.")]
    private let after = [("user", "Run the tests"), ("assistant", "All green."),
                         ("user", "Ship it"), ("assistant", "Shipped.")]

    private func waitUntil(_ what: String, timeout: Double = 8, _ condition: () -> Bool,
                           line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)", line: line)
    }

    private func settle() async {
        for _ in 0..<50 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(50))
    }

    private func openedStore(_ tag: String) async -> (SessionConversationStore, MockSessionSendTransport) {
        let transport = MockSessionSendTransport()
        transport.transcript = transcript(before)
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "paused-\(tag)"), transport: transport)
        await store.open()
        return (store, transport)
    }

    private func copies(_ store: SessionConversationStore) -> [ChatMessage] {
        store.messages.filter { $0.text == "Ship it" }
    }

    private func waiting(_ store: SessionConversationStore) -> ChatMessage? {
        copies(store).first { $0.failed == true && $0.retryNotice != nil }
    }

    /// Q1r: the retry's POST is in flight at the background and ends cancelled; the
    /// server had taken it. Back in the foreground the retry runs again, under the
    /// same id, and the message shows once.
    func testARetryInFlightWhenTheAppGoesAwayIsPausedNotAbandoned() async {
        let (store, transport) = await openedStore("q1r")
        defer { store.close() }
        transport.failuresRemaining = 1
        let accepted = await store.send("Ship it")
        XCTAssertFalse(accepted)
        XCTAssertNotNil(waiting(store), "waiting for its automatic retry")

        let gate = CheckedContinuationGate()
        transport.permanentError = APIError.cancelled
        transport.gate = gate
        await waitUntil("the retry's POST is in flight") { transport.sendCallCount == 2 }
        store.suspend()
        transport.transcript = transcript(after)
        gate.open()
        await settle()
        XCTAssertNotNil(waiting(store), "Q1r: the paused retry was settled as a terminal Not sent")

        transport.gate = nil
        transport.permanentError = nil
        store.resume()
        await waitUntil("the re-armed retry went out") { transport.sendCallCount == 3 }
        await waitUntil("the message shows once") { copies(store).count == 1 }
        XCTAssertFalse(store.messages.contains { $0.failed == true || $0.pending == true })
        XCTAssertEqual(Set(transport.messageIds.compactMap { $0 }).count, 1, "every attempt under one id")
    }

    /// The person's own send, cut short the same way while the page is away, waits
    /// for its retry too and goes out when the page is back.
    func testASendCutShortWhileAwayWaitsAndGoesOutOnReturn() async {
        let (store, transport) = await openedStore("first")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        transport.permanentError = APIError.cancelled
        let send = Task { await store.send("Ship it") }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        store.suspend()
        gate.open()
        _ = await send.value
        XCTAssertNotNil(waiting(store), "a cancelled send was given up while the page was away")

        transport.gate = nil
        transport.permanentError = nil
        transport.transcript = transcript(after)
        store.resume()
        await waitUntil("the re-armed send went out") { transport.sendCallCount == 2 }
        await waitUntil("the message shows once") { copies(store).count == 1 }
        XCTAssertEqual(Set(transport.messageIds.compactMap { $0 }).count, 1)
    }

    /// A failure the ladder rides out (the host's bridge is down), met while the page
    /// is away, waits as well instead of turning into the terminal copy.
    func testABridgeOutageMetWhileAwayWaitsForTheReturn() async {
        let (store, transport) = await openedStore("bridge")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        transport.permanentError = APIError.server(status: 503, code: "bridge_offline",
                                                   message: "No live bridge", serverHash: nil, serverContent: nil)
        let send = Task { await store.send("Ship it") }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        store.suspend()
        gate.open()
        _ = await send.value
        try? await Task.sleep(for: .seconds(SendRetryPolicy.baseDelay + 0.5))
        XCTAssertEqual(transport.sendCallCount, 1, "no attempt burned while away")
        XCTAssertNotNil(waiting(store))

        transport.gate = nil
        transport.permanentError = nil
        store.resume()
        await waitUntil("the re-armed send went out") { transport.sendCallCount == 2 }
        await waitUntil("the bubble is delivered") { !store.messages.contains { $0.failed == true } }
    }

    /// A page closed while a retry waits, then opened again, re-arms it: close()
    /// pauses like a suspend, and nothing else would wake the bubble.
    func testAPageOpenedAgainReArmsTheRetryCloseHadPaused() async {
        let (store, transport) = await openedStore("reopen")
        transport.failuresRemaining = 1
        _ = await store.send("Ship it")
        XCTAssertNotNil(waiting(store))
        store.close()
        try? await Task.sleep(for: .seconds(SendRetryPolicy.baseDelay + 0.5))
        XCTAssertEqual(transport.sendCallCount, 1, "a closed page posted")
        await store.open()
        defer { store.close() }
        await waitUntil("the re-armed retry went out") { transport.sendCallCount == 2 }
        await waitUntil("the bubble is delivered") { !store.messages.contains { $0.failed == true } }
    }

    /// A manual retry supersedes the automatic attempt in flight: when that attempt
    /// then ends cancelled, it leaves the bubble to the manual one (no "waiting"
    /// written over a send that is going out, and no extra retry armed).
    func testACancelledAttemptLeavesTheBubbleToTheRetryThatSupersededIt() async {
        let (store, transport) = await openedStore("supersede")
        defer { store.close() }
        transport.failuresRemaining = 1
        _ = await store.send("Ship it")
        let gate = CheckedContinuationGate()
        transport.permanentError = APIError.cancelled
        transport.gate = gate
        await waitUntil("the automatic retry's POST is in flight") { transport.sendCallCount == 2 }
        guard let bubble = waiting(store) else { return XCTFail("no waiting bubble") }
        transport.permanentError = nil // the manual attempt is answered
        let manual = Task { await store.retry(bubble) }
        await waitUntil("the manual retry's POST is in flight") { transport.sendCallCount == 3 }
        XCTAssertEqual(copies(store).first?.pending, true, "the manual retry is sending")
        gate.open()
        await manual.value
        await settle()
        XCTAssertFalse(copies(store).contains { $0.retryNotice != nil },
                       "the superseded attempt wrote its waiting state over the manual retry")
        try? await Task.sleep(for: .seconds(SendRetryPolicy.baseDelay + 0.5))
        XCTAssertEqual(transport.sendCallCount, 3, "an extra retry was armed")
    }

    /// A failure that is the server's answer still settles as "Not sent" while away.
    func testAServerRefusalWhileAwayIsStillTheTerminalCopy() async {
        let (store, transport) = await openedStore("refused")
        defer { store.close() }
        let gate = CheckedContinuationGate()
        transport.gate = gate
        transport.permanentError = APIError.server(status: 500, code: "internal", message: "boom",
                                                   serverHash: nil, serverContent: nil)
        let send = Task { await store.send("Ship it") }
        await waitUntil("the POST is in flight") { transport.sendCallCount == 1 }
        store.suspend()
        gate.open()
        _ = await send.value
        transport.gate = nil
        store.resume()
        await settle()
        let failed = copies(store).filter { $0.failed == true }
        XCTAssertEqual(failed.count, 1)
        XCTAssertNil(failed.first?.retryNotice, "a refused send was left waiting for a retry")
        XCTAssertEqual(transport.sendCallCount, 1)
    }

    func testCancellationInEveryShapeIsRecognised() {
        XCTAssertTrue(SessionConversationStore.isCancellation(CancellationError()))
        XCTAssertTrue(SessionConversationStore.isCancellation(APIError.cancelled))
        XCTAssertTrue(SessionConversationStore.isCancellation(URLError(.cancelled)))
        XCTAssertFalse(SessionConversationStore.isCancellation(URLError(.timedOut)))
        XCTAssertFalse(SessionConversationStore.isCancellation(APIError.badResponse))
    }
}

/// The real page uses this owner for Restart, Retry, initial open and refresh.
/// The demo hub counts actual SSE subscriptions, not just calls to a reopen stub.
@MainActor
final class SessionPageOperationsTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?

    override func setUp() async throws {
        LifecycleHub.shared.teardownAll()
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.turnScale = 0
        DemoServer.shared.reset()
        DemoURLProtocol.resetLog()
    }

    override func tearDown() async throws {
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        DemoServer.shared.turnScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    nonisolated override class func tearDown() {
        MainActor.assumeIsolated { LifecycleHub.shared.resumeAll() }
        super.tearDown()
    }

    private func waitUntil(_ what: String, _ condition: () -> Bool, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else { return XCTFail("timed out waiting for \(what)", line: line) }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    private func fixture(clock: SessionStreamClock = SystemSessionStreamClock()) async throws -> (
        WalnutSession, SessionConversationStore, MockSessionSendTransport, SessionPageOperations
    ) {
        let sessions = try await WalnutAPI().sessions()
        let session = try XCTUnwrap(sessions.sessions.first)
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(
            session: session, transport: transport, clock: clock,
            resumeIDs: SessionStreamResumeIDs(defaults: nil)
        )
        let owner = SessionPageOperations(store: store)
        owner.appear()
        await owner.refresh()
        await waitUntil("one live stream") { DemoServer.shared.streams.subscriberCount(.session(session.id)) == 1 }
        return (session, store, transport, owner)
    }

    private func streamRequests(_ id: String) -> Int {
        DemoURLProtocol.requestLog.filter { $0.path == "/api/v1/sessions/\(id)/stream" }.count
    }

    private func assertOneStream(_ id: String, afterRequests: Int) async {
        await waitUntil("the page to own exactly one new stream") {
            streamRequests(id) == afterRequests + 1
                && DemoServer.shared.streams.subscriberCount(.session(id)) == 1
        }
    }

    private func assertLateSuccessStaysClosed(retry: Bool) async throws {
        let (session, _, transport, owner) = try await fixture()
        defer { owner.disappear() }
        let lifecycle = SessionLifecycleController(sessionId: session.id)
        let responseGate = CheckedContinuationGate()
        defer { responseGate.open() }
        var successReady = false
        var cancelledAtCompletion = false
        let operation = try XCTUnwrap(owner.start {
            let success = retry ? await lifecycle.retry() : await lifecycle.restart()
            successReady = true
            // Deliberately ignores cancellation: a success already accepted by
            // the server is delivered to the page only after it has disappeared.
            await responseGate.wait()
            cancelledAtCompletion = Task.isCancelled
            return success
        })
        await waitUntil("the accepted lifecycle response") { successReady }
        XCTAssertNotNil(lifecycle.confirmation)
        let readsBeforeClose = transport.transcriptReads.count
        let streamsBeforeClose = streamRequests(session.id)

        owner.disappear()
        await waitUntil("the closed page to detach") { DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0 }
        responseGate.open()
        await operation.value
        XCTAssertTrue(cancelledAtCompletion, "leaving the page cancels its operation")
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 0)
        XCTAssertEqual(streamRequests(session.id), streamsBeforeClose, "late success reopened the closed page")
        XCTAssertEqual(transport.transcriptReads.count, readsBeforeClose)

        owner.appear()
        await owner.refresh()
        await assertOneStream(session.id, afterRequests: streamsBeforeClose)
        XCTAssertEqual(streamRequests(session.id), streamsBeforeClose + 1)
    }

    func testALateRestartSuccessCannotReopenAClosedPage() async throws {
        try await assertLateSuccessStaysClosed(retry: false)
    }

    func testALateRetrySuccessCannotReopenAClosedPage() async throws {
        try await assertLateSuccessStaysClosed(retry: true)
    }

    func testAnOldAppearanceCannotReplaceTheReopenedPagesStream() async throws {
        let (session, _, transport, owner) = try await fixture()
        defer { owner.disappear() }
        let gate = CheckedContinuationGate()
        defer { gate.open() }
        var started = false
        let operation = try XCTUnwrap(owner.start {
            started = true
            await gate.wait()
            return true
        })
        await waitUntil("the old operation to start") { started }
        owner.disappear()
        await waitUntil("the old stream to detach") { DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0 }
        let oldRequests = streamRequests(session.id)
        owner.appear()
        await owner.refresh()
        await assertOneStream(session.id, afterRequests: oldRequests)
        let currentRequests = streamRequests(session.id)
        let currentReads = transport.transcriptReads.count
        gate.open()
        await operation.value
        XCTAssertEqual(streamRequests(session.id), currentRequests)
        XCTAssertEqual(transport.transcriptReads.count, currentReads)
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 1)
    }

    func testARefreshFinishingAfterCloseCannotReviveTheStream() async throws {
        let (session, store, transport, owner) = try await fixture()
        defer { owner.disappear() }
        let gate = CheckedContinuationGate()
        transport.transcriptGate = gate
        defer { gate.open() }
        let initialReads = transport.transcriptReads.count
        let refreshing = Task { await owner.refresh() }
        await waitUntil("refresh to enter its transcript read") { transport.transcriptReads.count > initialReads }
        owner.disappear()
        await waitUntil("the refresh stream to detach") { DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0 }
        let closedRequests = streamRequests(session.id)
        transport.transcriptGate = nil
        gate.open()
        await refreshing.value
        await owner.refresh()
        store.resume()
        XCTAssertEqual(streamRequests(session.id), closedRequests)
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 0)
        XCTAssertNil(owner.start { XCTFail("a hidden page accepted an operation"); return true })
        owner.appear()
        await owner.refresh()
        await assertOneStream(session.id, afterRequests: closedRequests)
    }

    func testABackgroundedPagesLateSuccessCannotReattachItsStream() async throws {
        let (session, _, transport, owner) = try await fixture()
        defer { owner.disappear() }
        let gate = CheckedContinuationGate()
        defer { gate.open() }
        var started = false
        let lifecycle = SessionLifecycleController(sessionId: session.id)
        let operation = try XCTUnwrap(owner.start {
            let success = await lifecycle.restart()
            started = true
            await gate.wait()
            return success
        })
        await waitUntil("restart to succeed before its delayed callback") { started }
        let beforeRequests = streamRequests(session.id)
        let beforeReads = transport.transcriptReads.count
        owner.setActive(false)
        LifecycleHub.shared.suspendAll()
        defer { LifecycleHub.shared.resumeAll() }
        await waitUntil("backgrounding to detach the stream") {
            DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0
        }
        gate.open()
        await operation.value
        await owner.refresh()
        XCTAssertNil(owner.start { XCTFail("backgrounded page accepted an action"); return true })
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 0)
        XCTAssertEqual(streamRequests(session.id), beforeRequests)
        XCTAssertEqual(transport.transcriptReads.count, beforeReads)
        owner.setActive(true)
        LifecycleHub.shared.resumeAll()
        await assertOneStream(session.id, afterRequests: beforeRequests)
    }

    func testAnOperationFromBeforeBackgroundCannotReplaceTheForegroundStream() async throws {
        let (session, store, transport, owner) = try await fixture()
        defer { owner.disappear() }
        let gate = CheckedContinuationGate()
        defer { gate.open() }
        var started = false
        let operation = try XCTUnwrap(owner.start {
            started = true
            await gate.wait()
            return true
        })
        await waitUntil("the old operation to start") { started }
        owner.setActive(false)
        await waitUntil("the background stream to detach") {
            DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0
        }
        let beforeRequests = streamRequests(session.id)
        owner.setActive(true)
        await assertOneStream(session.id, afterRequests: beforeRequests)
        await waitUntil("foreground transcript refresh to finish") { !store.transcriptRefreshPending }
        let currentReads = transport.transcriptReads.count
        gate.open()
        await operation.value
        XCTAssertEqual(streamRequests(session.id), beforeRequests + 1)
        XCTAssertEqual(transport.transcriptReads.count, currentReads)
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 1)
    }

    func testAPageShownWhileBackgroundedOpensOnlyWhenItReturnsToTheForeground() async throws {
        let (session, _, _, owner) = try await fixture()
        defer { owner.disappear() }
        owner.disappear()
        await waitUntil("the old page to detach") {
            DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0
        }
        let beforeRequests = streamRequests(session.id)
        owner.setActive(false)
        owner.appear()
        await owner.refresh()
        XCTAssertEqual(streamRequests(session.id), beforeRequests)
        owner.setActive(true)
        await assertOneStream(session.id, afterRequests: beforeRequests)
    }

    func testATransientInactivePhaseKeepsTheRestartAndCurrentSubscription() async throws {
        let (session, store, transport, owner) = try await fixture()
        defer { owner.disappear() }
        let gate = CheckedContinuationGate()
        defer { gate.open() }
        let lifecycle = SessionLifecycleController(sessionId: session.id)
        var successReady = false
        var cancelledAtCompletion = false
        let operation = try XCTUnwrap(owner.start {
            let success = await lifecycle.restart()
            successReady = true
            await gate.wait()
            cancelledAtCompletion = Task.isCancelled
            return success
        })
        await waitUntil("restart to reach its held success") { successReady }
        // Transient inactive covers Control Center and system permission sheets.
        store.handle(SSEEvent(id: nil, event: "thinking", data: #"{"delta":"Checking the result."}"#))
        await waitUntil("the live thinking to flush") { !store.liveThinking.isEmpty }
        let thinking = store.liveThinking
        let beforeRequests = streamRequests(session.id)
        let beforeReads = transport.transcriptReads.count
        for phase in [ScenePhase.inactive, .active, .inactive, .active] {
            owner.setActive(phase != .background)
        }
        XCTAssertEqual(streamRequests(session.id), beforeRequests, "inactive must not reconnect the stream")
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 1)
        XCTAssertEqual(transport.transcriptReads.count, beforeReads)
        XCTAssertEqual(store.liveThinking, thinking, "inactive must not clear the live thinking")
        gate.open()
        await operation.value
        XCTAssertFalse(cancelledAtCompletion, "a transient interruption cancelled restart")
        await assertOneStream(session.id, afterRequests: beforeRequests)
        XCTAssertEqual(DemoURLProtocol.requestLog.filter {
            $0.method == "POST" && $0.path == "/api/v1/sessions/\(session.id)/restart"
        }.count, 1)
    }

    func testBackgroundingTheFirstCachedOpenStillLoadsTheInitialWindowOnReturn() async throws {
        let sessions = try await WalnutAPI().sessions()
        let session = try XCTUnwrap(sessions.sessions.first)
        let transport = MockSessionSendTransport()
        let clock = ManualStreamClock()
        let cachedGate = CheckedContinuationGate()
        defer { cachedGate.open() }
        transport.transcriptGate = cachedGate
        let store = SessionConversationStore(
            session: session, transport: transport, clock: clock,
            resumeIDs: SessionStreamResumeIDs(defaults: nil)
        )
        let owner = SessionPageOperations(store: store)
        defer { owner.disappear() }
        owner.appear()
        let firstOpen = Task { await owner.refresh() }
        await waitUntil("the first cached read to block") { transport.transcriptReads.count == 1 }
        await waitUntil("the first stream to attach") {
            DemoServer.shared.streams.subscriberCount(.session(session.id)) == 1
        }
        XCTAssertTrue(transport.pageReads.isEmpty, "initial rich window has not loaded yet")
        owner.setActive(false)
        await waitUntil("the first stream to detach") {
            DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0
        }
        let beforeRequests = streamRequests(session.id)
        transport.transcriptGate = nil
        owner.setActive(true)
        await assertOneStream(session.id, afterRequests: beforeRequests)
        await waitUntil("the initial rich window to load") { !transport.pageReads.isEmpty }
        XCTAssertEqual(transport.pageReads, [MockSessionSendTransport.PageRead(
            before: nil, since: nil, visible: SessionConversationStore.openVisibleRows
        )], "an incomplete first open must not take resume's incremental visible=0 path")
        await clock.settle()
        let currentReads = transport.transcriptReads.count
        cachedGate.open()
        await firstOpen.value
        await clock.settle()
        XCTAssertEqual(transport.transcriptReads.count, currentReads, "the old open started a fresh read on return")
        XCTAssertEqual(transport.pageReads.count, 1)
        XCTAssertEqual(streamRequests(session.id), beforeRequests + 1)
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 1)
    }

    func testALateCachedOpenCannotCancelTheReopenedPagesTurnEndRefresh() async throws {
        let clock = ManualStreamClock()
        let (session, store, transport, owner) = try await fixture(clock: clock)
        defer { owner.disappear() }
        await clock.settle()
        let cachedGate = CheckedContinuationGate()
        defer { cachedGate.open() }
        transport.transcriptGate = cachedGate
        let beforeReads = transport.transcriptReads.count
        let oldOpening = Task { await owner.refresh() }
        await waitUntil("the old cached read to block") { transport.transcriptReads.count > beforeReads }
        owner.disappear()
        await waitUntil("the old opening to detach") {
            DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0
        }
        transport.transcriptGate = nil
        let beforeRequests = streamRequests(session.id)
        owner.appear()
        await owner.refresh()
        await assertOneStream(session.id, afterRequests: beforeRequests)
        await clock.settle()
        let settledReads = transport.transcriptReads.count

        DemoServer.shared.streams.publish(.session(session.id), event: "turn-end", json: "{}", turnEnd: true)
        await waitUntil("the new turn-end to schedule its refresh") { store.transcriptRefreshPending }
        XCTAssertEqual(transport.transcriptReads.count, settledReads, "the turn-end read is still debounced")
        cachedGate.open()
        await oldOpening.value
        await clock.settle()
        XCTAssertEqual(transport.transcriptReads.count, settledReads,
                       "the cancelled cached open consumed the new page's refresh")
        XCTAssertTrue(store.transcriptRefreshPending, "the new turn-end refresh was cancelled")
        await clock.advance(by: SessionConversationStore.refreshDebounceSeconds + 0.01)
        XCTAssertEqual(transport.transcriptReads.count, settledReads + 1)
        XCTAssertFalse(store.transcriptRefreshPending)
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 1)
        XCTAssertEqual(streamRequests(session.id), beforeRequests + 1)
    }

    func testAHeldRestartAndSpeculativeStoresOwnOnlyOneForegroundStream() async throws {
        let (session, _, transport, owner) = try await fixture()
        defer { owner.disappear(); LifecycleHub.shared.resumeAll() }
        let speculativeTransport = MockSessionSendTransport()
        // State initializers and navigation builders may keep these objects alive
        // without ever installing either page. A weak hub is not enough to exclude them.
        let speculative = (0..<3).map { _ in
            SessionConversationStore(session: session, transport: speculativeTransport,
                                     resumeIDs: SessionStreamResumeIDs(defaults: nil))
        }
        defer { for store in speculative { store.close() } }
        let gate = CheckedContinuationGate()
        defer { gate.open() }
        let lifecycle = SessionLifecycleController(sessionId: session.id)
        var held = false
        let restart = try XCTUnwrap(owner.start {
            let success = await lifecycle.restart()
            held = true
            await gate.wait()
            return success
        })
        await waitUntil("restart's held success") { held }
        let beforeRequests = streamRequests(session.id)
        let beforeReads = transport.transcriptReads.count
        LifecycleHub.shared.suspendAll()
        owner.setActive(false)
        await waitUntil("every stream to detach for background") {
            DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0
        }
        gate.open()
        await restart.value
        // Inactive precedes active on a real foreground transition, so the page
        // observer may resume before WalnutApp's global hub observer.
        owner.setActive(true)
        LifecycleHub.shared.resumeAll()
        await assertOneStream(session.id, afterRequests: beforeRequests)
        for _ in 0..<3 {
            LifecycleHub.shared.resumeAll()
            owner.setActive(true)
        }
        await waitUntil("the current page's foreground read") { transport.transcriptReads.count > beforeReads }
        XCTAssertEqual(speculativeTransport.transcriptReads.count, 0, "a never-opened store read a transcript")
        XCTAssertEqual(streamRequests(session.id), beforeRequests + 1)
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 1)
        XCTAssertEqual(transport.transcriptReads.count - beforeReads, 1)
    }

    func testSpeculativeStoresCannotMultiplyTheForegroundReplayReads() async throws {
        let clock = ManualStreamClock()
        let (session, _, transport, owner) = try await fixture(clock: clock)
        defer { owner.disappear(); LifecycleHub.shared.resumeAll() }
        let speculativeTransport = MockSessionSendTransport()
        let speculative = (0..<3).map { _ in
            SessionConversationStore(session: session, transport: speculativeTransport, clock: clock,
                                     resumeIDs: SessionStreamResumeIDs(defaults: nil))
        }
        defer { for store in speculative { store.close() } }
        LifecycleHub.shared.suspendAll()
        owner.setActive(false)
        await waitUntil("the current stream to detach") {
            DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0
        }
        let beforeRequests = streamRequests(session.id)
        let beforeReads = transport.transcriptReads.filter(\.fresh).count
        // 512 real SSE events wait in the demo server's ring while the phone is away.
        let hub = DemoServer.shared.streams
        for index in 0..<512 {
            hub.publish(.session(session.id), event: "turn-end", json: "{}",
                        turnStart: index == 0, turnEnd: false)
        }
        hub.drain()
        // Exercise the opposite observer order too: hub before page activation.
        LifecycleHub.shared.resumeAll()
        owner.setActive(true)
        await assertOneStream(session.id, afterRequests: beforeRequests)
        await clock.settle()
        await clock.advance(by: SessionConversationStore.refreshDebounceSeconds + 0.01)
        let foregroundReads = transport.transcriptReads.filter(\.fresh).count - beforeReads
        XCTAssertGreaterThanOrEqual(foregroundReads, 1)
        XCTAssertLessThanOrEqual(foregroundReads, 2, "one resume read plus at most one replay follow-up")
        XCTAssertEqual(speculativeTransport.transcriptReads.count, 0)
        XCTAssertEqual(streamRequests(session.id), beforeRequests + 1)
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 1)
    }

    private func waitForRead(_ what: String, _ condition: () async -> Bool) async {
        let deadline = Date().addingTimeInterval(5)
        while !(await condition()) {
            guard Date() < deadline else { return XCTFail("timed out waiting for \(what)") }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    private func readTranscript(_ texts: [String]) -> SessionTranscript {
        SessionTranscript(
            sessionId: "read-owner", exportedAt: "2026-10-20T12:00:00Z", truncated: false,
            messages: texts.enumerated().map { index, text in
                SessionTranscript.Message(role: "assistant", text: text,
                                          timestamp: String(format: "2026-10-20T12:%02d:00Z", index), kind: nil)
            }
        )
    }

    func testAHubResumeBeforePageActivationPreservesTheInitialWindowDemand() async throws {
        let sessions = try await WalnutAPI().sessions()
        let session = try XCTUnwrap(sessions.sessions.first)
        let clock = ManualStreamClock()
        let transport = SessionPageReadTransport(transcript: readTranscript(["First row", "Last row"]))
        let cachedGate = CheckedContinuationGate()
        let freshGate = CheckedContinuationGate()
        defer { cachedGate.open(); freshGate.open() }
        await transport.holdNextCached(cachedGate)
        let store = SessionConversationStore(
            session: session, transport: transport, clock: clock,
            resumeIDs: SessionStreamResumeIDs(defaults: nil)
        )
        let owner = SessionPageOperations(store: store)
        defer { owner.disappear(); LifecycleHub.shared.resumeAll() }
        owner.appear()
        let opening = Task { await owner.refresh() }
        await waitForRead("the first cached read") { await transport.cachedReads == 1 }
        owner.setActive(false)
        LifecycleHub.shared.suspendAll()
        await waitUntil("the background stream to detach") {
            DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0
        }
        await transport.holdNextFresh(freshGate)
        // The app's observer wins the foreground race. The interrupted open's
        // pending full window must already be part of this resumed read.
        LifecycleHub.shared.resumeAll()
        await waitForRead("the hub's retained initial window") { await transport.pageReads.count == 1 }
        let firstRead = await transport.pageReads.first
        XCTAssertEqual(firstRead?.visible, SessionConversationStore.openVisibleRows)
        owner.setActive(true)
        await waitForRead("the page's new cached read") { await transport.cachedReads >= 2 }
        await clock.settle()
        cachedGate.open()
        await opening.value
        freshGate.open()
        await clock.settle()
        await clock.advance(by: SessionConversationStore.refreshDebounceSeconds + 0.01)
        await waitForRead("the retained initial-window read") {
            await transport.pageReads.contains { $0.visible == SessionConversationStore.openVisibleRows }
        }
        let reads = await transport.pageReads
        XCTAssertEqual(reads.map(\.visible), [SessionConversationStore.openVisibleRows, SessionConversationStore.openVisibleRows])
        XCTAssertNil(reads.last?.since, "the full window must not inherit an incremental cursor")
        XCTAssertEqual(store.historyMessages.map(\.text), ["First row", "Last row"])
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 1)
    }

    func testAPageReturningBeforeTheHubStillLoadsTheInitialWindow() async throws {
        let sessions = try await WalnutAPI().sessions()
        let session = try XCTUnwrap(sessions.sessions.first)
        let expected = ["First window row", "Second window row", "Latest window row"]
        let transport = SessionPageReadTransport(transcript: readTranscript(expected))
        let cachedGate = CheckedContinuationGate()
        defer { cachedGate.open() }
        await transport.holdNextCached(cachedGate)
        let store = SessionConversationStore(
            session: session, transport: transport, resumeIDs: SessionStreamResumeIDs(defaults: nil)
        )
        let owner = SessionPageOperations(store: store)
        defer { owner.disappear(); LifecycleHub.shared.resumeAll() }
        owner.appear()
        let opening = Task { await owner.refresh() }
        await waitForRead("the first cached read to block") { await transport.cachedReads == 1 }
        owner.setActive(false)
        LifecycleHub.shared.suspendAll()
        await waitUntil("the stream to pause") {
            DemoServer.shared.streams.subscriberCount(.session(session.id)) == 0
        }
        let beforeRequests = streamRequests(session.id)
        // The page's inactive transition precedes the app's active transition.
        // open registers against a still-suspended hub, so it must report false
        // while keeping the initial-window request for the later resume.
        owner.setActive(true)
        let waiting = try XCTUnwrap(owner.start { XCTFail("foreground open is already owned"); return false })
        await waiting.value
        let readsBeforeHub = await transport.pageReads
        XCTAssertTrue(readsBeforeHub.isEmpty)
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 0)
        LifecycleHub.shared.resumeAll()
        await assertOneStream(session.id, afterRequests: beforeRequests)
        await waitForRead("the hub to fulfill the initial window") { await transport.pageReads.count == 1 }
        let reads = await transport.pageReads
        XCTAssertEqual(reads.map(\.visible), [SessionConversationStore.openVisibleRows])
        XCTAssertNil(reads.first?.since)
        await waitUntil("the entire first window to land") { store.historyMessages.map(\.text) == expected }
        cachedGate.open()
        await opening.value
        XCTAssertEqual(store.historyMessages.map(\.text), expected)
        XCTAssertEqual(store.historyMessages.count, 3)
        XCTAssertEqual(streamRequests(session.id), beforeRequests + 1)
        XCTAssertEqual(DemoServer.shared.streams.subscriberCount(.session(session.id)), 1)
    }

    func testRestartSuccessSupersedesOnlyTheCachedReadAndKeepsTheFreshRows() async throws {
        let sessions = try await WalnutAPI().sessions()
        let session = try XCTUnwrap(sessions.sessions.first)
        let transport = SessionPageReadTransport(transcript: readTranscript(["Old first row", "Old last row"]))
        let store = SessionConversationStore(
            session: session, transport: transport, resumeIDs: SessionStreamResumeIDs(defaults: nil)
        )
        let owner = SessionPageOperations(store: store)
        defer { owner.disappear() }
        owner.appear()
        await owner.refresh()
        await waitUntil("the initial stream") { DemoServer.shared.streams.subscriberCount(.session(session.id)) == 1 }
        let cachedGate = CheckedContinuationGate()
        defer { cachedGate.open() }
        await transport.holdNextCached(cachedGate)
        let cachedReads = await transport.cachedReads
        let staleRefresh = Task { await owner.refresh() }
        await waitForRead("the old cached response to block") { await transport.cachedReads > cachedReads }
        let lifecycle = SessionLifecycleController(sessionId: session.id)
        let restart = try XCTUnwrap(owner.start {
            let success = await lifecycle.restart()
            await transport.setTranscript(self.readTranscript(["Fresh first row", "Fresh last row", "New row"]))
            return success
        })
        await restart.value
        XCTAssertNotNil(lifecycle.confirmation, "the restart POST was cancelled with a read")
        let expected = ["Fresh first row", "Fresh last row", "New row"]
        XCTAssertEqual(store.historyMessages.map(\.text), expected)
        let readsBeforeRelease = await transport.pageReads.count
        cachedGate.open()
        await staleRefresh.value
        XCTAssertEqual(store.historyMessages.map(\.text), expected, "the cancelled cached response overwrote fresh rows")
        XCTAssertEqual(store.historyMessages.count, 3)
        let readsAfterRelease = await transport.pageReads.count
        XCTAssertEqual(readsAfterRelease, readsBeforeRelease, "the stale refresh started another fresh read")
        await waitUntil("one final stream") { DemoServer.shared.streams.subscriberCount(.session(session.id)) == 1 }
        XCTAssertEqual(DemoURLProtocol.requestLog.filter {
            $0.method == "POST" && $0.path == "/api/v1/sessions/\(session.id)/restart"
        }.count, 1)
    }

    func testRepeatedActionsKeepOneRequestAndFailureAllowsTheNextAction() async throws {
        let (session, _, transport, owner) = try await fixture()
        defer { owner.disappear() }
        let gate = CheckedContinuationGate()
        defer { gate.open() }
        var actionCount = 0
        let first = try XCTUnwrap(owner.start {
            actionCount += 1
            await gate.wait()
            return false
        })
        await waitUntil("the first action") { actionCount == 1 }
        let initialRequests = streamRequests(session.id)
        let initialReads = transport.transcriptReads.count
        for _ in 0..<19 {
            XCTAssertNotNil(owner.start { actionCount += 1; return true })
        }
        gate.open()
        await first.value
        XCTAssertEqual(actionCount, 1, "repeated taps started extra lifecycle requests")
        XCTAssertEqual(streamRequests(session.id), initialRequests, "a refused operation reopened the page")
        XCTAssertEqual(transport.transcriptReads.count, initialReads)

        let next = try XCTUnwrap(owner.start { actionCount += 1; return true })
        await next.value
        await assertOneStream(session.id, afterRequests: initialRequests)
        XCTAssertEqual(actionCount, 2)
        XCTAssertEqual(streamRequests(session.id), initialRequests + 1)
    }
}

/// Captures each response before its gate, so a held cached read really returns
/// the OLD rows after a newer open has received the fresh rows.
private actor SessionPageReadTransport: SessionSendTransport {
    private var transcript: SessionTranscript
    private var nextCachedGate: CheckedContinuationGate?
    private var nextFreshGate: CheckedContinuationGate?
    private(set) var cachedReads = 0
    private(set) var pageReads: [MockSessionSendTransport.PageRead] = []

    init(transcript: SessionTranscript) { self.transcript = transcript }
    func setTranscript(_ transcript: SessionTranscript) { self.transcript = transcript }
    func holdNextCached(_ gate: CheckedContinuationGate) { nextCachedGate = gate }
    func holdNextFresh(_ gate: CheckedContinuationGate) { nextFreshGate = gate }

    func sessionTranscript(id: String, fresh: Bool, rich: Bool) async throws -> SessionTranscript {
        let answer = transcript
        let gate = nextCachedGate
        nextCachedGate = nil
        cachedReads += 1
        if let gate { await gate.wait() }
        return answer
    }

    func sessionTranscriptPage(id: String, before: String?, since: String?, visible: Int) async throws -> SessionTranscript {
        pageReads.append(MockSessionSendTransport.PageRead(before: before, since: since, visible: visible))
        let answer = transcript
        let gate = nextFreshGate
        nextFreshGate = nil
        if let gate { await gate.wait() }
        return answer
    }

    func sendSessionMessage(id: String, text: String, images: [ImagePayload], messageId: String?) async throws -> SessionSendReceipt {
        SessionSendReceipt(messageId: messageId ?? "qm-read-owner", queued: false)
    }
}
