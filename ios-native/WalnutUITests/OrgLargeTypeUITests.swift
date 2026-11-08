import XCTest

/// At the largest accessibility text size an Org node's chat keeps the screen for the
/// conversation (2026-11-08, a QA run at accessibility XXXL: the Threads, Tasks and Brief
/// buttons above the chat each read "T…", took a sixth of the screen and left the chat about
/// one line tall). The bar gives way to one row of icons and the node page's view picker to one
/// button (`OrgNodeBarLayout`).
///
/// Paired to `ChatPlaceFixtureServer`, a loopback server this runner hosts, whose Main is an
/// org node, so it runs with no Walnut and nobody's data. Nothing here sends a message.
final class OrgLargeTypeUITests: XCTestCase {

    private var fixture: ChatPlaceFixtureServer?

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        let server = try ChatPlaceFixtureServer()
        try server.start()
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func launchPaired(_ extra: [String]) throws -> XCUIApplication {
        let token = "chat-place-fixture"
        let app = UITestLaunch.launch(["-walnut.serverUrl", try XCTUnwrap(fixture).url,
                                       "-walnut.deviceToken", token] + extra)
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        return app
    }

    /// Main's chat, opened from the chat drawer's Org view (or already open from a last run).
    private func openMainChat(_ app: XCUIApplication) {
        let threads = element(app, "org.bar.threads")
        if threads.waitForExistence(timeout: 8) { return }
        if app.buttons["session.title"].exists {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        let menu = app.buttons["chat.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 60), "the chat never appeared")
        menu.tap()
        let picker = app.segmentedControls["chat.drawer.viewSwitch"]
        if picker.waitForExistence(timeout: 5), picker.buttons["Org"].exists { picker.buttons["Org"].tap() }
        let ceo = app.buttons["chat.drawer.org.ceo"]
        XCTAssertTrue(ceo.waitForExistence(timeout: 30), "no Main row in the drawer's Org view")
        ceo.tap()
        XCTAssertTrue(threads.waitForExistence(timeout: 30), "Main's chat has no Threads, Tasks and Brief bar")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testTheOrgChatKeepsItsHeightAtTheLargestAccessibilitySize() throws {
        let app = try launchPaired(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        openMainChat(app)
        Thread.sleep(forTimeInterval: 1.5)
        attach(app, "org-chat-ax5")
        let screen = app.windows.firstMatch.frame
        let buttons = ["threads", "tasks", "brief"].map { element(app, "org.bar.\($0)") }
        for button in buttons { XCTAssertTrue(button.exists, "\(button) is missing") }
        let frames = buttons.map(\.frame)
        print("[evidence] ax5 bar buttons: \(frames) on a \(screen.size) screen")
        // One row: the three buttons side by side, none pushed to a second line.
        XCTAssertEqual(Set(frames.map { Int($0.minY.rounded()) }).count, 1, "the bar's buttons are not on one row: \(frames)")
        // A bar's height, not a sixth of the screen (it was about 110pt here before).
        let barHeight = frames.map(\.height).max() ?? 0
        XCTAssertLessThanOrEqual(barHeight, 60, "the bar is \(barHeight)pt tall at AX5")
        // Each keeps its name for VoiceOver.
        XCTAssertTrue(buttons[0].label.hasPrefix("Threads"), "threads reads \(buttons[0].label)")
        XCTAssertEqual(buttons[1].label, "Tasks")
        XCTAssertEqual(buttons[2].label, "Brief")
        // The chat is the space between the bar and the composer: the most of the page there is.
        let composer = element(app, "chat.composer")
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "no composer")
        let chat = composer.frame.minY - (frames.map(\.maxY).max() ?? 0)
        print("[evidence] ax5 chat height \(Int(chat))pt of \(Int(screen.height))pt")
        XCTAssertGreaterThanOrEqual(chat, screen.height * 0.4, "the chat is \(chat)pt of a \(screen.height)pt screen")

        // The node page's view picker: one button naming the view shown, the others in its menu.
        buttons[1].tap()
        let picker = element(app, "org.node.tabs")
        XCTAssertTrue(picker.waitForExistence(timeout: 15), "the node page did not open")
        Thread.sleep(forTimeInterval: 1)
        attach(app, "org-page-ax5")
        print("[evidence] ax5 node page picker \(picker.frame)")
        XCTAssertLessThanOrEqual(picker.frame.height, 60, "the picker is \(picker.frame.height)pt tall at AX5")
        XCTAssertTrue(picker.label.contains("Tasks"), "the picker reads \(picker.label)")
        picker.tap()
        // The chat's own Brief button is under this page in the stack: the menu's row is the one on screen.
        let rows = app.buttons.matching(NSPredicate(format: "label == 'Brief'"))
        var brief: XCUIElement?
        let deadline = Date().addingTimeInterval(5)
        while brief == nil, Date() < deadline {
            brief = rows.allElementsBoundByIndex.first { $0.isHittable && $0.identifier != "org.bar.brief" }
            if brief == nil { Thread.sleep(forTimeInterval: 0.25) }
        }
        attach(app, "org-page-ax5-menu")
        try XCTUnwrap(brief, "the picker's menu has no Brief").tap()
        XCTAssertTrue(waitFor(picker) { $0.label.contains("Brief") }, "picking Brief left the picker on \(picker.label)")
        attach(app, "org-page-ax5-brief")
    }

    /// At the default size the bar keeps its words and the page its segments.
    func testTheOrgBarKeepsItsWordsAtTheDefaultSize() throws {
        let app = try launchPaired([])
        openMainChat(app)
        let tasks = element(app, "org.bar.tasks")
        XCTAssertTrue(app.staticTexts["Tasks"].exists || tasks.staticTexts["Tasks"].exists, "the Tasks button lost its word")
        tasks.tap()
        let segmented = app.segmentedControls["org.node.tabs"]
        XCTAssertTrue(segmented.waitForExistence(timeout: 15), "the node page has no segmented picker at the default size")
        XCTAssertEqual(segmented.buttons.count, 3)
    }

    private func waitFor(_ element: XCUIElement, timeout: TimeInterval = 5, _ check: (XCUIElement) -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if check(element) { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return check(element)
    }
}
