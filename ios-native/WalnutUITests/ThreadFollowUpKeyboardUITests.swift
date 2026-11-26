import XCTest

/// A thread card's Follow up box, tapped low on the page, comes up above the keyboard with its keys,
/// and stays above it as it grows while the user types (2026-11-26, CI on iOS 26.5: the focused box sat
/// at y 679 to 954 behind a keyboard from y 540, `KeyboardReveal`). Since bb0a87a737 the box is on
/// the card, no longer in a sheet that rose with the keyboard.
///
/// It records nothing: the box's own keys (Send) are judged, so the run needs no audio.
final class ThreadFollowUpKeyboardUITests: ThreadPushUITestCase {
    override var shotPrefix: String { "KB" }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    func testAFocusedBoxStaysAboveTheKeyboard() throws {
        try checkFocusedBox([], "default")
    }

    func testAFocusedBoxStaysAboveTheKeyboardAtTheLargestText() throws {
        try checkFocusedBox(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"], "largest")
    }

    private func checkFocusedBox(_ extra: [String], _ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        app = try launchPaired(["-walnut.debugThreadPush", "\(vp) \(ids[0])"] + extra)
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 60), "no VP page", file: file, line: line)
        let input = followUpInput(ids[0])
        XCTAssertTrue(input.waitForExistence(timeout: 15), "the card has no Follow up box", file: file, line: line)
        // Brought up from below, the box stops just above the tab bar: where the keyboard comes up.
        reachFollowUp(ids[0], file: file, line: line)
        input.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "the box took no focus", file: file, line: line)
        let send = followUp(ids[0], "send")
        func clears() -> Bool {
            let top = keyboard.frame.minY
            return input.frame.maxY <= top + 1 && send.exists && send.frame.maxY <= top + 1 && send.isHittable
        }
        XCTAssertTrue(poll(10, clears), "focused, the box is under the keyboard: field \(input.frame), Send \(send.frame), keyboard \(keyboard.frame)",
                      file: file, line: line)
        shot("\(name)-focused")
        // Four lines: the field grows to its tallest, and its keys stay above the keyboard.
        input.typeText("A long follow up that grows the box line by line while he keeps on writing more words into it.")
        XCTAssertTrue(poll(10, clears), "grown, the box is under the keyboard: field \(input.frame), Send \(send.frame), keyboard \(keyboard.frame)",
                      file: file, line: line)
        XCTAssertGreaterThanOrEqual(input.frame.minY, el("org.threads").frame.minY, "the box went above the page's top", file: file, line: line)
        shot("\(name)-grown")
    }
}
