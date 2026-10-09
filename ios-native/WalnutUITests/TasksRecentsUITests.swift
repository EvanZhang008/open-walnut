import XCTest

/// The Tasks tab's "Recently opened" drawer, driven like a person would: open things from
/// the board, find them again in the drawer, reopen them, and make sure the edge swipe
/// that opens it never touches the board rows it sits beside.
///
/// Paired tests: they need a server with a board (`WALNUT_UITEST_SERVER`, through
/// `ios-native/tests/ui/run-ui-tests.sh`), and they SKIP without one. Point it at an
/// isolated server, never production: opening a task marks it read, which is a write.
/// Nothing here completes, creates or deletes a task.
final class TasksRecentsUITests: XCTestCase {

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
        return UITestLaunch.launch([
            "-walnut.serverUrl", server,
            "-walnut.deviceToken", token,
        ])
    }

    // MARK: - Helpers

    private func boardRows(_ app: XCUIApplication) throws -> XCUIElementQuery {
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 30), "the tab bar never appeared")
        tasks.tap()
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

    private func drawer(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["tasks.recents.drawer"]
    }

    private func recentRows(_ app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.recents.row.'"))
    }

    private func openWithClock(_ app: XCUIApplication) {
        let clock = app.buttons["tasks.recents"]
        XCTAssertTrue(clock.waitForExistence(timeout: 10), "no Recently opened button")
        clock.tap()
        XCTAssertTrue(drawer(app).waitForExistence(timeout: 5), "the drawer did not open")
    }

    private func closeWithScrim(_ app: XCUIApplication) {
        let scrim = app.descendants(matching: .any)["tasks.recents.scrim"]
        XCTAssertTrue(scrim.waitForExistence(timeout: 5))
        scrim.tap()
        waitGone(drawer(app), "the scrim did not close the drawer")
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
        openWithClock(app)
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
        attach(app, "recents-empty")
        closeWithScrim(app)
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
    /// no session opens a New Session draft instead, which is cancelled untouched.
    private func openSomeSession(_ app: XCUIApplication, rows: XCUIElementQuery, skipping: Set<String>) -> String? {
        for index in 0..<min(rows.count, 8) {
            let row = rows.element(boundBy: index)
            let id = taskId(of: row)
            guard !skipping.contains(id) else { continue }
            waitHittable(row)
            row.tap()
            let menu = app.buttons["session.menu"]
            if menu.waitForExistence(timeout: 12) {
                return id
            }
            let cancel = app.buttons["Cancel"].firstMatch
            if cancel.waitForExistence(timeout: 3) {
                cancel.tap()
                waitGone(cancel, "the New Session draft did not close")
            }
        }
        return nil
    }

    private func goBack(_ app: XCUIApplication) {
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        waitGone(app.buttons["session.menu"], "the conversation did not close")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    // MARK: - The flow

    func testWhatWasOpenedIsListedNewestFirstAndReopens() throws {
        let app = try launchPaired()
        let rows = try boardRows(app)
        clearHistory(app)

        // 1. A task's details.
        let detailsRow = rows.element(boundBy: 0)
        let detailsId = taskId(of: detailsRow)
        openDetails(app, row: detailsRow)

        // 2. A conversation, opened from the board.
        guard let sessionId = openSomeSession(app, rows: rows, skipping: [detailsId]) else {
            throw XCTSkip("no board row near the top has a session to open")
        }
        goBack(app)

        // 3. The edge swipe opens the list, newest first.
        edgeSwipe(app, atY: app.windows.firstMatch.frame.height * 0.55)
        XCTAssertTrue(drawer(app).waitForExistence(timeout: 5), "the edge swipe did not open it")
        let listed = recentRows(app)
        XCTAssertEqual(listed.count, 2)
        XCTAssertEqual(listed.element(boundBy: 0).identifier, "tasks.recents.row.\(sessionId)")
        XCTAssertEqual(listed.element(boundBy: 1).identifier, "tasks.recents.row.\(detailsId)")
        attach(app, "recents-two-rows")

        // 4. The conversation's row goes back to the conversation…
        listed.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["session.menu"].waitForExistence(timeout: 12),
                      "the row did not reopen its conversation")
        waitGone(drawer(app), "the drawer stayed open over the conversation")
        goBack(app)

        // …and the details row to the details.
        openWithClock(app)
        app.descendants(matching: .any)["tasks.recents.row.\(detailsId)"].tap()
        let sheet = app.navigationBars["Task"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "the row did not reopen the task")
        attach(app, "recents-reopened-details")
        sheet.buttons["Done"].tap()
        waitGone(sheet, "the task sheet did not close")

        // 5. Reopening moved it to the top, still one row per task.
        openWithClock(app)
        XCTAssertEqual(recentRows(app).count, 2)
        XCTAssertEqual(recentRows(app).element(boundBy: 0).identifier, "tasks.recents.row.\(detailsId)")
        closeWithScrim(app)

        // 6. It survives a relaunch.
        app.terminate()
        let again = try launchPaired()
        _ = try boardRows(again)
        openWithClock(again)
        XCTAssertEqual(recentRows(again).count, 2, "the list did not survive a relaunch")
        XCTAssertEqual(recentRows(again).element(boundBy: 0).identifier, "tasks.recents.row.\(detailsId)")
        closeWithScrim(again)
    }

    /// The edge swipe claims only the margin beside the rows. A row's own leading swipe
    /// COMPLETES its task, so a swipe that opened the drawer and also swiped the row
    /// would complete a task nobody meant to touch.
    func testTheEdgeSwipeNeverSwipesTheRowBesideIt() throws {
        let app = try launchPaired()
        let rows = try boardRows(app)
        let row = rows.element(boundBy: 1)
        let ring = app.descendants(matching: .any)["board.ring.\(taskId(of: row))"]
        XCTAssertTrue(ring.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(ring.frame.minX, 16, "the ring reaches into the drawer's edge zone")
        let ringLabel = ring.label
        let rowX = row.frame.minX

        edgeSwipe(app, atY: row.frame.midY)
        XCTAssertTrue(drawer(app).waitForExistence(timeout: 5), "the edge swipe did not open it")
        closeWithScrim(app)

        XCTAssertEqual(row.frame.minX, rowX, accuracy: 0.5, "the row slid: its swipe was revealed")
        XCTAssertEqual(ring.label, ringLabel, "the row's done state changed")
        XCTAssertFalse(app.buttons["Reopen"].exists || app.buttons["Done"].exists,
                       "a swipe action is showing on a board row")
    }

    /// On a pushed conversation the left edge belongs to the page's back swipe.
    func testTheEdgeSwipeOnAConversationStillGoesBack() throws {
        let app = try launchPaired()
        let rows = try boardRows(app)
        guard openSomeSession(app, rows: rows, skipping: []) != nil else {
            throw XCTSkip("no board row near the top has a session to open")
        }
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
            .withOffset(CGVector(dx: 1, dy: 0))
        start.press(
            forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 300, dy: 0)),
            withVelocity: 600, thenHoldForDuration: 0
        )
        waitGone(app.buttons["session.menu"], "the edge swipe did not go back")
        XCTAssertFalse(drawer(app).exists, "the edge swipe opened the drawer over a pushed page")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5), "not back on the board")
    }

    /// A scroll that starts on the edge stays a scroll.
    func testAScrollDownTheEdgeScrollsTheBoard() throws {
        let app = try launchPaired()
        let rows = try boardRows(app)
        let row = rows.element(boundBy: 2)
        let before = row.frame.minY
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: 6, dy: window.frame.height * 0.75))
        let end = window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: 10, dy: window.frame.height * 0.35))
        start.press(forDuration: 0.05, thenDragTo: end)
        XCTAssertFalse(drawer(app).exists, "a vertical drag opened the drawer")
        XCTAssertLessThan(row.frame.minY, before - 40, "the board did not scroll")
    }

    /// Pushing the drawer shut from one of its own rows must not also open that row.
    func testDraggingTheDrawerShutDoesNotOpenTheRowUnderTheFinger() throws {
        let app = try launchPaired()
        let rows = try boardRows(app)
        openDetails(app, row: rows.element(boundBy: 0))
        openWithClock(app)
        let first = recentRows(app).element(boundBy: 0)
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        let from = first.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
        let to = from.withOffset(CGVector(dx: -240, dy: 0))
        from.press(forDuration: 0.05, thenDragTo: to)
        waitGone(drawer(app), "a leftward drag did not close the drawer")
        XCTAssertFalse(app.navigationBars["Task"].waitForExistence(timeout: 2),
                       "the drag also opened the row it started on")
    }
}
