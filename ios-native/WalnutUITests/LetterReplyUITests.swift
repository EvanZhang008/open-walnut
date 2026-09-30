import UIKit
import XCTest

/// The letter reply box, driven the way a finger drives it (TestFlight report,
/// 2026-09-28): there was no Walnut voice input, and a reply sent from the
/// Pinyin keyboard stayed in the field, still marked, under a "Sent" line that
/// named nobody and was gone after a reopen.
///
/// The box is `tests/ui/mid-turn-stub-server.mjs`: `/__stub/letter-reply` seeds
/// three letters, `/__stub/letter-reply-mode` picks how the next human-reply POST
/// answers (a delivery status, or a 503, or a request that never answers), and
/// `/__stub/stt` what transcription returns. `/__stub/work-session?on=1` gives the
/// phone the task and session letter A came from, so its status line names the
/// task and opens the session.
///
/// Some tests need the SIMULATOR set up first, and skip unless the runner says so:
///   WALNUT_UITEST_PINYIN=1      the only keyboard is Simplified Chinese Pinyin
///   WALNUT_UITEST_MIC_DENIED=1  the microphone permission is revoked
///   WALNUT_UITEST_DARK=1        dark appearance
/// Screenshots go to the stub, which writes them on the host (`WALNUT_STUB_SHOTS`).
final class LetterReplyUITests: XCTestCase {

    static let letterA = "lt-stub-reply-a"
    static let letterB = "lt-stub-reply-b"
    static let letterC = "lt-stub-reply-c"
    static let storeTitle = "Stub work task"
    static let transcript = "and please rerun the tests \u{7136}\u{540E}\u{628A}\u{7ED3}\u{679C}\u{53D1}\u{7ED9}\u{6211}"
    static let placeholder = "Reply to the agent"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    // MARK: - The report's repro: an uncommitted Pinyin composition, then Send

    /// What was sent must equal what the field showed, and the field must be empty
    /// one and three seconds later: the input session must not write it back.
    @MainActor
    func testPinyinCompositionThenSendSendsWhatWasShownAndClearsTheField() async throws {
        guard env("WALNUT_UITEST_PINYIN") == "1" else {
            throw XCTSkip("run with the Pinyin keyboard as the simulator's only keyboard and WALNUT_UITEST_PINYIN=1")
        }
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let field = replyField(app)
        focus(field, app)

        // "nihao", then its first candidate commits the two-character word for "hello"; "ma" stays marked.
        tapKeys("nihao", app)
        try await stub.screenshot(app, "pinyin-1-composing-nihao")
        let committedCandidate = commitCandidate("\u{4F60}\u{597D}", app)
        tapKeys("ma", app)
        try await Task.sleep(for: .milliseconds(600))
        let shown = fieldText(field)
        try await stub.screenshot(app, "pinyin-2-before-send-marked")
        diagnoseValue(app, "pinyin-before-send", "shown=\(shown) committedCandidate=\(committedCandidate)")
        XCTAssertFalse(shown.isEmpty, "nothing reached the field from the Pinyin keyboard")

        let send = app.buttons["inbox.letter.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        _ = try? await stub.call("POST", "__stub/letter-reply-mark?name=pinyin-send")
        send.tap()
        // The composition is committed and cleared in the tap's own turn.
        let rightAfter = fieldText(field)
        try await Task.sleep(for: .seconds(1))
        let after1 = fieldText(field)
        try await stub.screenshot(app, "pinyin-3-one-second-after-send")
        try await Task.sleep(for: .seconds(2))
        let after3 = fieldText(field)
        try await stub.screenshot(app, "pinyin-4-three-seconds-after-send")

        let state = try await stub.state()
        let posted = state.posts.map(\.text)
        diagnoseValue(app, "pinyin-after-send", "shown=\(shown) after1=\(after1) after3=\(after3) posted=\(posted)")
        XCTAssertEqual(posted.count, 1, "exactly one reply must be posted: \(posted)")
        XCTAssertEqual(Self.squash(posted.first ?? ""), Self.squash(shown),
                       "the reply sent (\(posted)) is not what the field showed (\(shown))")
        XCTAssertEqual(rightAfter, "", "right after Send the field still holds \"\(rightAfter)\"")
        XCTAssertEqual(after1, "", "one second after Send the field still holds \"\(after1)\"")
        XCTAssertEqual(after3, "", "three seconds after Send the field still holds \"\(after3)\"")
    }

    /// The report's timing. A real reply crosses a relay and can take seconds, and
    /// the input session is still alive in the box meanwhile (dictation keeps
    /// publishing after Send; here, a Pinyin syllable typed while the reply is on
    /// its way). The words that were sent must leave the field at once and stay
    /// gone when the answer lands; words typed after Send are the next reply and
    /// must survive the answer too.
    @MainActor
    func testPinyinCompositionLiveWhileASlowReplyLandsNeverLeavesTheSentWordsInTheField() async throws {
        guard env("WALNUT_UITEST_PINYIN") == "1" else {
            throw XCTSkip("run with the Pinyin keyboard as the simulator's only keyboard and WALNUT_UITEST_PINYIN=1")
        }
        let stub = try await prepared()
        // Long enough that the syllable below is typed, and still marked, before
        // the answer lands (a key tap costs seconds on a loaded machine).
        try await stub.call("POST", "__stub/letter-reply-mode?delayMs=15000")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let field = replyField(app)
        focus(field, app)
        tapKeys("nihao", app)
        let committedCandidate = commitCandidate("\u{4F60}\u{597D}", app)
        try await Task.sleep(for: .milliseconds(400))
        let shown = fieldText(field)
        XCTAssertFalse(shown.isEmpty, "nothing reached the field from the Pinyin keyboard")

        app.buttons["inbox.letter.send"].tap()
        try await Task.sleep(for: .seconds(1))
        let during = fieldText(field)
        let keyboardStayedUp = app.keyboards.element.exists
        try await stub.screenshot(app, "pinyin-slow-1-one-second-after-send")

        // Keep composing while the reply is on its way. The old reader left the
        // field focused; the fixed one ended editing, so the finger taps back in.
        if !keyboardStayedUp { focus(field, app) }
        tapKeys("ma", app)
        let composing = fieldText(field)
        let stillInFlight = (try? await stub.state())?.posts.first?.answeredAt == nil
        try await stub.screenshot(app, "pinyin-slow-2-composing-while-in-flight")

        // Wait for the stub to answer, then give the reader two seconds to act on it.
        var answered = false
        for _ in 0..<100 where !answered {
            answered = (try? await stub.state())?.posts.first?.answeredAt != nil
            if !answered { try await Task.sleep(for: .milliseconds(250)) }
        }
        try await Task.sleep(for: .seconds(2))
        let after = fieldText(field)
        try await stub.screenshot(app, "pinyin-slow-3-two-seconds-after-the-answer")
        let posted = try await stub.state().posts.map(\.text)
        diagnoseValue(app, "pinyin-slow", "shown=\(shown) committedCandidate=\(committedCandidate) "
            + "during=\(during) keyboardStayedUp=\(keyboardStayedUp) composing=\(composing) "
            + "stillInFlight=\(stillInFlight) answered=\(answered) "
            + "after=\(after) posted=\(posted) status=\(statusLabels(app))")

        XCTAssertTrue(answered, "the stub never answered the reply")
        XCTAssertTrue(stillInFlight, "the answer landed before the syllable was typed; the timing under test did not happen")
        XCTAssertEqual(posted.count, 1, "exactly one reply must be posted: \(posted)")
        XCTAssertEqual(Self.squash(posted.first ?? ""), Self.squash(shown),
                       "the reply sent (\(posted)) is not what the field showed (\(shown))")
        XCTAssertFalse(during.contains("\u{4F60}\u{597D}"), "one second after Send the field still holds the sent words: \"\(during)\"")
        XCTAssertFalse(after.contains("\u{4F60}\u{597D}"), "after the answer landed the field holds the sent words: \"\(after)\"")
        XCTAssertFalse(after.isEmpty, "the words typed after Send were wiped when the answer landed")
    }

    // MARK: - English reply: clears, status under the reply, opens the session

    @MainActor
    func testAnEnglishReplyClearsTheFieldShowsWhoItWentToAndOpensTheSession() async throws {
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let text = "Looks right, ship it on Friday."
        enter(text, app)
        app.buttons["inbox.letter.send"].tap()

        let field = replyField(app)
        XCTAssertTrue(waitUntil(timeout: 5) { self.fieldText(field).isEmpty }, "the field kept \(fieldText(field))")
        let status = statusLine(app, prefix: "Sent to \(Self.storeTitle) · ")
        XCTAssertTrue(status.waitForExistence(timeout: 20), "no status line naming the task: \(statusLabels(app))")
        let bubble = humanTurn(app, text)
        XCTAssertTrue(bubble.exists, "the reply is not in the thread")
        XCTAssertGreaterThanOrEqual(status.frame.minY, bubble.frame.maxY - 2, "the status line is not under the reply")
        try await Task.sleep(for: .seconds(2))
        XCTAssertEqual(fieldText(field), "", "the field refilled after the send")
        try await stub.screenshot(app, "english-1-sent-with-status")

        XCTAssertTrue(waitUntil(timeout: 10) { status.elementType == .button }, "the line never became a way into the session")
        status.tap()
        XCTAssertTrue(element(app, "session.menu").waitForExistence(timeout: 20), "the status line did not open the session")
        try await stub.screenshot(app, "english-2-session-opened")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(statusLine(app, prefix: "Sent to \(Self.storeTitle) · ").waitForExistence(timeout: 10),
                      "the status line is gone after coming back")
        let state = try await stub.state()
        XCTAssertEqual(state.posts.count, 1, "\(state.posts)")
        XCTAssertEqual(state.humanTurns(Self.letterA).map(\.text), [text])
    }

    /// A session this phone cannot open: the line says "the agent" and is plain
    /// text, so a tap never ends in "couldn't open that session".
    @MainActor
    func testAReplyToAnUnknownSessionSaysTheAgentAndIsNotADeadEndTap() async throws {
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterC)
        enter("Who sent this?", app)
        app.buttons["inbox.letter.send"].tap()
        let status = statusLine(app, prefix: "Sent to the agent · ")
        XCTAssertTrue(status.waitForExistence(timeout: 20), "\(statusLabels(app))")
        // Give the by-id lookup time to fail, then tap anyway.
        try await Task.sleep(for: .seconds(3))
        XCTAssertNotEqual(status.elementType, .button, "a line into a session nobody can open is still a button")
        status.tap()
        try await Task.sleep(for: .seconds(2))
        XCTAssertFalse(element(app, "session.menu").exists, "the tap opened something")
        XCTAssertFalse(element(app, "inbox.letter.delivery").exists, "the tap ended in an error note")
        try await stub.screenshot(app, "unknown-session-status")
    }

