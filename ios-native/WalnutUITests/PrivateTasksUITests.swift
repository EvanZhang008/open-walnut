import XCTest

/// The task menu's Sync section against a real server with one project that syncs to a
/// fixture service ("Tracker", `tests/ui/private-tasks-server.ts`, run by
/// `tests/ui/run-private-tasks-ui.sh`): a synced task turns local from its long-press menu
/// and keeps its row, the menu then says it is local and why, and Sync to Tracker sends it
/// back. Skips without a pairing, like every paired UI test here.
final class PrivateTasksUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func env(_ name: String) -> String? {
        let value = ProcessInfo.processInfo.environment[name]
        return (value?.isEmpty ?? true) ? nil : value
    }

    private func launchPaired() throws -> XCUIApplication {
        guard let server = env("WALNUT_UITEST_SERVER"), let token = env("WALNUT_UITEST_TOKEN"),
              env("WALNUT_UITEST_PRIVATE_TASKS") != nil
        else { throw XCTSkip("run through ios-native/tests/ui/run-private-tasks-ui.sh") }
        return UITestLaunch.launch([
            "-walnut.serverUrl", UITestLaunch.pairedServer(server),
            "-walnut.deviceToken", token,
        ])
    }

    private func openBoard(_ app: XCUIApplication) {
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 30), "the tab bar never appeared")
        tasks.tap()
        let scrim = app.descendants(matching: .any)["tasks.drawer.scrim"]
        if !scrim.waitForExistence(timeout: 3) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "no board button on the Tasks page")
            menu.tap()
        }
    }

    private func row(_ app: XCUIApplication, _ taskId: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "board.row.\(taskId)").firstMatch
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Long-press the row and open its Sync section; answers the section's label.
    private func openSync(_ app: XCUIApplication, _ taskId: String, expecting label: String) -> XCUIElement {
        let target = row(app, taskId)
        XCTAssertTrue(target.waitForExistence(timeout: 45), "no board row for \(taskId)")
        target.press(forDuration: 1.2)
        let sync = app.buttons[label]
        XCTAssertTrue(sync.waitForExistence(timeout: 10), "the menu has no \"\(label)\" row")
        return sync
    }

    func testASyncedTaskTurnsLocalFromItsMenuAndSyncsBack() throws {
        guard let synced = env("WALNUT_UITEST_SYNCED_TASK") else { throw XCTSkip("no fixture task id") }
        let app = try launchPaired()
        openBoard(app)

        // Synced: the section names the service and offers the three ways to make it local.
        openSync(app, synced, expecting: "Sync: Syncs to Tracker").tap()
        let keep = app.buttons["Make local, keep its copy in Tracker"]
        XCTAssertTrue(keep.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Make local, archive it in Tracker"].exists)
        XCTAssertTrue(app.buttons["Make local, neutralize it in Tracker"].exists)
        shot(app, "1-synced-menu")
        keep.tap()

        // Local now, in the same project: the row stays and its menu says why.
        XCTAssertTrue(row(app, synced).waitForExistence(timeout: 20), "the row left the board")
        let localLabel = "Sync: Local, not in Tracker"
        openSync(app, synced, expecting: localLabel).tap()
        XCTAssertTrue(app.staticTexts["Kept out of Tracker: You made it local"].waitForExistence(timeout: 5)
            || app.buttons["Kept out of Tracker: You made it local"].exists,
            "the menu does not say why it is local")
        let back = app.buttons["Sync to Tracker"]
        XCTAssertTrue(back.exists)
        XCTAssertTrue(app.buttons["Archive its copy in Tracker"].exists, "a kept copy can be archived")
        shot(app, "2-kept-menu")
        back.tap()

        // Sent back: the menu reads synced again once the server sent it (a moment of
        // "Checking…" first is allowed: close the menu and look again).
        XCTAssertTrue(row(app, synced).waitForExistence(timeout: 20))
        var syncedAgain = false
        for _ in 0..<5 {
            row(app, synced).press(forDuration: 1.2)
            if app.buttons["Sync: Syncs to Tracker"].waitForExistence(timeout: 6) { syncedAgain = true; break }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap()
            sleep(2)
        }
        XCTAssertTrue(syncedAgain, "the task never read synced again")
        shot(app, "3-synced-again")
    }

    func testALocalTaskInASyncingProjectOffersSyncToTheService() throws {
        guard let kept = env("WALNUT_UITEST_KEPT_TASK") else { throw XCTSkip("no fixture task id") }
        let app = try launchPaired()
        openBoard(app)
        openSync(app, kept, expecting: "Sync: Local, not in Tracker").tap()
        XCTAssertTrue(app.buttons["Sync to Tracker"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Make local, keep its copy in Tracker"].exists)
        shot(app, "4-local-task-menu")
    }
}
