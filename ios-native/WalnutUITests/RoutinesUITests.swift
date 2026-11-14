import XCTest

/// The Routines screen at a real density (2026-11-04, the user: "routine page should
/// be seperate by global routine and each peoject routine so messy and deault
/// firsvpage show min.info"): the global routines first, then one section per
/// project; each routine one line until it is opened; a failing one first in its
/// section; a folded section stays folded after a relaunch; the switch, Run Now
/// and Delete still work from the opened row. And (2026-11-04, the console's row on
/// the phone): what a routine sends and its history fold open in the opened row, Edit
/// saves with PATCH, "+" creates one with POST and opens it, and a stopped or paused
/// row says why when opened.
///
/// The app is paired to `ChatPlaceFixtureServer` with this file's routines on top
/// (`extraRoutes`), so it runs anywhere, CI included, with nobody's data. Each step
/// attaches a screenshot.
final class RoutinesUITests: XCTestCase {

    private var fixture: ChatPlaceFixtureServer?
    private var store = RoutineFixtures()

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        store = RoutineFixtures()
        let server = try ChatPlaceFixtureServer()
        let store = self.store
        server.extraRoutes = { method, path, body in store.route(method: method, path: path, body: body) }
        try server.start()
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    private var arguments: [String] = []

    private func launchPaired() throws -> XCUIApplication {
        let server = try XCTUnwrap(fixture).url
        let token = "routines-fixture"
        arguments = ["-walnut.serverUrl", server, "-walnut.deviceToken", token]
        let app = UITestLaunch.launch(arguments)
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "the app never opened")
        return app
    }

    private func openRoutines(_ app: XCUIApplication) {
        app.tabBars.buttons["Settings"].tap()
        let entry = app.buttons["settings.routines"].firstMatch
        if !entry.waitForExistence(timeout: 10) { app.swipeUp() }
        XCTAssertTrue(entry.waitForExistence(timeout: 10), "no Routines row in Settings")
        entry.tap()
        XCTAssertTrue(element(app, "routines.group.global").waitForExistence(timeout: 20), "the routines never loaded")
    }

    /// Scroll a little at a time until the element is above the tab bar (a swipe goes a
    /// page, which carries what is just above it out of the shot).
    private func nudge(_ app: XCUIApplication, _ target: XCUIElement) {
        let bottom = app.tabBars.firstMatch.exists ? app.tabBars.firstMatch.frame.minY : app.frame.maxY
        var tries = 0
        while target.exists, target.frame.maxY > bottom - 8, tries < 8 {
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55)))
            tries += 1
        }
    }

    /// Drag a little at a time until the element's top is between `low` and `high` points
    /// under the navigation bar: clear of the bar, and high enough that what opens under
    /// it fits above the tab bar (so a check for a jump does not meet the reveal).
    private func place(_ app: XCUIApplication, _ target: XCUIElement, low: CGFloat = 60, high: CGFloat = 160) {
        var drags = 0
        while target.exists, drags < 8 {
            let bar = app.navigationBars.firstMatch.frame.maxY
            let y = target.frame.minY
            if y < bar + low {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.53)))
            } else if y > bar + high {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.53))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)))
            } else { break }
            drags += 1
        }
    }

    /// Where the tab bar starts: what must be seen stays above it.
    private func tabTop(_ app: XCUIApplication) -> CGFloat {
        app.tabBars.firstMatch.exists ? app.tabBars.firstMatch.frame.minY : app.frame.maxY
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    /// "Paused 40m ago" (a minute or two more by the time the row is opened).
    private func pausedSince(_ app: XCUIApplication) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "Paused 4[0-9]m ago")).firstMatch
    }

    /// Let an open or a scroll finish its animation before a screenshot or a frame check.
    private func settle() { usleep(900_000) }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Scroll until the element is on screen (a long list), at most a few pages.
    private func reveal(_ app: XCUIApplication, _ target: XCUIElement, up: Bool = false) {
        var tries = 0
        while !(target.exists && target.isHittable), tries < 12 {
            if up { app.swipeDown() } else { app.swipeUp() }
            tries += 1
        }
    }

    func testGroupedFirstScreenOpenAndActions() throws {
        let app = try launchPaired()
        openRoutines(app)
        // The page's count over the groups, as the console's toolbar.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "[0-9]+ routines")).firstMatch.exists, "no page count")
        let failingCount = element(app, "routines.summaryFailing")
        XCTAssertTrue(failingCount.exists, "the page count does not say how many fail")
        XCTAssertEqual(failingCount.label, "3 failing")
        shot("01-first-screen")
        // It takes you to the first failing routine.
        failingCount.tap()
        settle()
        XCTAssertTrue(element(app, "routines.row.r-router").isHittable, "the failing count did not show the failing routine")
        shot("01a-failing-count-jump")
        reveal(app, element(app, "routines.group.global"), up: true)

        // Global first, then the projects by name.
        let order = ["routines.group.global", "routines.group.project:Acme", "routines.group.project:Home Ops"]
        var previous: XCUIElement?
        for id in order {
            let header = element(app, id)
            reveal(app, header)
            XCTAssertTrue(header.exists, "no section header \(id)")
            // The one before is above it: on screen higher up, or scrolled off the top.
            if let previous, previous.exists, previous.isHittable {
                XCTAssertGreaterThan(header.frame.minY, previous.frame.minY, "\(id) is out of order")
            }
            previous = header
        }
        XCTAssertTrue(element(app, "routines.group.project:Home Ops").label.contains("1 failing"))

        // The failing routine leads its section.
        let failing = element(app, "routines.row.r-router")
        let calm = element(app, "routines.row.r-backup")
        reveal(app, failing)
        XCTAssertTrue(failing.exists)
        reveal(app, calm)
        XCTAssertLessThan(failing.frame.minY, calm.frame.minY, "the failing routine is not first in Home Ops")

        // One line until opened; opened, it shows its task, its error and its actions.
        XCTAssertFalse(app.buttons["routines.run.r-router"].exists, "actions show before the row is opened")
        failing.tap()
        let run = app.buttons["routines.run.r-router"]
        XCTAssertTrue(run.waitForExistence(timeout: 5), "the row did not open")
        XCTAssertTrue(app.staticTexts["Home Ops watcher"].exists, "the opened row does not name its task")
        // The error names the task by its title, and says what to do about a done task.
        let error = element(app, "routines.error.r-router")
        XCTAssertTrue(error.exists, "the opened row does not show the error")
        XCTAssertEqual(error.label, "Its task \"Home Ops watcher\" is complete, so its last run went nowhere.")
        XCTAssertFalse(error.label.contains("t-home-ops"), "the raw task id is shown: \(error.label)")
        XCTAssertEqual(element(app, "routines.errorNext.r-router").label, "Point it at an open task with Edit, or turn it off.")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Every hour\nNext run")).firstMatch.exists,
                      "the opened row does not say when it runs next")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "2[0-9]m ago")).firstMatch.exists,
                      "the last run is not shown")
        // The box says it failed: the Last run fact only says when.
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "2[0-9]m ago · failed")).firstMatch.exists,
                       "Last run says \"failed\" again under the red box")
        settle()
        shot("02-failing-row-open")

        XCTAssertEqual(run.label, "Run now")
        XCTAssertFalse(element(app, "routines.historyFold.r-router").exists, "a History fold with nothing in it")
        // The four actions on one line at the default size.
        let rowDelete = app.buttons["routines.delete.r-router"]
        XCTAssertEqual(rowDelete.frame.midY, run.frame.midY, accuracy: 2, "Delete went to a line of its own")
        XCTAssertEqual(app.buttons["routines.openTask.r-router"].frame.midY, run.frame.midY, accuracy: 2)

        // Run now into a complete task: the server answers "ran" before it delivers, so
        // the row says Started, then, once the routine shows the failed run, says so.
        run.tap()
        let outcome = element(app, "routines.runOutcome.r-router")
        XCTAssertTrue(outcome.waitForExistence(timeout: 5), "Run now said nothing")
        let failed = expectation(for: NSPredicate(format: "label CONTAINS %@", "It ran and failed: the reason is above."), evaluatedWith: outcome)
        wait(for: [failed], timeout: 12)
        XCTAssertFalse(outcome.label.contains("Started"))
        XCTAssertEqual(store.ran, ["r-router"])
        XCTAssertTrue(app.staticTexts["just now"].waitForExistence(timeout: 5), "Last run did not update after Run now")
        XCTAssertTrue(store.fetched.contains("r-router"), "Run now did not fetch the routine again")
        // The list brought what Run now said above the tab bar by itself.
        settle()
        XCTAssertLessThanOrEqual(outcome.frame.maxY, tabTop(app), "what Run now said is under the tab bar")
        XCTAssertGreaterThanOrEqual(outcome.frame.minY, app.navigationBars.firstMatch.frame.maxY)
        shot("03-run-now")
        // Open task: the task it runs in, in the app's own task sheet.
        let openTask = app.buttons["routines.openTask.r-router"]
        XCTAssertTrue(openTask.exists, "no Open task on a routine with a task")
        openTask.tap()
        // Its task is asked for and shown over the list.
        let asked = expectation(for: NSPredicate { _, _ in self.store.taskDetails.contains("t-home-ops") }, evaluatedWith: nil)
        wait(for: [asked], timeout: 15)
        settle()
        XCTAssertFalse(openTask.isHittable, "the task sheet did not open over the routine")
        shot("37-open-task")
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
        top.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        let back = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: openTask)
        wait(for: [back], timeout: 5)
        // Back from its task: the row is still open, where it was.
        XCTAssertTrue(app.buttons["routines.run.r-router"].isHittable, "the row closed or went out of view behind the task")
        settle()
        shot("37b-back-from-task")

        // Opening another row closes the first. Its run lands ok: "Ran just now", then gone.
        reveal(app, calm)
        calm.tap()
        XCTAssertTrue(app.buttons["routines.delete.r-backup"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["routines.run.r-router"].exists, "two rows are open at once")
        let backupRun = app.buttons["routines.run.r-backup"]
        reveal(app, backupRun)
        backupRun.tap()
        let backupOutcome = element(app, "routines.runOutcome.r-backup")
        XCTAssertTrue(backupOutcome.waitForExistence(timeout: 5))
        let ranOk = expectation(for: NSPredicate(format: "label CONTAINS %@", "Ran just now"), evaluatedWith: backupOutcome)
        wait(for: [ranOk], timeout: 12)
        usleep(500_000)
        XCTAssertLessThanOrEqual(backupOutcome.frame.maxY, tabTop(app), "\"Ran just now\" is under the tab bar")
        shot("26-ran-just-now")
        let cleared = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: backupOutcome)
        wait(for: [cleared], timeout: 10)

        // The switch pauses, and the row says so in place.
        let toggle = app.switches["routines.toggle.r-backup"]
        reveal(app, toggle)
        toggle.tap()
        let paused = NSPredicate(format: "label CONTAINS %@", "Paused")
        XCTAssertTrue(element(app, "routines.row.r-backup").waitForExistence(timeout: 5))
        let pausedRow = expectation(for: paused, evaluatedWith: element(app, "routines.row.r-backup"))
        wait(for: [pausedRow], timeout: 5)
        XCTAssertEqual(store.toggled, ["r-backup"])
        settle()
        shot("04-paused")

        // Delete asks first, then the row is gone.
        app.buttons["routines.delete.r-backup"].tap()
        let confirm = app.buttons["Delete Routine"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertTrue(store.deleted.isEmpty, "Delete went through before it was confirmed")
        settle()
        shot("04a-delete-confirm")
        confirm.tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element(app, "routines.row.r-backup"))
        wait(for: [gone], timeout: 5)
        XCTAssertEqual(store.deleted, ["r-backup"])
        shot("05-deleted")
    }

    /// The same screen at a large text size: it stays one line a routine, nothing
    /// overlaps, and the failing word still reads. In dark mode when the simulator is
    /// dark (tests/fleet/run-dark.sh runs this one that way).
    func testDarkModeAndLargeText() throws {
        try XCTSkipIf(fixture == nil)
        let server = try XCTUnwrap(fixture).url
        let token = "routines-fixture"
        arguments = ["-walnut.serverUrl", server, "-walnut.deviceToken", token,
                     "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXL"]
        let app = UITestLaunch.launch(arguments)
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "the app never opened")
        openRoutines(app)
        shot("08-dark-xxl-first-screen")
        let failing = element(app, "routines.row.r-router")
        reveal(app, failing)
        failing.tap()
        XCTAssertTrue(app.buttons["routines.run.r-router"].waitForExistence(timeout: 5))
        // Opening keeps the routine's own line in view, under the bar, not cut by it.
        sleep(1)
        XCTAssertTrue(failing.isHittable, "the opened row's line went out of view")
        XCTAssertGreaterThanOrEqual(failing.frame.minY, app.navigationBars.firstMatch.frame.maxY - 1,
                                    "the opened row's line is under the navigation bar")
        shot("09-dark-xxl-row-open")

        // Its folds open at this size too.
        let sendsFold = element(app, "routines.sendsFold.r-router")
        reveal(app, sendsFold)
        sendsFold.tap()
        XCTAssertTrue(element(app, "routines.sends.r-router").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "routines.historyFold.r-router").exists, "a History fold with nothing in it")
        settle()
        shot("18-dark-xxl-folds-open")

        // The action buttons stack and stay tappable; the Edit sheet fits.
        let edit = app.buttons["routines.edit.r-router"]
        let delete = app.buttons["routines.delete.r-router"]
        reveal(app, edit)
        nudge(app, delete)
        settle()
        XCTAssertTrue(edit.isHittable)
        XCTAssertLessThanOrEqual(delete.frame.maxY, tabTop(app), "Delete is under the tab bar")
        // Two even lines at this size: Run now and Edit, Open task and Delete.
        let run = app.buttons["routines.run.r-router"]
        let openTask = app.buttons["routines.openTask.r-router"]
        XCTAssertEqual(edit.frame.midY, run.frame.midY, accuracy: 2, "Run now and Edit are not on one line")
        XCTAssertEqual(delete.frame.midY, openTask.frame.midY, accuracy: 2, "Delete sits alone on its line")
        XCTAssertGreaterThan(openTask.frame.minY, run.frame.maxY - 1, "the four are on one line at this size")
        shot("19-dark-xxl-actions")
        edit.tap()
        XCTAssertTrue(app.textFields["routines.editor.name"].waitForExistence(timeout: 5))
        shot("20-dark-xxl-edit-sheet")
        app.buttons["routines.editor.cancel"].tap()
        XCTAssertTrue(store.patched.isEmpty, "Cancel saved something")

        // A paused row at this size: readable, and its details say since when.
        let paused = element(app, "routines.row.r-acme-4")
        reveal(app, paused, up: true)
        reveal(app, paused)
        paused.tap()
        XCTAssertTrue(pausedSince(app).waitForExistence(timeout: 5), "the opened paused row does not say since when")
        settle()
        shot("21-dark-xxl-paused-open")
    }

    /// What it sends and its history fold open in the opened row; Edit renames it with PATCH.
    func testPromptHistoryAndEdit() throws {
        let app = try launchPaired()
        openRoutines(app)
        let row = element(app, "routines.row.r-marina-1")
        reveal(app, row)
        row.tap()
        let sendsFold = element(app, "routines.sendsFold.r-marina-1")
        XCTAssertTrue(sendsFold.waitForExistence(timeout: 5), "no fold for what it sends")
        XCTAssertTrue(sendsFold.label.contains("What it sends when the check finds something"), sendsFold.label)
        let checkFact = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "Runs sh check-pipeline.sh on devbox\nLast check: [0-9]+m ago")).firstMatch
        XCTAssertTrue(checkFact.exists, "the Check fact does not say what it runs and when it last checked (the box says it failed)")
        XCTAssertTrue(element(app, "routines.error.r-marina-1").label.contains("exit code 2: the pipeline page timed out"))
        XCTAssertEqual(element(app, "routines.errorNext.r-marina-1").label, "Fix the check command with Edit.")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "Woke its task once, 9 min ago · at most 6 a day")).firstMatch.exists,
                      "no Activity fact in plain words with its daily budget")
        XCTAssertFalse(element(app, "routines.sends.r-marina-1").exists, "the fold starts open")
        reveal(app, sendsFold)
        sendsFold.tap()
        let sends = element(app, "routines.sends.r-marina-1")
        XCTAssertTrue(sends.waitForExistence(timeout: 5))
        XCTAssertTrue(sends.label.contains("payments pipeline"), sends.label)
        settle()
        shot("10-prompt-fold-open")

        let historyFold = element(app, "routines.historyFold.r-marina-1")
        reveal(app, historyFold)
        XCTAssertTrue(historyFold.label.contains("History (3 recorded checks)"), historyFold.label)
        historyFold.tap()
        let history = element(app, "routines.historyList.r-marina-1")
        XCTAssertTrue(history.waitForExistence(timeout: 5))
        let first = history.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "The check failed (exit code 2)")).firstMatch
        let last = history.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Quiet: the check found nothing")).firstMatch
        XCTAssertTrue(first.exists && last.exists, "the history rows are missing")
        nudge(app, last)
        XCTAssertLessThan(first.frame.minY, last.frame.minY, "the history is not newest first")
        settle()
        shot("11-history-fold-open")

        // Edit: a new name, saved with PATCH; the row shows it.
        let edit = app.buttons["routines.edit.r-marina-1"]
        reveal(app, edit)
        edit.tap()
        let name = app.textFields["routines.editor.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5), "the Edit sheet did not open")
        XCTAssertEqual(name.value as? String, "Pipeline watch: payments")
        // At its end, so the deletes take the whole name.
        name.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40))
        XCTAssertFalse(app.buttons["routines.editor.save"].isEnabled, "Save is on with no name")
        name.typeText("Payments pipeline watch")
        XCTAssertTrue(app.buttons["routines.editor.save"].isEnabled)
        shot("12-edit-sheet")
        // Under its Task and Schedule: the trigger's check command.
        var swipes = 0
        while !(app.textFields["routines.editor.check"].exists || app.textViews["routines.editor.check"].exists), swipes < 5 {
            app.swipeUp()
            swipes += 1
        }
        XCTAssertTrue(app.textFields["routines.editor.check"].exists || app.textViews["routines.editor.check"].exists,
                      "a trigger's sheet has no check command")
        app.buttons["routines.editor.save"].tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: name)
        wait(for: [closed], timeout: 5)
        XCTAssertEqual(store.patched.count, 1)
        XCTAssertEqual(store.patched.first?.id, "r-marina-1")
        XCTAssertEqual(store.patched.first?.body["name"] as? String, "Payments pipeline watch")
        XCTAssertEqual(Set(store.patched.first?.body.keys.map { $0 } ?? []), ["name"], "an unchanged schedule or prompt was sent")
        let renamed = element(app, "routines.row.r-marina-1")
        reveal(app, renamed, up: true)
        XCTAssertTrue(renamed.label.hasPrefix("Payments pipeline watch,"), renamed.label)
        settle()
        shot("13-edit-saved")
    }

    /// "+" opens the same sheet empty; Create posts a routine that runs in Walnut and opens it.
    func testNewRoutine() throws {
        let app = try launchPaired()
        openRoutines(app)
        app.buttons["routines.new"].tap()
        let name = app.textFields["routines.editor.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5), "the New Routine sheet did not open")
        let save = app.buttons["routines.editor.save"]
        XCTAssertFalse(save.isEnabled, "Create is on for an empty routine")
        name.tap()
        name.typeText("Stretch break")
        XCTAssertFalse(save.isEnabled, "Create is on with nothing to send")
        let sends = app.textFields["routines.editor.sends"].exists ? app.textFields["routines.editor.sends"] : app.textViews["routines.editor.sends"]
        sends.tap()
        sends.typeText("Remind me to stand up and stretch.")
        XCTAssertTrue(save.isEnabled)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Runs in Home Chat")).firstMatch.exists,
                      "the sheet does not name where it runs as the row does")
        shot("14-new-routine-sheet")
        save.tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: name)
        wait(for: [closed], timeout: 5)
        let body = try XCTUnwrap(store.created.first)
        XCTAssertEqual(body["name"] as? String, "Stretch break")
        let executor = try XCTUnwrap(body["executor"] as? [String: Any])
        XCTAssertEqual(executor["type"] as? String, "main-agent")
        XCTAssertEqual((executor["config"] as? [String: Any])?["instructions"] as? String, "Remind me to stand up and stretch.")
        let schedule = try XCTUnwrap(body["schedule"] as? [String: Any])
        XCTAssertEqual(schedule["kind"] as? String, "cron")
        XCTAssertEqual(schedule["expr"] as? String, "0 9 * * *")
        // The new row is listed and shown open.
        let row = element(app, "routines.row.r-created-1")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the new routine is not listed")
        XCTAssertTrue(app.buttons["routines.edit.r-created-1"].waitForExistence(timeout: 5), "the new routine is not opened")
        sleep(1)
        XCTAssertTrue(app.buttons["routines.edit.r-created-1"].isHittable, "the new routine is not in view")
        XCTAssertTrue(app.staticTexts["Home Chat"].exists, "the opened row does not say it runs in Home Chat, as the sheet did")
        settle()
        shot("15-new-routine-open")
    }

    /// A stopped trigger and a paused routine, opened: each says why it is quiet.
    func testStoppedAndPausedRowsOpened() throws {
        let app = try launchPaired()
        openRoutines(app)
        let stopped = element(app, "routines.row.r-marina-stopped")
        reveal(app, stopped)
        XCTAssertTrue(stopped.label.contains("Checks every 5 min"), stopped.label)
        XCTAssertFalse(stopped.label.contains("Stopped after"), "the row repeats the stop: \(stopped.label)")
        stopped.tap()
        XCTAssertTrue(app.staticTexts["Stopped after 5 failed checks"].waitForExistence(timeout: 5))
        // Stopped after failed checks, so its last check failed (never "Not checked yet").
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "Last check: 6m ago")).firstMatch.exists,
                      "the stopped trigger's last check does not say when (the box says it failed)")
        XCTAssertTrue(element(app, "routines.error.r-marina-stopped").label.contains("exit 1: release.sh"))
        XCTAssertEqual(element(app, "routines.errorNext.r-marina-stopped").label, "Fix the check command with Edit, then Resume.")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "ot checked yet")).firstMatch.exists)
        XCTAssertTrue(element(app, "routines.historyFold.r-marina-stopped").label.contains("History (5 recorded checks)"))
        XCTAssertFalse(app.buttons["routines.run.r-marina-stopped"].exists, "a stopped trigger offers Run check now")
        XCTAssertTrue(app.buttons["routines.edit.r-marina-stopped"].exists)
        let resume = app.buttons["routines.resume.r-marina-stopped"]
        XCTAssertTrue(resume.exists, "a stopped trigger offers no Resume beside why it stopped")
        settle()
        shot("16-stopped-trigger-open")
        // Resume switches it on, and the routine is fetched so its next check shows.
        resume.tap()
        let resumed = expectation(for: NSPredicate(format: "label CONTAINS %@", "· next in"), evaluatedWith: stopped)
        wait(for: [resumed], timeout: 5)
        XCTAssertEqual(store.toggled, ["r-marina-stopped"])
        XCTAssertTrue(store.fetched.contains("r-marina-stopped"), "Resume did not fetch the routine")

        let paused = element(app, "routines.row.r-acme-4")
        reveal(app, paused, up: true)
        XCTAssertTrue(paused.label.contains("Paused · "), paused.label)
        XCTAssertFalse(paused.label.contains("ago"), "the paused row says ago: \(paused.label)")
        paused.tap()
        XCTAssertTrue(pausedSince(app).waitForExistence(timeout: 5), "the opened paused row does not say since when")
        XCTAssertTrue(app.buttons["routines.run.r-acme-4"].isEnabled, "a paused routine's Run Now is off")
        settle()
        shot("17-paused-row-open")

        // A run the engine refuses (a 200 that says error) shows why, never "Started".
        let refused = element(app, "routines.row.\(RoutineFixtures.refusedRun)")
        reveal(app, refused, up: true)
        refused.tap()
        let run = app.buttons["routines.run.\(RoutineFixtures.refusedRun)"]
        XCTAssertTrue(run.waitForExistence(timeout: 5))
        run.tap()
        let why = element(app, "routines.runOutcome.\(RoutineFixtures.refusedRun)")
        XCTAssertTrue(why.waitForExistence(timeout: 5), "a refused run shows no reason")
        XCTAssertTrue(why.label.contains("Did not run: \(RoutineFixtures.refusal)"), why.label)
        XCTAssertFalse(run.label.contains("Started"), "a refused run says Started")
        XCTAssertEqual(store.ran, [RoutineFixtures.refusedRun])
        settle()
        shot("22-run-refused")
    }

    /// A switch and a delete the server refuses: each says so on its own row, in place,
    /// and the row is as it was (the switch back on, the row back and open).
    func testRefusedSwitchAndDeleteSayItOnTheRow() throws {
        let app = try launchPaired()
        openRoutines(app)
        let id = RoutineFixtures.refusedWrites
        let row = element(app, "routines.row.\(id)")
        reveal(app, row)
        let toggle = app.switches["routines.toggle.\(id)"]
        nudge(app, toggle)
        settle()
        let top = row.frame.minY
        XCTAssertEqual(toggle.value as? String, "1")
        toggle.tap()
        let failure = element(app, "routines.rowError.\(id)")
        XCTAssertTrue(failure.waitForExistence(timeout: 5), "a refused switch says nothing")
        XCTAssertTrue(failure.label.contains("Could not pause it: \(RoutineFixtures.writeRefusal)"), failure.label)
        XCTAssertEqual(store.toggled, [id])
        let back = expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: toggle)
        wait(for: [back], timeout: 5)
        XCTAssertEqual(row.frame.minY, top, accuracy: 1, "the refused row moved")
        XCTAssertGreaterThan(failure.frame.minY, row.frame.minY, "the failure is not under its row")
        settle()
        shot("27-switch-refused")

        // Delete, refused: the row is back where it was, open, and says why.
        row.tap()
        let delete = app.buttons["routines.delete.\(id)"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        reveal(app, delete)
        delete.tap()
        let confirm = app.buttons["Delete Routine"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(failure.waitForExistence(timeout: 5), "a refused delete says nothing")
        XCTAssertTrue(failure.label.contains("Could not delete it: \(RoutineFixtures.writeRefusal)"), failure.label)
        XCTAssertEqual(store.deleted, [id])
        XCTAssertTrue(row.exists, "the refused delete took the row away")
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "the row is not open again")
        nudge(app, delete)
        settle()
        shot("28-delete-refused")
        // Dismissed, it goes.
        element(app, "routines.rowErrorDismiss.\(id)").tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: failure)
        wait(for: [gone], timeout: 5)
    }

    /// Edit's Task: the routine's task by title and project, said plainly to be complete;
    /// open tasks found by title; a pick saved sends the executor back with the new task.
    func testEditPointsTheRoutineAtAnOpenTask() throws {
        let app = try launchPaired()
        openRoutines(app)
        let row = element(app, "routines.row.r-router")
        reveal(app, row)
        row.tap()
        let edit = app.buttons["routines.edit.r-router"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        reveal(app, edit)
        edit.tap()
        let current = element(app, "routines.editor.taskCurrent")
        XCTAssertTrue(current.waitForExistence(timeout: 5), "the Edit sheet has no Task")
        let complete = expectation(for: NSPredicate(format: "label CONTAINS %@", "complete: change it to an open task"), evaluatedWith: current)
        wait(for: [complete], timeout: 5)
        XCTAssertTrue(current.label.contains("Home Ops watcher"), current.label)
        XCTAssertTrue(current.label.contains("Home Ops"), current.label)
        // The first screen is the current task and one row: the schedule still shows.
        XCTAssertFalse(element(app, "routines.editor.taskSearch").exists, "the search shows before Change task")
        XCTAssertFalse(element(app, "routines.editor.taskHit.t-router-fw").exists, "a list of tasks before Change task")
        XCTAssertTrue(element(app, "routines.editor.repeat").isHittable, "the schedule is pushed off the first screen")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Every few hours")).firstMatch.exists,
                      "the interval choice does not read as words")
        settle()
        shot("29a-edit-first-screen")
        app.buttons["routines.editor.changeTask"].tap()
        // The latest open tasks before anything is typed; a complete one never.
        XCTAssertTrue(element(app, "routines.editor.taskHit.t-router-fw").waitForExistence(timeout: 5), "no open tasks offered")
        XCTAssertFalse(element(app, "routines.editor.taskHit.t-router-old").exists, "a complete task is offered")
        XCTAssertTrue(store.taskQueries.contains { $0["ids"] == "t-home-ops" }, "the current task was not looked up")
        settle()
        shot("29-edit-task-section")

        let search = app.textFields["routines.editor.taskSearch"]
        search.tap()
        search.typeText("firmware")
        let narrowed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element(app, "routines.editor.taskHit.t-router-swap"))
        wait(for: [narrowed], timeout: 5)
        let hit = element(app, "routines.editor.taskHit.t-router-fw")
        XCTAssertTrue(hit.exists, "the search lost its match")
        let sent = try XCTUnwrap(store.taskQueries.last { $0["q"] == "firmware" }, "the search never reached the server")
        XCTAssertEqual(sent["completion"], "todo,in_progress")
        XCTAssertEqual(sent["sort"], "updated_desc")
        XCTAssertEqual(sent["fields"], "list")
        XCTAssertEqual(sent["limit"], "8")
        settle()
        shot("30-edit-task-search")

        hit.tap()
        let picked = expectation(for: NSPredicate(format: "label CONTAINS %@", "Router firmware upgrade"), evaluatedWith: current)
        wait(for: [picked], timeout: 5)
        XCTAssertFalse(current.label.contains("complete"), current.label)
        settle()
        shot("31-task-picked")

        app.buttons["routines.editor.save"].tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: current)
        wait(for: [closed], timeout: 5)
        let patch = try XCTUnwrap(store.patched.first)
        XCTAssertEqual(patch.id, "r-router")
        let executor = try XCTUnwrap(patch.body["executor"] as? [String: Any], "the executor was not sent")
        XCTAssertEqual(executor["type"] as? String, "session")
        let config = try XCTUnwrap(executor["config"] as? [String: Any])
        XCTAssertEqual(config["target"] as? String, "t-router-fw")
        XCTAssertTrue((config["prompt"] as? String)?.hasPrefix("Ping the router") == true, "what it sends was lost")
        XCTAssertNil(patch.body["schedule"], "an unchanged schedule was sent")

        // The opened row names its new task, and the old failure no longer asks for Edit.
        XCTAssertTrue(app.staticTexts["Router firmware upgrade"].waitForExistence(timeout: 5), "the row does not name its new task")
        let error = element(app, "routines.error.r-router")
        XCTAssertTrue(error.label.contains("the task it ran in then was complete"), error.label)
        XCTAssertEqual(element(app, "routines.errorNext.r-router").label, "It runs in \"Router firmware upgrade\" from its next run.")
        // No longer failing: the row and the header say so (the box still explains).
        let fixed = element(app, "routines.row.r-router")
        XCTAssertFalse(fixed.label.contains("failed"), fixed.label)
        XCTAssertFalse(element(app, "routines.group.project:Home Ops").label.contains("failing"), element(app, "routines.group.project:Home Ops").label)
        settle()
        shot("32-task-saved")
    }

    /// Opening a row below an open one: the open one closes and the tapped row stays where
    /// it was under the finger; its details then come into view.
    func testTappedRowStaysPut() throws {
        let app = try launchPaired()
        openRoutines(app)
        let upper = element(app, "routines.row.r-acme-1")
        reveal(app, upper)
        nudge(app, upper)
        upper.tap()
        XCTAssertTrue(app.buttons["routines.edit.r-acme-1"].waitForExistence(timeout: 5))
        settle()
        let lower = element(app, "routines.row.r-acme-3")
        reveal(app, lower)
        nudge(app, lower)
        // Clear of the bar, and high enough that its details fit: a row under the bar, or
        // one whose details run under the tab bar, is moved into view once opened, which
        // is the reveal, not the jump this checks for.
        place(app, lower)
        settle()
        XCTAssertTrue(app.buttons["routines.edit.r-acme-1"].exists, "the upper row closed before the tap")
        let before = lower.frame.minY
        shot("33-row-stays-before")
        lower.tap()
        // Read as fast as the frames come: no read may find it moved (QA saw one frame off).
        var reads: [CGFloat] = []
        for _ in 0..<6 { reads.append(lower.frame.minY) }
        XCTAssertTrue(app.buttons["routines.edit.r-acme-3"].waitForExistence(timeout: 5))
        usleep(250_000)
        reads.append(lower.frame.minY)
        for y in reads { XCTAssertEqual(y, before, accuracy: 4, "the tapped row moved while the row above closed: \(reads)") }
        settle()
        // Then, at most, it moves up to show its details, never under the bar.
        XCTAssertGreaterThanOrEqual(lower.frame.minY, app.navigationBars.firstMatch.frame.maxY - 1)
        XCTAssertTrue(app.buttons["routines.edit.r-acme-3"].isHittable, "the opened details are not in view")
        shot("34-row-stays-after")
    }

    /// A very tall open row in the group above (its whole error and fourteen lines of
    /// what it sends shown): tapping a row in the next group keeps that row under the
    /// finger. Moving the list by the content's change in size once threw it off the
    /// screen, the list back at its top (2026-11-05, QA).
    func testTappedRowStaysPutUnderATallOpenRow() throws {
        store.addTallFailure()
        let app = try launchPaired()
        openRoutines(app)
        let tall = element(app, "routines.row.\(RoutineFixtures.tallFailure)")
        reveal(app, tall)
        nudge(app, tall)
        tall.tap()
        let fullError = element(app, "routines.errorFold.\(RoutineFixtures.tallFailure)")
        XCTAssertTrue(fullError.waitForExistence(timeout: 5), "the long error has no fold")
        reveal(app, fullError)
        nudge(app, fullError)
        fullError.tap()
        let sends = element(app, "routines.sendsFold.\(RoutineFixtures.tallFailure)")
        reveal(app, sends)
        nudge(app, sends)
        sends.tap()
        XCTAssertTrue(element(app, "routines.sends.\(RoutineFixtures.tallFailure)").waitForExistence(timeout: 5))
        settle()
        shot("33a-tall-row-open")
        let lower = element(app, "routines.row.r-acme-3")
        reveal(app, lower)
        nudge(app, lower)
        place(app, lower)
        settle()
        XCTAssertFalse(tall.isHittable, "the tall row's line is on screen: the row tapped is not far below it")
        let before = lower.frame.minY
        shot("33b-tall-row-before")
        lower.tap()
        var reads: [CGFloat] = []
        for _ in 0..<6 { reads.append(lower.frame.minY) }
        XCTAssertTrue(app.buttons["routines.edit.r-acme-3"].waitForExistence(timeout: 5))
        usleep(250_000)
        reads.append(lower.frame.minY)
        for y in reads { XCTAssertEqual(y, before, accuracy: 4, "the tapped row moved while the tall row closed: \(reads)") }
        XCTAssertTrue(lower.isHittable, "the tapped row left the screen")
        settle()
        XCTAssertTrue(lower.isHittable, "the tapped row left the screen")
        XCTAssertGreaterThanOrEqual(lower.frame.minY, app.navigationBars.firstMatch.frame.maxY - 1)
        XCTAssertTrue(app.buttons["routines.edit.r-acme-3"].isHittable, "the opened details are not in view")
        shot("33c-tall-row-after")
    }

    /// Unsaved edits are asked about, on Cancel and on a swipe down.
    func testUnsavedEditsAskBeforeTheyGo() throws {
        let app = try launchPaired()
        openRoutines(app)
        let row = element(app, "routines.row.r-briefing")
        reveal(app, row)
        row.tap()
        let edit = app.buttons["routines.edit.r-briefing"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        reveal(app, edit)
        edit.tap()
        let name = app.textFields["routines.editor.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        name.typeText(" (draft)")
        // A drag down holds the sheet and asks.
        let grab = app.navigationBars["Edit Routine"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        grab.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        let discard = app.buttons["Discard Changes"].firstMatch
        XCTAssertTrue(discard.waitForExistence(timeout: 5), "a swipe down dropped the edits without asking")
        XCTAssertTrue(name.exists)
        settle()
        shot("35-discard-prompt")
        // Keep Editing is a button of its own, beside Discard Changes.
        let keep = app.alerts.buttons["Keep Editing"].firstMatch
        XCTAssertTrue(keep.exists, "the prompt has no Keep Editing")
        keep.tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: discard)
        wait(for: [gone], timeout: 5)
        XCTAssertTrue(name.waitForExistence(timeout: 3))
        XCTAssertEqual(name.value as? String, "Morning briefing (draft)", "Keep Editing lost the words")
        // Cancel asks too; Discard closes with nothing sent.
        app.buttons["routines.editor.cancel"].tap()
        XCTAssertTrue(discard.waitForExistence(timeout: 5))
        discard.tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: name)
        wait(for: [closed], timeout: 5)
        XCTAssertTrue(store.patched.isEmpty, "a discarded edit was saved")
    }

    /// Crons with ranges and steps read as words on the closed row; one with none reads
    /// "Custom schedule", its expression only in the opened row's When.
    func testCronRangesAndStepsRead() throws {
        let app = try launchPaired()
        openRoutines(app)
        let office = element(app, "routines.row.r-office")
        reveal(app, office)
        let officeWords = office.label.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
        XCTAssertTrue(officeWords.contains("Every 15 min from 9:00 AM to 5:45 PM, weekdays"), office.label)
        let water = element(app, "routines.row.r-water")
        XCTAssertTrue(water.label.contains("Every 2 days at 8:30"), water.label)
        let quarter = element(app, "routines.row.r-quarter")
        reveal(app, quarter)
        XCTAssertTrue(quarter.label.contains("on days 1 to 7 of the month and on Mondays"), quarter.label)
        XCTAssertFalse(quarter.label.contains("1-7"), "the closed row shows the raw cron: \(quarter.label)")
        quarter.tap()
        let when = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "on days 1 to 7 of the month and on Mondays", "\nNext run")).firstMatch
        XCTAssertTrue(when.waitForExistence(timeout: 5), "the opened row's When does not say it in words")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "0 9 1-7")).firstMatch.exists, "the raw cron is shown")
        settle()
        shot("36-cron-described")
    }

    /// The largest accessibility size: the row stacks (the switch under the words), the
    /// facts stack, the buttons stack, and the section header keeps "1 failing" whole.
    func testAccessibilityTextSize() throws {
        store.addTallFailure()
        let server = try XCTUnwrap(fixture).url
        let token = "routines-fixture"
        arguments = ["-walnut.serverUrl", server, "-walnut.deviceToken", token,
                     "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        let app = UITestLaunch.launch(arguments)
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "the app never opened")
        openRoutines(app)
        // The page's count at this size: each half whole, on its own line if need be.
        let count = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "[0-9]+ routines")).firstMatch
        let failingCount = element(app, "routines.summaryFailing")
        XCTAssertTrue(count.exists && failingCount.exists, "no page count at this size")
        XCTAssertTrue(failingCount.frame.minY >= count.frame.maxY - 1 || abs(failingCount.frame.midY - count.frame.midY) < 4,
                      "the page count's halves overlap: \(count.frame) \(failingCount.frame)")
        settle()
        shot("22a-ax-first-screen")
        let row = element(app, "routines.row.r-briefing")
        // The failing routine leads its group: at this size it fills the first screen.
        reveal(app, row)
        nudge(app, app.switches["routines.toggle.r-briefing"])
        XCTAssertTrue(row.exists)
        let toggle = app.switches["routines.toggle.r-briefing"]
        XCTAssertTrue(toggle.exists)
        XCTAssertGreaterThan(toggle.frame.minY, row.frame.minY + 10, "the switch is not on its own line under the words")
        settle()
        shot("23-ax-collapsed")

        let failingHeader = element(app, "routines.group.project:Home Ops")
        reveal(app, failingHeader)
        XCTAssertTrue(failingHeader.label.contains("1 failing"))
        let failing = element(app, "routines.row.r-router")
        reveal(app, failing)
        failing.tap()
        XCTAssertTrue(app.buttons["routines.run.r-router"].waitForExistence(timeout: 5))
        settle()
        XCTAssertTrue(failing.isHittable, "the opened row's line went out of view")
        shot("24-ax-row-open")
        // The error is its head and a fold, not a screen of words.
        // A one-sentence error is not folded: it and what to do are both shown.
        XCTAssertTrue(element(app, "routines.errorNext.r-router").exists, "a one-sentence error hid what to do")
        XCTAssertFalse(element(app, "routines.errorFold.r-router").exists, "a one-sentence error is folded at this size")
        let run = app.buttons["routines.run.r-router"]
        let edit = app.buttons["routines.edit.r-router"]
        let delete = app.buttons["routines.delete.r-router"]
        reveal(app, edit)
        nudge(app, delete)
        settle()
        // Two to a line where two fit, else one each: never three and Delete alone.
        let openTask = app.buttons["routines.openTask.r-router"]
        XCTAssertGreaterThan(openTask.frame.minY, run.frame.maxY - 1, "the buttons do not wrap at this size")
        let paired = abs(delete.frame.midY - openTask.frame.midY) < 2
        let stacked = edit.frame.minY > run.frame.maxY - 1 && delete.frame.minY > openTask.frame.maxY - 1
        XCTAssertTrue(paired || stacked, "Delete sits alone under the others: run \(run.frame) edit \(edit.frame) open \(openTask.frame) delete \(delete.frame)")
        XCTAssertLessThanOrEqual(delete.frame.maxY, tabTop(app), "Delete is under the tab bar")
        shot("25-ax-actions")

        // A long error at this size: its head and a fold, then the whole of it.
        let tall = element(app, "routines.row.\(RoutineFixtures.tallFailure)")
        reveal(app, tall, up: true)
        nudge(app, tall)
        tall.tap()
        let fold = element(app, "routines.errorFold.\(RoutineFixtures.tallFailure)")
        XCTAssertTrue(fold.waitForExistence(timeout: 5), "a long error is not folded at this size")
        reveal(app, fold)
        nudge(app, fold)
        settle()
        XCTAssertTrue(tall.isHittable || fold.isHittable)
        shot("25a-ax-long-error")
        fold.tap()
        settle()
        let error = element(app, "routines.error.\(RoutineFixtures.tallFailure)")
        XCTAssertTrue(error.label.contains("502 Bad Gateway"), error.label)
        shot("25b-ax-long-error-full")
    }

    func testAFoldedSectionStaysFoldedAfterARelaunch() throws {
        var app = try launchPaired()
        openRoutines(app)
        let header = element(app, "routines.group.project:Acme")
        reveal(app, header)
        let row = element(app, "routines.row.r-acme-1")
        reveal(app, row)
        nudge(app, row)
        XCTAssertTrue(row.exists, "Acme's routines are not listed")
        // The header clear of the bar: under it the tap went to the bar.
        place(app, header, low: 20, high: 300)
        XCTAssertTrue(header.isHittable, "the Acme header went out of view")
        settle()
        let open = header.frame
        // The empty right end of the header folds too.
        header.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        let folded = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: row)
        wait(for: [folded], timeout: 5)
        let foldedHeader = element(app, "routines.group.project:Acme")
        XCTAssertEqual(foldedHeader.value as? String, "Collapsed")
        settle()
        // It stays where it was under the finger, folded as unfolded.
        XCTAssertEqual(foldedHeader.frame.minX, open.minX, accuracy: 1, "the folded header moved sideways")
        XCTAssertEqual(foldedHeader.frame.minY, open.minY, accuracy: 2, "the folded header moved up or down")
        // A folded group leaves no section's gap before the next header.
        let next = element(app, "routines.group.project:Home Ops")
        XCTAssertTrue(next.exists)
        XCTAssertLessThan(next.frame.minY - foldedHeader.frame.maxY, 40, "a tall gap under the folded group")
        shot("06-acme-folded")

        app.terminate()
        app = UITestLaunch.launch(arguments)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60))
        openRoutines(app)
        let again = element(app, "routines.group.project:Acme")
        reveal(app, again)
        XCTAssertTrue(again.exists)
        XCTAssertEqual(again.value as? String, "Collapsed")
        XCTAssertFalse(element(app, "routines.row.r-acme-1").exists, "the fold did not survive a relaunch")
        settle()
        shot("07a-acme-still-folded-after-relaunch")
        again.tap()
        XCTAssertTrue(element(app, "routines.row.r-acme-1").waitForExistence(timeout: 5), "unfolding shows nothing")
        shot("07-acme-unfolded-after-relaunch")
    }
}