    // MARK: - Double tap, failures, retry

    @MainActor
    func testADoubleTapOnSendPostsExactlyOneReply() async throws {
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        enter("Double tap test.", app)
        let send = app.buttons["inbox.letter.send"]
        send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).doubleTap()
        try await Task.sleep(for: .seconds(3))
        send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        try await Task.sleep(for: .seconds(1))
        let state = try await stub.state()
        XCTAssertEqual(state.posts.count, 1, "a double tap posted \(state.posts.count) replies: \(state.posts)")
        XCTAssertEqual(state.humanTurns(Self.letterA).count, 1)
        XCTAssertTrue(statusLine(app, prefix: "Sent to ").waitForExistence(timeout: 10))
    }

    @MainActor
    func testA503KeepsTheWordsSurvivesLeavingAndRetrySendsOnce() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-mode?fail=503&count=1")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let text = "Retry after a 503, \u{7136}\u{540E}\u{544A}\u{8BC9}\u{6211}\u{7ED3}\u{679C}."
        enter(text, app)
        app.buttons["inbox.letter.send"].tap()

        let failed = statusLine(app, prefix: "Not sent. ")
        XCTAssertTrue(failed.waitForExistence(timeout: 20), "\(statusLabels(app))")
        XCTAssertEqual(failed.label, "Not sent. Your Mac is not connected to Walnut right now. Your reply is kept here; Retry when it is back.")
        XCTAssertTrue(element(app, "inbox.letter.pendingReply").exists, "the words are gone")
        XCTAssertEqual(element(app, "inbox.letter.pendingReply").label, text)
        XCTAssertEqual(fieldText(replyField(app)), "")
        try await stub.screenshot(app, "fail503-1-not-sent")

        // Leave the letter and come back: the refused reply is still there.
        goBack(app)
        openLetter(app, Self.letterA)
        XCTAssertTrue(statusLine(app, prefix: "Not sent. ").waitForExistence(timeout: 10), "the failed reply was lost")

        let retry = app.buttons["inbox.letter.replyRetry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        retry.tap()
        XCTAssertTrue(statusLine(app, prefix: "Sent to \(Self.storeTitle) · ").waitForExistence(timeout: 20),
                      "\(statusLabels(app))")
        XCTAssertFalse(element(app, "inbox.letter.pendingReply").exists)
        let state = try await stub.state()
        XCTAssertEqual(state.posts.map(\.outcome), ["503", "recorded:queued"], "\(state.posts)")
        XCTAssertEqual(state.humanTurns(Self.letterA).map(\.text), [text])
        try await stub.screenshot(app, "fail503-2-retried")
    }

    /// The request reaches the server, which records and delivers the reply,
    /// and then never answers: the phone times out (45s). The gate's case: the
    /// phone said "Not sent", and Edit then sent the words again under a new id.
    /// Now the phone re-reads the letter, finds the reply by its id, and shows
    /// it as sent. Edit is never offered on the way.
    @MainActor
    func testATimeoutThatWasRecordedShowsAsSentOnceAndNeverOffersEdit() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-mode?fail=timeout&count=1")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let text = "Recorded, but the answer was lost."
        enter(text, app)
        app.buttons["inbox.letter.send"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Sending to ").waitForExistence(timeout: 10), "\(statusLabels(app))")
        try await stub.screenshot(app, "timeout-1-sending")

        let sent = statusLine(app, prefix: "Sent to \(Self.storeTitle) · ")
        var sawEdit = false
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline, !sent.exists {
            if app.buttons["inbox.letter.replyEdit"].exists { sawEdit = true }
            try await Task.sleep(for: .milliseconds(250))
        }
        XCTAssertTrue(sent.exists, "the recorded reply never showed as sent: \(statusLabels(app))")
        XCTAssertFalse(sawEdit, "Edit was offered for a reply that may already be on record")
        try await stub.screenshot(app, "timeout-2-reread-shows-sent")
        let state = try await stub.state()
        XCTAssertEqual(state.posts.count, 1, "\(state.posts)")
        XCTAssertEqual(state.humanTurns(Self.letterA).map(\.text), [text])
        XCTAssertEqual(humanTurns(app, text), 1, "the reply shows twice")
        XCTAssertFalse(element(app, "inbox.letter.pendingReply").exists)
    }

    /// Same lost answer, and the re-read fails too: the line says the reply may
    /// have arrived, offers Retry and no Edit, and Retry (same id) threads it once.
    @MainActor
    func testATimeoutThenEditCannotSendTheReplyTwice() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-mode?fail=timeout&count=1")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let text = "Maybe on record, maybe not."
        enter(text, app)
        app.buttons["inbox.letter.send"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Sending to ").waitForExistence(timeout: 10), "\(statusLabels(app))")
        // Only now, so the open's own read is not the one refused.
        try await stub.call("POST", "__stub/letter-reply-reads?fail=3")

        let unsure = statusLine(app, prefix: "Not confirmed. ")
        XCTAssertTrue(unsure.waitForExistence(timeout: 90), "\(statusLabels(app))")
        XCTAssertEqual(unsure.label, "Not confirmed. It may have reached \(Self.storeTitle). Retry is safe, it will not send twice.")
        try await Task.sleep(for: .seconds(2))
        XCTAssertTrue(unsure.exists, "the line changed with nothing settled: \(statusLabels(app))")
        XCTAssertFalse(app.buttons["inbox.letter.replyEdit"].exists, "Edit would send it again under a new id")
        XCTAssertTrue(app.buttons["inbox.letter.replyRetry"].exists)
        try await stub.screenshot(app, "timeout-3-not-confirmed")

        try await stub.call("POST", "__stub/letter-reply-reads?fail=0")
        app.buttons["inbox.letter.replyRetry"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Sent to \(Self.storeTitle) · ").waitForExistence(timeout: 20),
                      "\(statusLabels(app))")
        let state = try await stub.state()
        XCTAssertEqual(state.posts.count, 2, "\(state.posts)")
        XCTAssertEqual(Set(state.posts.map(\.clientId)).count, 1, "Retry must reuse the reply's id")
        XCTAssertEqual(state.humanTurns(Self.letterA).map(\.text), [text], "the reply was threaded twice")
        XCTAssertEqual(humanTurns(app, text), 1, "the reply shows twice")
        try await stub.screenshot(app, "timeout-4-retried-once")
    }

    // MARK: - Retry and Edit are their own targets

    /// Retry sits under a line that used to open the session; a tap that just
    /// missed Retry opened it (gate: 9pt above Retry's centre). The line is not a
    /// way into the session while Retry shows, and Retry is a 44pt target.
    @MainActor
    func testANearMissAboveRetryNeverOpensTheSession() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-mode?delivery=failed")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        enter("Please try this one again.", app)
        app.buttons["inbox.letter.send"].tap()
        let line = statusLine(app, prefix: "Not sent to \(Self.storeTitle) · ")
        XCTAssertTrue(line.waitForExistence(timeout: 20), "\(statusLabels(app))")
        try await Task.sleep(for: .seconds(1.5))
        let retry = app.buttons["inbox.letter.replyRetry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        let r = retry.frame
        diagnoseValue(app, "near-miss-frames", "line=\(line.frame) retry=\(r)")
        XCTAssertGreaterThanOrEqual(r.height, 44, "Retry is \(r)")
        XCTAssertGreaterThanOrEqual(r.width, 44, "Retry is \(r)")
        XCTAssertLessThanOrEqual(line.frame.maxY, r.minY + 0.5, "the line and Retry overlap: \(line.frame) \(r)")
        XCTAssertNotEqual(line.elementType, .button, "the line is still a way into the session beside Retry")
        XCTAssertTrue(retry.isHittable, "Retry is not on screen: \(r)")
        XCTAssertLessThanOrEqual(r.maxY, element(app, "inbox.letter.composer").frame.minY + 0.5, "Retry is under the reply box")
        try await stub.screenshot(app, "nearmiss-1-retry-under-the-line")

        // On the line, well clear of Retry: nothing happens at all.
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        let l = line.frame
        origin.withOffset(CGVector(dx: l.minX + 60, dy: l.minY + 6)).tap()
        try await Task.sleep(for: .seconds(2))
        XCTAssertFalse(element(app, "session.menu").exists, "a tap on the line opened the session")
        let afterLine = try await stub.state().posts.count
        XCTAssertEqual(afterLine, 1, "a tap on the line retried")

        // Just above Retry, in the gap: never the session (iOS may give a tap
        // this close to the nearest button, which is Retry, and that is safe).
        origin.withOffset(CGVector(dx: r.midX, dy: r.minY - 3)).tap()
        try await Task.sleep(for: .seconds(2))
        XCTAssertFalse(element(app, "session.menu").exists, "a tap just above Retry opened the session")

        // The gate's tap, 9pt above Retry's centre, is Retry now.
        try await stub.call("POST", "__stub/letter-reply-mode?delivery=queued")
        origin.withOffset(CGVector(dx: r.midX, dy: r.midY - 9)).tap()
        XCTAssertTrue(statusLine(app, prefix: "Sent to \(Self.storeTitle) · ").waitForExistence(timeout: 20),
                      "\(statusLabels(app))")
        XCTAssertFalse(element(app, "session.menu").exists, "the tap opened the session instead of retrying")
        let state = try await stub.state()
        XCTAssertGreaterThanOrEqual(state.posts.count, 2, "\(state.posts)")
        XCTAssertEqual(Set(state.posts.map(\.clientId)).count, 1, "a retry used a new id")
        XCTAssertEqual(state.humanTurns(Self.letterA).count, 1)
        try await stub.screenshot(app, "nearmiss-2-retried")
    }

    // MARK: - Every delivery state, and a reopen

    @MainActor
    func testEveryDeliveryStateRendersItsCopyAndSurvivesAReopen() async throws {
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let cases: [(delivery: String, text: String, prefix: String)] = [
            ("queued", "Reply one.", "Sent to \(Self.storeTitle) · "),
            ("deferred", "Reply two.", "Queued for \(Self.storeTitle) · "),
            ("skipped", "Reply three.", "Saved · "),
            ("failed", "Reply four.", "Not sent to \(Self.storeTitle) · "),
        ]
        for c in cases {
            try await stub.call("POST", "__stub/letter-reply-mode?delivery=\(c.delivery)")
            enter(c.text, app)
            app.buttons["inbox.letter.send"].tap()
            XCTAssertTrue(statusLine(app, prefix: c.prefix).waitForExistence(timeout: 20),
                          "\(c.delivery): \(statusLabels(app))")
        }
        let labels = statusLabels(app)
        XCTAssertEqual(labels.count, 4, "\(labels)")
        XCTAssertTrue(labels[1].hasSuffix("It is waiting on a permission prompt, and your reply reaches it after that."), labels[1])
        XCTAssertTrue(labels[2].hasSuffix("The agent that wrote this letter has ended, so nothing was sent."), labels[2])
        XCTAssertTrue(labels[3].hasSuffix("Your reply is saved in this letter."), labels[3])
        for label in labels {
            XCTAssertFalse(label.contains("\u{2014}") || label.contains("\u{2013}"), "a dash in \(label)")
        }
        try await stub.screenshot(app, "states-1-all-four")

        // Close and reopen: the words come from the server's record now.
        UITestLaunch.terminate()
        let relaunched = try launchPaired()
        openLetter(relaunched, Self.letterA)
        XCTAssertTrue(statusLine(relaunched, prefix: cases[3].prefix).waitForExistence(timeout: 20))
        XCTAssertEqual(statusLabels(relaunched), labels, "a reopened letter says something different")
        try await stub.screenshot(relaunched, "states-2-after-relaunch")
        letterScroll(relaunched).swipeUp()
        try await Task.sleep(for: .seconds(1))
        try await stub.screenshot(relaunched, "states-2b-failed-line-after-relaunch")

        // Retry the failed delivery: the same turn, delivered, once.
        try await stub.call("POST", "__stub/letter-reply-mode?delivery=queued")
        relaunched.buttons["inbox.letter.replyRetry"].tap()
        XCTAssertTrue(waitUntil(timeout: 20) { self.statusLabels(relaunched).filter { $0.hasPrefix("Sent to") }.count == 2 },
                      "\(statusLabels(relaunched))")
        let state = try await stub.state()
        XCTAssertEqual(state.humanTurns(Self.letterA).count, 4)
        XCTAssertEqual(state.posts.count, 5)
        try await stub.screenshot(relaunched, "states-3-failed-retried")
    }

    // MARK: - The newest status line stays above the reply box

    /// Five replies, each status line checked right after its send: the whole
    /// line sits between the navigation bar and the reply box.
    @MainActor
    func testTheNewestStatusLineStaysAboveTheReplyBox() async throws {
        try await assertEachNewStatusLineIsInView(largest: false)
    }

    @MainActor
    func testTheNewestStatusLineStaysAboveTheReplyBoxAtTheLargestTextSize() async throws {
        try await assertEachNewStatusLineIsInView(largest: true)
    }

    /// Someone who scrolled up to read is never moved when a status changes.
    @MainActor
    func testAReaderWhoScrolledUpIsNotMovedWhenTheStatusChanges() async throws {
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        // Enough replies that the top of the letter is far from its end.
        for n in 1...6 {
            let filler = "Filler reply \(n), long enough to wrap onto a second line so the letter is taller than the screen."
            enter(filler, app)
            app.buttons["inbox.letter.send"].tap()
            XCTAssertTrue(humanTurn(app, filler).waitForExistence(timeout: 20), "filler \(n) never landed")
        }
        try await stub.call("POST", "__stub/letter-reply-mode?delayMs=8000")
        let text = "The one whose answer is slow."
        enter(text, app)
        app.buttons["inbox.letter.send"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Sending to ").waitForExistence(timeout: 10), "\(statusLabels(app))")

        // Read the top of the letter while the answer is on its way.
        let letter = letterScroll(app)
        let subject = element(app, "inbox.letter.subject")
        for _ in 0..<5 where !subject.isHittable {
            letter.swipeDown()
            try await Task.sleep(for: .milliseconds(500))
        }
        try await Task.sleep(for: .seconds(1))
        XCTAssertEqual(fieldText(replyField(app)), "", "the field picked up text while reading: \(fieldText(replyField(app)))")
        XCTAssertTrue(subject.isHittable, "the swipe did not reach the top of the letter")
        let before = subject.frame.minY
        try await stub.screenshot(app, "follow-3-scrolled-up-while-sending")

        var answered = false
        for _ in 0..<60 where !answered {
            answered = (try? await stub.state())?.posts.last?.answeredAt != nil
            if !answered { try await Task.sleep(for: .milliseconds(250)) }
        }
        XCTAssertTrue(answered, "the slow answer never came")
        XCTAssertTrue(statusLine(app, prefix: "Sent to \(Self.storeTitle) · ").waitForExistence(timeout: 10))
        let sentLabels = statusLabels(app).filter { $0.hasPrefix("Sent to") }
        XCTAssertEqual(sentLabels.count, 7, "\(statusLabels(app))")
        try await Task.sleep(for: .seconds(1.5))
        try await stub.screenshot(app, "follow-4-still-reading-after-the-answer")
        XCTAssertEqual(subject.frame.minY, before, accuracy: 1, "the letter moved under a reader who scrolled up")
        XCTAssertTrue(subject.isHittable)
    }

    /// The gate's natural flow: open a long letter, read from the top, reply.
    /// The reply and its line come into view above the reply box.
    @MainActor
    func testASendAfterReadingFromTheTopShowsTheReplyAndItsLine() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-thread?id=\(Self.letterB)&n=6")
        let app = try launchPaired()
        openLetter(app, Self.letterB)
        let letter = letterScroll(app)
        letter.swipeUp()
        letter.swipeDown()
        letter.swipeDown()
        try await Task.sleep(for: .seconds(1))
        XCTAssertTrue(element(app, "inbox.letter.subject").isHittable, "not reading from the top")
        let text = "Read it all from the top. Ship it."
        enter(text, app)
        app.buttons["inbox.letter.send"].tap()
        try await assertReplyAndLineInView(app, stub, text, shot: "follow-send-after-reading-from-the-top")
        // Keep the keyboard up for a follow-up: the new reply is above the box and the keyboard.
        let followUp = "And one more thing."
        enter(followUp, app)
        app.buttons["inbox.letter.send"].tap()
        try await assertReplyAndLineInView(app, stub, followUp, shot: "follow-follow-up-keyboard-up")
        let turns = try await stub.state().humanTurns(Self.letterB).count
        XCTAssertEqual(turns, 8)
    }

    /// Type, drag the letter down to put the keyboard away (which scrolls it up),
    /// then Send: the reply comes into view all the same.
    @MainActor
    func testASendAfterTheKeyboardDragShowsTheReplyAndItsLine() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-thread?id=\(Self.letterB)&n=6")
        let app = try launchPaired()
        openLetter(app, Self.letterB)
        let letter = letterScroll(app)
        for _ in 0..<3 { letter.swipeUp() }
        let text = "Written, then the keyboard dragged away."
        enter(text, app)
        dismissKeyboard(app)
        letter.swipeDown()
        try await Task.sleep(for: .seconds(1))
        XCTAssertFalse(app.keyboards.element.exists, "the drag left the keyboard up")
        XCTAssertEqual(fieldText(replyField(app)), text, "the drag lost the draft")
        app.buttons["inbox.letter.send"].tap()
        try await assertReplyAndLineInView(app, stub, text, shot: "follow-send-after-the-drag")
        let turns = try await stub.state().humanTurns(Self.letterB).count
        XCTAssertEqual(turns, 7)
    }

    /// A letter whose newest reply already has a status line opens at its top
    /// and stays there while the detail and the task titles arrive (it used to
    /// jump to the end a quarter second after it painted).
    @MainActor
    func testALetterWithAStatusLineOpensAtItsTopAndStaysThere() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-thread?id=\(Self.letterB)&n=6")
        let app = try launchPaired()
        for round in 1...2 {
            openLetter(app, Self.letterB)
            let subject = element(app, "inbox.letter.subject")
            XCTAssertTrue(subject.waitForExistence(timeout: 10))
            let first = subject.frame.minY
            XCTAssertTrue(subject.isHittable, "open \(round) did not start at the top")
            var lowest = first
            for _ in 0..<12 {
                try await Task.sleep(for: .milliseconds(250))
                lowest = min(lowest, subject.frame.minY)
            }
            try await stub.screenshot(app, "open-at-top-\(round)")
            XCTAssertEqual(lowest, first, accuracy: 1, "open \(round): the letter moved from \(first) to \(lowest)")
            XCTAssertTrue(subject.isHittable, "open \(round) left the top")
            XCTAssertFalse(statusLabels(app).isEmpty, "the seeded replies carry no status line")
            goBack(app)
        }
    }

    /// The newest reply bubble and the status line under it sit between the
    /// navigation bar and the reply box (which rides above the keyboard).
    @MainActor
    func assertReplyAndLineInView(
        _ app: XCUIApplication, _ stub: LetterStub, _ text: String, shot: String
    ) async throws {
        let bubble = app.descendants(matching: .any).matching(
            NSPredicate(format: "(identifier == %@ OR identifier == %@) AND label == %@",
                        "inbox.letter.humanTurn", "inbox.letter.pendingReply", text)
        ).firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 20), "the reply never showed: \(statusLabels(app))")
        try await Task.sleep(for: .seconds(1.5))
        let composer = element(app, "inbox.letter.composer").frame
        let top = app.navigationBars.firstMatch.frame.maxY
        try await stub.screenshot(app, shot)
        XCTAssertGreaterThanOrEqual(bubble.frame.minY, top - 0.5, "the reply (\(bubble.frame)) is under the navigation bar (\(top))")
        XCTAssertLessThanOrEqual(bubble.frame.maxY, composer.minY + 0.5, "the reply (\(bubble.frame)) is under the reply box (\(composer))")
        guard let line = statusLine(under: bubble, app) else {
            XCTFail("no status line under the reply: \(statusLabels(app))")
            return
        }
        XCTAssertLessThanOrEqual(line.frame.maxY, composer.minY + 0.5, "the line (\(line.frame)) is under the reply box (\(composer))")
        if app.keyboards.element.exists {
            XCTAssertLessThanOrEqual(line.frame.maxY, app.keyboards.element.frame.minY, "the line is under the keyboard")
        }
    }

    @MainActor
    private func assertEachNewStatusLineIsInView(largest: Bool) async throws {
        let stub = try await prepared()
        let app = try launchPaired(largest ? ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] : [])
        openLetter(app, Self.letterA)
        let tag = largest ? "axxxl" : "default"
        let sends: [(delivery: String, text: String, prefix: String)] = [
            ("queued", "First of five.", "Sent to "),
            ("deferred", "Second of five, a little longer so that it wraps onto another line.", "Queued for "),
            ("skipped", "Third of five.", "Saved \u{00B7} "),
            ("failed", "Fourth of five.", "Not sent to "),
            ("skipped", "Fifth of five, the newest.", "Saved \u{00B7} "),
        ]
        for (index, send) in sends.enumerated() {
            try await stub.call("POST", "__stub/letter-reply-mode?delivery=\(send.delivery)")
            enter(send.text, app)
            _ = try? await stub.call("POST", "__stub/letter-reply-mark?name=follow-\(tag)-send-\(index + 1)")
            app.buttons["inbox.letter.send"].tap()
            let bubble = humanTurn(app, send.text)
            XCTAssertTrue(bubble.waitForExistence(timeout: 20), "reply \(index + 1) never landed: \(statusLabels(app))")
            // The follow scroll runs after the line lays out; give it and its animation time.
            try await Task.sleep(for: .seconds(1.5))
            guard let line = statusLine(under: bubble, app) else {
                XCTFail("no status line under reply \(index + 1): \(statusLabels(app))")
                return
            }
            XCTAssertTrue(line.label.hasPrefix(send.prefix), "reply \(index + 1) reads \"\(line.label)\"")
            let composer = element(app, "inbox.letter.composer").frame
            let top = app.navigationBars.firstMatch.frame.maxY
            XCTAssertLessThanOrEqual(line.frame.maxY, composer.minY + 0.5,
                                     "reply \(index + 1)'s status line (\(line.frame)) is under the reply box (\(composer))")
            XCTAssertGreaterThanOrEqual(line.frame.minY, top - 0.5,
                                        "reply \(index + 1)'s status line (\(line.frame)) is under the navigation bar (\(top))")
            if index == 2 || index == sends.count - 1 {
                try await stub.screenshot(app, "follow-\(tag)-after-reply-\(index + 1)")
            }
        }
        let recorded = try await stub.state().humanTurns(Self.letterA)
        XCTAssertEqual(recorded.count, sends.count)
    }

    /// The status line directly under a reply bubble: the nearest one below it.
    @MainActor
    func statusLine(under bubble: XCUIElement, _ app: XCUIApplication) -> XCUIElement? {
        let floor = bubble.frame.maxY - 2
        return app.descendants(matching: .any).matching(identifier: "inbox.letter.replyStatus")
            .allElementsBoundByIndex
            .filter { $0.frame.minY >= floor }
            .min { $0.frame.minY < $1.frame.minY }
    }

    // MARK: - Drafts

    @MainActor
    func testADraftSurvivesLeavingTheLetterAndOpeningAnother() async throws {
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        enter("Half a reply for A", app)
        goBack(app)
        openLetter(app, Self.letterB)
        XCTAssertEqual(fieldText(replyField(app)), "", "letter B shows letter A's draft")
        enter("Something for B", app)
        goBack(app)
        openLetter(app, Self.letterA)
        XCTAssertEqual(fieldText(replyField(app)), "Half a reply for A")
        try await stub.screenshot(app, "draft-1-back-on-a")
        goBack(app)
        openLetter(app, Self.letterB)
        XCTAssertEqual(fieldText(replyField(app)), "Something for B")
        let state = try await stub.state()
        XCTAssertEqual(state.posts.count, 0, "a draft was sent")
    }

    /// The draft and a refused reply are on disk, not only in memory: both come
    /// back after the app is closed, and Retry sends the refused one with the id
    /// it had before, once.
    @MainActor
    func testARelaunchKeepsTheDraftAndARefusedReply() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/letter-reply-mode?fail=503&count=1")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let refused = "Refused before the relaunch, \u{7136}\u{540E}\u{544A}\u{8BC9}\u{6211}."
        enter(refused, app)
        app.buttons["inbox.letter.send"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Not sent. ").waitForExistence(timeout: 20), "\(statusLabels(app))")
        let draft = "Half a second thought"
        enter(draft, app)
        try await Task.sleep(for: .seconds(1.5))
        try await stub.screenshot(app, "relaunch-1-before")
        // Leave the app, then have it killed, as iOS does to a backgrounded app.
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(2))
        UITestLaunch.terminate()

        let relaunched = try launchPaired(keepSaved: true)
        openLetter(relaunched, Self.letterA)
        XCTAssertTrue(waitUntil(timeout: 10) { self.fieldText(self.replyField(relaunched)) == draft },
                      "the draft did not survive: \(fieldText(replyField(relaunched)))")
        let pending = element(relaunched, "inbox.letter.pendingReply")
        XCTAssertTrue(pending.waitForExistence(timeout: 10), "the refused reply did not survive")
        XCTAssertEqual(pending.label, refused)
        XCTAssertTrue(statusLine(relaunched, prefix: "Not sent. ").exists, "\(statusLabels(relaunched))")
        try await stub.screenshot(relaunched, "relaunch-2-after")

        relaunched.buttons["inbox.letter.replyRetry"].tap()
        XCTAssertTrue(statusLine(relaunched, prefix: "Sent to \(Self.storeTitle) · ").waitForExistence(timeout: 20),
                      "\(statusLabels(relaunched))")
        let state = try await stub.state()
        XCTAssertEqual(state.posts.map(\.outcome), ["503", "recorded:queued"], "\(state.posts)")
        XCTAssertEqual(Set(state.posts.map(\.clientId)).count, 1, "the Retry after the relaunch used a new id")
        XCTAssertEqual(state.humanTurns(Self.letterA).map(\.text), [refused])
        XCTAssertEqual(fieldText(replyField(relaunched)), draft, "the retry took the draft")
        try await stub.screenshot(relaunched, "relaunch-3-retried")
    }

    // MARK: - Long mixed reply

    @MainActor
    func testALongMixedReplyGrowsToFiveLinesThenScrollsAndSends() async throws {
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        let field = replyField(app)
        let oneLine = field.frame.height
        let lines = [
            "Line one: the build is green \u{6784}\u{5EFA}\u{901A}\u{8FC7}\u{4E86}",
            "Line two: please rerun the flaky suite \u{518D}\u{8DD1}\u{4E00}\u{6B21}",
            "Line three: the migration looks right",
            "Line four: \u{6570}\u{636E}\u{5E93}\u{8FC1}\u{79FB}\u{6CA1}\u{95EE}\u{9898}",
            "Line five: ship it after lunch",
            "Line six: \u{7136}\u{540E}\u{901A}\u{77E5}\u{5927}\u{5BB6}",
            "Line seven: thanks, this was careful work",
        ]
        enter(lines[0...4].joined(separator: "\n"), app)
        let fiveLines = field.frame.height
        typeMore("\n" + lines[5...6].joined(separator: "\n"), app)
        let sevenLines = field.frame.height
        try await stub.screenshot(app, "long-1-seven-lines-scrolls")
        XCTAssertGreaterThan(fiveLines, oneLine * 2.5, "the field did not grow (\(oneLine) → \(fiveLines))")
        XCTAssertEqual(sevenLines, fiveLines, accuracy: 2, "the field kept growing past five lines")

        app.buttons["inbox.letter.send"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Sent to ").waitForExistence(timeout: 20), "\(statusLabels(app))")
        let state = try await stub.state()
        XCTAssertEqual(state.posts.map(\.text), [lines.joined(separator: "\n")])
        XCTAssertEqual(fieldText(field), "")
        try await stub.screenshot(app, "long-2-sent")
    }

    // MARK: - Voice

    @MainActor
    func testVoiceWithTheKeyboardUpInsertsTheTranscriptAfterTheText() async throws {
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        enter("Draft start,", app)
        XCTAssertTrue(app.keyboards.element.exists, "the keyboard should be up for this case")
        try await record(app, stub, seconds: 2.5, shot: "voice-1-recording-keyboard-up")
        let field = replyField(app)
        XCTAssertTrue(waitUntil(timeout: 20) { self.fieldText(field) == "Draft start, \(Self.transcript)" },
                      "the field reads \(fieldText(field))")
        try await stub.screenshot(app, "voice-2-transcript-inserted")
        // Editable before sending, and it is what gets sent.
        typeMore(" Thanks.", app)
        app.buttons["inbox.letter.send"].tap()
        XCTAssertTrue(statusLine(app, prefix: "Sent to ").waitForExistence(timeout: 20))
        let state = try await stub.state()
        XCTAssertEqual(state.sttCalls, 1)
        XCTAssertEqual(state.posts.map(\.text), ["Draft start, \(Self.transcript) Thanks."])
    }

    @MainActor
    func testVoiceWithTheKeyboardDownInsertsTheTranscript() async throws {
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterB)
        enter("Second", app)
        // Leave and come back: the draft is there and nothing is being edited.
        goBack(app)
        openLetter(app, Self.letterB)
        XCTAssertTrue(waitUntil(timeout: 5) { !app.keyboards.element.exists }, "the keyboard did not go down")
        XCTAssertEqual(fieldText(replyField(app)), "Second")
        try await record(app, stub, seconds: 2.5, shot: "voice-3-recording-keyboard-down")
        let field = replyField(app)
        XCTAssertTrue(waitUntil(timeout: 20) { self.fieldText(field) == "Second \(Self.transcript)" },
                      "the field reads \(fieldText(field))")
    }

    @MainActor
    func testCancellingARecordingInsertsNothing() async throws {
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        enter("Keep me", app)
        app.buttons["inbox.letter.mic"].tap()
        let cancel = app.buttons["inbox.letter.voiceCancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10), "no recording row: \(voiceError(app))")
        try await Task.sleep(for: .seconds(1.5))
        cancel.tap()
        XCTAssertTrue(replyField(app).waitForExistence(timeout: 5))
        try await Task.sleep(for: .seconds(1))
        XCTAssertEqual(fieldText(replyField(app)), "Keep me")
        let state = try await stub.state()
        XCTAssertEqual(state.sttCalls, 0, "a cancelled take was uploaded")
    }

    @MainActor
    func testATranscriptionFailureShowsTheComposersMessageAndRetryRecoversIt() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/stt?mode=unavailable")
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        enter("Before", app)
        try await record(app, stub, seconds: 2.5, shot: "voice-4-recording-before-failure")
        let error = element(app, "inbox.letter.voiceError")
        XCTAssertTrue(error.waitForExistence(timeout: 20), "no transcription failure message")
        XCTAssertEqual(error.label, "Voice unavailable: No speech engine is reachable right now. Recording saved.")
        // ONE notice: the error already says the take was saved, so there is no
        // second row saying "1 recording saved" (2026-09-29 gate, P2-2). Its
        // Retry and Discard ride on it.
        XCTAssertTrue(app.buttons["inbox.letter.voiceRetry"].waitForExistence(timeout: 5), "the take was not offered back")
        XCTAssertTrue(app.buttons["inbox.letter.voiceDiscardPending"].exists, "the take cannot be discarded")
        XCTAssertFalse(element(app, "inbox.letter.voicePendingRow").exists, "the saved take is announced twice")
        XCTAssertEqual(fieldText(replyField(app)), "Before")
        try await stub.screenshot(app, "voice-5-transcription-failed")

        try await stub.call("POST", "__stub/stt?mode=ok")
        app.buttons["inbox.letter.voiceRetry"].tap()
        XCTAssertTrue(waitUntil(timeout: 20) { self.fieldText(self.replyField(app)) == "Before \(Self.transcript)" },
                      "the retried take did not land: \(fieldText(replyField(app)))")
        XCTAssertFalse(element(app, "inbox.letter.voicePendingRow").exists)
        XCTAssertFalse(app.buttons["inbox.letter.voiceRetry"].exists, "the recovered take is still offered")
    }

    /// Gate: at the largest size a voice notice filled the screen, its Retry was
    /// a column of single letters, and the field, mic and send went under the
    /// tab bar. The notices now scroll inside a capped height, their buttons get
    /// a row of their own, and the reply box stays above the tab bar. Round 4:
    /// the notice is one short sentence with its buttons right under it, all of
    /// it in view without a swipe (it took two or three).
    @MainActor
    func testAVoiceNoticeAtTheLargestSizeKeepsTheReplyBoxAboveTheTabBar() async throws {
        let stub = try await prepared()
        try await stub.call("POST", "__stub/stt?mode=unavailable")
        let app = try launchPaired(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        openLetter(app, Self.letterA)
        try await record(app, stub, seconds: 2.5, shot: "ax-voice-1-recording")
        let error = element(app, "inbox.letter.voiceError")
        XCTAssertTrue(error.waitForExistence(timeout: 20), "no transcription failure message")
        XCTAssertTrue(app.buttons["inbox.letter.voiceRetry"].waitForExistence(timeout: 5), "the take was not offered back")
        try await Task.sleep(for: .seconds(1))
        try await stub.screenshot(app, "ax-voice-2-notice")
        // VoiceOver still reads the whole sentence; the screen shows the short one.
        XCTAssertEqual(error.label, "Voice unavailable: No speech engine is reachable right now. Recording saved.")

        let tabBar = app.tabBars.firstMatch
        let floor = tabBar.exists ? tabBar.frame.minY : app.windows.firstMatch.frame.maxY
        let parts = [
            ("field", replyField(app).frame),
            ("mic", app.buttons["inbox.letter.mic"].frame),
            ("send", app.buttons["inbox.letter.send"].frame),
        ]
        let notices = element(app, "inbox.letter.voiceNotices").frame
        diagnoseValue(app, "ax-voice-frames", "floor=\(floor) notices=\(notices) " + parts.map { "\($0.0)=\($0.1)" }.joined(separator: " "))
        for (name, frame) in parts {
            XCTAssertGreaterThan(frame.height, 0, "no \(name)")
            XCTAssertLessThanOrEqual(frame.maxY, floor + 0.5, "\(name) \(frame) is under the tab bar (\(floor))")
            XCTAssertGreaterThanOrEqual(frame.minY, notices.maxY - 0.5, "\(name) \(frame) is under the notices \(notices)")
        }
        XCTAssertLessThanOrEqual(notices.height, 301, "the notices grew to \(notices)")
        XCTAssertGreaterThan(replyField(app).frame.width, 100, "the field was squeezed")

        // The notice's sentence and its Retry, Discard and dismiss are all in
        // view as it opens: no swipe.
        let retry = app.buttons["inbox.letter.voiceRetry"]
        for (name, control) in [
            ("sentence", error), ("Retry", retry),
            ("Discard", app.buttons["inbox.letter.voiceDiscardPending"]),
            ("dismiss", app.buttons["inbox.letter.voiceErrorDismiss"]),
        ] {
            let f = control.frame
            XCTAssertGreaterThanOrEqual(f.minY, notices.minY - 0.5, "the \(name) \(f) is cut off above the notice \(notices)")
            XCTAssertLessThanOrEqual(f.maxY, notices.maxY + 0.5, "the \(name) \(f) needs a swipe: notice \(notices)")
        }
        XCTAssertLessThan(error.frame.height, 130, "the sentence is more than two lines: \(error.frame)")
        // The size the human chose: one caption line at the largest size is
        // over 40pt; capped at the second accessibility size it was 28pt.
        XCTAssertGreaterThanOrEqual(error.frame.height, 40, "the notice is smaller than the text size: \(error.frame)")
        diagnoseValue(app, "ax-voice-notice", "sentence=\(error.frame) retry=\(retry.frame)")
        XCTAssertLessThanOrEqual(retry.frame.minY - error.frame.maxY, 12, "the buttons are not right under the sentence")
        XCTAssertTrue(retry.isHittable, "the voice Retry cannot be reached")
        XCTAssertGreaterThanOrEqual(retry.frame.width, 44, "Retry is \(retry.frame)")
        XCTAssertGreaterThanOrEqual(retry.frame.height, 44, "Retry is \(retry.frame)")
        XCTAssertLessThan(retry.frame.height, 120, "Retry is a column of letters: \(retry.frame)")
        try await stub.screenshot(app, "ax-voice-3-retry-reached")
        try await stub.call("POST", "__stub/stt?mode=ok")
        retry.tap()
        XCTAssertTrue(waitUntil(timeout: 20) { self.fieldText(self.replyField(app)) == Self.transcript },
                      "the retried take did not land: \(fieldText(replyField(app)))")
    }

    @MainActor
    func testADeniedMicrophoneShowsTheComposersMessage() async throws {
        guard env("WALNUT_UITEST_MIC_DENIED") == "1" else {
            throw XCTSkip("run with the microphone permission revoked and WALNUT_UITEST_MIC_DENIED=1")
        }
        let stub = try await prepared()
        let app = try launchPaired()
        openLetter(app, Self.letterA)
        enter("Typed first", app)
        app.buttons["inbox.letter.mic"].tap()
        let error = element(app, "inbox.letter.voiceError")
        XCTAssertTrue(error.waitForExistence(timeout: 15), "no permission message")
        XCTAssertEqual(error.label, "Microphone access denied. Enable it in Settings.")
        let settings = app.buttons["inbox.letter.voiceOpenSettings"]
        XCTAssertTrue(settings.exists, "no way to Settings from the permission message")
        XCTAssertGreaterThanOrEqual(settings.frame.height, 44, "Open Settings is \(settings.frame)")
        XCTAssertGreaterThanOrEqual(app.buttons["inbox.letter.voiceErrorDismiss"].frame.width, 44, "the dismiss X is too small")
        XCTAssertFalse(app.buttons["inbox.letter.voiceStop"].exists, "a recording row opened without a microphone")
        XCTAssertEqual(fieldText(replyField(app)), "Typed first")
        try await stub.screenshot(app, "voice-6-mic-denied")
    }

    // MARK: - Appearance

    @MainActor
    func testDarkAppearanceAtTheLargestTextSize() async throws {
        guard env("WALNUT_UITEST_DARK") == "1" else {
            throw XCTSkip("run with the simulator in dark appearance and WALNUT_UITEST_DARK=1")
        }
        let stub = try await prepared()
        let app = try launchPaired(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        openLetter(app, Self.letterA)
        try await stub.call("POST", "__stub/letter-reply-mode?delivery=deferred")
        enter("A reply at the largest text size, \u{6700}\u{5927}\u{5B57}\u{53F7}.", app)
        app.buttons["inbox.letter.send"].tap()
        let status = statusLine(app, prefix: "Queued for ")
        XCTAssertTrue(status.waitForExistence(timeout: 20), "\(statusLabels(app))")
        let window = app.windows.firstMatch.frame
        XCTAssertLessThanOrEqual(status.frame.maxX, window.maxX + 0.5, "the status line runs off screen")
        XCTAssertGreaterThan(status.frame.height, 40, "the status line did not wrap at the largest size")
        // At this size Send puts the keyboard away and scrolls the line above
        // the reply box; swipe only if it did not.
        for _ in 0..<4 where status.frame.maxY > replyField(app).frame.minY - 8 {
            letterScroll(app).swipeUp()
            try await Task.sleep(for: .milliseconds(600))
        }
        try await stub.screenshot(app, "appearance-2-dark-axxxl-status")

        enter("A draft that is still being written", app)
        try await Task.sleep(for: .seconds(1))
        try await stub.screenshot(app, "appearance-1-dark-axxxl")
        let field = replyField(app).frame
        let mic = app.buttons["inbox.letter.mic"].frame
        let send = app.buttons["inbox.letter.send"].frame
        XCTAssertFalse(field.intersects(mic), "the field overlaps the mic: \(field) \(mic)")
        XCTAssertFalse(mic.intersects(send), "the mic overlaps send: \(mic) \(send)")
        XCTAssertLessThanOrEqual(send.maxX, window.maxX + 0.5, "send is clipped: \(send)")
        XCTAssertGreaterThan(field.width, 100, "the field was squeezed to \(field.width)pt")

        // Dragging the letter down puts the keyboard away, and keeps the draft.
        dismissKeyboard(app)
        let keyboardDown = waitUntil(timeout: 3) { !app.keyboards.element.exists }
        try await stub.screenshot(app, "appearance-3-dark-axxxl-dragged-down")
        XCTAssertTrue(keyboardDown, "dragging the letter down left the keyboard up")
        XCTAssertEqual(fieldText(replyField(app)), "A draft that is still being written", "the drag lost the draft")
    }

    // MARK: - Driving the app

    func env(_ name: String) -> String? { ProcessInfo.processInfo.environment[name] }

    /// Launch against the stub. Saved drafts and refused replies are wiped
    /// first (every test reuses the same letter ids) unless `keepSaved`, which
    /// is how a relaunch test sees what the first launch saved.
    @MainActor
    func launchPaired(_ extra: [String] = [], keepSaved: Bool = false) throws -> XCUIApplication {
        let (server, token) = try pairing()
        let reset = keepSaved ? [] : ["-walnut.resetLetterReplies", "YES"]
        return UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token] + reset + extra)
    }

    private func pairing() throws -> (server: String, token: String) {
        guard let server = env("WALNUT_UITEST_SERVER"), let token = env("WALNUT_UITEST_TOKEN"),
              !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip("no pairing reached the test runner: point WALNUT_UITEST_SERVER at a running "
                + "ios-native/tests/ui/mid-turn-stub-server.mjs (see run-ui-tests.sh)")
        }
        return (server, token)
    }

    /// Reset the stub, give it the work session, seed the three letters.
    func prepared() async throws -> LetterStub {
        let (server, _) = try pairing()
        guard let base = URL(string: server) else { throw XCTSkip("unusable server URL \(server)") }
        let stub = LetterStub(base: base)
        do {
            try await stub.call("GET", "__stub/state")
        } catch {
            throw XCTSkip("\(server) is not the UI stub: \(error). This test never runs against a real Walnut.")
        }
        try await stub.call("POST", "__stub/reset")
        try await stub.call("POST", "__stub/work-session?on=1")
        try await stub.call("POST", "__stub/letter-reply")
        return stub
    }

    @MainActor
    func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    /// The letter's own scroll view. Not `scrollViews.firstMatch`: with the
    /// keyboard up that can be the keyboard's suggestion bar (a swipe there
    /// picks suggestions and types them into the field) or the reply field.
    @MainActor
    func letterScroll(_ app: XCUIApplication) -> XCUIElement {
        app.scrollViews.containing(.any, identifier: "inbox.letter.subject").firstMatch
    }

    @MainActor
    func replyField(_ app: XCUIApplication) -> XCUIElement {
        element(app, "inbox.letter.replyField")
    }

    @MainActor
    func openLetter(_ app: XCUIApplication, _ id: String) {
        let tab = app.tabBars.buttons["Inbox"]
        XCTAssertTrue(tab.waitForExistence(timeout: 60), "the tab bar never appeared")
        if !tab.isSelected { tab.tap() }
        let all = element(app, "inbox.filter.all")
        if all.waitForExistence(timeout: 20), !all.isSelected { all.tap() }
        let row = element(app, "inbox.row.\(id)")
        if !row.waitForExistence(timeout: 30) {
            // The list lands a moment after the tab; one pull brings the seeded rows.
            app.swipeDown()
        }
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no row for \(id)")
        row.tap()
        XCTAssertTrue(replyField(app).waitForExistence(timeout: 20), "the reply box never appeared")
    }

    @MainActor
    func goBack(_ app: XCUIApplication) {
        dismissKeyboard(app)
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 10))
        back.tap()
        XCTAssertTrue(element(app, "inbox.filterBar").waitForExistence(timeout: 15), "not back on the inbox")
    }

    /// Put the caret in the field. A field that is already being edited is left
    /// alone (a tap would move the caret into the middle of the text); otherwise
    /// the tap lands at the bottom right, so the caret goes to the end.
    @MainActor
    private func focus(_ field: XCUIElement, _ app: XCUIApplication) {
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        if app.keyboards.element.exists, (field.value(forKey: "hasKeyboardFocus") as? Bool) == true { return }
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.85)).tap()
        if !app.keyboards.element.waitForExistence(timeout: 10) {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.85)).tap()
            XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 10), "the keyboard never came up")
        }
    }

    /// Type into the (empty or not) reply field, pasting when `typeText` cannot
    /// carry the characters (it can drop CJK on the English keyboard).
    @MainActor
    func enter(_ text: String, _ app: XCUIApplication) {
        let field = replyField(app)
        focus(field, app)
        let before = fieldText(field)
        field.typeText(text)
        if fieldText(field) == before + text { return }
        // Undo whatever partial text landed, then paste the whole thing.
        let landed = fieldText(field).count - before.count
        if landed > 0 { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: landed)) }
        UIPasteboard.general.string = text
        field.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"].firstMatch
        if paste.waitForExistence(timeout: 5) { paste.tap() }
        XCTAssertTrue(waitUntil(timeout: 5) { self.fieldText(field) == before + text },
                      "the field reads \"\(fieldText(field))\", not \"\(before + text)\"")
    }

    @MainActor
    private func typeMore(_ text: String, _ app: XCUIApplication) {
        let field = replyField(app)
        focus(field, app)
        let before = fieldText(field)
        field.typeText(text)
        if fieldText(field) == before + text { return }
        let landed = fieldText(field).count - before.count
        if landed > 0 { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: landed)) }
        UIPasteboard.general.string = text
        field.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"].firstMatch
        if paste.waitForExistence(timeout: 5) { paste.tap() }
        XCTAssertTrue(waitUntil(timeout: 5) { self.fieldText(field) == before + text },
                      "the field reads \"\(fieldText(field))\"")
    }

    /// Tap letters on the on-screen keyboard one by one, so an IME sees real keys.
    @MainActor
    private func tapKeys(_ letters: String, _ app: XCUIApplication) {
        for ch in letters {
            let key = app.keyboards.keys[String(ch)]
            if key.waitForExistence(timeout: 3) {
                key.tap()
            } else {
                let upper = app.keyboards.keys[String(ch).uppercased()]
                if upper.exists { upper.tap() } else { replyField(app).typeText(String(ch)) }
            }
            usleep(150_000)
        }
    }

    /// Tap the Pinyin candidate `word`, committing it. The candidate bar is part of
    /// the keyboard on some iOS versions and a sibling of it on others; look in
    /// both, never at the field itself. False when no such candidate showed.
    @MainActor
    private func commitCandidate(_ word: String, _ app: XCUIApplication) -> Bool {
        let isCandidate = NSPredicate(format: "label == %@ AND identifier != %@", word, "inbox.letter.replyField")
        var candidate = app.keyboards.descendants(matching: .any).matching(isCandidate).firstMatch
        if !candidate.waitForExistence(timeout: 4) {
            candidate = app.descendants(matching: .any).matching(isCandidate).firstMatch
        }
        guard candidate.waitForExistence(timeout: 2), candidate.isHittable else { return false }
        candidate.tap()
        return true
    }

    @MainActor
    private func dismissKeyboard(_ app: XCUIApplication) {
        guard app.keyboards.element.exists else { return }
        // A tap on the letter's subject: outside the field, and not a control.
        // Drag the letter down, from just above the reply box to the bottom of the
        // screen, as a finger does: the reader dismisses the keyboard interactively.
        let window = app.windows.firstMatch
        let fieldTop = replyField(app).frame.minY
        let origin = window.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: window.frame.midX, dy: max(120, fieldTop - 40)))
        let end = origin.withOffset(CGVector(dx: window.frame.midX, dy: window.frame.maxY - 8))
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
        _ = waitUntil(timeout: 3) { !app.keyboards.element.exists }
    }

    /// Tap the mic, record, stop.
    @MainActor
    func record(_ app: XCUIApplication, _ stub: LetterStub, seconds: Double, shot: String) async throws {
        let mic = app.buttons["inbox.letter.mic"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "no mic in the reply box")
        mic.tap()
        let stop = app.buttons["inbox.letter.voiceStop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 15), "no recording row: \(voiceError(app))")
        XCTAssertTrue(app.buttons["inbox.letter.voiceCancel"].exists, "no cancel on the recording row")
        XCTAssertTrue(element(app, "inbox.letter.voiceRecordingCaption").exists)
        try await Task.sleep(for: .seconds(seconds))
        try await stub.screenshot(app, shot)
        stop.tap()
    }

    @MainActor
    private func voiceError(_ app: XCUIApplication) -> String {
        let error = element(app, "inbox.letter.voiceError")
        return error.exists ? error.label : "(no voice error shown)"
    }

    /// The field's text, "" for an empty one (whatever the placeholder says).
    @MainActor
    func fieldText(_ field: XCUIElement) -> String {
        let value = (field.value as? String) ?? ""
        return value == Self.placeholder ? "" : value
    }

    @MainActor
    func statusLine(_ app: XCUIApplication, prefix: String) -> XCUIElement {
        app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "inbox.letter.replyStatus", prefix)
        ).firstMatch
    }

    /// Every status line on screen, top to bottom.
    @MainActor
    func statusLabels(_ app: XCUIApplication) -> [String] {
        let all = app.descendants(matching: .any)
            .matching(identifier: "inbox.letter.replyStatus").allElementsBoundByIndex
        var seen = Set<String>()
        return all.sorted { $0.frame.minY < $1.frame.minY }
            .compactMap { element -> String? in
                let key = "\(element.label)@\(Int(element.frame.minY))"
                guard !element.label.isEmpty, seen.insert(key).inserted else { return nil }
                return element.label
            }
    }

    @MainActor
    func humanTurn(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier == %@ AND label == %@", "inbox.letter.humanTurn", text)
        ).firstMatch
    }

    @MainActor
    func humanTurns(_ app: XCUIApplication, _ text: String) -> Int {
        app.descendants(matching: .any).matching(
            NSPredicate(format: "(identifier == %@ OR identifier == %@) AND label == %@",
                        "inbox.letter.humanTurn", "inbox.letter.pendingReply", text)
        ).count
    }

    /// Whitespace and pinyin syllable marks are not part of what was said.
    private static func squash(_ s: String) -> String {
        s.filter { !$0.isWhitespace && $0 != "'" && $0 != "\u{2019}" }
    }

    @MainActor
    func diagnoseValue(_ app: XCUIApplication, _ name: String, _ text: String) {
        let attachment = XCTAttachment(string: text + "\n\n" + app.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        XCTContext.runActivity(named: name) { $0.add(attachment) }
        guard let base = env("WALNUT_UITEST_SERVER"), let url = URL(string: base + "/__stub/diag?name=" + name) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data((text + "\n\n" + app.debugDescription).utf8)
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 10)
    }

    func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return condition()
    }

    // MARK: - The stub

    struct LetterStub: Sendable {
        let base: URL

        struct State: Decodable {
            struct Post: Decodable {
                let clientId: String?
                let text: String
                let outcome: String
                /// Set when a delayed (`delayMs`) answer went out.
                let answeredAt: String?
            }
            struct Delivery: Decodable { let status: String }
            struct Turn: Decodable { let from: String; let text: String?; let delivery: Delivery? }
            struct LetterThread: Decodable { let id: String; let thread: [Turn] }
            let posts: [Post]
            let sttCalls: Int
            let letters: [LetterThread]

            func humanTurns(_ id: String) -> [Turn] {
                (letters.first { $0.id == id }?.thread ?? []).filter { $0.from == "human" }
            }
        }

        @discardableResult
        func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
            let root = base.absoluteString.hasSuffix("/") ? base.absoluteString : base.absoluteString + "/"
            guard let url = URL(string: root + path) else {
                throw NSError(domain: "stub", code: -1, userInfo: [NSLocalizedDescriptionKey: "bad URL \(path)"])
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.timeoutInterval = 20
            if let body {
                request.httpBody = body
                request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else {
                throw NSError(domain: "stub", code: code, userInfo: [NSLocalizedDescriptionKey: "\(method) \(path) answered \(code)"])
            }
            return data
        }

        func state() async throws -> State {
            try JSONDecoder().decode(State.self, from: try await call("GET", "__stub/letter-reply-state"))
        }

        @MainActor
        func screenshot(_ app: XCUIApplication, _ name: String) async throws {
            let shot = app.screenshot()
            let attachment = XCTAttachment(screenshot: shot)
            attachment.name = name
            attachment.lifetime = .keepAlways
            XCTContext.runActivity(named: "screenshot \(name)") { $0.add(attachment) }
            try await call("POST", "__stub/screenshot?name=\(name)", body: shot.pngRepresentation)
        }
    }
}
