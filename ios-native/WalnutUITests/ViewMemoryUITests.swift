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
        settle(app)
        return app
    }

    /// The tab bar shows before the app has finished starting (the tab a launch picks, the chat
    /// it puts back), and a tap that early can be lost or undone: on a slow CI runner the first
    /// tab tap after a 30 s launch did not stick (2026-11-10). Wait for the app's own first
    /// screen, as `ChatPlaceUITests` does, before touching it.
    private func settle(_ app: XCUIApplication) {
        let ready = [app.buttons["chat.menu"], app.buttons["session.title"], element(app, "org.bar.tasks"),
                     app.segmentedControls["org.node.tabs"]]
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !app.tabBars.buttons.allElementsBoundByIndex.contains(where: \.isSelected)
                || (app.tabBars.buttons["Chat"].isSelected && !ready.contains(where: \.exists)) {
            Thread.sleep(forTimeInterval: 0.25)
        }
        Thread.sleep(forTimeInterval: 1)
    }

    /// Picks `tab` and waits until the tab bar says it is picked (one more tap if the first
    /// was lost), then for the choice to be written.
    private func select(_ app: XCUIApplication, _ tab: String) {
        let button = app.tabBars.buttons[tab]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "no \(tab) tab")
        if button.isSelected { return }
        for _ in 0..<2 where !button.isSelected {
            button.tap()
            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline, !button.isSelected { Thread.sleep(forTimeInterval: 0.2) }
        }
        if !button.isSelected { dump(app, "\(tab) tab never picked") }
        XCTAssertTrue(button.isSelected, "a tap on \(tab) did not pick it")
        Thread.sleep(forTimeInterval: 1)
    }

    /// The screen's element tree in the log: a CI run keeps no screenshot to look at.
    private func dump(_ app: XCUIApplication, _ why: String) {
        print("ViewMemoryUITests: \(why)\n\(app.debugDescription)")
        attach(app, why)
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

    /// Until the kept page is on top, the chat under it stays covered (2026-11-09: a launch showed
    /// the chat for about a second, then slid the page over it). Polls from the launch on.
    private func assertNoChatBeforeKeptPage(_ app: XCUIApplication) {
        let page = app.segmentedControls["org.node.tabs"]
        let chatBar = element(app, "org.bar.tasks")
        let cover = element(app, "session.coveredUntilPage")
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !page.exists {
            if chatBar.exists, !cover.exists, !page.exists {
                attach(app, "chat-shown-before-kept-page")
                XCTFail("the chat showed before the kept page came back over it")
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    func testTheTabLeftIsTheTabALaunchOpens() throws {
        var app = launch()
        for tab in ["Inbox", "Notes", "Chat"] {
            select(app, tab)
            app = relaunch(app)
            let button = app.tabBars.buttons[tab]
            XCTAssertTrue(button.waitForExistence(timeout: 20))
            if !button.isSelected { dump(app, "left on \(tab), relaunched elsewhere") }
            XCTAssertTrue(button.isSelected, "left on \(tab), the launch opened another tab")
            attach(app, "after-relaunch-\(tab)")
        }
    }

    func testTheOrgPageOverTheChatComesBackAfterALaunch() throws {
        var app = launch()
        select(app, "Chat")
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
            if !menu.waitForExistence(timeout: 30) { dump(app, "no chat menu on the Chat tab") }
            XCTAssertTrue(menu.exists, "no chat menu on the Chat tab")
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

        // Watched from the first frame: the token is kept, so no setup screen to wait out.
        app.terminate()
        app = UITestLaunch.launch(arguments(fresh: false))
        assertNoChatBeforeKeptPage(app)
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
