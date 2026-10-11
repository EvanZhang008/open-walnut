import XCTest

/// The Tasks tab as a person drives it: the page is a SESSION, the board is the drawer on
/// its left, a task tap lands in its conversation, and "Recently opened" is a page of the
/// drawer.
///
/// Paired tests: they need a server with a board (`WALNUT_UITEST_SERVER`, through
/// `ios-native/tests/ui/run-ui-tests.sh`), and they SKIP without one. Point it at an
/// isolated server, never production: opening a task marks it read, which is a write.
/// Nothing here completes, creates or deletes a task.
final class TasksDrawerUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launchPaired() throws -> XCUIApplication {
        guard
            let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
            let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"],
            !server.isEmpty, !token.isEmpty, !server.contains(":9/"), !server.hasSuffix(":9")
        else {
            throw XCTSkip("no paired server reached the runner (use tests/ui/run-ui-tests.sh)")
        }
        print("[uitest] runner server value: \(server)")
        return UITestLaunch.launch([
            "-walnut.serverUrl", UITestLaunch.pairedServer(server),
            "-walnut.deviceToken", token,
        ])
    }

    // MARK: - Helpers

    /// The drawer is OPEN exactly while its scrim (the closer beside it) exists. Not the
    /// board's list: the drawer stays mounted while shut (folded to one element, off
    /// screen), so the list's identifier is in the tree either way.
    private func board(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["tasks.drawer.scrim"]
    }

    /// The Tasks tab with its drawer open, and the board's rows once it has three.
    private func openBoard(_ app: XCUIApplication) throws -> XCUIElementQuery {
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 30), "the tab bar never appeared")
        tasks.tap()
        if !board(app).waitForExistence(timeout: 3) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "no board button on the Tasks page")
            menu.tap()
        }
        XCTAssertTrue(board(app).waitForExistence(timeout: 10), "the board drawer did not open")
        let rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'board.row.'"))
        let deadline = Date().addingTimeInterval(45)
        while rows.count < 3, Date() < deadline {
            _ = rows.firstMatch.waitForExistence(timeout: 2)
        }
        guard rows.count >= 3 else {
            attach(app, "board-not-ready")
            throw XCTSkip("the board has fewer than three rows (\(rows.count))")
        }
        return rows
    }

    private func recentsPage(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["tasks.recents.page"]
    }

    private func recentRows(_ app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.recents.row.'"))
    }

    /// From the board: the clock pushes Recently opened inside the drawer.
    private func openRecents(_ app: XCUIApplication) {
        let clock = app.buttons["tasks.recents"]
        XCTAssertTrue(clock.waitForExistence(timeout: 10), "no Recently opened button")
        clock.tap()
        XCTAssertTrue(recentsPage(app).waitForExistence(timeout: 5), "Recently opened did not open")
    }

    /// Back from Recently opened to the board, inside the drawer.
    private func backToBoard(_ app: XCUIApplication) {
        let back = app.navigationBars["Recently opened"].buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        waitGone(recentsPage(app), "Back did not leave Recently opened")
    }

    private func closeWithScrim(_ app: XCUIApplication) {
        let scrim = board(app)
        XCTAssertTrue(scrim.waitForExistence(timeout: 5))
        scrim.tap()
        waitGone(scrim, "the scrim did not close the drawer")
    }

    private func waitGone(_ element: XCUIElement, _ message: String) {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 5), .completed, message)
    }

    /// A drag from the screen's very left edge, at the height of `y`.
    private func edgeSwipe(_ app: XCUIApplication, atY y: CGFloat) {
        let window = app.windows.firstMatch
        let from = window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: 3, dy: y))
        let to = window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: 280, dy: y))
        from.press(forDuration: 0.05, thenDragTo: to)
    }

    private func clearHistory(_ app: XCUIApplication) {
        openRecents(app)
        let clear = app.buttons["tasks.recents.clear"]
        if clear.exists {
            clear.tap()
            let confirm = app.sheets.buttons["Clear"].exists
                ? app.sheets.buttons["Clear"] : app.buttons["Clear"].firstMatch
            XCTAssertTrue(confirm.waitForExistence(timeout: 5), "no Clear confirmation")
            confirm.tap()
        }
        XCTAssertTrue(
            app.descendants(matching: .any)["tasks.recents.empty"].waitForExistence(timeout: 5),
            "a cleared list shows the empty state"
        )
        backToBoard(app)
    }

    private func taskId(of row: XCUIElement) -> String {
        row.identifier.replacingOccurrences(of: "board.row.", with: "")
    }

    /// The tab switch is still settling when the rows first exist; a press then is refused.
    private func waitHittable(_ element: XCUIElement) {
        let ready = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: element)
        XCTAssertEqual(XCTWaiter().wait(for: [ready], timeout: 10), .completed,
                       "\(element.identifier) never became hittable")
    }

    /// Open the task's details through the row's long-press menu, then close the sheet.
    private func openDetails(_ app: XCUIApplication, row: XCUIElement) {
        waitHittable(row)
        row.press(forDuration: 1.0)
        let details = app.buttons["Details, dates & priority"]
        XCTAssertTrue(details.waitForExistence(timeout: 5), "no Details item in the row menu")
        details.tap()
        let title = app.navigationBars["Task"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "the task sheet did not open")
        title.buttons["Done"].tap()
        waitGone(title, "the task sheet did not close")
    }

    /// Tap rows until one opens a conversation; returns that row's task id. A row with
    /// no session opens a New Session draft instead, which is cancelled untouched, and
    /// the drawer is opened again for the next try.
    private func openSomeSession(_ app: XCUIApplication, rows: XCUIElementQuery, skipping: Set<String>) -> String? {
        for index in 0..<min(rows.count, 8) {
            let row = rows.element(boundBy: index)
            let id = taskId(of: row)
            guard !skipping.contains(id) else { continue }
            waitHittable(row)
            row.tap()
            if app.buttons["session.menu"].waitForExistence(timeout: 12) {
                waitGone(board(app), "opening a session left the drawer open over it")
                return id
            }
            let cancel = app.buttons["Cancel"].firstMatch
            if cancel.waitForExistence(timeout: 3) {
                cancel.tap()
                waitGone(cancel, "the New Session draft did not close")
            }
            if !board(app).exists { app.buttons["tasks.menu"].tap() }
        }
        return nil
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    // MARK: - A task tap is a session tap

    /// The whole point of the shape: a board row lands in its conversation, on the tab's
    /// page, with the drawer out of the way; the task's details are the session's title.
    func testABoardRowOpensItsSessionAndTheTitleOpensTheTask() throws {
        let app = try launchPaired()
        let rows = try openBoard(app)
        guard openSomeSession(app, rows: rows, skipping: []) != nil else {
            throw XCTSkip("no board row near the top has a session to open")
        }
        attach(app, "session-on-the-page")
        let title = app.buttons["session.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5), "the session title is not a button")
        title.tap()
        let sheet = app.navigationBars["Task"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "the title did not open the task")
        sheet.buttons["Done"].tap()
        waitGone(sheet, "the task sheet did not close")
        XCTAssertTrue(app.buttons["session.menu"].exists, "closing the task left the session")
    }

    // MARK: - Recently opened

    func testWhatWasOpenedIsListedNewestFirstAndReopens() throws {
        let app = try launchPaired()
        let rows = try openBoard(app)
        // The demo's sample history, as every launch of the demo starts it.
        openRecents(app)
        XCTAssertTrue(recentRows(app).firstMatch.waitForExistence(timeout: 5), "the demo has no sample history")
        let sample = recentRows(app).allElementsBoundByIndex.map(\.identifier)
        backToBoard(app)
        clearHistory(app)

        // 1. A task's details.
        let detailsRow = rows.element(boundBy: 0)
        let detailsId = taskId(of: detailsRow)
        openDetails(app, row: detailsRow)

        // 2. A conversation, opened from the board.
        guard let sessionId = openSomeSession(app, rows: rows, skipping: [detailsId]) else {
            throw XCTSkip("no board row near the top has a session to open")
        }

        // 3. The edge swipe opens the drawer over the session; the clock lists, newest first.
        edgeSwipe(app, atY: app.windows.firstMatch.frame.height * 0.55)
        XCTAssertTrue(board(app).waitForExistence(timeout: 5), "the edge swipe did not open the board")
        openRecents(app)
        let listed = recentRows(app)
        XCTAssertEqual(listed.count, 2)
        XCTAssertEqual(listed.element(boundBy: 0).identifier, "tasks.recents.row.\(sessionId)")
        XCTAssertEqual(listed.element(boundBy: 1).identifier, "tasks.recents.row.\(detailsId)")
        attach(app, "recents-two-rows")

        // 4. The conversation's row goes back to the conversation, and the drawer closes.
        listed.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["session.menu"].waitForExistence(timeout: 12),
                      "the row did not reopen its conversation")
        // The scrim, not the page: a shut drawer folds to one element that still carries
        // the identifier of the page it was left on.
        waitGone(board(app), "the drawer stayed open over the conversation")

        // The drawer comes back on the board, where its calendar and + are: a session put
        // on the page leaves Recently opened, as it ends a search (UI QA, 2026-10-11).
        app.buttons["tasks.menu"].tap()
        XCTAssertTrue(board(app).waitForExistence(timeout: 5), "the board button did not open the drawer")
        waitGone(app.navigationBars["Recently opened"], "the drawer came back on Recently opened")
        XCTAssertTrue(app.buttons["tasks.calendar"].waitForExistence(timeout: 5), "the board's toolbar is not back")

        // …and the details row's long press opens the details.
        openRecents(app)
        app.descendants(matching: .any)["tasks.recents.row.\(detailsId)"].press(forDuration: 1.0)
        let details = app.buttons["Task Details"]
        XCTAssertTrue(details.waitForExistence(timeout: 5), "no Task Details in the row's menu")
        details.tap()
        let sheet = app.navigationBars["Task"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "the menu did not open the task")
        sheet.buttons["Done"].tap()
        waitGone(sheet, "the task sheet did not close")

        // 5. Reopening moved it to the top, still one row per task.
        XCTAssertEqual(recentRows(app).count, 2)
        XCTAssertEqual(recentRows(app).element(boundBy: 0).identifier, "tasks.recents.row.\(detailsId)")
        closeWithScrim(app)

        // 6. A relaunch starts the demo again from its sample data, history included, and
        // the demo reopens nothing: the tab opens on the board. (Outside the demo a launch
        // reopens the newest session and the history survives: `RecentOpensTests`.)
        app.terminate()
        let again = try launchPaired()
        let tasks = again.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 30))
        tasks.tap()
        XCTAssertTrue(board(again).waitForExistence(timeout: 15), "the demo's tab did not open on the board")
        XCTAssertFalse(again.buttons["session.menu"].exists, "the demo reopened a session")
        openRecents(again)
        _ = recentRows(again).firstMatch.waitForExistence(timeout: 5)
        XCTAssertEqual(recentRows(again).allElementsBoundByIndex.map(\.identifier), sample,
                       "a relaunch did not start the demo's history again")
    }

    // MARK: - Gestures inside the drawer

    /// A sideways drag on the chip rail scrolls the rail; only a drag elsewhere closes
    /// the drawer.
    func testADragOnTheChipRailDoesNotCloseTheDrawer() throws {
        let app = try launchPaired()
        _ = try openBoard(app)
        let bar = app.descendants(matching: .any)["board.bandBar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 10), "no chip rail on the board")
        // Wait out the slide: the drag is aimed by the bar's frame, which moves with it.
        let deadline = Date().addingTimeInterval(5)
        while bar.frame.minX < 0, Date() < deadline { usleep(100_000) }
        let railFrame = bar.frame
        let from = bar.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: -200, dy: 0)))
        XCTAssertTrue(board(app).waitForExistence(timeout: 2),
                      "a drag on the chip rail closed the drawer (rail at \(railFrame))")
    }

    /// Pushing the drawer shut from a board row closes it, and neither opens nor swipes
    /// the row: a row's leading swipe COMPLETES its task, so a close drag that also
    /// swiped it would complete a task nobody meant to touch.
    func testDraggingTheDrawerShutFromARowLeavesTheRowAlone() throws {
        let app = try launchPaired()
        let rows = try openBoard(app)
        let row = rows.element(boundBy: 1)
        let ring = app.descendants(matching: .any)["board.ring.\(taskId(of: row))"]
        XCTAssertTrue(ring.waitForExistence(timeout: 5))
        let ringLabel = ring.label
        // What the page showed before the drag (a restored session, or the empty page).
        let pageTitle = app.buttons["session.title"].exists ? app.buttons["session.title"].label : nil
        let from = row.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: -240, dy: 0)))
        waitGone(board(app), "a leftward drag did not close the drawer")
        // Shut, the board is off screen and takes no touch. Its List rows stay in the
        // accessibility tree (the known gap `LeadingDrawerHost.keepsDrawerMounted` records).
        XCTAssertFalse(row.isHittable, "the shut drawer's row can still be touched")
        XCTAssertFalse(
            app.descendants(matching: .any)["newSessionChat.pathPill"].waitForExistence(timeout: 2),
            "the drag also opened the row's draft"
        )
        let after = app.buttons["session.title"].exists ? app.buttons["session.title"].label : nil
        XCTAssertEqual(after, pageTitle, "the drag also opened the row's session")
        app.buttons["tasks.menu"].tap()
        XCTAssertTrue(board(app).waitForExistence(timeout: 5))
        // Open again: rows and search field.
        XCTAssertTrue(ring.waitForExistence(timeout: 5), "the reopened board's rows are not in the accessibility tree")
        XCTAssertTrue(app.searchFields["Search tasks & sessions"].exists, "the reopened board has no search field")
        XCTAssertEqual(ring.label, ringLabel, "the row's done state changed")
        XCTAssertFalse(app.buttons["Reopen"].exists || app.buttons["Done"].exists,
                       "a swipe action is showing on a board row")
    }

    /// Over the calendar (a page pushed over the session) the left edge is the page's back
    /// swipe, never the drawer.
    func testTheEdgeSwipeOnTheCalendarGoesBack() throws {
        let app = try launchPaired()
        _ = try openBoard(app)
        let calendar = app.buttons["tasks.calendar"]
        XCTAssertTrue(calendar.waitForExistence(timeout: 5), "no calendar button on the board")
        calendar.tap()
        let page = app.navigationBars["Calendar"]
        XCTAssertTrue(page.waitForExistence(timeout: 10), "the calendar page did not open")
        waitGone(board(app), "the drawer stayed open over the calendar")
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
            .withOffset(CGVector(dx: 1, dy: 0))
        start.press(
            forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 300, dy: 0)),
            withVelocity: 600, thenHoldForDuration: 0
        )
        waitGone(page, "the edge swipe did not go back")
        XCTAssertFalse(board(app).exists, "the edge swipe opened the drawer over a pushed page")
    }
}
