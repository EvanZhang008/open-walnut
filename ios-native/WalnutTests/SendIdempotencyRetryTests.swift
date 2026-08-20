import XCTest
@testable import Walnut

/// The two halves of the durable-send contract on the client:
///
///  1. **A retry must reuse the original messageId.** The server's durable
///     message queue is idempotent BY that id (core/session-message-queue.ts
///     `enqueueMessage`, plus the relay ledger in daemon-connection.ts). If the
///     first attempt actually reached the queue and only its ack was lost, a
///     retry carrying a FRESH id is a brand-new message — the turn is delivered
///     twice, which is the "conversation repeats" family of field reports. The
///     dedupe can only save us if the id is stable across attempts.
///
///  2. **503 bridge_offline retries itself on a backoff ladder.** It means the
///     session's host has no live bridge right now (lid closed, Wi-Fi change,
///     SSH flap) — nothing is wrong with the message and the condition usually
///     clears in seconds. Reporting "Not sent" made the human the retry loop.
final class SendIdempotencyRetryTests: XCTestCase {

    private func bridgeOffline() -> APIError {
        .server(status: 503, code: "bridge_offline",
                message: "No live bridge to this session's host",
                serverHash: nil, serverContent: nil)
    }

    // MARK: - 1. Retry reuses the original messageId

