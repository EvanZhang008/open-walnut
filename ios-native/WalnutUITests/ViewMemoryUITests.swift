import XCTest

/// What was open last is what opens next (the owner, 2026-11-08: "whatever I had open last,
/// for example a VP, must be what opens next time, not always Ask Walnut"): the tab, and the
/// page over an Org node's chat, across an ended process. Paired to `ChatPlaceFixtureServer`
/// (Main is an org node there), so it needs no Walnut and nobody's data. Nothing is sent.
final class ViewMemoryUITests: XCTestCase {

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

    /// The first launch of a test starts from nothing kept; the launches after it keep what it left.
    private func arguments(fresh: Bool) -> [String] {
        ["-walnut.serverUrl", fixture?.url ?? "", "-walnut.deviceToken", "chat-place-fixture"]
            + (fresh ? [] : [UITestLaunch.keepViewsArgument, "YES"])
    }

    private func launch(fresh: Bool = true) -> XCUIApplication {
        let app = UITestLaunch.launch(arguments(fresh: fresh))
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText("chat-place-fixture")
            app.buttons["setup.connect"].tap()
        }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "the app never came up")
        return app
    }

    private func relaunch(_ app: XCUIApplication) -> XCUIApplication {
        app.terminate()
        return launch(fresh: false)
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testTheTabLeftIsTheTabALaunchOpens() throws {
        var app = launch()
        for tab in ["Inbox", "Notes", "Chat"] {
            app.tabBars.buttons[tab].tap()
            Thread.sleep(forTimeInterval: 1)
            app = relaunch(app)
            let button = app.tabBars.buttons[tab]
            XCTAssertTrue(button.waitForExistence(timeout: 20))
            XCTAssertTrue(button.isSelected, "left on \(tab), the launch opened another tab")
            attach(app, "after-relaunch-\(tab)")
        }
    }

    func testTheOrgPageOverTheChatComesBackAfterALaunch() throws {
        var app = launch()
        app.tabBars.buttons["Chat"].tap()
        // A page a run before left over the chat (it comes back a moment after the chat): back to
        // the chat first.
        let bar = element(app, "org.bar.tasks")
        let page = app.segmentedControls["org.node.tabs"]
        if page.waitForExistence(timeout: 15) {
            Thread.sleep(forTimeInterval: 1)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertTrue(page.waitForNonExistence(timeout: 10), "Back did not close the kept page")
        }
        if !bar.waitForExistence(timeout: 5) {
            let menu = app.buttons["chat.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 30))
            menu.tap()
            let picker = app.segmentedControls["chat.drawer.viewSwitch"]
            if picker.waitForExistence(timeout: 5), picker.buttons["Org"].exists { picker.buttons["Org"].tap() }
            let ceo = app.buttons["chat.drawer.org.ceo"]
            XCTAssertTrue(ceo.waitForExistence(timeout: 30), "no Main row in the drawer's Org view")
            ceo.tap()
        }
        XCTAssertTrue(bar.waitForExistence(timeout: 30), "Main's chat has no Threads, Tasks and Brief bar")
        bar.tap()
        let tabs = app.segmentedControls["org.node.tabs"]
        XCTAssertTrue(tabs.waitForExistence(timeout: 15), "the Tasks page did not open")
        // Moved on to Brief on the page itself: that is what comes back.
        tabs.buttons["Brief"].tap()
        Thread.sleep(forTimeInterval: 1)

        app = relaunch(app)
        let back = app.segmentedControls["org.node.tabs"]
        XCTAssertTrue(back.waitForExistence(timeout: 30), "a launch did not put the Org page back over Main's chat")
        XCTAssertTrue(back.buttons["Brief"].isSelected, "the page came back on another view")
        attach(app, "org-page-after-relaunch")

        // Back to the chat: a launch then opens the chat, no page over it.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(element(app, "org.bar.tasks").waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1)
        app = relaunch(app)
        XCTAssertTrue(element(app, "org.bar.tasks").waitForExistence(timeout: 30), "Main's chat did not come back")
        XCTAssertFalse(app.segmentedControls["org.node.tabs"].exists, "the page closed with Back came back")
        attach(app, "chat-after-back-and-relaunch")
    }
}
