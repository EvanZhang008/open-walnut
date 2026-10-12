import Foundation
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