/// The routines the fixture serves: about forty, over six projects and the global
/// group, with a failing one, a paused one and a stopped trigger, some saying what they
/// send and one with a history. Mutations are recorded so the test can check what
/// reached the server.
final class RoutineFixtures: @unchecked Sendable {
    private let lock = NSLock()
    private var jobs: [[String: Any]]
    // Written on the server's queue, read by the test: both under the lock.
    private var ranLog: [String] = []
    private var toggledLog: [String] = []
    private var deletedLog: [String] = []
    private var fetchedLog: [String] = []
    private var createdLog: [[String: Any]] = []
    private var patchedLog: [(id: String, body: [String: Any])] = []
    private var taskQueryLog: [[String: String]] = []
    private var taskDetailLog: [String] = []
    /// Runs the server took and has not recorded yet, by routine: a run is answered
    /// before it delivers, and its outcome lands on the routine a moment later.
    private var pendingRuns: [String: Double] = [:]
    /// The tasks a session routine can run in: each project's watcher (Home Ops's is
    /// complete, which is why its routine fails) and a few more open ones.
    private var tasks: [[String: Any]] = []

    private func locked<T>(_ read: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return read()
    }

    /// A Global routine that fails with a long error and sends fourteen lines: opened,
    /// with both shown, its row is taller than the screen.
    static let tallFailure = "r-letters"

