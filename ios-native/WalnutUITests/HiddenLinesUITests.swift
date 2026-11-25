import XCTest

/// What Walnut hid from a reply, for a developer (`ui.show_hidden_lines`): one closed "Hidden by
/// Walnut" row under the words, open on a tap to the lines as the session wrote them, closed again
/// on a second tap. Harness fixture `TimelineHiddenLinesFixtures` (`--timeline-harness-hidden-lines`,
/// switch on): no server, no pairing.
final class HiddenLinesUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    @MainActor
    func testTheFoldOpensToTheHiddenLinesAndCloses() throws {
        let app = UITestLaunch.launch(["--timeline-harness-hidden-lines"])
        let reply = app.textViews.matching(NSPredicate(format: "value CONTAINS 'production serves it'")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "the reply never showed")
        let fold = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Hidden by Walnut'")).firstMatch
        XCTAssertTrue(fold.waitForExistence(timeout: 10), "no Hidden by Walnut row under the reply")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Hidden by Walnut'")).count, 1,
                       "a reply with nothing hidden has no row")
        let lines = app.textViews.matching(NSPredicate(format: "label CONTAINS 'th-5eb5fa81b1fd' OR value CONTAINS 'th-5eb5fa81b1fd'")).firstMatch
        XCTAssertFalse(lines.exists, "closed until tapped")
        attach("1-closed")
        fold.tap()
        XCTAssertTrue(lines.waitForExistence(timeout: 10), "the hidden lines never showed")
        // The status line the screen took out of the text is in the fold, not in the reply.
        let status = app.textViews.matching(NSPredicate(format: "label CONTAINS 'FOR_USER_STATE: answered' OR value CONTAINS 'FOR_USER_STATE: answered'"))
        // The fold's text view and its line element both carry it; the reply's text does not.
        XCTAssertTrue(status.firstMatch.exists, "the status line shows in the fold")
        XCTAssertFalse((reply.value as? String ?? "").contains("FOR_USER_STATE"), "the reply's own text never shows it")
        attach("2-open")
        fold.tap()
        XCTAssertTrue(waitGone(lines), "the lines stayed after a second tap")
        attach("3-closed-again")
    }

    private func waitGone(_ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if !element.exists { return true }; Thread.sleep(forTimeInterval: 0.2) }
        return !element.exists
    }

    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