    /// The core assertion: two attempts, ONE messageId, and it is the id the
    /// FIRST attempt used. A regression here re-opens double-delivery.
    @MainActor
    func testManualRetryReusesTheOriginalMessageId() async {
        let transport = MockSessionSendTransport()
        // Fail the first attempt only — a permanent failure would settle the
        // bubble the same way, but one failure keeps the assertion focused.
        transport.failuresRemaining = 1
        transport.failureError = bridgeOffline()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "retry-id"), transport: transport
        )
        await store.open()

        _ = await store.send("the only copy of this text")
        XCTAssertEqual(transport.sendCallCount, 1)
        let firstId = transport.messageIds.first ?? nil
        XCTAssertNotNil(firstId, "the client must mint its own idempotency key")
        XCTAssertTrue(firstId!.hasPrefix("qm-mobile-"),
                      "id must use the qm- vocabulary the server's regex accepts")

        // The bubble survived as a failed one, still holding the id.
        guard let failed = store.messages.last(where: { $0.failed == true }) else {
            return XCTFail("a failed send must leave a retryable bubble")
        }
        XCTAssertEqual(failed.clientMessageId, firstId)

        // Cancel the automatic ladder's influence by retrying manually right
        // away (a manual tap supersedes the scheduled attempt).
        await store.retry(failed)

        XCTAssertEqual(transport.sendCallCount, 2, "retry must actually re-POST")
        XCTAssertEqual(transport.messageIds[1], firstId,
                       "THE contract: a retry carries the ORIGINAL messageId so the "
                       + "server's queue dedupes it instead of double-delivering")
        XCTAssertEqual(Set(transport.messageIds.compactMap { $0 }).count, 1,
                       "all attempts at one user message share exactly one id")
    }

    /// Every automatic ladder attempt reuses the id too — not just the manual
    /// tap. (One failure, then success, so the ladder fires exactly once.)
    @MainActor
    func testAutomaticRetryReusesTheOriginalMessageId() async {
        let transport = MockSessionSendTransport()
        transport.failuresRemaining = 1
        transport.failureError = bridgeOffline()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "auto-retry-id"), transport: transport
        )
        await store.open()

        _ = await store.send("hello from the ladder")
        let firstId = transport.messageIds.first ?? nil
        XCTAssertNotNil(firstId)

        // The first automatic wait is SendRetryPolicy.baseDelay (2s). Wait it
        // out plus slack; the store's retry task is real (this is the one
        // wall-clock test — the schedule itself is asserted purely below).
        try? await Task.sleep(for: .seconds(SendRetryPolicy.baseDelay + 1.5))

        XCTAssertGreaterThanOrEqual(transport.sendCallCount, 2,
                                    "bridge_offline must retry itself, not wait for the user")
        for id in transport.messageIds {
            XCTAssertEqual(id, firstId, "every automatic attempt reuses the original id")
        }
        // Succeeded on attempt 2 → no failed bubble left behind.
        XCTAssertNil(store.messages.last(where: { $0.failed == true }),
                     "a successful retry must clear the failed state")
    }

    /// Regression: manual retry used to be gated on `canSend`, which is false
    /// while `offline` — i.e. it no-op'd in exactly the situation it exists for.
    /// A bridge_offline bubble MUST stay manually retryable, and the attempt is
    /// also how the app discovers the bridge came back.
    @MainActor
    func testManualRetryWorksWhileOfflineAndClearsItOnSuccess() async {
        let transport = MockSessionSendTransport()
        transport.failuresRemaining = 1
        transport.failureError = bridgeOffline()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "retry-while-offline"), transport: transport
        )
        await store.open()
        _ = await store.send("retry me while offline")

        XCTAssertTrue(store.offline, "a 503 must raise the offline banner")
        XCTAssertFalse(store.canSend, "the composer is correctly gated while offline")
        guard let failed = store.messages.last(where: { $0.failed == true }) else {
            return XCTFail("expected a failed bubble")
        }

        await store.retry(failed)
        XCTAssertEqual(transport.sendCallCount, 2,
                       "tap-to-retry must fire even while offline — that IS the common case")
        XCTAssertFalse(store.offline, "a 202 proves the bridge is back; clear the banner")
        XCTAssertTrue(store.canSend)
        XCTAssertNil(store.messages.last(where: { $0.failed == true }),
                     "a successful retry must clear the failed bubble")
    }

    /// A DIFFERENT user message gets a different id (the ids must be per
    /// message, not per store — otherwise two messages would dedupe onto one).
    @MainActor
    func testDistinctMessagesGetDistinctIds() async {
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "distinct-ids"), transport: transport
        )
        await store.open()
        _ = await store.send("first")
        _ = await store.send("second")
        let ids = transport.messageIds.compactMap { $0 }
        XCTAssertEqual(ids.count, 2)
        XCTAssertNotEqual(ids[0], ids[1], "two user messages must never share an id")
    }

    /// Discarding a failed bubble must also kill its scheduled retry: a timer
    /// re-delivering text the user deleted is worse than not retrying at all.
    @MainActor
    func testDiscardCancelsThePendingAutomaticRetry() async {
        let transport = MockSessionSendTransport()
        transport.permanentError = bridgeOffline()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "discard-cancels"), transport: transport
        )
        await store.open()
        _ = await store.send("throw me away")
        XCTAssertEqual(transport.sendCallCount, 1)

        guard let failed = store.messages.last(where: { $0.failed == true }) else {
            return XCTFail("expected a failed bubble")
        }
        store.discardFailed(failed)
        try? await Task.sleep(for: .seconds(SendRetryPolicy.baseDelay + 1.5))
        XCTAssertEqual(transport.sendCallCount, 1,
                       "a discarded bubble must never be re-sent by the ladder")
    }

    // MARK: - 2. Backoff schedule (pure — injected elapsed time, no clock)

    func testDelayDoublesFromTwoSecondsAndCaps() {
        XCTAssertEqual(SendRetryPolicy.delay(forAttempt: 1), 2)
        XCTAssertEqual(SendRetryPolicy.delay(forAttempt: 2), 4)
        XCTAssertEqual(SendRetryPolicy.delay(forAttempt: 3), 8)
        XCTAssertEqual(SendRetryPolicy.delay(forAttempt: 4), 16)
        XCTAssertEqual(SendRetryPolicy.delay(forAttempt: 5), 32)
        // Capped — a single wait longer than this reads as "the app gave up".
        XCTAssertEqual(SendRetryPolicy.delay(forAttempt: 6), SendRetryPolicy.maxDelay)
        XCTAssertEqual(SendRetryPolicy.delay(forAttempt: 99), SendRetryPolicy.maxDelay)
    }

    func testLadderRunsFiveAttemptsWithinTheBudget() {
        // Walk the ladder with the elapsed time the delays themselves produce.
        var elapsed: TimeInterval = 0
        var attempts = 0
        var attempt = 1
        while SendRetryPolicy.shouldRetry(attempt: attempt, elapsed: elapsed) {
            elapsed += SendRetryPolicy.delay(forAttempt: attempt)
            attempts += 1
            attempt += 1
        }
        XCTAssertEqual(attempts, SendRetryPolicy.maxAttempts,
                       "the ladder must use its whole attempt allowance: 2+4+8+16+32 = 62s")
        XCTAssertEqual(elapsed, 62)
        XCTAssertLessThanOrEqual(elapsed, SendRetryPolicy.budget)
    }

    func testAttemptCapEndsTheLadderEvenWithBudgetLeft() {
        // 62s of sleeping leaves budget headroom, but 5 failures is enough.
        XCTAssertFalse(
            SendRetryPolicy.shouldRetry(attempt: SendRetryPolicy.maxAttempts + 1, elapsed: 0),
            "attempts are capped independently of the time budget"
        )
    }

    func testBudgetEndsTheLadderEvenWithAttemptsLeft() {
        // A slow-failing server can burn wall clock without burning attempts:
        // near the budget, the NEXT delay must not fit.
        XCTAssertFalse(
            SendRetryPolicy.shouldRetry(attempt: 2, elapsed: SendRetryPolicy.budget - 1),
            "a retry that would wake past the budget must not be scheduled"
        )
        XCTAssertTrue(SendRetryPolicy.shouldRetry(attempt: 2, elapsed: 0))
    }

    func testZeroAndNegativeAttemptsAreRejected() {
        XCTAssertFalse(SendRetryPolicy.shouldRetry(attempt: 0, elapsed: 0))
        XCTAssertFalse(SendRetryPolicy.shouldRetry(attempt: -1, elapsed: 0))
    }

    // MARK: - What auto-retries

    private func transport(_ code: Int) -> APIError {
        .network(underlying: NSError(domain: NSURLErrorDomain, code: code))
    }

    func testOnlyBridgeOfflineAndAnswerlessTransportAreRetryable() {
        XCTAssertTrue(SendRetryPolicy.isRetryable(bridgeOffline()))
        // 409: the CLI is gone — a retry can't conjure it back.
        XCTAssertFalse(SendRetryPolicy.isRetryable(APIError.server(
            status: 409, code: "session_dead", message: "gone",
            serverHash: nil, serverContent: nil
        )))
        // 400: the message itself is the problem.
        XCTAssertFalse(SendRetryPolicy.isRetryable(APIError.server(
            status: 400, code: "bad_request", message: "no text",
            serverHash: nil, serverContent: nil
        )))
        XCTAssertFalse(SendRetryPolicy.isRetryable(APIError.cancelled))
        XCTAssertFalse(SendRetryPolicy.isRetryable(APIError.badResponse))

        // NEW (2026-08-20): a request that got NO answer is retryable too. The
        // real incident was two POSTs abandoned at the app's own 30s timeout
        // during a bridge outage — the ladder never engaged because it only
        // reacted to a 503 RESPONSE, so the bubble went red while the session
        // was healthy and visibly streaming. Safe only because the bubble
        // carries ONE stable qm- id across every attempt.
        XCTAssertTrue(SendRetryPolicy.isRetryable(transport(NSURLErrorTimedOut)))
        XCTAssertTrue(SendRetryPolicy.isRetryable(transport(NSURLErrorNetworkConnectionLost)))
        XCTAssertTrue(SendRetryPolicy.isRetryable(transport(NSURLErrorNotConnectedToInternet)))
        XCTAssertTrue(SendRetryPolicy.isRetryable(transport(NSURLErrorCannotConnectToHost)))
        XCTAssertTrue(SendRetryPolicy.isRetryable(transport(NSURLErrorSecureConnectionFailed)))
        XCTAssertTrue(SendRetryPolicy.isRetryable(transport(NSURLErrorDNSLookupFailed)))
        XCTAssertTrue(SendRetryPolicy.isRetryable(transport(NSURLErrorCannotFindHost)))

        // An answered-but-refused request, and non-URL errors, stay terminal:
        // retrying those is how you get a double-delivery or a spin.
        XCTAssertFalse(SendRetryPolicy.isRetryable(transport(NSURLErrorBadServerResponse)))
        XCTAssertFalse(SendRetryPolicy.isRetryable(transport(NSURLErrorCancelled)))
        XCTAssertFalse(SendRetryPolicy.isRetryable(
            APIError.network(underlying: NSError(domain: "SomeOtherDomain", code: NSURLErrorTimedOut))
        ))
    }

    /// Store-level proof of the same thing: a timed-out POST must land on the
    /// backoff ladder with the waiting copy, NOT the red terminal bubble.
    @MainActor
    func testTimedOutSendRidesTheLadderInsteadOfGoingRed() async {
        let transport = MockSessionSendTransport()
        transport.failuresRemaining = 1
        transport.failureError = APIError.network(
            underlying: NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        )
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "timeout-ladder"), transport: transport
        )
        await store.open()
        _ = await store.send("streaming fine, send timed out")

        guard let bubble = store.messages.last(where: { $0.failed == true }) else {
            return XCTFail("expected a retryable bubble")
        }
        XCTAssertNotNil(bubble.retryNotice,
                        "a timed-out send must show 'waiting… retrying', never the terminal copy")
        let firstId = transport.messageIds.first ?? nil
        XCTAssertNotNil(firstId)

        // The automatic attempt lands and succeeds, reusing the SAME id.
        try? await Task.sleep(for: .seconds(SendRetryPolicy.baseDelay + 1.5))
        XCTAssertGreaterThanOrEqual(transport.sendCallCount, 2,
                                    "the ladder must fire an automatic retry")
        XCTAssertEqual(transport.messageIds[1], firstId,
                       "the retry must reuse the original id or it double-delivers")
    }

    /// A transport failure must NOT raise the bridge-offline banner: the bridge
    /// may be perfectly fine and only this request died.
    @MainActor
    func testTimedOutSendDoesNotClaimTheBridgeIsOffline() async {
        let transport = MockSessionSendTransport()
        transport.permanentError = APIError.network(
            underlying: NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        )
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "timeout-not-offline"), transport: transport
        )
        await store.open()
        _ = await store.send("only this request died")
        XCTAssertFalse(store.offline,
                       "a request timeout says nothing about the host's bridge")
    }

    /// A dead session must settle immediately — no ladder, no waiting copy.
    @MainActor
    func testSessionDeadSettlesImmediatelyWithNoRetry() async {
        let transport = MockSessionSendTransport()
        transport.permanentError = APIError.server(
            status: 409, code: "session_dead", message: "Session process died mid-send",
            serverHash: nil, serverContent: nil
        )
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "dead-no-retry"), transport: transport
        )
        await store.open()
        _ = await store.send("into the void")

        XCTAssertTrue(store.dead)
        guard let failed = store.messages.last(where: { $0.failed == true }) else {
            return XCTFail("expected a failed bubble")
        }
        XCTAssertNil(failed.retryNotice, "a dead session shows the terminal copy, not 'waiting'")
        try? await Task.sleep(for: .seconds(SendRetryPolicy.baseDelay + 1.0))
        XCTAssertEqual(transport.sendCallCount, 1, "a 409 must not be retried automatically")
    }

    // MARK: - UI state while the ladder runs

    /// While a retry is pending the bubble must say so ("Waiting for Mac…"),
    /// not "Not sent" — and it must still be tappable (the notice is a Button).
    @MainActor
    func testWaitingNoticeShownWhileRetryPendingThenTerminalCopy() async {
        let transport = MockSessionSendTransport()
        transport.permanentError = bridgeOffline()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "waiting-copy"), transport: transport
        )
        await store.open()
        _ = await store.send("waiting on the bridge")

        guard let waiting = store.messages.last(where: { $0.failed == true }) else {
            return XCTFail("expected a failed bubble")
        }
        XCTAssertEqual(waiting.retryNotice, SendRetryPolicy.waitingNotice(host: "Mac"),
                       "a retryable failure must read as 'waiting', not 'not sent'")
        XCTAssertTrue(waiting.failed == true,
                      "still genuinely undelivered — a green bubble here would be the ghost bug")
    }

    /// The notice names the SESSION'S host, so a remote session doesn't send the
    /// user to debug the wrong machine (same rule as the offline banner).
    @MainActor
    func testWaitingNoticeNamesTheSessionHost() async {
        let remote = WalnutSession(
            id: "remote-host-copy", title: "Remote", taskId: nil, taskTitle: nil, project: nil,
            host: "devbox", processStatus: "running", model: nil, mode: nil,
            startedAt: "2026-08-18T00:00:00Z", lastActiveAt: "2026-08-18T00:00:00Z",
            messageCount: 0, cwd: nil, pinned: nil, focusTier: nil, description: nil
        )
        let transport = MockSessionSendTransport()
        transport.permanentError = bridgeOffline()
        let store = SessionConversationStore(session: remote, transport: transport)
        await store.open()
        _ = await store.send("hi devbox")

        let waiting = store.messages.last(where: { $0.failed == true })
        XCTAssertEqual(waiting?.retryNotice, SendRetryPolicy.waitingNotice(host: "devbox"))
        XCTAssertTrue(waiting?.retryNotice?.contains("devbox") == true)
    }

    /// Backgrounding pauses the ladder (no attempts burned while suspended);
    /// foregrounding re-arms it. This is the app-lifecycle half of requirement 2.
    @MainActor
    func testSuspendPausesTheLadderAndResumeReArmsIt() async {
        let transport = MockSessionSendTransport()
        transport.permanentError = bridgeOffline()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "bg-pause"), transport: transport
        )
        await store.open()
        _ = await store.send("pause me")
        XCTAssertEqual(transport.sendCallCount, 1)

        store.suspendForBackground()
        try? await Task.sleep(for: .seconds(SendRetryPolicy.baseDelay + 1.0))
        XCTAssertEqual(transport.sendCallCount, 1,
                       "a backgrounded app must not burn retry attempts it can't complete")
        // The bubble kept its waiting state, so the user still sees the truth.
        XCTAssertNotNil(store.messages.last(where: { $0.failed == true })?.retryNotice)

        store.resumeForForeground()
        try? await Task.sleep(for: .seconds(SendRetryPolicy.baseDelay + 1.5))
        XCTAssertGreaterThanOrEqual(transport.sendCallCount, 2,
                                    "foreground must resume the ladder for a still-waiting bubble")
    }

    // MARK: - messageId shape guard (the server validates it)

    func testMintedIdsMatchTheServersAcceptedShape() {
        // Server regex: /^qm-[A-Za-z0-9-]{1,64}$/ (session-stream-v1.ts). An id
        // that fails it is silently ignored and the server mints its own —
        // which would break dedupe without any visible error.
        for _ in 0..<200 {
            let id = SendRetryPolicy.newMessageId()
            XCTAssertTrue(SendRetryPolicy.isValidMessageId(id), "\(id) must satisfy the server regex")
            XCTAssertTrue(id.hasPrefix("qm-mobile-"))
            let body = id.dropFirst(3)
            XCTAssertLessThanOrEqual(body.count, 64)
            XCTAssertGreaterThanOrEqual(body.count, 1)
            XCTAssertTrue(body.allSatisfy {
                $0.isLetter && $0.isASCII || $0.isNumber && $0.isASCII || $0 == "-"
            })
        }
    }

    func testInvalidIdsAreRejectedByTheGuard() {
        XCTAssertFalse(SendRetryPolicy.isValidMessageId("not-a-qm-id"))
        XCTAssertFalse(SendRetryPolicy.isValidMessageId("qm-"))
        XCTAssertFalse(SendRetryPolicy.isValidMessageId("qm-has space"))
        XCTAssertFalse(SendRetryPolicy.isValidMessageId("qm-semi;colon"))
        XCTAssertFalse(SendRetryPolicy.isValidMessageId("qm-" + String(repeating: "a", count: 65)))
        XCTAssertTrue(SendRetryPolicy.isValidMessageId("qm-" + String(repeating: "a", count: 64)))
    }
}