    func addTallFailure() {
        let now = Date().timeIntervalSince1970 * 1000
        let schedule: [String: Any] = ["kind": "cron", "expr": "0 8 * * *"]
        let sends = (1...14).map { "\($0). Read the letters that came overnight and say which of them need an answer today." }
        let error = "claude exited with code 1 after 42s: the mail page did not load.\n"
            + (1...8).map { "  at step \($0): GET https://mail.example.com/inbox returned 502 Bad Gateway" }.joined(separator: "\n")
        let job: [String: Any] = [
            "id": Self.tallFailure, "name": "Morning letters digest", "enabled": true,
            "description": "Reads the new letters each morning and says which need an answer.",
            "schedule": schedule,
            "executor": ["type": "claude-code", "config": ["instructions": sends.joined(separator: "\n")]],
            "state": ["lastStatus": "error", "lastRunAtMs": now - 50 * 60_000, "lastError": error,
                      "nextRunAtMs": RoutineFixtures.nextRun(schedule, nowMs: now)],
        ]
        locked { jobs.append(job) }
    }

    var ran: [String] { locked { ranLog } }
    var toggled: [String] { locked { toggledLog } }
    var deleted: [String] { locked { deletedLog } }
    /// GET /routines/:id, by id.
    var fetched: [String] { locked { fetchedLog } }
    /// POST /routines bodies.
    var created: [[String: Any]] { locked { createdLog } }
    /// PATCH /routines/:id, with its body.
    var patched: [(id: String, body: [String: Any])] { locked { patchedLog } }
    /// GET /api/tasks queries, each as its parameters.
    var taskQueries: [[String: String]] { locked { taskQueryLog } }
    /// GET /api/v1/tasks/:id, by id (Open task).
    var taskDetails: [String] { locked { taskDetailLog } }
    /// The routine whose switch and delete the server refuses.
    static let refusedWrites = "r-learn-1"
    static let writeRefusal = "The Mac is saving another change to this routine. Try again in a moment."
    /// How long a run takes to land on its routine after it was answered.
    static let runLandsAfterMs: Double = 1500
    /// The routine whose Run Now the engine refuses (a 200 with status "error").
    static let refusedRun = "r-break"
    static let refusal = "Claude Code is not set up on this computer"

