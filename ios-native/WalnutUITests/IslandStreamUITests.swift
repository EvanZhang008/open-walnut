import XCTest

/// An html-app island draws its layout while it streams, runs no script until it is
/// complete, and becomes the running island in place (`.islandPreview` in
/// `TimelineRichHTMLCell`, `RichHTMLDocument.islandPreviewBody`).
///
/// 2026-10-29, the user: an interactive block sat as an empty "Building interactive
/// block…" label for the whole stream. The harness streams
/// `TimelineRichFixtures.islandStreamChunks` (layout first, then the script, with a
/// 3 s pause in the middle of it), keeps the finished reply live for 4 s and then
/// ends the turn, so the saved message replaces the live one. No server, no pairing.
final class IslandStreamUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    @MainActor
    func testAnIslandDrawsWhileItStreamsAndRunsItsScriptOnlyOnceComplete() throws {
        let app = UITestLaunch.launch(["--timeline-harness-island-stream"])
        let start = app.buttons["harness.islandStream"]
        XCTAssertTrue(start.waitForExistence(timeout: 30))
        start.tap()

        // The layout is drawn while the block is still arriving.
        try expectText(app, "Week planner LIVE")
        try expectText(app, "Script has not run")
        let island = app.webViews.firstMatch
        attach(app, "1-layout-while-streaming")

        // Inside the 3 s pause the script is half written: nothing of it has run.
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertFalse(text(app, "Script ran").exists, "a script ran before the block was complete")
        try expectText(app, "Script has not run")
        let streamingHeight = island.frame.height
        XCTAssertGreaterThan(streamingHeight, 60, "the preview should be drawn at its content height")
        attach(app, "2-script-half-written")

        // The fence closes: the script runs, in place, at the same height.
        try expectText(app, "Script ran, ticks 0")
        XCTAssertFalse(text(app, "Script has not run").exists)
        XCTAssertEqual(app.webViews.firstMatch.frame.height, streamingHeight, accuracy: 3,
                       "the block changed height when the island took over")
        // The markdown under the island (a native text row, not in a web view).
        let after = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Tap the button when Tuesday")).firstMatch
        XCTAssertTrue(after.waitForExistence(timeout: 10))
        let liveRow = row(app).frame
        let liveAfterY = after.frame.minY
        attach(app, "3-running")

        // The turn ends and the saved reply takes the live one's place: the same
        // block at the same height, the text under it where it was, and the
        // island still keeps state and reports.
        Thread.sleep(forTimeInterval: 6)
        try expectText(app, "Script ran, ticks 0")
        XCTAssertEqual(app.webViews.firstMatch.frame.height, streamingHeight, accuracy: 3,
                       "the saved reply's island opened at another height")
        XCTAssertEqual(row(app).frame.height, liveRow.height, accuracy: 3,
                       "the saved reply's island row has another height")
        XCTAssertEqual(after.frame.minY - row(app).frame.minY, liveAfterY - liveRow.minY, accuracy: 3,
                       "the text under the island moved when the turn ended")
        let done = app.webViews.buttons["Mark Tuesday done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        done.tap()
        try expectText(app, "Script ran, ticks 1")
        let review = app.buttons["chat.islandResult.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 10), "the result strip never appeared")
        attach(app, "4-saved-reply-reports")
    }

    /// At the largest text size the saved reply's island still holds all of its
    /// content (it used to be cut down to its heading at the turn end).
    @MainActor
    func testAtTheLargestTextTheSavedIslandStillShowsAllOfIt() throws {
        let app = UITestLaunch.launch(["--timeline-harness-island-stream",
                                       "-UIPreferredContentSizeCategoryName",
                                       "UICTContentSizeCategoryAccessibilityXXXL"])
        let start = app.buttons["harness.islandStream"]
        XCTAssertTrue(start.waitForExistence(timeout: 30))
        start.tap()
        try expectText(app, "Script ran, ticks 0")
        Thread.sleep(forTimeInterval: 6)
        attach(app, "ax3-saved")
        let island = row(app)
        let webView = app.webViews.firstMatch
        XCTAssertLessThanOrEqual(webView.frame.maxY, island.frame.maxY + 1,
                                 "the island's document runs past its row")
        let done = app.webViews.buttons["Mark Tuesday done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        XCTAssertTrue(done.isHittable, "the island's button was cut off")
        XCTAssertLessThanOrEqual(done.frame.maxY, island.frame.maxY, "the button lies outside the island's row")
    }

    // MARK: - Helpers

    private func row(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "chat.richIsland").firstMatch
    }

    private struct Missing: Error { let text: String }

    private func text(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func expectText(_ app: XCUIApplication, _ value: String,
                            file: StaticString = #filePath, line: UInt = #line) throws {
        guard text(app, value).waitForExistence(timeout: 30) else {
            attach(app, "missing-\(value)")
            XCTFail("never saw \"\(value)\" in the island", file: file, line: line)
            throw Missing(text: value)
        }
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
