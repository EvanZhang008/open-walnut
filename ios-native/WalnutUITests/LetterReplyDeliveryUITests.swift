import XCTest

/// A Send always ends with a visible status line for THAT reply, on every path
/// (2026-09-29 gate, round 3):
///  - P1-A: the server's 12s route deadline answered 504 while the reply was
///    already threaded and still being delivered. The phone dropped its
///    "Sending" bubble for the recorded turn, which had no delivery yet, so no
///    line showed at all, and nothing read the letter again: "Sent" appeared
///    only after a reopen. The current server answers 202 with the turn on
///    record as `pending`; both answers now show "Sending to ..." and then
///    "Sent to ..." without a reopen.
///  - P1-B: a reply sent while an older refused one was still pending rendered
///    ABOVE it, and at the largest text size the new reply and its "Sent" were
///    off screen while only the old red "Not sent" showed.
///  - P2-4: a Retry made its button row vanish and come back, and the failure
///    line grew by a line afterwards.
/// And from the round 4 gate:
///  - P1: a Retry of an OLDER refused reply jumped it to the end of the thread in
///    one frame when the server answered, out of view. A Retry of a refused
///    reply is a new send now: it moves last at once, reading "Sending", and the
///    letter follows it there.
///  - P2-1: ordering by clock put a new reply above an older refused one when
///    the server's clock ran 10s behind the phone's. It is by sequence now.
///  - P2-4: after the re-reads gave up, nothing looked again, and "Not
///    confirmed" stayed after the delivery settled.
extension LetterReplyUITests {

    @MainActor
    func testADeadlineAnswerForARecordedReplyShowsSendingThenSentWithoutReopening() async throws {
        let stub = try await prepared()
        // An older server: it records the turn with no delivery, answers 504 at
        // its deadline (1.5s here), and writes the delivery 5s after recording.
        try await stub.call("POST", "__stub/letter-reply-mode?fail=504&count=1&delayMs=1500&settleMs=5000")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let text = "Recorded before the deadline."
        enter(text, app)
        app.buttons["inbox.letter.send"].tap()
        try await assertSendingThenSent(app, stub, text, shot: "deadline-504")
        let state = try await stub.state()
        XCTAssertEqual(state.posts.map(\.outcome), ["recorded:no-delivery:504"], "the phone sent it again: \(state.posts)")
        XCTAssertEqual(state.humanTurns(Self.letterA).map(\.text), [text])
    }

    @MainActor
    func testAPendingDeliveryAnsweredWith202ShowsSendingThenSentWithoutReopening() async throws {
        let stub = try await prepared()
        // The current server: 202 with the turn on record as pending, the
        // outcome written 4s later.
        try await stub.call("POST", "__stub/letter-reply-mode?fail=202&count=1&settleMs=4000")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let text = "On record, still being delivered."
        enter(text, app)
        app.buttons["inbox.letter.send"].tap()
        try await assertSendingThenSent(app, stub, text, shot: "pending-202")
        let state = try await stub.state()
        XCTAssertEqual(state.posts.map(\.outcome), ["recorded:pending:202"], "\(state.posts)")
        XCTAssertEqual(state.humanTurns(Self.letterA).map(\.text), [text])
    }

    /// The outcome never comes (the server died mid-delivery): after the phone's
    /// bounded re-reads the line says "Not confirmed" with Retry, never "Sending"
    /// forever and never nothing. Retry reuses the reply's id.
    @MainActor
    func testADeliveryThatNeverReportsBackEndsAsNotConfirmedWithRetry() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-mode?fail=202&count=2&settleMs=120000")
        // The re-read backoff (2, 4, 8, 16, 30s) at a twentieth: 3s in all.
        let app = try launchPaired(["-walnut.deliveryRecheckScale", "0.05"])
        openLetter(app, Self.letterA)
        let text = "Nobody answers this one."
        enter(text, app)
        app.buttons["inbox.letter.send"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Sending to ").waitForExistence(timeout: 10), "\(statusLabels(app))")
        let unsure = statusLine(app, prefix: "Not confirmed. ")
        XCTAssertTrue(unsure.waitForExistence(timeout: 30), "the wait never ended: \(statusLabels(app))")
        XCTAssertEqual(unsure.label, "Not confirmed. It may have reached \(Self.storeTitle). Retry is safe, it will not send twice.")
        XCTAssertTrue(app.buttons["inbox.letter.replyRetry"].exists, "no way forward")
        XCTAssertFalse(app.buttons["inbox.letter.replyEdit"].exists, "Edit would send it again under a new id")
        try await stub.screenshot(app, "never-settles-1-not-confirmed")

        app.buttons["inbox.letter.replyRetry"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Sending to ").waitForExistence(timeout: 10),
                      "the retry did not go back to waiting: \(statusLabels(app))")
        let state = try await stub.state()
        XCTAssertEqual(state.posts.count, 2, "\(state.posts)")
        XCTAssertEqual(Set(state.posts.map(\.clientId)).count, 1, "Retry must reuse the reply's id")
        XCTAssertEqual(state.humanTurns(Self.letterA).map(\.text), [text], "the reply was threaded twice")
    }