    init() {
        let now = Date().timeIntervalSince1970 * 1000
        var all: [[String: Any]] = []
        func add(_ id: String, _ name: String, project: String?, schedule: [String: Any],
                 enabled: Bool = true, state: [String: Any] = [:], check: [String: Any]? = nil,
                 sends: String? = nil, task: (id: String, title: String)? = nil) {
            let type = project == nil ? "claude-code" : "session"
            var config: [String: Any] = [:]
            if let sends { config[type == "session" ? "prompt" : "instructions"] = sends }
            // A session routine runs in its task, as the server stores it.
            let owner = task ?? (id: RoutineFixtures.taskId(project ?? ""), title: "\(project ?? "") watcher")
            if project != nil { config["target"] = owner.id }
            var job: [String: Any] = [
                "id": id, "name": name, "enabled": enabled,
                "description": "Watches \(name.lowercased()) and tells its task when something changed.",
                "schedule": schedule,
                "executor": ["type": type, "config": config],
                "state": state.merging(["nextRunAtMs": RoutineFixtures.nextRun(schedule, nowMs: now)]) { a, _ in a },
            ]
            if let check { job["check"] = check }
            if let project {
                job["owner"] = ["taskId": owner.id, "title": owner.title, "project": project]
            }
            all.append(job)
        }
        let every5: [String: Any] = ["kind": "every", "everyMs": 300_000]
        let hourly: [String: Any] = ["kind": "every", "everyMs": 3_600_000]
        let weekdays: [String: Any] = ["kind": "cron", "expr": "0 9 * * 1-5"]
        let evening: [String: Any] = ["kind": "cron", "expr": "30 17 * * *"]
        add("r-briefing", "Morning briefing", project: nil, schedule: weekdays,
            sends: "Summarize the calendar, the tasks due and the new letters in five lines.")
        add("r-pr", "Weekday PR summary", project: nil, schedule: weekdays)
        add("r-break", "Lunch break nudge", project: nil, schedule: hourly)
        // Crons with ranges and steps, and one with no words (QA: the row showed them raw).
        add("r-office", "Office hours ping", project: nil, schedule: ["kind": "cron", "expr": "*/15 9-17 * * 1-5"])
        add("r-water", "Water the balcony plants", project: nil, schedule: ["kind": "cron", "expr": "30 20 */2 * *"])
        add("r-quarter", "Quarter planning nudge", project: nil, schedule: ["kind": "cron", "expr": "0 9 1-7 * 1"])
        for (i, name) in ["Customer ticket digest", "Weekly status to the team", "Slack channel: new mentions",
                          "Design review comments"].enumerated() {
            add("r-acme-\(i + 1)", name, project: "Acme", schedule: i % 2 == 0 ? every5 : weekdays,
                enabled: i != 3, state: i == 3 ? ["pausedAtMs": now - 40 * 60_000] : [:])
        }
        // Home Ops's watcher task is complete: only the router routine still runs in it.
        let chores = (id: "t-home-chores", title: "Home chores")
        add("r-backup", "Backup disk health", project: "Home Ops", schedule: every5, task: chores)
        add("r-router", "Router uptime check", project: "Home Ops", schedule: hourly,
            state: ["lastStatus": "error", "lastRunAtMs": now - 20 * 60_000,
                    "lastError": "target task \(RoutineFixtures.taskId("Home Ops")) is complete; the trigger will not resurrect it"],
            sends: "Ping the router's status page. If it was down in the last hour, say for how long and since when.")
        for name in ["Mail: new newsletter issue", "Package delivery watch", "Rent reminder"] {
            add("r-home-\(name.count)", name, project: "Home Ops", schedule: evening, task: chores)
        }
        for (i, name) in ["Paper of the day", "Spanish practice reminder", "Weekend reading list"].enumerated() {
            add("r-learn-\(i)", name, project: "Learning", schedule: i == 0 ? evening : hourly)
        }
        let pipelineChecks: [[String: Any]] = [
            ["atMs": now - 4 * 60_000, "outcome": "error", "error": "exit 2: the pipeline page timed out"],
            ["atMs": now - 9 * 60_000, "outcome": "fired", "items": 1, "seq": 12, "epoch": "e1",
             "delivery": ["status": "ok", "summary": "Marina watcher"]],
            ["atMs": now - 14 * 60_000, "outcome": "quiet", "reason": "fire-false"],
        ]
        for (i, name) in ["PR review watch: api-gateway", "Pipeline watch: payments", "Nightly integration tests",
                          "Flaky test triage", "Dependency bump digest", "Staging deploy 10:00 + 16:00",
                          "On-call handoff notes"].enumerated() {
            add("r-marina-\(i)", name, project: "Marina", schedule: i % 3 == 0 ? every5 : weekdays,
                state: i == 1 ? ["checkLog": pipelineChecks, "fireLog": [pipelineChecks[1]], "fireCount": 1,
                                 "lastCheck": pipelineChecks[0]] : [:],
                check: i == 1 ? ["run": "sh check-pipeline.sh", "host": "devbox", "maxFiresPerDay": 6] : nil,
                sends: i == 1 ? "The payments pipeline changed state. Read the failing stage's log and say what broke." : nil)
        }
        // Stopped by the server after five failed checks in a row: its last check failed.
        let releaseChecks: [[String: Any]] = (0..<5).map { i in
            ["atMs": now - Double(6 + 5 * i) * 60_000, "outcome": "error", "error": "exit 1: release.sh: the train page returned 503"]
        }
        add("r-marina-stopped", "Release train watch", project: "Marina", schedule: every5, enabled: false,
            state: ["consecutiveErrors": 5, "lastCheck": releaseChecks[0], "checkLog": releaseChecks],
            check: ["run": "sh release.sh", "host": "devbox"])
        for (i, name) in ["Studio daily report", "Draft review watch"].enumerated() {
            add("r-studio-\(i)", name, project: "Studio", schedule: evening)
        }
        for (i, name) in ["open-walnut release watch", "main CI run ended", "Community voice: hourly round",
                          "Instance watch: risky issues", "Mac queue results", "Daily digest (evening)",
                          "Release notes draft", "Phone build upload watch", "Docs link checker", "Weekly usage report",
                          "Search index health", "Notes backup check", "Plugin store sync", "Daemon update watch",
                          "Threads tidy reminder"].enumerated() {
            add("r-walnut-\(i)", name, project: "Walnut", schedule: i % 2 == 0 ? every5 : hourly)
        }
        jobs = all
        var known: [[String: Any]] = []
        for project in ["Acme", "Home Ops", "Learning", "Marina", "Studio", "Walnut"] {
            known.append(["id": RoutineFixtures.taskId(project), "title": "\(project) watcher", "project": project,
                          "phase": project == "Home Ops" ? "COMPLETE" : "IN_PROGRESS"])
        }
        known += [
            ["id": "t-home-chores", "title": "Home chores", "project": "Home Ops", "phase": "IN_PROGRESS"],
            ["id": "t-router-fw", "title": "Router firmware upgrade", "project": "Home Ops", "phase": "IN_PROGRESS"],
            ["id": "t-router-swap", "title": "Replace the hallway router", "project": "Home Ops", "phase": "TODO"],
            ["id": "t-router-old", "title": "Router reset after the outage", "project": "Home Ops", "phase": "COMPLETE"],
            ["id": "t-inbox-shelf", "title": "Sort the bookshelf", "project": "", "phase": "TODO"],
        ]
        tasks = known
    }

