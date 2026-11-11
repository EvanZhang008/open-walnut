import XCTest

/// A project's launch defaults on the phone's new-session draft (`DraftLaunchDefaults`): the
/// project's engine, model and mode are what the pills show, the line under the draft names the
/// project, and a pick of the draft's own is no longer the project's.
///
/// Every launch is in the in-app demo (`DemoMode`), whose Learning project starts new tasks on
/// Sonnet in Accept Edits (`DemoFixtures.launchDefaults`). The demo server lives in the app's
/// memory: nothing here writes to any server, and nothing is sent.
final class ProjectLaunchDefaultsUITests: XCTestCase {

    private static let demoURL = "https://demo.walnut.invalid"
    private static let demoToken = "walnut-demo-token"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    /// The Tasks tab with its board drawer open.
    private func openBoard(_ app: XCUIApplication) {
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 60), "the tab bar never appeared")
        tasks.tap()
        let scrim = app.descendants(matching: .any)["tasks.drawer.scrim"]
        if !scrim.waitForExistence(timeout: 3) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "no board button on the Tasks page")
            menu.tap()
        }
        XCTAssertTrue(scrim.waitForExistence(timeout: 10), "the board drawer did not open")
    }

    /// A project's launch defaults on the draft: Learning starts on Sonnet in Accept Edits, the
    /// pills say so and name the project, and a pick of the draft's own is no longer the project's.
    func testAProjectsLaunchDefaultsShowOnTheDraftUntilThePillsArePicked() throws {
        let app = UITestLaunch.launch([
            UITestLaunch.serverURLArgument, Self.demoURL, "-walnut.deviceToken", Self.demoToken,
        ])
        openBoard(app)
        app.buttons["sessions.new"].tap()
        let projectPill = element(app, "newSessionChat.projectPill")
        XCTAssertTrue(projectPill.waitForExistence(timeout: 15), "the draft did not open")
        let modePill = element(app, "newSessionChat.modePill")
        let modelPill = element(app, "newSessionChat.modelPill")
        XCTAssertTrue(modePill.waitForExistence(timeout: 10))
        // Inbox sets none: the global start, no line.
        XCTAssertFalse(modePill.label.contains("project default"), modePill.label)
        XCTAssertFalse(element(app, "newSessionChat.projectDefaults").exists)
        sleep(1)

        projectPill.tap()
        XCTAssertTrue(element(app, "task.project.picker").waitForExistence(timeout: 10), "no project picker")
        let learning = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Learning")).firstMatch
        XCTAssertTrue(learning.waitForExistence(timeout: 10), "Learning is not in the picker")
        learning.tap()
        XCTAssertTrue(element(app, "task.project.picker").waitForNonExistence(timeout: 10))

        let line = element(app, "newSessionChat.projectDefaults")
        XCTAssertTrue(line.waitForExistence(timeout: 10), "no project defaults line")
        XCTAssertTrue(line.label.contains("Learning") && line.label.contains("Accept Edits"), line.label)
        XCTAssertEqual(modePill.label, "Permission mode: Accept Edits, project default")
        XCTAssertTrue(modelPill.label.contains("Sonnet") && modelPill.label.contains("project default"), modelPill.label)
        sleep(2)

        // A mode of the draft's own: the pill no longer names the project, the model still does.
        modePill.tap()
        let plan = app.buttons.matching(NSPredicate(format: "label == %@", "Plan")).firstMatch
        XCTAssertTrue(plan.waitForExistence(timeout: 10), "no mode menu")
        plan.tap()
        let picked = expectation(for: NSPredicate(format: "label == %@", "Permission mode: Plan"), evaluatedWith: modePill)
        XCTAssertEqual(XCTWaiter().wait(for: [picked], timeout: 10), .completed, modePill.label)
        XCTAssertTrue(modelPill.label.contains("project default"), modelPill.label)
        sleep(2)
    }
}
