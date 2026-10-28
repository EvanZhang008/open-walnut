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

    @MainActor
    func testTheQuizComesBackWhereItWasAndItsResultIsSentOnlyByThePress() throws {
        var app = UITestLaunch.launch(["--timeline-harness-island-fresh"])
        try expectText(app, "Question 1 of 3")
        try tapAnswer(app, "Answer 4")
        try expectText(app, "Question 2 of 3")
        // The page's write is coalesced (~120ms) and the store's persist debounced
        // (~500ms); a terminate is not a background, so give both time to land.
        Thread.sleep(forTimeInterval: 2)
        attach(app, "1-question-2-before-relaunch")

        UITestLaunch.terminate()
        app = UITestLaunch.launch(["--timeline-harness-island"])
        try expectText(app, "Question 2 of 3")
        attach(app, "2-question-2-after-relaunch")
        XCTAssertFalse(app.buttons["chat.islandResult.review"].exists,
                       "no result is offered before the quiz is done")

        try tapAnswer(app, "Answer Paris")
        try tapAnswer(app, "Answer Jupiter")
        try expectText(app, "Quiz done: 3 of 3 right")
        let review = app.buttons["chat.islandResult.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 10), "the result strip never appeared")
        let sent = app.staticTexts["harness.islandSent"]
        XCTAssertEqual(sent.label, "Sent 0", "nothing may be sent before the user presses Send")
        attach(app, "3-result-strip")

        review.tap()
        let text = app.staticTexts["islandResult.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 10), "the review sheet never opened")
        XCTAssertTrue(text.label.contains("Quiz result: 3/3 right."), text.label)
        attach(app, "4-review-sheet")
        let send = app.buttons["islandResult.send"]
        XCTAssertTrue(send.isEnabled)
        let shown = text.label
        send.tap()

        XCTAssertTrue(waitFor(sent, label: "Sent 1"), "the page was never handed the text: \(sent.label)")
        XCTAssertEqual(sent.value as? String, shown, "what was sent is not what the sheet showed")
        let after = app.buttons["chat.islandResult.review"]
        XCTAssertTrue(after.waitForExistence(timeout: 10))
        XCTAssertTrue(waitFor(after, label: "Review"), "the strip did not turn to sent: \(after.label)")
        attach(app, "5-sent")

        // A relaunch keeps the sent mark: the page reports the same text again on load,
        // and the user is not asked to send it twice.
        UITestLaunch.terminate()
        app = UITestLaunch.launch(["--timeline-harness-island"])
        try expectText(app, "Quiz done: 3 of 3 right")
        let relaunched = app.buttons["chat.islandResult.review"]
        XCTAssertTrue(relaunched.waitForExistence(timeout: 10))
        XCTAssertTrue(waitFor(relaunched, label: "Review"), relaunched.label)
        attach(app, "6-sent-after-relaunch")
    }

    // MARK: - Helpers

    private struct Missing: Error { let text: String }

    private func expectText(_ app: XCUIApplication, _ text: String,
                            file: StaticString = #filePath, line: UInt = #line) throws {
        let match = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        guard match.waitForExistence(timeout: 30) else {
            attach(app, "missing-\(text)")
            XCTFail("never saw \"\(text)\" in the island", file: file, line: line)
            throw Missing(text: text)
        }
    }

    private func tapAnswer(_ app: XCUIApplication, _ label: String) throws {
        let button = app.webViews.buttons[label]
        XCTAssertTrue(button.waitForExistence(timeout: 15), "no \(label) button in the island")
        button.tap()
    }

    private func waitFor(_ element: XCUIElement, label: String, timeout: TimeInterval = 10) -> Bool {
        let predicate = NSPredicate(format: "label == %@", label)
        let wait = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [wait], timeout: timeout) == .completed
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
