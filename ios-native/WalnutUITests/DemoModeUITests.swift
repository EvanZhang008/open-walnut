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

    /// Scroll until `target` can be tapped, in short slow drags toward it. A full
    /// swipe flings: on the board it carried a row from under the tab bar to
    /// under the sticky chip bar in one move, where it cannot be tapped either,
    /// and the next swipe went past it.
    private func scrollTo(_ target: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<20 where !target.isHittable {
            // Not drawn yet means further down; drawn but hidden at the top
            // means a step back up.
            let down = !target.exists || target.frame.midY > app.frame.midY
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.62 : 0.38))
            let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.38 : 0.62))
            from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.1)
        }
    }

    /// `scrollTo`, then on until `target` is drawn whole above the tab bar. iOS 26's
    /// tab bar floats over the list and XCUITest calls a row under it hittable, so a
    /// tap on that row lands on the bar (r9 run ui-r9-1: the Completed fold at y 789
    /// to 841 under the bar at y 791 stayed Collapsed after its tap).
    private func scrollClearOfTheTabBar(_ target: XCUIElement, in app: XCUIApplication) {
        scrollTo(target, in: app)
        let bar = app.tabBars.firstMatch
        for _ in 0..<6 {
            guard target.exists, bar.exists, target.frame.maxY > bar.frame.minY - 4 else { return }
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
            let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
            from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.1)
        }
    }

    /// True when `target` is drawn whole above the tab bar (or there is no bar).
    private func clearOfTheTabBar(_ target: XCUIElement, in app: XCUIApplication) -> Bool {
        let bar = app.tabBars.firstMatch
        return target.exists && (!bar.exists || target.frame.maxY <= bar.frame.minY - 4)
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
        // The privacy policy, right under Try the demo (guideline 5.1.1).
        let setupPolicy = element(app, "setup.privacyPolicy")
        scrollTo(setupPolicy, in: app)
        XCTAssertTrue(setupPolicy.isHittable, "no Privacy Policy link on the pairing screen")
        XCTAssertEqual(setupPolicy.label, "Privacy Policy")
        XCTAssertGreaterThan(setupPolicy.frame.minY, tryDemo.frame.minY, "the policy link is not under Try the demo")
        scrollTo(tryDemo, in: app)
        tryDemo.tap()

        // Chat opens on the sample conversation, with the Demo label up.
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 30), "the demo never opened")
        XCTAssertTrue(element(app, "demo.banner").waitForExistence(timeout: 10), "no Demo label")
        // "for today", or "for tomorrow" late in the day.
        XCTAssertTrue(text(app, containing: "realistic plan for").waitForExistence(timeout: 20),
                      "the sample conversation did not open")

        // Send a message and see the reply stream in.
        let composer = element(app, "chat.composer")
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "no chat composer")
        composer.tap()
        composer.typeText("How are the kitchen quotes going?")
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.tap()
        let reply = text(app, containing: "butcher block for 1,800")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "the streamed reply never appeared")

        // The keyboard covers the tab bar, as on a phone: drag the transcript
        // down to put it away before switching tabs.
        if app.keyboards.element.exists {
            reply.swipeDown()
            if !app.keyboards.element.waitForNonExistence(timeout: 5) { app.swipeDown() }
        }
        XCTAssertTrue(app.keyboards.element.waitForNonExistence(timeout: 5), "the keyboard stayed up")

        // Inbox: answer the headline letter. The session that asked does the
        // work and writes back in the letter's thread.
        tab(app, "Inbox")
        let headline = text(app, containing: "onboarding headline should ship")
        XCTAssertTrue(headline.waitForExistence(timeout: 15), "the sample letters are missing")
        headline.tap()
        let optionB = text(app, containing: "Ship option B")
        XCTAssertTrue(optionB.waitForExistence(timeout: 15), "the headline letter has no options")
        optionB.tap()
        XCTAssertTrue(app.navigationBars["Answered"].waitForExistence(timeout: 15), "the letter did not take the answer")
        sleep(6)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(headline.waitForExistence(timeout: 10))
        headline.tap()
        XCTAssertTrue(text(app, containing: "now say").waitForExistence(timeout: 15),
                      "the session never wrote back in the letter's thread")
        app.navigationBars.buttons.firstMatch.tap()

        // Notes.
        tab(app, "Notes")
        XCTAssertTrue(text(app, containing: "Pebble").waitForExistence(timeout: 15),
                      "the sample notes are missing")

        // Tasks: the board, then a new task.
        tab(app, "Tasks")
        XCTAssertTrue(text(app, containing: "shared album").waitForExistence(timeout: 15),
                      "the sample board is missing")
        // The board's status badge says Demo, the same word as Settings.
        XCTAssertFalse(app.staticTexts["Live"].exists, "the board says Live in the demo")
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
        // Return adds the task and leaves the field where it was, in view and
        // below the pinned chip bar, for the next entry (App Store gate,
        // 2026-10-05: the list scrolled to the new row and the field came back
        // under the bar while the user kept typing).
        sleep(1)
        let fieldBefore = quickAdd.frame
        quickAdd.typeText("Buy oat milk\n")
        sleep(2)
        quickAdd.typeText("Order new")
        XCTAssertTrue(quickAdd.isHittable, "the quick-add field left the screen after Return")
        XCTAssertEqual(quickAdd.frame.minY, fieldBefore.minY, accuracy: 1, "the quick-add field moved after Return")
        quickAdd.typeText(" garden hose")
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
        // There is no server, so no server status: the status says Demo, and no
        // server version is shown.
        let status = element(app, "settings.status")
        scrollTo(status, in: app)
        XCTAssertTrue(status.exists, "no Status row")
        let reads = "\(status.label) \((status.value as? String) ?? "")"
        XCTAssertTrue(reads.contains("Demo") && !reads.contains("Live"), "the status reads \(reads)")
        // Nothing on the whole page claims a server: no connection test (it said
        // "Connected: LIVE"), no Disconnect, no upload, no notification setting.
        let serverWords = ["LIVE", "Live", "Connected", "Test Connection", "Disconnect", "Server version",
                           "Send Diagnostics", "Letter Notifications", "v0.6.0", "Uptime"]
        for _ in 0..<8 {
            for word in serverWords {
                let hit = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", word)).firstMatch
                XCTAssertFalse(hit.exists, "Settings in the demo shows \"\(word)\": \(hit.exists ? hit.label : "")")
            }
            app.swipeUp()
        }
        // The Privacy Policy row opens Safari, in the demo too, and the demo
        // refused nothing for it: the address never went through the app.
        let policy = element(app, "settings.privacyPolicy")
        scrollTo(policy, in: app)
        XCTAssertTrue(policy.isHittable, "no Privacy Policy row in Settings")
        XCTAssertEqual(policy.label, "Privacy Policy")
        checkThePrivacyPolicyOpensInSafari(app, policy)
        for _ in 0..<10 where !leave.isHittable { app.swipeDown() }
        XCTAssertEqual(leave.value as? String, "blocked 0", "the policy link went through the demo's server")
        leave.tap()

        // Back on the pairing screen, with no demo left behind.
        XCTAssertTrue(app.buttons["setup.tryDemo"].waitForExistence(timeout: 15), "Leave demo did not return to pairing")
        XCTAssertFalse(element(app, "demo.banner").exists)
        XCTAssertFalse(app.tabBars.firstMatch.exists)
    }

    private func waitForValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval = 15) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (element.value as? String) == value { return true }
            usleep(200_000)
        }
        return (element.value as? String) == value
    }

    /// The screens added after the first submission, in the demo: Inbox letters marked
    /// without opening them (a right swipe, Select, two fingers dragged down the rows),
    /// the Tasks search finding finished work behind "Completed (1)", and the Recently
    /// opened drawer, which starts from the demo's sample history and goes back to a
    /// conversation. Nothing leaves the demo: Settings still says "blocked 0".
    @MainActor
    func testTheDemoMarksLettersFindsFinishedWorkAndReopensRecents() throws {
        let app = UITestLaunch.launch([UITestLaunch.serverURLArgument, Self.demoURL])
        let tryDemo = app.buttons["setup.tryDemo"]
        if !tryDemo.waitForExistence(timeout: 15) {
            leaveDemo(app)
        }
        XCTAssertTrue(tryDemo.waitForExistence(timeout: 30), "no Try the demo on the pairing screen")
        tryDemo.tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "the demo never opened")

        // Inbox: three unread letters to start with.
        tab(app, "Inbox")
        let unread = element(app, "inbox.filter.unread")
        XCTAssertTrue(unread.waitForExistence(timeout: 20), "no Unread chip")
        XCTAssertTrue(waitForValue(unread, "3"), "the demo inbox does not start with three unread letters")

        // A right swipe marks a letter read without opening it, and a second one unread.
        let merge = element(app, "inbox.row.l-merge")
        XCTAssertTrue(merge.waitForExistence(timeout: 15), "no ready-to-merge letter")
        func swipeRead(_ row: XCUIElement) {
            row.swipeRight(velocity: .fast)
            let button = element(app, "inbox.swipe.read")
            if button.waitForExistence(timeout: 1), button.isHittable { button.tap() }
        }
        swipeRead(merge)
        XCTAssertTrue(waitForValue(unread, "2"), "a right swipe did not mark the letter read")
        XCTAssertFalse(element(app, "inbox.letter.menu").exists, "the swipe opened the letter")
        swipeRead(merge)
        XCTAssertTrue(waitForValue(unread, "3"), "a second right swipe did not mark it unread")

        // Select, pick two, Mark Read.
        element(app, "inbox.select").tap()
        XCTAssertTrue(app.navigationBars["Select Letters"].waitForExistence(timeout: 5), "Select did not open")
        element(app, "inbox.row.l-headline").tap()
        element(app, "inbox.row.l-pricing").tap()
        XCTAssertTrue(app.navigationBars["2 Selected"].waitForExistence(timeout: 5), "the title does not count the picks")
        XCTAssertFalse(element(app, "inbox.letter.menu").exists, "a tap in Select mode opened a letter")
        element(app, "inbox.selection.markRead").tap()
        XCTAssertTrue(element(app, "inbox.select").waitForExistence(timeout: 5), "Mark Read did not leave Select mode")
        XCTAssertTrue(waitForValue(unread, "1"), "Mark Read did not mark the two letters read")

        // Two fingers dragged down the rows start Select mode with those rows picked;
        // Mark Unread puts them back. The demo's letters are tall (a title over two
        // lines of preview), so the drag runs from the first row on screen to the last
        // one, slowly: from the first to the third it picked one row (first run).
        let rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'inbox.row.'"))
            .allElementsBoundByIndex.filter(\.isHittable).sorted { $0.frame.minY < $1.frame.minY }
        XCTAssertGreaterThanOrEqual(rows.count, 3, "fewer than three letters on screen")
        let first = rows[0], last = rows[rows.count - 1]
        try MultiTouch.twoFingerDrag(
            from: CGPoint(x: first.frame.midX - 20, y: first.frame.minY + 24),
            to: CGPoint(x: first.frame.midX - 20, y: last.frame.midY),
            duration: 2.4
        )
        XCTAssertTrue(element(app, "inbox.selectDone").waitForExistence(timeout: 5),
                      "two fingers dragged down the rows did not start Select mode")
        let title = app.navigationBars.firstMatch.identifier
        let picked = Int(title.split(separator: " ").first ?? "") ?? 0
        XCTAssertGreaterThanOrEqual(picked, 2, "the drag picked fewer than two rows (title \(title))")
        element(app, "inbox.selection.markUnread").tap()
        XCTAssertTrue(element(app, "inbox.select").waitForExistence(timeout: 5), "Mark Unread did not leave Select mode")
        XCTAssertNotEqual(unread.value as? String, "1", "Mark Unread changed nothing")

        // Opening an unread letter reads it, and it stays read once the letter's own
        // answer arrives: the reader asks for the letter as it marks it, and that
        // answer, made before the read landed, used to put it back (r8 gate).
        let beforeOpen = Int(unread.value as? String ?? "") ?? 0
        XCTAssertGreaterThan(beforeOpen, 0, "no unread letter left to open")
        // The drag can leave the list scrolled, with this row under the pinned filter
        // bar, where a tap on its middle lands on the bar (App Store r6 gate, run 2:
        // the row at y 121 to 249 under the All chip at y 148 to 178). Scroll back
        // until the whole row is below the bar, then open it.
        let target = element(app, "inbox.row.l-merge")
        func clearOfTheBar() -> Bool {
            target.exists && target.isHittable && target.frame.minY > unread.frame.maxY + 4
        }
        for _ in 0..<5 where !clearOfTheBar() { app.swipeDown() }
        XCTAssertTrue(clearOfTheBar(), "the letter stays under the filter bar (row \(target.frame), bar \(unread.frame))")
        target.tap()
        XCTAssertTrue(element(app, "inbox.letter.subject").waitForExistence(timeout: 10), "the letter did not open")
        // The demo answers each request after a random 50 to 160 ms: let both land.
        // A letter answer slower than the read's is the case that went wrong.
        Thread.sleep(forTimeInterval: 2)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(waitForValue(unread, String(beforeOpen - 1)), "opening the letter did not leave it read")

        // Tasks: search finds the finished crash fixes the list does not carry.
        tab(app, "Tasks")
        XCTAssertTrue(text(app, containing: "shared album").waitForExistence(timeout: 30), "the sample board is missing")
        let search = app.searchFields.firstMatch
        if !search.waitForExistence(timeout: 5) { app.swipeDown() }
        XCTAssertTrue(search.waitForExistence(timeout: 10), "no search field on the board")
        search.tap()
        search.typeText("crash")
        let inline = element(app, "tasks.row.t-upload-crash")
        XCTAssertTrue(inline.waitForExistence(timeout: 20), "search did not find the finished upload crash fix")
        // The keyboard covers the lower half, where `scrollTo` drags: its Search key
        // puts it away and keeps the results (run 3 found no fold behind it).
        let searchKey = app.keyboards.buttons["Search"].firstMatch
        if searchKey.waitForExistence(timeout: 3) { searchKey.tap() }
        let fold = element(app, "search.fold.completed")
        scrollClearOfTheTabBar(fold, in: app)
        XCTAssertTrue(fold.waitForExistence(timeout: 10), "no Completed fold")
        XCTAssertTrue(fold.label.contains("Completed (1)"), "the fold reads \(fold.label)")
        XCTAssertTrue(clearOfTheTabBar(fold, in: app),
                      "the fold stays under the tab bar (fold \(fold.frame), bar \(app.tabBars.firstMatch.frame))")
        fold.tap()
        let folded = element(app, "tasks.row.t-widget-crash")
        XCTAssertTrue(folded.waitForExistence(timeout: 10), "the Completed fold did not open")
        scrollClearOfTheTabBar(folded, in: app)
        XCTAssertTrue(clearOfTheTabBar(folded, in: app),
                      "the finished task stays under the tab bar (row \(folded.frame), bar \(app.tabBars.firstMatch.frame))")
        folded.tap()
        let opened = element(app, "task.title")
        XCTAssertTrue(opened.waitForExistence(timeout: 15), "the finished task did not open")
        XCTAssertTrue(opened.label.contains("home screen widget"), "the page opened \(opened.label)")
        let done = app.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 10), "no Done on the task page")
        done.tap()
        // iOS 26 ends a search with Close (an xmark) where earlier systems said Cancel;
        // the Recently opened button comes back once the search has ended (run 4).
        let close = app.navigationBars.buttons["Close"].firstMatch
        let cancel = app.buttons["Cancel"].firstMatch
        if close.waitForExistence(timeout: 5) { close.tap() } else if cancel.exists { cancel.tap() }

        // Recently opened: the task just opened on top, then the sample history.
        let clock = app.buttons["tasks.recents"]
        XCTAssertTrue(clock.waitForExistence(timeout: 10), "no Recently opened button")
        clock.tap()
        XCTAssertTrue(element(app, "tasks.recents.drawer").waitForExistence(timeout: 10), "the drawer did not open")
        let recent = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.recents.row.'"))
        XCTAssertTrue(recent.firstMatch.waitForExistence(timeout: 10), "the drawer is empty")
        XCTAssertEqual(recent.firstMatch.identifier, "tasks.recents.row.t-widget-crash", "the task just opened is not on top")
        XCTAssertGreaterThanOrEqual(recent.count, 5, "the sample history is missing")
        XCTAssertFalse(element(app, "tasks.recents.empty").exists)
        element(app, "tasks.recents.row.t-crash").tap()
        // The conversation's More menu (its Session Info item stays inside it).
        XCTAssertTrue(element(app, "session.menu").waitForExistence(timeout: 20),
                      "the crash row did not go back to its conversation")
        XCTAssertTrue(text(app, containing: "force unwrap on an album").waitForExistence(timeout: 20),
                      "the conversation is not the crash fix")
        app.navigationBars.buttons.firstMatch.tap()

        // Nothing left the demo.
        tab(app, "Settings")
        let leave = app.buttons["settings.leaveDemo"]
        XCTAssertTrue(leave.waitForExistence(timeout: 10))
        // The demo has no token, so Settings shows no masked one (r6 gate).
        XCTAssertTrue(text(app, containing: "no server").waitForExistence(timeout: 5), "no demo address row")
        XCTAssertFalse(text(app, containing: "\u{2022}\u{2022}\u{2022}\u{2022}").exists,
                       "the demo's Settings shows a token the demo does not have")
        XCTAssertEqual(leave.value as? String, "blocked 0", "the demo refused a request for another host")
        scrollTo(leave, in: app)
        leave.tap()
        XCTAssertTrue(app.buttons["setup.tryDemo"].waitForExistence(timeout: 15), "Leave demo did not return to pairing")
    }

    /// Taps the Privacy Policy row and sees Safari come up, then returns to the app
    /// and closes Safari. The ONE place a UI test may attach to Safari, and only to
    /// wait for it and terminate it (UITestLaunchRatchetTests, by this name).
    private func checkThePrivacyPolicyOpensInSafari(_ app: XCUIApplication, _ policy: XCUIElement) {
        policy.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 20), "Privacy Policy did not open Safari")
        app.activate()
        safari.terminate()
        XCTAssertTrue(policy.waitForExistence(timeout: 15), "the app did not come back from Safari")
    }
}
