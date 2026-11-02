import XCTest

/// An html-app island keeps its place across a relaunch and hands its result back
/// only when the user presses Send (`IslandRuntime`, `IslandStateStore`).
///
/// The 2026-10-27 report: halfway through a 15-question quiz island the reader was
/// back on question 1. The harness fixture (`TimelineRichFixtures.islandQuiz`) is a
/// three-question quiz that saves its step in `localStorage` and calls
/// `walnut.report` at the end; the harness records what the page was handed
/// ("Sent N") instead of sending it anywhere. No server, no pairing.
final class IslandStateUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    /// The app under test. A step may relaunch it (`readIsland`), so the test reads it
    /// from here rather than holding its own.
    private var app: XCUIApplication!

    @MainActor
    func testTheQuizComesBackWhereItWasAndItsResultIsSentOnlyByThePress() throws {
        app = UITestLaunch.launch(["--timeline-harness-island-fresh"])
        try expectText("Question 1 of 3")
        try answer("Answer 4", then: "Question 2 of 3")
        // The page's write is coalesced (~120ms) and the store's persist debounced
        // (~500ms); a terminate is not a background, so give both time to land.
        Thread.sleep(forTimeInterval: 2)
        attach("1-question-2-before-relaunch")

        relaunch()
        try expectText("Question 2 of 3")
        attach("2-question-2-after-relaunch")
        XCTAssertFalse(app.buttons["chat.islandResult.review"].exists,
                       "no result is offered before the quiz is done")

        try answer("Answer Paris", then: "Question 3 of 3")
        try answer("Answer Jupiter", then: "Quiz done: 3 of 3 right")
        let review = app.buttons["chat.islandResult.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 10), "the result strip never appeared")
        let sent = app.staticTexts["harness.islandSent"]
        XCTAssertEqual(sent.label, "Sent 0", "nothing may be sent before the user presses Send")
        attach("3-result-strip")

        review.tap()
        let text = app.staticTexts["islandResult.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 10), "the review sheet never opened")
        XCTAssertTrue(text.label.contains("Quiz result: 3/3 right."), text.label)
        attach("4-review-sheet")
        let send = app.buttons["islandResult.send"]
        XCTAssertTrue(send.isEnabled)
        let shown = text.label
        send.tap()

        XCTAssertTrue(waitFor(sent, label: "Sent 1"), "the page was never handed the text: \(sent.label)")
        XCTAssertEqual(sent.value as? String, shown, "what was sent is not what the sheet showed")
        let after = app.buttons["chat.islandResult.review"]
        XCTAssertTrue(after.waitForExistence(timeout: 10))
        XCTAssertTrue(waitFor(after, label: "Review"), "the strip did not turn to sent: \(after.label)")
        attach("5-sent")

        // A relaunch keeps the sent mark: the page reports the same text again on load,
        // and the user is not asked to send it twice.
        relaunch()
        try expectText("Quiz done: 3 of 3 right")
        let relaunched = app.buttons["chat.islandResult.review"]
        XCTAssertTrue(relaunched.waitForExistence(timeout: 10))
        XCTAssertTrue(waitFor(relaunched, label: "Review"), relaunched.label)
        attach("6-sent-after-relaunch")
    }

    // MARK: - Helpers

    private struct Missing: Error { let text: String }

    /// Open the quiz again with whatever it saved.
    @MainActor
    private func relaunch() {
        UITestLaunch.terminate()
        app = UITestLaunch.launch(["--timeline-harness-island"])
    }

    /// A web view that lists none of its page (`IslandTap`, case 2) is read again after
    /// a relaunch, once. The page then comes back from what it saved: a relaunch is what
    /// this test is about, so it proves the same thing. Recorded with a screenshot.
    @MainActor
    private func relaunchUnreadable(_ waitingFor: String) {
        attach("unreadable-\(waitingFor)")
        // Let the page's last write and the store's debounced persist land first.
        Thread.sleep(forTimeInterval: 2)
        relaunch()
    }

    @MainActor
    private func expectText(_ text: String, file: StaticString = #filePath, line: UInt = #line) throws {
        var outcome = IslandTap.read(text, in: app, timeout: 30)
        if outcome == .unreadable {
            relaunchUnreadable(text)
            outcome = IslandTap.read(text, in: app, timeout: 30)
        }
        guard outcome == .shown else {
            attach("missing-\(text)")
            XCTFail("never saw \"\(text)\" in the island", file: file, line: line)
            throw Missing(text: text)
        }
    }

    /// Pick an answer and wait for the step it leads to (`IslandTap`: a tap the page did
    /// not take is tapped again, never one it took).
    @MainActor
    private func answer(_ label: String, then next: String,
                        file: StaticString = #filePath, line: UInt = #line) throws {
        var outcome = IslandTap.press(label, in: app, until: next, test: self)
        if outcome == .unreadable {
            relaunchUnreadable(next)
            // A page that took the tap comes back on `next`; one that did not, on the
            // step with `label`, which is pressed again.
            outcome = IslandTap.read(next, in: app, timeout: IslandTap.settle)
            if outcome != .shown { outcome = IslandTap.press(label, in: app, until: next, test: self) }
        }
        guard outcome == .shown else {
            attach("missing-\(next)")
            XCTFail("never saw \"\(next)\" in the island after \(label)", file: file, line: line)
            throw Missing(text: next)
        }
    }

    private func waitFor(_ element: XCUIElement, label: String, timeout: TimeInterval = 10) -> Bool {
        let predicate = NSPredicate(format: "label == %@", label)
        let wait = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [wait], timeout: timeout) == .completed
    }

    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
