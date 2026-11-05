import XCTest

/// Chat code blocks on the timeline (TimelineCodeCell): a language label, Wrap
/// and Copy in a header over colored code, a streaming block framed as it grows.
/// Harness fixture `TimelineCodeFixtures` (`--timeline-harness-code-stream`): no
/// server, no pairing.
final class CodeBlockUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    @MainActor
    func testCopyAndWrap() throws {
        let app = UITestLaunch.launch(["--timeline-harness-code"])
        XCTAssertTrue(app.staticTexts["Go"].waitForExistence(timeout: 30), "the Go block's label never showed")
        XCTAssertTrue(app.staticTexts["Shell"].exists)
        XCTAssertTrue(app.staticTexts["Text"].exists, "a block with no language is labeled Text")
        attach("1-blocks")

        let copy = app.buttons.matching(identifier: "timeline.code.copy").firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 10) && copy.isHittable)
        copy.tap()
        XCTAssertTrue(waitFor(copy, label: "Copied"), "Copy never said Copied: \(copy.label)")
        attach("2-copied")
        XCTAssertTrue(waitFor(copy, label: "Copy code"), "Copy did not come back: \(copy.label)")

        let wraps = app.buttons.matching(identifier: "timeline.code.wrap")
        let wrap = wraps.element(boundBy: 0)
        XCTAssertEqual(wrap.label, "Wrap long lines")
        wrap.tap()
        XCTAssertTrue(waitFor(wrap, label: "Stop wrapping long lines"), wrap.label)
        // Only that block: the next one keeps its own state.
        XCTAssertEqual(wraps.element(boundBy: 1).label, "Wrap long lines")
        attach("3-wrapped")
        wrap.tap()
        XCTAssertTrue(waitFor(wrap, label: "Wrap long lines"), wrap.label)
        attach("4-unwrapped")
    }

    /// A long block streaming in: framed and labeled as it grows, its header
    /// (Copy) on screen while the reader is in its middle.
    @MainActor
    func testAStreamingBlockKeepsItsHeaderInView() throws {
        let app = UITestLaunch.launch(["--timeline-harness-code-stream"])
        let done = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "All 120 workers written", "All 120 workers written")).firstMatch
        XCTAssertTrue(app.staticTexts["TypeScript"].waitForExistence(timeout: 30), "the streaming block's label never showed")
        attach("1-streaming")
        XCTAssertTrue(done.waitForExistence(timeout: 60), "the stream never finished")
        // Scroll into the block's middle: its Copy is still on screen and works.
        app.collectionViews.firstMatch.swipeDown(velocity: .slow)
        Thread.sleep(forTimeInterval: 1)
        let copies = app.buttons.matching(identifier: "timeline.code.copy")
        let visible = copies.allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(visible, "no code block's Copy is on screen mid-block")
        XCTAssertTrue(app.staticTexts["TypeScript"].isHittable, "the long block's header is not the one on screen")
        attach("2-mid-block")
        visible?.tap()
        if let visible { XCTAssertTrue(waitFor(visible, label: "Copied"), visible.label) }
        attach("3-copied-mid-block")
    }

    private func waitFor(_ element: XCUIElement, label: String, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists && element.label == label { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }

    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
