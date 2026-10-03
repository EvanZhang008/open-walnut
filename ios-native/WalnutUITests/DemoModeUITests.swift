import XCTest

/// The App Review path, end to end through real taps: "Try the demo" on the
/// pairing screen, every tab, a new task, a chat message and its streamed reply,
/// then "Leave demo" back to pairing.
///
/// The app is pinned at the demo server's address (`-walnut.serverUrl`), which
/// is answered inside the app, so this test reaches no network at all. The
/// Settings row reports how many requests the demo refused for other hosts; the
/// test requires zero.
///
/// OPT-IN, because it is destructive on purpose: "Try the demo" saves the demo
/// pairing over whatever this simulator's app was paired to, and "Leave demo"
/// erases the app's pairing and local data, exactly as Disconnect does. On a
/// simulator that keeps a dogfood pairing that is real damage, so the test
/// skips unless the run says the app's data may be erased:
/// `TEST_RUNNER_WALNUT_UITEST_MAY_ERASE_APP_DATA=1 xcodebuild test ...`
/// (xcodebuild hands `TEST_RUNNER_`-prefixed variables to the runner).
final class DemoModeUITests: XCTestCase {
    private static let demoURL = "https://demo.walnut.invalid"
    static let optInVariable = "WALNUT_UITEST_MAY_ERASE_APP_DATA"

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment[Self.optInVariable] == "1",
            "Leave demo erases this simulator's pairing and app data; set TEST_RUNNER_\(Self.optInVariable)=1 to run it"
        )
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier))
            .firstMatch
    }

    private func text(_ app: XCUIApplication, containing fragment: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", fragment))
            .firstMatch
    }

    private func tab(_ app: XCUIApplication, _ name: String) {
        let button = app.tabBars.buttons[name]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "no \(name) tab")
        button.tap()
    }

    /// Scroll Settings until `target` is on screen.
    private func scrollTo(_ target: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<8 where !target.isHittable {
            app.swipeUp()
        }
    }

    private func leaveDemo(_ app: XCUIApplication) {
        tab(app, "Settings")
        let leave = app.buttons["settings.leaveDemo"]
        XCTAssertTrue(leave.waitForExistence(timeout: 10), "no Leave demo in Settings")
        scrollTo(leave, in: app)
        leave.tap()
    }

    /// A tier move lands where the server will put the row, and the answer does not
    /// move it. The server keeps a task's pin order when its tier changes and sorts
    /// every tier by it; the move used to put the row at the foot of its new tier,
    /// so the row jumped when the answer came back. Here the demo answers slowly
    /// (`-walnut.demoLatencyScale`, read by Debug builds only), so the first look
    /// happens while the request is still in flight.
    @MainActor
    func testATierMoveLandsWhereTheServerPutsIt() throws {
        let app = UITestLaunch.launch([
            UITestLaunch.serverURLArgument, Self.demoURL, "-walnut.demoLatencyScale", "40",
        ])
        let tryDemo = app.buttons["setup.tryDemo"]
        if !tryDemo.waitForExistence(timeout: 15) {
            leaveDemo(app)
        }
        XCTAssertTrue(tryDemo.waitForExistence(timeout: 30), "no Try the demo on the pairing screen")
        tryDemo.tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "the demo never opened")
        tab(app, "Tasks")

        // "Localize the settings screen" is the first Satellite row. It was pinned
        // after "Write release notes for 2.4" and before "Get three quotes for the
        // kitchen counters", the last two Focus rows, so in Focus it sits between them.
        func row(_ title: String) -> XCUIElement {
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", title)).firstMatch
        }
        let mover = row("Localize the settings screen")
        let above = row("Write release notes for 2.4")
        let below = row("Get three quotes")
        XCTAssertTrue(text(app, containing: "shared album").waitForExistence(timeout: 60), "the sample board is missing")
        scrollTo(mover, in: app)
        XCTAssertTrue(mover.exists, "no Localize the settings screen on the board")
        XCTAssertTrue(above.exists && below.exists, "the Focus tail is not beside the first Satellite row")
        XCTAssertGreaterThan(mover.frame.minY, below.frame.minY, "it starts in Satellite, below Focus")

        func assertBetween(_ moment: String) {
            XCTAssertGreaterThan(mover.frame.minY, above.frame.minY, "\(moment): the row is above its place")
            XCTAssertLessThan(mover.frame.minY, below.frame.minY, "\(moment): the row is below its place")
        }

        mover.press(forDuration: 1.2)
        let moveTo = app.buttons["Move to Tier"]
        XCTAssertTrue(moveTo.waitForExistence(timeout: 5), "no Move to Tier in the row's menu")
        moveTo.tap()
        let focusChoices = app.buttons.matching(NSPredicate(format: "label == %@", "Focus"))
        XCTAssertTrue(focusChoices.firstMatch.waitForExistence(timeout: 5), "no Focus in the tier menu")
        focusChoices.allElementsBoundByIndex.last?.tap()

        // The request takes 2 to 6 seconds here, so this is the optimistic board.
        assertBetween("while the move is in flight")
        sleep(8)
        assertBetween("after the server answered")
        // Pull to refresh, then look again.
        for _ in 0..<10 { app.swipeDown() }
        sleep(8)
        scrollTo(mover, in: app)
        assertBetween("after a refetch")

        leaveDemo(app)
        XCTAssertTrue(app.buttons["setup.tryDemo"].waitForExistence(timeout: 30), "Leave demo did not return to pairing")
    }

    @MainActor
    func testTryTheDemoVisitEveryTabCreateATaskChatAndLeave() throws {
        let app = UITestLaunch.launch([UITestLaunch.serverURLArgument, Self.demoURL])
        let tryDemo = app.buttons["setup.tryDemo"]
        if !tryDemo.waitForExistence(timeout: 15) {
            // An earlier run that stopped mid-demo left it paired: leave first.
            leaveDemo(app)
        }
        XCTAssertTrue(tryDemo.waitForExistence(timeout: 15), "no Try the demo on the pairing screen")
        XCTAssertEqual(tryDemo.label, "Try the demo")
        tryDemo.tap()

        // Chat opens on the sample conversation, with the Demo label up.
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 30), "the demo never opened")
        XCTAssertTrue(element(app, "demo.banner").waitForExistence(timeout: 10), "no Demo label")
        XCTAssertTrue(text(app, containing: "realistic plan for today").waitForExistence(timeout: 20),
                      "the sample conversation did not open")

        // Send a message and see the reply stream in.
        let composer = element(app, "chat.composer")
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "no chat composer")
        composer.tap()
        composer.typeText("How are the kitchen quotes going?")
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.tap()
        let reply = text(app, containing: "Riverside Kitchens")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "the streamed reply never appeared")

        // The keyboard covers the tab bar, as on a phone: drag the transcript
        // down to put it away before switching tabs.
        if app.keyboards.element.exists {
            reply.swipeDown()
            if !app.keyboards.element.waitForNonExistence(timeout: 5) { app.swipeDown() }
        }
        XCTAssertTrue(app.keyboards.element.waitForNonExistence(timeout: 5), "the keyboard stayed up")

        // Inbox.
        tab(app, "Inbox")
        XCTAssertTrue(text(app, containing: "onboarding headline").waitForExistence(timeout: 15),
                      "the sample letters are missing")

        // Notes.
        tab(app, "Notes")
        XCTAssertTrue(text(app, containing: "Pebble").waitForExistence(timeout: 15),
                      "the sample notes are missing")

        // Tasks: the board, then a new task.
        tab(app, "Tasks")
        XCTAssertTrue(text(app, containing: "shared album").waitForExistence(timeout: 15),
                      "the sample board is missing")
        // The toolbar + opens New Session directly: no menu in between, and with
        // the demo's quick folders up the page names the folder by its chip and
        // pill, never by a full path.
        let plus = element(app, "sessions.new")
        XCTAssertTrue(plus.waitForExistence(timeout: 10), "no + on the board")
        plus.tap()
        XCTAssertTrue(element(app, "newSessionChat.pathPill").waitForExistence(timeout: 10),
                      "+ did not land in New Session")
        XCTAssertFalse(app.buttons["sessions.create"].exists, "+ opened a menu instead of the page")
        XCTAssertTrue(element(app, "newSessionChat.quickFolders").waitForExistence(timeout: 10),
                      "the quick-folder row is missing")
        XCTAssertFalse(element(app, "newSessionChat.summary").exists,
                       "the full path is spelled out while a quick-folder chip is lit for it")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(element(app, "newSessionChat.pathPill").waitForNonExistence(timeout: 10))

        // The full New Task sheet opens from the quick-add row's expand icon (the
        // toolbar + is New Session alone since 2026-10-03), seeded with the sentence.
        let quickAdd = element(app, "tasks.quickAdd.field")
        XCTAssertTrue(quickAdd.waitForExistence(timeout: 10), "no quick-add row on the board")
        quickAdd.tap()
        quickAdd.typeText("Order new garden hose")
        let expand = app.buttons["tasks.quickAdd.expand"]
        XCTAssertTrue(expand.waitForExistence(timeout: 10), "the quick-add row has no expand icon once text is typed")
        expand.tap()
        let title = element(app, "newTask.title")
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertEqual(title.value as? String, "Order new garden hose",
                       "the sheet did not inherit the quick-add sentence")
        let add = app.buttons["newTask.add"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()
        // A new task lands in Satellite, below the Focus rows: scroll to it.
        let created = text(app, containing: "Order new garden hose")
        XCTAssertTrue(add.waitForNonExistence(timeout: 10), "the New Task sheet did not close")
        for _ in 0..<6 where !created.waitForExistence(timeout: 2) {
            app.swipeUp()
        }
        XCTAssertTrue(created.waitForExistence(timeout: 10), "the new task did not appear on the board")

        // It lands at the foot of Satellite, under the band's last sample row, and
        // a refetch leaves it there. The demo used to put a new task at the head
        // of its list, so the next refresh moved it to the top of Satellite and
        // the reader's next checkbox tap landed on a different task.
        let newRow = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Order new garden hose")).firstMatch
        let lastSample = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Call the dentist")).firstMatch
        scrollTo(newRow, in: app)
        XCTAssertTrue(lastSample.waitForExistence(timeout: 5), "the last Satellite sample row is not beside the new one")
        XCTAssertGreaterThan(newRow.frame.minY, lastSample.frame.minY, "a new task lands at the foot of Satellite")
        // Pull to refresh: the same full refetch the board's poll runs.
        for _ in 0..<10 { app.swipeDown() }
        sleep(2)
        scrollTo(newRow, in: app)
        XCTAssertTrue(newRow.isHittable && lastSample.exists, "after a refetch the new task is not where it was")
        XCTAssertGreaterThan(newRow.frame.minY, lastSample.frame.minY, "a refetch moved the new task")

        // Settings: nothing went to another host, then leave.
        tab(app, "Settings")
        let leave = app.buttons["settings.leaveDemo"]
        XCTAssertTrue(leave.waitForExistence(timeout: 10))
        XCTAssertEqual(leave.value as? String, "blocked 0", "the demo refused a request for another host")
        scrollTo(leave, in: app)
        leave.tap()

        // Back on the pairing screen, with no demo left behind.
        XCTAssertTrue(app.buttons["setup.tryDemo"].waitForExistence(timeout: 15), "Leave demo did not return to pairing")
        XCTAssertFalse(element(app, "demo.banner").exists)
        XCTAssertFalse(app.tabBars.firstMatch.exists)
    }
}
