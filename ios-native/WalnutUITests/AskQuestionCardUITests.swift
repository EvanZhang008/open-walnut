import XCTest

/// UI layer for the AskUserQuestion card — the parts no unit test can prove
/// because they need real taps: that the question text and every option are
/// actually ON SCREEN (the reported bug was "I can see nothing"), that Submit
/// stays inert until every question is answered, and that submitting produces
/// the `answers` map the agent needs.
///
/// Drives the DEBUG `-askq-harness` (AskQuestionHarnessView), which renders the
/// PRODUCT card against a real-shape payload — a live CLI blocked mid-turn on
/// this tool is not a state you can hold still for a test.
///
/// XCUITest, not a coordinate clicker: taps are scoped to this app's elements,
/// so nothing can land in another app on a shared desktop.
final class AskQuestionCardUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        // Pointed at nothing: this harness's data comes from `-askq-harness`, and an
        // unpinned launch talked to whatever the simulator was paired to.
        UITestLaunch.launch(["-askq-harness"])
    }

    private func id(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    /// Scroll until an element is hittable. The card is deliberately taller than
    /// the screen (three questions, every option, every description — nothing is
    /// truncated to fit), so Submit and the later options start below the fold;
    /// SwiftUI doesn't always publish far-offscreen elements to the
    /// accessibility tree, so plain `waitForExistence` isn't enough. The swipe
    /// lands on the cards' own scroll box, the only thing a user can drag there.
    @discardableResult
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 14) -> Bool {
        for _ in 0..<swipes {
            if element.exists && element.isHittable && onScreen(element, in: app) { return true }
            swipeToward(element, in: app)
        }
        return element.exists && element.isHittable && onScreen(element, in: app)
    }

    /// One short drag down through the cards. Downward only: XCUITest's frames lag
    /// for rows scrolled back above the box, so callers walk the cards top to
    /// bottom instead of seeking back up.
    private func swipeToward(_ element: XCUIElement, in app: XCUIApplication) {
        let box = id("session.permissionStack", in: app)
        // A fixed-distance drag that holds at the end: a flick's momentum carried
        // a short row clean past the box in one swipe, so it was never inside it.
        // Always downward through the cards; callers start from the top.
        box.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).press(
            forDuration: 0.05,
            thenDragTo: box.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)),
            withVelocity: .slow, thenHoldForDuration: 0.3
        )
    }

    /// Scroll an element into the tree WITHOUT requiring it to be hittable — a
    /// DISABLED button (Submit before every question is answered) exists and is
    /// on screen but reports `isHittable == false`.
    @discardableResult
    private func scrollToExists(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 14) -> Bool {
        for _ in 0..<swipes {
            if element.exists && onScreen(element, in: app) { return true }
            swipeToward(element, in: app)
        }
        return element.exists && onScreen(element, in: app)
    }

    /// Inside the visible part of the cards' scroll box: an element the page cut
    /// off still exists in the tree, which is how the old layout passed.
    private func onScreen(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        let box = id("session.permissionStack", in: app).frame
        let frame = element.frame
        return !frame.isEmpty && frame.minY >= box.minY - 1 && frame.maxY <= box.maxY + 1
    }

    /// The reported bug: a card with many questions was taller than the page and
    /// the page cut it off, so the later options and Submit could not be reached
    /// by any swipe. The cards now scroll in a box of at most ~60% of the page,
    /// and the transcript stays visible under them.
    func testTallCardScrollsWithinCapAndKeepsTranscriptVisible() {
        let app = launch()
        let stack = id("session.permissionStack", in: app)
        XCTAssertTrue(stack.waitForExistence(timeout: 30))

        let window = app.windows.firstMatch.frame
        XCTAssertLessThanOrEqual(
            stack.frame.height, window.height * 0.62,
            "the cards must not take the whole page"
        )
        XCTAssertGreaterThan(stack.frame.height, 150, "the cards must still have room to read")
        let row = app.staticTexts["Transcript row 1"]
        XCTAssertTrue(row.waitForExistence(timeout: 5) && row.isHittable, "the transcript stays visible")
        XCTAssertTrue(id("askq.harness.composer", in: app).isHittable, "the composer stays visible")

        // Submit starts below the box's fold and is reached by scrolling the box.
        let submit = id("session.askQuestion.submit", in: app)
        XCTAssertFalse(submit.exists && onScreen(submit, in: app), "the harness card must be taller than its box")
        XCTAssertTrue(scrollToExists(submit, in: app), "Submit must be reachable by swiping the cards")
        XCTAssertTrue(id("session.askQuestion.dismiss", in: app).isHittable)

        // Typing into the LAST question's free-text field: it stays on screen
        // above the keyboard, and the composer is not pushed under it.
        let others = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", "session.askQuestion.other"))
        let lastOther = others.element(boundBy: others.count - 1)
        XCTAssertTrue(scrollTo(lastOther, in: app))
        lastOther.tap()
        lastOther.typeText("Both, staged")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        // The box shrinks when the keyboard comes up; the field being typed in
        // must still sit wholly inside it, not cut at its bottom edge. Waited
        // for first: the box resizes and scrolls after the keyboard lands.
        let settled = expectation(for: NSPredicate { _, _ in self.onScreen(lastOther, in: app) }, evaluatedWith: nil)
        wait(for: [settled], timeout: 5)
        XCTAssertTrue(lastOther.isHittable, "the focused field stays visible above the keyboard")
        XCTAssertLessThanOrEqual(
            lastOther.frame.maxY, app.keyboards.firstMatch.frame.minY + 1,
            "the focused field must not sit under the keyboard"
        )
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "typing-last-question"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Gate findings 2026-10-26: an answer that wrapped grew its field below the
    /// box's edge, so the line being typed and the cursor went out of sight; and
    /// dragging the cards to put the keyboard away left it stuck halfway (the box's
    /// height follows the keyboard, so an interactive dismiss resized it under the
    /// finger). v6: typed line by line, the field's mic (the Stop's seat while a
    /// take runs) fell below the box now and then, so a tap on the Stop's lower
    /// half reached the transcript, and the recording outline 4pt below the field
    /// was cut. Checked after EVERY line, the whole row and that outline's room.
    func testTypingAWrappingAnswerKeepsItInViewAndADragPutsTheKeyboardAway() {
        let app = launch()
        let stack = id("session.permissionStack", in: app)
        XCTAssertTrue(stack.waitForExistence(timeout: 30))
        let firstOther = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", "session.askQuestion.other")).element(boundBy: 0)
        let firstMic = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", "voice-mic.ask-question")).element(boundBy: 0)
        XCTAssertTrue(scrollTo(firstOther, in: app))
        firstOther.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let startHeight = firstOther.frame.height
        // The outline sits this far outside the field (`voiceDictationOutlineOutset`).
        let outline: CGFloat = 4
        let lines = [
            "First line of a long answer that keeps going well past one row,",
            "\nsecond line,", "\nthird line,", "\nfourth line,", "\nfifth line where the cursor is",
        ]
        for (index, line) in lines.enumerated() {
            firstOther.typeText(line)
            let rowInside = expectation(for: NSPredicate { _, _ in
                let box = stack.frame
                let field = firstOther.frame
                let mic = firstMic.frame
                return field.maxY + outline <= box.maxY + 1 && mic.isInside(box)
            }, evaluatedWith: nil)
            wait(for: [rowInside], timeout: 5)
            XCTAssertTrue(firstMic.isHittable, "after line \(index + 1) the mic seat is inside the box")
        }
        XCTAssertGreaterThan(firstOther.frame.height, startHeight * 2, "the answer grew to several lines")
        let typed = XCTAttachment(screenshot: app.screenshot())
        typed.name = "wrapped-answer-in-view"
        typed.lifetime = .keepAlways
        add(typed)

        // Drag through the cards (the drag every other test scrolls them with):
        // the keyboard goes away, all the way.
        swipeToward(stack, in: app)
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.keyboards.firstMatch)
        wait(for: [gone], timeout: 5)
        XCTAssertTrue(id("askq.harness.composer", in: app).isHittable, "the composer is back once the keyboard is away")
    }

    /// The regression itself: question text and option labels + descriptions are
    /// visible. Before the fix this screen showed the word "AskUserQuestion" and
    /// nothing else.
    func testEveryQuestionAndOptionIsOnScreen() {
        let app = launch()
        XCTAssertTrue(
            id("session.askQuestionCard", in: app).waitForExistence(timeout: 30),
            "the ask card should render for an AskUserQuestion prompt"
        )

        // All three question texts, in full.
        for question in [
            "Which cache backend should the indexer use?",
            "How should a stale entry be treated?",
            "Which surfaces should the rollout cover?",
        ] {
            XCTAssertTrue(
                app.staticTexts[question].waitForExistence(timeout: 10),
                "question should be readable: \(question)"
            )
        }

        // Option labels AND their descriptions. SwiftUI folds an option row into
        // ONE button whose accessibility label is "label, description", so
        // asserting on the button label proves BOTH halves are rendered — which
        // is the whole point: a description-less option list would hide what each
        // choice actually means.
        let expected = [
            "On-disk (Recommended), Survives restarts and costs one extra fsync per batch.",
            "In-memory, Fastest, but every restart rebuilds the whole index.",
            "Serve stale, refresh behind, Answers instantly and recomputes in the background.",
            "Block until fresh, Always correct, but a cold entry pays full latency.",
            "Web console, The desktop browser UI.",
            "Phone app, The native mobile client.",
            "CLI, The terminal entry point.",
        ]
        for label in expected {
            XCTAssertTrue(
                scrollToExists(app.buttons[label], in: app),
                "option should render its label AND description: \(label)"
            )
        }
        // Multi-select is signposted, so a user knows several are allowed.
        XCTAssertTrue(app.staticTexts["Choose one or more"].exists)
    }

    /// Submit is gated on EVERY question, and the submitted map is keyed by
    /// question text with multi-select joined — a partial answer must not reach
    /// the agent.
    func testSubmitGatesUntilAnsweredThenEmitsAnswers() {
        let app = launch()
        XCTAssertTrue(id("session.askQuestionCard", in: app).waitForExistence(timeout: 30))

        // One pass down the cards (XCUITest's frames lag for rows scrolled back
        // above the box, so a tap there misses): answer questions 1 and 2, leave
        // 3 open, and Submit must still be inert.
        for label in ["In-memory", "Block until fresh"] {
            let option = app.buttons
                .containing(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
            XCTAssertTrue(scrollTo(option, in: app), "option should be reachable: \(label)")
            option.tap()
        }

        // Submit is on screen but disabled — that IS the gate: a partial answer
        // set can't be sent, so the agent never receives a half-answered set.
        // (This used to assert "not hittable", which held only because the page
        // cut Submit off: the bug itself.)
        let submit = id("session.askQuestion.submit", in: app)
        XCTAssertTrue(scrollToExists(submit, in: app), "Submit should be reachable by scrolling")
        XCTAssertFalse(submit.isEnabled, "Submit must stay inert until every question is answered")
        submit.tap()
        XCTAssertFalse(
            id("askq.harness.submitted", in: app).exists,
            "a partial answer set must not submit"
        )

        // Question 3 sits right above Submit: multi-select, two taps.
        for label in ["Web console", "Phone app"] {
            let option = app.buttons
                .containing(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
            XCTAssertTrue(scrollTo(option, in: app), "option should be reachable: \(label)")
            option.tap()
        }

        XCTAssertTrue(submit.isEnabled, "a complete set enables Submit")
        submit.tap()

        let readback = id("askq.harness.submitted", in: app)
        XCTAssertTrue(readback.waitForExistence(timeout: 10), "a complete set should submit")
        // Multi-select joins with ", " the way the CLI's own summary reads.
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "Web console, Phone app")
            ).firstMatch.waitForExistence(timeout: 10),
            "multi-select answers should join with a comma"
        )
    }
}

private extension CGRect {
    /// Wholly inside `box` vertically, with a point of slack for rounding.
    func isInside(_ box: CGRect) -> Bool {
        !isEmpty && minY >= box.minY - 1 && maxY <= box.maxY + 1
    }
}