    /// A project's watcher task id, as an id looks (no spaces): "t-home-ops".
    static func taskId(_ project: String) -> String {
        "t-" + project.lowercased().replacingOccurrences(of: " ", with: "-")
    }

    /// When the schedule fires next, as the server would say: an interval a few minutes
    /// in, a "m h * * dow" cron at its own next hour.
    static func nextRun(_ schedule: [String: Any], nowMs: Double) -> Double {
        if let every = schedule["everyMs"] as? Double { return nowMs + min(every, 7 * 60_000) }
        if let every = schedule["everyMs"] as? Int { return nowMs + min(Double(every), 7 * 60_000) }
        guard let expr = schedule["expr"] as? String else { return nowMs + 7 * 60_000 }
        let f = expr.split(separator: " ").map(String.init)
        guard f.count == 5, let minute = Int(f[0]), let hour = Int(f[1]) else { return nowMs + 7 * 60_000 }
        let days: Set<Int> = f[4] == "*" ? Set(1...7) : f[4] == "1-5" ? [2, 3, 4, 5, 6] : Set(f[4].split(separator: ",").compactMap { Int($0) }.map { $0 + 1 })
        let cal = Calendar.current
        var best: Date?
        for weekday in days {
            if let d = cal.nextDate(after: Date(timeIntervalSince1970: nowMs / 1000),
                                    matching: DateComponents(hour: hour, minute: minute, weekday: weekday),
                                    matchingPolicy: .nextTime) {
                if best == nil || d < best! { best = d }
            }
        }
        return (best ?? Date()).timeIntervalSince1970 * 1000
    }

