import XCTest

/// Stop, "Interrupt & send" and the queue strip on a coding session's page, as a finger
/// drives them, against the demo server (answered inside the app, no network).
///
/// The demo's `Rebuild the search index` session is mid-turn from the first frame and its
/// turn runs until it is stopped or steered, so every case has a turn to act on without a
/// race. OPT-IN like the other demo tests: "Try the demo" saves the demo pairing over the
/// simulator's, so the run must say the app's data may be erased:
/// `TEST_RUNNER_WALNUT_UITEST_MAY_ERASE_APP_DATA=1 xcodebuild test ...`
final class SessionStopSteerUITests: XCTestCase {
    private static let demoURL = "https://demo.walnut.invalid"
    private static let optInVariable = "WALNUT_UITEST_MAY_ERASE_APP_DATA"

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment[Self.optInVariable] == "1",
            "The demo pairing replaces this simulator's; set TEST_RUNNER_\(Self.optInVariable)=1 to run it"
        )
    }

    // MARK: - Finding things

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier))
            .firstMatch
    }

    private func elements(_ app: XCUIApplication, beginningWith prefix: String) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
    }

    private func text(_ app: XCUIApplication, containing fragment: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", fragment))
            .firstMatch
    }

    // MARK: - Getting to the session

    /// The demo opened with the tab bar up, then the long-running session from a search hit.
    private func openLongSession() -> XCUIApplication {
        let app = UITestLaunch.launch([UITestLaunch.serverURLArgument, Self.demoURL])
        let tryDemo = app.buttons["setup.tryDemo"]
        if tryDemo.waitForExistence(timeout: 15) { tryDemo.tap() }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "the demo never opened")
        let tasks = app.tabBars.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 20))
        tasks.tap()
        let scrim = element(app, "tasks.drawer.scrim")
        if !scrim.waitForExistence(timeout: 3) {
            app.buttons["tasks.menu"].tap()
            XCTAssertTrue(scrim.waitForExistence(timeout: 10), "the board drawer did not open")
        }
        let search = app.searchFields["Search tasks & sessions"]
        XCTAssertTrue(search.waitForExistence(timeout: 30), "no search on the board")
        search.tap()
        search.typeText("Rebuild the search")
        let hit = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Rebuild the search index")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 20), "no hit for the long session")
        hit.tap()
        XCTAssertTrue(app.buttons["session.menu"].waitForExistence(timeout: 20), "the hit opened no session")
        XCTAssertTrue(element(app, "chat.stop").waitForExistence(timeout: 20), "the turn is not running: no Stop")
        return app
    }

    private func type(_ words: String, in app: XCUIApplication) {
        let composer = element(app, "chat.composer")
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "no composer")
        composer.tap()
        composer.typeText(words)
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    // MARK: - Stop

    func testStopEndsTheTurnAndKeepsTheSession() throws {
        let app = openLongSession()
        attach(app, "1-running")
        XCTAssertFalse(element(app, "session.interruptSend").exists, "nothing typed: nothing to interrupt with")
        element(app, "chat.stop").tap()
        XCTAssertTrue(element(app, "chat.stop").waitForNonExistence(timeout: 20), "the turn did not stop")
        XCTAssertTrue(text(app, containing: "38 of 120 shards").waitForExistence(timeout: 10),
                      "what the turn had written is kept")
        attach(app, "2-stopped")
        // The session is alive: a new message starts a new turn.
        type("Carry on, please", in: app)
        element(app, "chat.send").tap()
        XCTAssertTrue(text(app, containing: "get oriented").waitForExistence(timeout: 30), "no reply after Stop")
    }

    // MARK: - The queue strip

    func testAWordSentWhileItRunsWaitsInTheStripAndCanBeEditedAndWithdrawn() throws {
        let app = openLongSession()
        type("Skip the slow shards", in: app)
        XCTAssertTrue(element(app, "session.interruptSend").waitForExistence(timeout: 5), "no Interrupt & send")
        element(app, "chat.send").tap()
        let strip = element(app, "session.queue.strip")
        XCTAssertTrue(strip.waitForExistence(timeout: 20), "the queued message is not listed")
        XCTAssertTrue(element(app, "chat.queuedBadge").waitForExistence(timeout: 10), "the bubble does not say it is queued")
        attach(app, "3-queued")
        let row = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("Skip the slow shards"))

        // Edit it.
        row.tap()
        let editor = element(app, "session.queue.edit.text")
        XCTAssertTrue(editor.waitForExistence(timeout: 10), "the queued message did not open")
        attach(app, "4-edit-sheet")
        editor.tap()
        editor.press(forDuration: 1.0)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        editor.typeText("Skip the shards older than a week")
        element(app, "session.queue.save").tap()
        XCTAssertTrue(element(app, "session.queue.edit.text").waitForNonExistence(timeout: 10), "Save left the sheet up")
        let edited = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(edited.waitForExistence(timeout: 10))
        XCTAssertTrue(edited.label.contains("older than a week"), "the strip does not show the edited words")

        // Withdraw it with the cross.
        elements(app, beginningWith: "session.queue.withdraw.").firstMatch.tap()
        XCTAssertTrue(strip.waitForNonExistence(timeout: 10), "the withdrawn message is still listed")
        XCTAssertFalse(text(app, containing: "older than a week").exists, "its bubble is still on the page")
    }

    // MARK: - Interrupt & send

    func testInterruptAndSendStopsTheTurnAndAnswersTheNewWords() throws {
        let app = openLongSession()
        type("Stop that and tell me what is done", in: app)
        let steer = element(app, "session.interruptSend")
        XCTAssertTrue(steer.waitForExistence(timeout: 5), "no Interrupt & send")
        attach(app, "5-interrupt-offered")
        steer.tap()
        XCTAssertTrue(text(app, containing: "get oriented").waitForExistence(timeout: 30),
                      "the new words were not answered")
        XCTAssertFalse(element(app, "session.queue.strip").exists, "an interrupting send waits in no queue")
        attach(app, "6-steered")
    }

    func testSendNowFromTheQueuedMessageInterruptsToo() throws {
        let app = openLongSession()
        type("Do the other thing first", in: app)
        element(app, "chat.send").tap()
        let row = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the queued message is not listed")
        row.tap()
        let sendNow = element(app, "session.queue.sendNow")
        XCTAssertTrue(sendNow.waitForExistence(timeout: 10), "no Send now in the sheet")
        XCTAssertTrue(sendNow.label.contains("Interrupt"), "a running turn: the button says it interrupts")
        sendNow.tap()
        XCTAssertTrue(text(app, containing: "get oriented").waitForExistence(timeout: 30), "Send now was not answered")
        XCTAssertTrue(element(app, "session.queue.strip").waitForNonExistence(timeout: 10))
    }
}