    /// The re-reads give up ("Not confirmed"), and the outcome lands after that:
    /// the slow re-read picks it up and the line turns to "Sent" on its own.
    @MainActor
    func testALateOutcomeAfterTheGiveUpStillTurnsTheLineToSent() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-mode?fail=202&count=1&settleMs=7000")
        // Backoff 3s in all, then a slow re-read every 3s.
        let app = try launchPaired(["-walnut.deliveryRecheckScale", "0.05"])
        openLetter(app, Self.letterA)
        enter("Settles after the give-up.", app)
        app.buttons["inbox.letter.send"].tap()
        let unsure = statusLine(app, prefix: "Not confirmed. ")
        XCTAssertTrue(unsure.waitForExistence(timeout: 30), "never gave up: \(statusLabels(app))")
        try await stub.screenshot(app, "late-1-not-confirmed")
        let sent = statusLine(app, prefix: "Sent to \(Self.storeTitle) · ")
        XCTAssertTrue(sent.waitForExistence(timeout: 30), "the late outcome never showed: \(statusLabels(app))")
        XCTAssertFalse(unsure.exists, "Not confirmed stayed next to Sent")
        try await stub.screenshot(app, "late-2-sent-on-its-own")
        let state = try await stub.state()
        XCTAssertEqual(state.posts.count, 1, "nothing was tapped, so nothing is sent again: \(state.posts)")
    }

    /// Same, with the slow re-read set past the test: coming back to the app
    /// is what reads the letter again.
    @MainActor
    func testALateOutcomeShowsWhenTheAppComesBackToTheForeground() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-mode?fail=202&count=1&settleMs=5000")
        let app = try launchPaired(["-walnut.deliveryRecheckScale", "0.05", "-walnut.deliveryLateSeconds", "600"])
        openLetter(app, Self.letterA)
        enter("Settles while the app is away.", app)
        app.buttons["inbox.letter.send"].tap()
        let unsure = statusLine(app, prefix: "Not confirmed. ")
        XCTAssertTrue(unsure.waitForExistence(timeout: 30), "never gave up: \(statusLabels(app))")
        // Past the settle, and nothing has read the letter since the give-up.
        var settled = false
        for _ in 0..<40 where !settled {
            settled = try await stub.state().humanTurns(Self.letterA).last?.delivery?.status == "queued"
            if !settled { try await Task.sleep(for: .milliseconds(500)) }
        }
        XCTAssertTrue(settled, "the stub never settled")
        try await Task.sleep(for: .seconds(1))
        XCTAssertTrue(unsure.exists, "something re-read the letter already: \(statusLabels(app))")
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(2))
        app.activate()
        let sent = statusLine(app, prefix: "Sent to \(Self.storeTitle) · ")
        XCTAssertTrue(sent.waitForExistence(timeout: 15), "coming back did not read the letter: \(statusLabels(app))")
        try await stub.screenshot(app, "late-3-sent-after-foreground")
    }

    // MARK: - r4 P1: a Retry of an older refused reply is a new send

    @MainActor
    func testARetryOfAnOlderRefusedReplyMovesItLastAndTheLetterFollowsIt() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-mode?fail=503&count=1")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let oldest = "The oldest, refused."
        enter(oldest, app)
        app.buttons["inbox.letter.send"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Not sent. ").waitForExistence(timeout: 20), "\(statusLabels(app))")
        let newer = (1...5).map { "Newer reply \($0), sent while the oldest waits." }
        for text in newer {
            enter(text, app)
            app.buttons["inbox.letter.send"].tap()
            XCTAssertTrue(humanTurn(app, text).waitForExistence(timeout: 20), "\(text) never showed")
        }
        XCTAssertTrue(waitUntil(timeout: 20) {
            self.statusLabels(app).filter { $0.hasPrefix("Sending to ") }.isEmpty
        }, "the newer replies never settled: \(statusLabels(app))")

        // Back up to the refused reply, as the human would, to reach its Retry:
        // short drags with no fling, so no drag carries it past the button (a
        // swipe on the thread itself pressed its centre, which is off screen
        // once the thread is taller than the screen).
        let retry = app.buttons["inbox.letter.replyRetry"]
        let scroll = letterScroll(app)
        for _ in 0..<16 where !retry.isHittable {
            let from = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
            let to = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
            from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        XCTAssertTrue(retry.isHittable, "the refused reply's Retry is out of reach")
        try await stub.screenshot(app, "retry-old-1-before")

        // 6s: long enough to look at the "Sending" state on a loaded machine.
        try await stub.call("POST", "__stub/letter-reply-mode?delayMs=6000")
        _ = try? await stub.call("POST", "__stub/letter-reply-mark?name=retry-old-tap")
        retry.tap()
        let moved = app.descendants(matching: .any).matching(
            NSPredicate(format: "(identifier == %@ OR identifier == %@) AND label == %@",
                        "inbox.letter.humanTurn", "inbox.letter.pendingReply", oldest)
        ).firstMatch
        // On its way: last in the thread, reading "Sending", in view.
        XCTAssertTrue(waitUntil(timeout: 5) { self.statusLabels(app).last?.hasPrefix("Sending to ") == true },
                      "the retried reply is not last and on its way: \(statusLabels(app))")
        try await Task.sleep(for: .seconds(1))
        if let line = statusLine(under: moved, app) {
            let label = line.label
            let frame = line.frame
            let composer = element(app, "inbox.letter.composer").frame
            let top = app.navigationBars.firstMatch.frame.maxY
            XCTAssertTrue(label.hasPrefix("Sending to "), "its line reads \(label) while the Retry is on its way")
            XCTAssertLessThanOrEqual(frame.maxY, composer.minY + 0.5, "its Sending line \(frame) is under the reply box \(composer)")
            XCTAssertGreaterThanOrEqual(frame.minY, top - 0.5, "its Sending line \(frame) is under the navigation bar")
        } else {
            XCTFail("no status line under the retried reply while it is on its way: \(statusLabels(app))")
        }
        try await stub.screenshot(app, "retry-old-2-sending-last")
        let sent = statusLine(app, prefix: "Sent to \(Self.storeTitle) · ")
        XCTAssertTrue(waitUntil(timeout: 20) {
            self.statusLabels(app).filter { $0.hasPrefix("Sending to ") }.isEmpty && sent.exists
        }, "the Retry never settled: \(statusLabels(app))")
        try await Task.sleep(for: .seconds(1.5))
        try await stub.screenshot(app, "retry-old-3-sent-last")

        // It is below every newer reply, and its line is on screen above the box.
        let lastNewer = humanTurn(app, newer[4])
        XCTAssertGreaterThan(moved.frame.minY, lastNewer.frame.maxY, "the retried reply is not last")
        guard let line = statusLine(under: moved, app) else {
            XCTFail("no status line under the retried reply: \(statusLabels(app))")
            return
        }
        XCTAssertTrue(line.label.hasPrefix("Sent to "), "its line reads \(line.label)")
        let composer = element(app, "inbox.letter.composer").frame
        let top = app.navigationBars.firstMatch.frame.maxY
        XCTAssertLessThanOrEqual(line.frame.maxY, composer.minY + 0.5, "its line \(line.frame) is under the reply box \(composer)")
        XCTAssertGreaterThanOrEqual(line.frame.minY, top - 0.5, "its line \(line.frame) is under the navigation bar")
        let state = try await stub.state()
        XCTAssertEqual(state.humanTurns(Self.letterA).map(\.text), newer + [oldest], "the server's order")
        XCTAssertEqual(state.posts.filter { $0.text == oldest }.count, 2, "\(state.posts)")
    }

    // MARK: - P1-B: one list in time order

    @MainActor
    func testANewReplySentWhileAnOlderOneIsRefusedRendersBelowItWithItsLineInView() async throws {
        try await assertNewReplyBelowRefused(largest: false)
    }

    @MainActor
    func testANewReplySentWhileAnOlderOneIsRefusedRendersBelowItAtTheLargestTextSize() async throws {
        try await assertNewReplyBelowRefused(largest: true)
    }

    /// The server's clock 10s behind the phone's: the new reply is recorded at
    /// a time before the refused one was sent (r4 gate, P2-1).
    @MainActor
    func testANewReplyStaysBelowARefusedOneWhenTheServerClockIsBehind() async throws {
        try await assertNewReplyBelowRefused(largest: false, skewMs: -10_000)
    }

    @MainActor
    func testANewReplyStaysBelowARefusedOneWhenTheServerClockIsAhead() async throws {
        try await assertNewReplyBelowRefused(largest: false, skewMs: 10_000)
    }

    // MARK: - P2-4: Retry keeps the line and its row the same size

    /// A recorded reply whose delivery failed, retried slowly and failing again.
    /// While the Retry is on its way the line says so ("Sending to ..."; the red
    /// failure above a "Sending" row was two opposite states at once, r4 gate
    /// P2-5), in the space the failure took, with progress where the buttons were.
    @MainActor
    func testARetryKeepsTheFailedLineAndItsButtonRowTheSameSize() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-mode?delivery=failed")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        enter("Retry me without moving anything.", app)
        app.buttons["inbox.letter.send"].tap()
        let line = statusLine(app, prefix: "Not sent to \(Self.storeTitle) · ")
        XCTAssertTrue(line.waitForExistence(timeout: 20), "\(statusLabels(app))")
        let retry = app.buttons["inbox.letter.replyRetry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        try await Task.sleep(for: .seconds(1.5))
        let before = (line: line.frame, label: line.label, row: retry.frame)
        try await stub.screenshot(app, "retry-size-1-failed")

        // A slow Retry that fails again. 6s, so the busy row is still there for
        // the queries below on a loaded machine (at load 160 one XCUITest query
        // took 29s, and a 2.5s answer had come and gone before the first one).
        try await stub.call("POST", "__stub/letter-reply-mode?delivery=failed&delayMs=6000")
        retry.tap()
        let busy = element(app, "inbox.letter.replyRetrying")
        XCTAssertTrue(busy.waitForExistence(timeout: 5), "no progress in the button row: \(statusLabels(app))")
        let during = statusLine(app, prefix: "Sending to \(Self.storeTitle)")
        XCTAssertTrue(during.exists, "the line does not say the Retry is on its way: \(statusLabels(app))")
        XCTAssertFalse(statusLine(app, prefix: "Not sent").exists, "the failure is still shown during the Retry: \(statusLabels(app))")
        XCTAssertEqual(during.frame.minY, before.line.minY, accuracy: 0.5, "the line moved during the Retry")
        XCTAssertEqual(during.frame.height, before.line.height, accuracy: 0.5, "the line resized during the Retry")
        XCTAssertEqual(busy.frame.midY, before.row.midY, accuracy: 2, "the busy row moved: \(busy.frame) vs \(before.row)")
        XCTAssertFalse(app.buttons["inbox.letter.replyRetry"].exists, "Retry can be tapped twice")
        try await stub.screenshot(app, "retry-size-2-busy")

        XCTAssertTrue(retry.waitForExistence(timeout: 20), "the Retry never settled: \(statusLabels(app))")
        try await Task.sleep(for: .seconds(1))
        let after = statusLine(app, prefix: "Not sent to \(Self.storeTitle) · ")
        XCTAssertEqual(after.label, before.label, "the failure line changed its words")
        XCTAssertEqual(after.frame.height, before.line.height, accuracy: 0.5, "the failure line grew")
        XCTAssertEqual(retry.frame.minY, before.row.minY, accuracy: 1, "the button row moved")
        try await stub.screenshot(app, "retry-size-3-failed-again")
    }

    // MARK: - Helpers

    /// From the Send until "Sent to": every line under the reply reads "Sending
    /// to ...", there is always one, and it ends with the reply and its line in
    /// view above the reply box, all without a reopen.
    @MainActor
    private func assertSendingThenSent(
        _ app: XCUIApplication, _ stub: LetterStub, _ text: String, shot: String
    ) async throws {
        let bubble = app.descendants(matching: .any).matching(
            NSPredicate(format: "(identifier == %@ OR identifier == %@) AND label == %@",
                        "inbox.letter.humanTurn", "inbox.letter.pendingReply", text)
        ).firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 10), "the reply never showed")
        var seen: [String] = []
        var lineless = 0
        var tookShot = false
        let deadline = Date().addingTimeInterval(40)
        while Date() < deadline {
            if let line = statusLine(under: bubble, app) {
                // ONE read per sample: every `.label` asks the app again, and a
                // line that turned to "Sent" between two reads ended the loop
                // with "Sent" never recorded (r4e main, 2026-09-29).
                let label = line.label
                if seen.last != label { seen.append(label) }
                if label.hasPrefix("Sent to ") { break }
                if !tookShot, label.hasPrefix("Sending to "), try await stub.state().posts.first?.answeredAt != nil {
                    try await stub.screenshot(app, "\(shot)-1-sending-after-the-answer")
                    tookShot = true
                }
            } else {
                lineless += 1
            }
            try await Task.sleep(for: .milliseconds(150))
        }
        XCTAssertEqual(seen.last.map { $0.hasPrefix("Sent to \(Self.storeTitle) · ") }, true,
                       "never Sent without a reopen: \(seen)")
        XCTAssertTrue(seen.dropLast().allSatisfy { $0.hasPrefix("Sending to ") }, "before Sent the line read \(seen)")
        XCTAssertTrue(seen.first?.hasPrefix("Sending to ") == true, "no Sending line first: \(seen)")
        XCTAssertEqual(lineless, 0, "the reply had no status line in \(lineless) samples: \(seen)")
        try await assertReplyAndLineInView(app, stub, text, shot: "\(shot)-2-sent")
    }

    @MainActor
    private func assertNewReplyBelowRefused(largest: Bool, skewMs: Int? = nil) async throws {
        let stub = try await prepared()
        let tag = (largest ? "axxxl" : "default") + (skewMs.map { "-skew\($0 / 1000)s" } ?? "")
        try await stub.call("POST", "__stub/letter-reply-mode?fail=503&count=1")
        if let skewMs { try await stub.call("POST", "__stub/letter-reply-skew?ms=\(skewMs)") }
        let app = try launchPaired(largest ? ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] : [])
        openLetter(app, Self.letterA)
        let older = "Older, refused."
        let newer = "Newer, sent."
        enter(older, app)
        app.buttons["inbox.letter.send"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Not sent. ").waitForExistence(timeout: 20), "\(statusLabels(app))")
        // The gate's case: the new reply about 3s after the refused one.
        if skewMs != nil { try await Task.sleep(for: .seconds(3)) }

        enter(newer, app)
        _ = try? await stub.call("POST", "__stub/letter-reply-mark?name=order-\(tag)-send-newer")
        app.buttons["inbox.letter.send"].tap()
        let oldBubble = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier == %@ AND label == %@", "inbox.letter.pendingReply", older)
        ).firstMatch
        let newBubble = app.descendants(matching: .any).matching(
            NSPredicate(format: "(identifier == %@ OR identifier == %@) AND label == %@",
                        "inbox.letter.humanTurn", "inbox.letter.pendingReply", newer)
        ).firstMatch
        XCTAssertTrue(newBubble.waitForExistence(timeout: 10), "the new reply never showed")
        // From the Send until it settles, the new reply stays below the old one.
        var order: [CGFloat] = []
        let sent = statusLine(app, prefix: "Sent to \(Self.storeTitle) · ")
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if oldBubble.exists, newBubble.exists { order.append(newBubble.frame.minY - oldBubble.frame.maxY) }
            if sent.exists { break }
            try await Task.sleep(for: .milliseconds(150))
        }
        XCTAssertTrue(sent.exists, "the new reply never showed as sent: \(statusLabels(app))")
        XCTAssertTrue(order.allSatisfy { $0 > 0 }, "the new reply went above the refused one: \(order)")
        try await Task.sleep(for: .seconds(1.5))
        try await stub.screenshot(app, "order-\(tag)-new-below-refused")
        XCTAssertGreaterThan(newBubble.frame.minY, oldBubble.frame.maxY, "the new reply is above the refused one")

        // The new reply's line is the one in view, right above the reply box.
        guard let line = statusLine(under: newBubble, app) else {
            XCTFail("no status line under the new reply: \(statusLabels(app))")
            return
        }
        XCTAssertTrue(line.label.hasPrefix("Sent to "), "the line under the new reply reads \(line.label)")
        let composer = element(app, "inbox.letter.composer").frame
        let top = app.navigationBars.firstMatch.frame.maxY
        XCTAssertLessThanOrEqual(line.frame.maxY, composer.minY + 0.5, "the new line \(line.frame) is under the reply box \(composer)")
        XCTAssertGreaterThanOrEqual(line.frame.minY, top - 0.5, "the new line \(line.frame) is under the navigation bar \(top)")
        XCTAssertLessThan(composer.minY - line.frame.maxY, 60, "the new line is not right above the reply box")
        XCTAssertEqual(statusLabels(app).last.map { $0.hasPrefix("Sent to ") }, true, "the last line is not the new reply's")
        let state = try await stub.state()
        XCTAssertEqual(state.humanTurns(Self.letterA).map(\.text), [newer])
    }
}