    func route(method: String, path target: String, body: Data) -> (Int, Any)? {
        let split = target.split(separator: "?", maxSplits: 1).map(String.init)
        let path = split.first ?? target
        let query = RoutineFixtures.parameters(split.count > 1 ? split[1] : "")
        if path == "/api/tasks", method == "GET" { return taskList(query) }
        if path.hasPrefix("/api/v1/tasks/"), method == "GET" { return taskDetail(String(path.dropFirst("/api/v1/tasks/".count))) }
        let base = "/api/v1/routines"
        guard path.hasPrefix(base) else { return nil }
        lock.lock(); defer { lock.unlock() }
        let input = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let nowMs = Date().timeIntervalSince1970 * 1000
        landRuns(nowMs: nowMs)
        let rest = path.dropFirst(base.count).split(separator: "/").map(String.init)
        if rest.isEmpty, method == "GET" { return (200, ["jobs": jobs]) }
        if rest.isEmpty, method == "POST" {
            createdLog.append(input)
            guard let schedule = input["schedule"] as? [String: Any] else {
                return (400, ["error": ["code": "bad_request", "message": "Invalid input. Provide at least schedule and payload."]])
            }
            var job: [String: Any] = [
                "id": "r-created-\(createdLog.count)", "name": input["name"] ?? "", "enabled": true,
                "schedule": schedule, "executor": input["executor"] ?? [:],
                "state": ["nextRunAtMs": RoutineFixtures.nextRun(schedule, nowMs: nowMs)],
            ]
            if let description = input["description"] { job["description"] = description }
            jobs.append(job)
            return (201, ["job": job])
        }
        guard let id = rest.first, let i = jobs.firstIndex(where: { $0["id"] as? String == id }) else {
            return (404, ["error": ["code": "not_found", "message": "no such routine"]])
        }
        switch (method, rest.count > 1 ? rest[1] : "") {
        case ("POST", "toggle"):
            toggledLog.append(id)
            if id == RoutineFixtures.refusedWrites {
                return (409, ["error": ["code": "conflict", "message": RoutineFixtures.writeRefusal]])
            }
            var job = jobs[i]
            let on = !(job["enabled"] as? Bool ?? true)
            job["enabled"] = on
            var state = job["state"] as? [String: Any] ?? [:]
            state["pausedAtMs"] = on ? nil : nowMs
            job["state"] = state
            jobs[i] = job
            return (200, ["job": job])
        case ("POST", "run"):
            ranLog.append(id)
            if id == RoutineFixtures.refusedRun {
                return (200, ["result": ["status": "error", "error": RoutineFixtures.refusal]])
            }
            // Answered before it delivers, as the server does; the outcome lands later.
            pendingRuns[id] = nowMs
            return (200, ["result": ["ok": true, "ran": true]])
        case ("PATCH", ""):
            patchedLog.append((id, input))
            var job = jobs[i]
            for key in ["name", "description", "schedule", "executor", "check"] {
                if let value = input[key] { job[key] = value }
            }
            // As every routine answer does: the task it runs in, and so its project.
            if let executor = input["executor"] as? [String: Any], let config = executor["config"] as? [String: Any],
               let target = config["target"] as? String, let task = tasks.first(where: { $0["id"] as? String == target }) {
                job["owner"] = ["taskId": target, "title": task["title"] ?? target, "project": task["project"] ?? ""]
            }
            if let schedule = input["schedule"] as? [String: Any] {
                var state = job["state"] as? [String: Any] ?? [:]
                state["nextRunAtMs"] = RoutineFixtures.nextRun(schedule, nowMs: nowMs)
                job["state"] = state
            }
            jobs[i] = job
            return (200, ["job": job])
        case ("DELETE", ""):
            deletedLog.append(id)
            if id == RoutineFixtures.refusedWrites {
                return (409, ["error": ["code": "conflict", "message": RoutineFixtures.writeRefusal]])
            }
            jobs.remove(at: i)
            return (200, ["ok": true])
        case ("GET", ""):
            fetchedLog.append(id)
            return (200, ["job": jobs[i]])
        default:
            return nil
        }
    }

