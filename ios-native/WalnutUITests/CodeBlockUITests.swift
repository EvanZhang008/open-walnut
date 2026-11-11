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

    /// At the largest text size a line of code still holds a phone's worth of characters
    /// (code stops growing at `CodeHighlighter.largestType`; it used to follow the text
    /// size to a dozen characters a line), and Wrap brings every line inside the screen.
    @MainActor
    func testCodeStaysReadableAtTheLargestTextSize() throws {
        let app = UITestLaunch.launch(["--timeline-harness-code",
                                       "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let window = app.windows.firstMatch.frame
        let json = app.textViews.matching(NSPredicate(format: "identifier == 'timeline.code' AND value BEGINSWITH %@", "{ \"region\"")).firstMatch
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 30), "the harness timeline never showed")
        // Its start on screen (unwrapped, the line runs on past the right edge).
        func onScreen() -> Bool {
            json.exists && window.insetBy(dx: 0, dy: 120).contains(CGPoint(x: json.frame.minX + 4, y: json.frame.midY))
        }
        for _ in 0..<10 where !onScreen() {
            list.swipeDown(velocity: .slow)
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(onScreen(), "the JSON block never came on screen")
        attach("ax5-1-unwrapped")
        // One line, unwrapped: its text view is as wide as the line.
        let characters = CGFloat(("{ \"region\": \"us-west-2\", \"healthy\": 112, \"drained\": 3, \"ok\": true }").count)
        let perLine = window.width / (json.frame.width / characters)
        XCTAssertGreaterThanOrEqual(perLine, 24, "a screen's width holds only \(Int(perLine)) characters of code at the largest text size")

        // Wrap that block: every line inside the screen.
        let card = json.frame
        let wrap = app.buttons.matching(identifier: "timeline.code.wrap").allElementsBoundByIndex
            .filter { $0.isHittable && $0.frame.maxY <= card.minY + 1 }
            .max { $0.frame.maxY < $1.frame.maxY }
        try XCTUnwrap(wrap, "the JSON block has no Wrap on screen").tap()
        // Found again by its state: the rows move as the block grows, and an element
        // bound by its index would then name another block's Wrap.
        let unwrap = app.buttons.matching(NSPredicate(format: "identifier == 'timeline.code.wrap' AND label == %@",
                                                      "Stop wrapping long lines")).firstMatch
        XCTAssertTrue(unwrap.waitForExistence(timeout: 5), "the JSON block did not wrap")
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertLessThanOrEqual(json.frame.maxX, window.maxX + 0.5, "the wrapped block runs off the screen: \(json.frame)")
        XCTAssertGreaterThan(json.frame.height, card.height * 1.5, "the wrapped block did not grow into lines")
        attach("ax5-2-wrapped")
        unwrap.tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: unwrap)
        XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 5), .completed, "the JSON block did not unwrap")
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
