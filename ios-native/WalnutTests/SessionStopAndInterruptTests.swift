import XCTest
@testable import Walnut

/// Stop and "Interrupt & send" on the session page.
///
/// Stop ends the running turn and nothing else (`POST /sessions/:id/interrupt`); Interrupt &
/// send is a send that carries `interrupt: true`, on EVERY attempt of the bubble, because the
/// first attempt can be lost after the server took it and the retry must mean the same thing.
@MainActor
final class SessionStopAndInterruptTests: XCTestCase {
    private func event(_ name: String, _ json: String = "{}") -> SSEEvent {
        SSEEvent(id: nil, event: name, data: json)
    }

    private func store(_ tag: String) -> (SessionConversationStore, MockSessionSendTransport) {
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "stop-\(tag)"), transport: transport)
        return (store, transport)
    }

    private func waitUntil(_ what: String, timeout: Double = 5, _ condition: () -> Bool,
                           line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)", line: line)
    }

    override func tearDown() {
        SessionConversationStore.stopWait = 10
        super.tearDown()
    }

    // MARK: - Stop

    func testStopAsksTheServerToInterruptThisSession() async {
        let (store, transport) = store("call")
        store.handle(event("turn-start"))
        XCTAssertTrue(store.streaming)
        await store.stopTurn()
        XCTAssertEqual(transport.interruptCalls, ["stop-call"])
        XCTAssertNotNil(store.stopRequestedAt, "Stop shows stopping until the turn ends")
        XCTAssertNil(store.errorMessage)
    }

    func testStopWithNoRunningTurnSendsNothing() async {
        let (store, transport) = store("idle")
        XCTAssertFalse(store.streaming)
        await store.stopTurn()
        XCTAssertTrue(transport.interruptCalls.isEmpty)
        XCTAssertNil(store.stopRequestedAt)
    }

    func testASecondTapWhileStoppingDoesNotSendASecondStop() async {
        let (store, transport) = store("twice")
        store.handle(event("turn-start"))
        let gate = CheckedContinuationGate()
        transport.interruptGate = gate
        let first = Task { await store.stopTurn() }
        await waitUntil("the first stop is in flight") { transport.interruptCalls.count == 1 }
        await store.stopTurn()
        XCTAssertEqual(transport.interruptCalls.count, 1)
        gate.open()
        await first.value
        await store.stopTurn()
        XCTAssertEqual(transport.interruptCalls.count, 1, "still stopping: the turn has not ended")
    }

    func testTheTurnEndingClearsStopping() async {
        let (store, _) = store("ends")
        store.handle(event("turn-start"))
        await store.stopTurn()
        XCTAssertNotNil(store.stopRequestedAt)
        store.handle(event("turn-end"))
        XCTAssertFalse(store.streaming)
        XCTAssertNil(store.stopRequestedAt)
    }

    func testAnErrorEventClearsStoppingToo() async {
        let (store, _) = store("err")
        store.handle(event("turn-start"))
        await store.stopTurn()
        store.handle(event("error", #"{"message":"boom"}"#))
        XCTAssertNil(store.stopRequestedAt)
    }

    func testStopOffersItselfAgainWhenTheTurnDoesNotEnd() async {
        SessionConversationStore.stopWait = 0.05
        let (store, transport) = store("reset")
        store.handle(event("turn-start"))
        await store.stopTurn()
        await waitUntil("stopping resets") { store.stopRequestedAt == nil }
        XCTAssertTrue(store.streaming, "the turn still runs: Stop can be tapped again")
        await store.stopTurn()
        XCTAssertEqual(transport.interruptCalls.count, 2)
    }

    func testAFailedStopSaysWhyAndOffersItselfAgain() async {
        let (store, transport) = store("fail")
        store.handle(event("turn-start"))
        transport.interruptError = APIError.server(
            status: 503, code: "bridge_offline", message: "No live bridge", serverHash: nil, serverContent: nil
        )
        await store.stopTurn()
        XCTAssertNil(store.stopRequestedAt)
        XCTAssertEqual(store.errorMessage, "Can't reach your Mac to stop it. Try again in a moment.")
        XCTAssertTrue(store.streaming)
    }

    func testACancelledStopIsSilent() async {
        let (store, transport) = store("cancel")
        store.handle(event("turn-start"))
        transport.interruptError = APIError.cancelled
        await store.stopTurn()
        XCTAssertNil(store.errorMessage)
        XCTAssertNil(store.stopRequestedAt)
    }

    func testEveryStopFailureReadsAsASentenceNeverACode() {
        let codes = ["bridge_offline", "not_found", "session_control_needs_upgrade", "internal", "bad_request"]
        for code in codes {
            let text = SessionConversationStore.stopFailureText(APIError.server(
                status: 500, code: code, message: "Something went wrong.", serverHash: nil, serverContent: nil
            ))
            XCTAssertFalse(text.isEmpty, code)
            XCTAssertFalse(text.contains(code), "\(code) must not reach the screen as a code")
        }
    }

    func testTheCLIsAbortLineIsACardNotAUserBubble() async {
        for line in ["[Request interrupted by user]", "[Request interrupted by user for tool use]"] {
            let transport = MockSessionSendTransport()
            transport.transcript = SessionTranscript(
                sessionId: "stop-line", exportedAt: "2026-11-04T10:00:00Z", truncated: false,
                messages: [
                    SessionTranscript.Message(role: "user", text: "run the shards", timestamp: "2026-11-04T10:00:01Z", kind: nil),
                    SessionTranscript.Message(role: "user", text: line, timestamp: "2026-11-04T10:00:09Z", kind: nil),
                ]
            )
            let store = SessionConversationStore(session: ScriptedSSE.session(id: "stop-line"), transport: transport)
            await store.open()
            let rows = store.messages
            XCTAssertEqual(rows.count, 2, line)
            XCTAssertEqual(rows.last?.kind, .notification, line)
            XCTAssertEqual(rows.last?.source, "interrupt", line)
            XCTAssertFalse(rows.contains { $0.text.contains("Request interrupted") }, "the plumbing text never shows")
        }
    }

    func testWordsThatMerelyMentionTheAbortLineStayABubble() {
        XCTAssertFalse(SessionConversationStore.isInterruptMarker("please explain [Request interrupted by user]"))
        XCTAssertFalse(SessionConversationStore.isInterruptMarker("Request interrupted by user"))
        XCTAssertTrue(SessionConversationStore.isInterruptMarker("  [Request interrupted by user]\n"))
    }

    func testAStopThatFindsNothingRunningReadsTheTranscriptSoThePageSettles() async {
        let (store, transport) = store("stale")
        store.handle(event("turn-start"))
        transport.interruptResult = SessionInterruptResult(status: "interrupted", sessionId: "stop-stale", wasRunning: false)
        let readsBefore = transport.transcriptReads.count
        await store.stopTurn()
        XCTAssertGreaterThan(transport.transcriptReads.count, readsBefore,
                             "the page was out of date: read the transcript")
    }

    // MARK: - Interrupt & send

    func testAnInterruptingSendCarriesTheFlag() async {
        let (store, transport) = store("steer")
        await store.open()
        store.handle(event("turn-start"))
        let kept = await store.sendFromComposer("do this instead", interrupt: true)
        XCTAssertTrue(kept)
        XCTAssertEqual(transport.interruptFlags, [true])
        XCTAssertEqual(transport.sendCallCount, 1)
    }

    func testAPlainSendDoesNotInterrupt() async {
        let (store, transport) = store("plain")
        await store.open()
        store.handle(event("turn-start"))
        _ = await store.sendFromComposer("also this")
        XCTAssertEqual(transport.interruptFlags, [false])
    }

    func testEveryRetryOfAnInterruptingSendCarriesTheFlagUnderOneId() async {
        let (store, transport) = store("retry")
        await store.open()
        transport.failuresRemaining = 1
        transport.failureError = APIError.server(
            status: 503, code: "bridge_offline", message: "No live bridge", serverHash: nil, serverContent: nil
        )
        _ = await store.send("steer it", interrupt: true)
        guard let failed = store.messages.last(where: { $0.failed == true }) else {
            return XCTFail("the failed send keeps a retryable bubble")
        }
        await store.retry(failed)
        XCTAssertEqual(transport.interruptFlags, [true, true])
        XCTAssertEqual(Set(transport.messageIds.compactMap { $0 }).count, 1, "one id: the server stops the turn once")
    }

    func testAPlainSendAfterAnInterruptingOneIsPlain() async {
        let (store, transport) = store("mixed")
        await store.open()
        _ = await store.send("first", interrupt: true)
        _ = await store.send("second")
        XCTAssertEqual(transport.interruptFlags, [true, false])
    }

    // MARK: - The queue seams

    func testAWithdrawnQueuedMessageTakesItsBubbleWithIt() async {
        let (store, transport) = store("withdraw")
        await store.open()
        store.handle(event("turn-start"))
        _ = await store.send("queued words")
        let id = transport.messageIds.first ?? nil
        XCTAssertNotNil(id)
        XCTAssertTrue(store.messages.contains { $0.clientMessageId == id })
        store.queuedMessageWithdrawn(id!)
        XCTAssertFalse(store.messages.contains { $0.clientMessageId == id })
        XCTAssertFalse(store.messages.contains { $0.text == "queued words" })
    }

    func testWithdrawingAnUnknownIdChangesNothing() async {
        let (store, _) = store("unknown")
        await store.open()
        _ = await store.send("kept")
        store.queuedMessageWithdrawn("qm-not-a-bubble")
        XCTAssertTrue(store.messages.contains { $0.text == "kept" })
    }

    func testAnEditedQueuedMessageShowsItsNewWordsOnItsBubble() async {
        let (store, transport) = store("edit")
        await store.open()
        store.handle(event("turn-start"))
        _ = await store.send("old words")
        let id = (transport.messageIds.first ?? nil)!
        store.queuedMessageEdited(id, text: "new words")
        XCTAssertTrue(store.messages.contains { $0.text == "new words" })
        XCTAssertFalse(store.messages.contains { $0.text == "old words" })
    }

    func testAcceptedSendsCountsEachAcceptance() async {
        let (store, _) = store("count")
        await store.open()
        let before = store.acceptedSends
        _ = await store.send("one")
        _ = await store.send("two")
        XCTAssertEqual(store.acceptedSends, before + 2)
    }
}