    /// A run lands on its routine once it has had time to deliver: into a complete
    /// task it fails (as the server's does), else it is ok.
    private func landRuns(nowMs: Double) {
        for (id, at) in pendingRuns where nowMs - at >= RoutineFixtures.runLandsAfterMs {
            pendingRuns[id] = nil
            guard let i = jobs.firstIndex(where: { $0["id"] as? String == id }) else { continue }
            var job = jobs[i]
            var state = job["state"] as? [String: Any] ?? [:]
            let target = ((job["executor"] as? [String: Any])?["config"] as? [String: Any])?["target"] as? String
            let done = target.flatMap { t in tasks.first { $0["id"] as? String == t } }?["phase"] as? String == "COMPLETE"
            if job["check"] != nil {
                state["lastCheck"] = ["atMs": at + 800, "outcome": done ? "error" : "quiet",
                                      "error": done ? "target task \(target ?? "") is complete" : NSNull()]
            } else {
                state["lastRunAtMs"] = at + 800
                state["lastStatus"] = done ? "error" : "ok"
                state["lastDurationMs"] = 800
                state["lastError"] = done ? "target task \(target ?? "") is complete; the trigger will not resurrect it" : nil
            }
            job["state"] = state
            jobs[i] = job
        }
    }

    /// GET /api/tasks: the filters the routine editor sends (q on the title, ids,
    /// completion, limit), newest first as `sort=updated_desc` asks.
    private func taskList(_ query: [String: String]) -> (Int, Any) {
        lock.lock(); defer { lock.unlock() }
        taskQueryLog.append(query)
        let q = (query["q"] ?? "").lowercased()
        let ids = Set((query["ids"] ?? "").split(separator: ",").map(String.init))
        let completion = Set((query["completion"] ?? "").split(separator: ",").map(String.init))
        let limit = Int(query["limit"] ?? "") ?? 50
        let found = tasks.filter { task in
            let phase = task["phase"] as? String ?? ""
            let status = phase == "COMPLETE" ? "done" : phase == "TODO" ? "todo" : "in_progress"
            return (ids.isEmpty || ids.contains(task["id"] as? String ?? ""))
                && (completion.isEmpty || completion.contains(status))
                && (q.isEmpty || (task["title"] as? String ?? "").lowercased().contains(q))
        }
        return (200, ["tasks": Array(found.prefix(limit)), "total": found.count, "truncated": found.count > limit])
    }

    /// GET /api/v1/tasks/:id: one task, as the task sheet reads it.
    private func taskDetail(_ raw: String) -> (Int, Any) {
        lock.lock(); defer { lock.unlock() }
        let id = raw.removingPercentEncoding ?? raw
        taskDetailLog.append(id)
        guard let task = tasks.first(where: { $0["id"] as? String == id }) else {
            return (404, ["error": ["code": "not_found", "message": "no such task"]])
        }
        let phase = task["phase"] as? String ?? "TODO"
        return (200, ["task": ["id": id, "title": task["title"] ?? id, "project": task["project"] ?? "",
                               "phase": phase, "status": phase == "COMPLETE" ? "done" : "todo", "priority": "none",
                               "description": "", "summary": "", "note": "", "tags": []]])
    }

    /// "a=1&b=x%20y" as its decoded parameters.
    static func parameters(_ query: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in query.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            let value = kv.count > 1 ? kv[1] : ""
            out[kv[0].removingPercentEncoding ?? kv[0]] = value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? value
        }
        return out
    }
}
