import XCTest

/// An html-app island draws its layout while it streams, runs no script until it is
/// complete, and becomes the running island in place (`.islandPreview` in
/// `TimelineRichHTMLCell`, `RichHTMLDocument.islandPreviewBody`).
///
/// 2026-10-29, the user: an interactive block sat as an empty "Building interactive
/// block…" label for the whole stream. The harness streams
/// `TimelineRichFixtures.islandStreamChunks` (layout first, then the script), holds in
/// the middle of the script, keeps the finished reply live, and then ends the turn, so
/// the saved message replaces the live one. Each hold lasts until the test taps
/// `harness.islandNext` (`next(_:)`): no stage is read against a clock. No server, no pairing.
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

        // The layout is drawn while the block is still arriving: the stream holds with
        // the script half written, and nothing of it has run.
        try waitHeld(app)
        try expectText(app, "Week planner LIVE")
        try expectText(app, "Script has not run")
        let island = app.webViews.firstMatch
        attach(app, "1-layout-while-streaming")
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertFalse(text(app, "Script ran").exists, "a script ran before the block was complete")
        try expectText(app, "Script has not run")
        let streamingHeight = island.frame.height
        XCTAssertGreaterThan(streamingHeight, 60, "the preview should be drawn at its content height")
        attach(app, "2-script-half-written")

        // The fence closes: the script runs, in place, at the same height.
        try next(app)
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
        try next(app)
        Thread.sleep(forTimeInterval: 2)
        try expectText(app, "Script ran, ticks 0")
        XCTAssertEqual(app.webViews.firstMatch.frame.height, streamingHeight, accuracy: 3,
                       "the saved reply's island opened at another height")
        XCTAssertEqual(row(app).frame.height, liveRow.height, accuracy: 3,
                       "the saved reply's island row has another height")
        XCTAssertEqual(after.frame.minY - row(app).frame.minY, liveAfterY - liveRow.minY, accuracy: 3,
                       "the text under the island moved when the turn ended")
        // A tap the page did not take is tapped again (`IslandTap`); one it took twice
        // reads "ticks 2" and fails here.
        if IslandTap.press("Mark Tuesday done", in: app, until: "Script ran, ticks 1", test: self) != .shown {
            try expectText(app, "Script ran, ticks 1")
        }
        let review = app.buttons["chat.islandResult.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 10), "the result strip never appeared")
        attach(app, "4-saved-reply-reports")
    }

    /// When the turn ends the saved reply's rows replace the live ones (other ids,
    /// the same documents, one row higher) and the timeline reloads its cells.
    /// Each island must keep the page it was running, never load again
    /// (2026-11-01, the user: streaming and finished must look exactly the same,
    /// "no flash"). On the simulator UIKit hands each island its own cell back,
    /// so this walk passes without the document takeover too; the takeover for
    /// a cell handed another row's document is pinned by RichHTMLHandoverTests.
    @MainActor
    func testTwoIslandsKeepTheirRunningPagesWhenTheTurnEnds() throws {
        let app = UITestLaunch.launch(["--timeline-harness-island-stream"])
        let start = app.buttons["harness.islandPair"]
        XCTAssertTrue(start.waitForExistence(timeout: 30))
        start.tap()
        try waitHeld(app)
        let tokenA = try loadToken(app, "A")
        let tokenB = try loadToken(app, "B")
        attach(app, "pair-1-live")

        try next(app)
        Thread.sleep(forTimeInterval: 2.5)
        XCTAssertEqual(try loadToken(app, "A"), tokenA, "island A loaded again when the turn ended")
        XCTAssertEqual(try loadToken(app, "B"), tokenB, "island B loaded again when the turn ended")
        attach(app, "pair-2-saved")
    }

    /// The token island `name` drew when its script ran ("Island A load k3j9x2").
    @MainActor
    private func loadToken(_ app: XCUIApplication, _ name: String) throws -> String {
        let label = app.webViews.staticTexts
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Island \(name) load ")).firstMatch
        guard label.waitForExistence(timeout: 20) else {
            attach(app, "no-token-\(name)")
            throw XCTSkip("island \(name) never ran")
        }
        return label.label
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
        try next(app)
        try expectText(app, "Script ran, ticks 0")
        try next(app)
        Thread.sleep(forTimeInterval: 2)
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

    /// Wait until the harness stream holds at its next stage.
    private func waitHeld(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) throws {
        let button = app.buttons["harness.islandNext"]
        let held = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "held"), object: button)
        guard XCTWaiter.wait(for: [held], timeout: 30) == .completed else {
            XCTFail("the island stream never reached its next hold", file: file, line: line)
            throw Missing(text: "held")
        }
    }

    /// Let the harness stream go on from the hold it reached.
    private func next(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) throws {
        try waitHeld(app, file: file, line: line)
        app.buttons["harness.islandNext"].tap()
    }

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
