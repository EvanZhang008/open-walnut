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
        let app = XCUIApplication()
        app.launchArguments = ["-askq-harness"]
        app.launch()
        return app
    }

    private func id(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    /// Scroll until an element is hittable. The card is deliberately taller than
    /// the screen (three questions, every option, every description — nothing is
    /// truncated to fit), so Submit and the later options start below the fold;
    /// SwiftUI doesn't always publish far-offscreen elements to the
    /// accessibility tree, so plain `waitForExistence` isn't enough.
    @discardableResult
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 6) -> Bool {
        for _ in 0..<swipes {
            if element.exists && element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists && element.isHittable
    }

    /// Scroll an element into the tree WITHOUT requiring it to be hittable — a
    /// DISABLED button (Submit before every question is answered) exists and is
    /// on screen but reports `isHittable == false`.
    @discardableResult
    private func scrollToExists(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 8) -> Bool {
        for _ in 0..<swipes {
            if element.exists { return true }
            app.swipeUp()
        }
        return element.exists
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
        XCTAssertTrue(scrollToExists(app.staticTexts["Choose one or more"], in: app))
    }

    /// Submit is gated on EVERY question, and the submitted map is keyed by
    /// question text with multi-select joined — a partial answer must not reach
    /// the agent.
    func testSubmitGatesUntilAnsweredThenEmitsAnswers() {
        let app = launch()
        XCTAssertTrue(id("session.askQuestionCard", in: app).waitForExistence(timeout: 30))

        // Answer question 1 only, then try to submit → still incomplete, so
        // nothing may be emitted.
        let firstOption = app.buttons
            .containing(NSPredicate(format: "label BEGINSWITH %@", "In-memory")).firstMatch
        XCTAssertTrue(scrollTo(firstOption, in: app), "question 1's option should be reachable")
        firstOption.tap()

        // Submit EXISTS but is disabled (hence not hittable) — that IS the gate:
        // a partial answer set can't be sent, so the agent never receives a
        // half-answered question set.
        let submit = id("session.askQuestion.submit", in: app)
        XCTAssertTrue(scrollToExists(submit, in: app), "Submit should be reachable by scrolling")
        XCTAssertFalse(submit.isHittable, "Submit must stay inert until every question is answered")
        XCTAssertFalse(
            id("askq.harness.submitted", in: app).exists,
            "a partial answer set must not submit"
        )

        // Answer the remaining two (question 3 is multi-select: two taps).
        for label in ["Block until fresh", "Web console", "Phone app"] {
            let option = app.buttons
                .containing(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
            XCTAssertTrue(scrollTo(option, in: app), "option should be reachable: \(label)")
            option.tap()
        }

        let submitButton = id("session.askQuestion.submit", in: app)
        XCTAssertTrue(scrollTo(submitButton, in: app))
        submitButton.tap()

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
