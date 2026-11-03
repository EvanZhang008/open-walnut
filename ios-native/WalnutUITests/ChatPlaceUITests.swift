import XCTest

/// The Chat tab comes back to the chat the user was in, on every way back: another
/// tab and back, the app in the background and back, and a launch after the process
/// was ended. (Tapping the Chat tab while ON it is iOS's "back to the top": it pops a
/// pushed session to the chat under it, as every tab of every app does.) (the user, 2026-11-02: "if I am in the main
/// chat, stay in the main chat, don't turn it into a new chat").
///
/// The app is paired to `ChatPlaceFixtureServer`, a loopback server this runner hosts
/// with a Main, two conversations and an ask, so the tests run anywhere, CI included,
/// with no Walnut and nobody's data. Nothing here sends a message.
final class ChatPlaceUITests: XCTestCase {

    private var fixture: ChatPlaceFixtureServer?

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        // A loaded CI runner can take a while to bring a listener up: once more on a miss.
        do {
            let server = try ChatPlaceFixtureServer()
            try server.start()
            fixture = server
        } catch {
            let server = try ChatPlaceFixtureServer()
            try server.start()
            fixture = server
        }
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    private var arguments: [String] = []

    private func launchPaired() throws -> XCUIApplication {
        let server = try XCTUnwrap(fixture).url
        let token = "chat-place-fixture"
        arguments = [
            "-walnut.serverUrl", server,
            "-walnut.deviceToken", token,
        ]
        let app = UITestLaunch.launch(arguments)
        // A Release build takes no token from the command line: pair it the way a
        // person does, on the setup page.
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            let name = app.textFields["setup.deviceName"]
            if name.exists { name.tap(); name.typeText("lane-b") }
            app.buttons["setup.connect"].tap()
        }
        // The chat, or the session the last run left open over it (put back on launch).
        let deadline = Date().addingTimeInterval(60)
        while !app.buttons["chat.menu"].exists, !sessionTitle(app).exists, Date() < deadline {
            _ = app.buttons["chat.menu"].waitForExistence(timeout: 2)
        }
        XCTAssertTrue(app.buttons["chat.menu"].exists || sessionTitle(app).exists, "the chat never appeared")
        return app
    }

    private func relaunch(_ app: XCUIApplication) -> XCUIApplication {
        app.terminate()
        let again = UITestLaunch.launch(arguments)
        return again
    }

    // MARK: - Where the chat is

    private func sessionTitle(_ app: XCUIApplication) -> XCUIElement { app.buttons["session.title"] }
    private func chatTitle(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["chat.title"].firstMatch
    }

    private func pause(_ seconds: Double) { Thread.sleep(forTimeInterval: seconds) }

    /// Off any session a previous run left pushed over the chat.
    private func backToTheChat(_ app: XCUIApplication) {
        guard sessionTitle(app).exists else { return }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["chat.menu"].waitForExistence(timeout: 20), "Back did not return to the chat")
    }

    private func openDrawer(_ app: XCUIApplication, view: String) {
        let menu = app.buttons["chat.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20))
        menu.tap()
        let picker = app.segmentedControls["chat.drawer.viewSwitch"]
        if picker.waitForExistence(timeout: 5) {
            let segment = picker.buttons[view]
            if segment.exists, !segment.isSelected { segment.tap() }
        }
    }

    /// Every way back to the Chat tab, each followed by `check`: the user is where
    /// they were.
    private func everyReturn(_ start: XCUIApplication, step: String, check: (XCUIApplication, String) -> Void) {
        var app = start
        for tab in ["Inbox", "Notes", "Settings", "Tasks"] {
            app.tabBars.buttons[tab].tap()
            pause(1.2)
            app.tabBars.buttons["Chat"].tap()
            pause(1.2)
            check(app, "\(step): back from \(tab)")
        }
        XCUIDevice.shared.press(.home)
        pause(3)
        app.activate()
        pause(2)
        check(app, "\(step): back from the background")
        app = relaunch(app)
        pause(4)
        check(app, "\(step): a launch after the app was ended")
        attach(app, "\(step)-after-relaunch")
    }

    // MARK: - Tests

    /// Main (the org's CEO node), opened from the drawer's Org view.
    func testMainChatComesBackOnEveryReturn() throws {
        let app = try launchPaired()
        backToTheChat(app)
        openDrawer(app, view: "Org")
        let ceo = app.buttons["chat.drawer.org.ceo"]
        XCTAssertTrue(ceo.waitForExistence(timeout: 30), "no Main row in the drawer's Org view")
        ceo.tap()
        let title = sessionTitle(app)
        XCTAssertTrue(title.waitForExistence(timeout: 30), "Main's chat did not open")
        pause(2)
        let expected = title.label
        attach(app, "main-opened")
        everyReturn(app, step: "main") { app, why in
            let now = self.sessionTitle(app)
            XCTAssertTrue(now.waitForExistence(timeout: 20), "\(why): Main's chat is gone")
            XCTAssertEqual(now.label, expected, "\(why): another chat is on screen")
        }
    }

    /// One of the agent's own conversations, opened from the drawer's Chats view.
    func testAConversationComesBackOnEveryReturn() throws {
        let app = try launchPaired()
        // Off any session a previous run left pushed.
        backToTheChat(app)
        openDrawer(app, view: "Chats")
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat.drawer.conversation.'"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 30), "no conversation in the drawer")
        let row = rows.element(boundBy: min(1, rows.count - 1))
        row.tap()
        pause(2)
        let expected = chatTitle(app).label
        XCTAssertFalse(sessionTitle(app).exists, "a conversation opens in the chat itself")
        attach(app, "conversation-opened")
        everyReturn(app, step: "conversation") { app, why in
            let now = self.chatTitle(app)
            XCTAssertTrue(now.waitForExistence(timeout: 20), "\(why): the chat is gone")
            XCTAssertEqual(now.label, expected, "\(why): another conversation is on screen")
            XCTAssertFalse(self.sessionTitle(app).exists, "\(why): a session is over the chat")
        }
    }

    /// An ask from the drawer's Recents: its session, pushed over the chat.
    func testAnAskComesBackOnEveryReturn() throws {
        let app = try launchPaired()
        backToTheChat(app)
        openDrawer(app, view: "Chats")
        let asks = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat.drawer.ask.'"))
        XCTAssertTrue(asks.firstMatch.waitForExistence(timeout: 30), "no ask in the drawer")
        asks.firstMatch.tap()
        let title = sessionTitle(app)
        XCTAssertTrue(title.waitForExistence(timeout: 30), "the ask's chat did not open")
        pause(2)
        let expected = title.label
        everyReturn(app, step: "ask") { app, why in
            let now = self.sessionTitle(app)
            XCTAssertTrue(now.waitForExistence(timeout: 20), "\(why): the ask's chat is gone")
            XCTAssertEqual(now.label, expected, "\(why): another chat is on screen")
        }
    }

    /// The drawer's New chat is how the user starts fresh, and a new chat they left
    /// stays a new chat.
    func testNewChatIsTheExplicitWayAndIsRemembered() throws {
        var app = try launchPaired()
        backToTheChat(app)
        openDrawer(app, view: "Chats")
        let newChat = app.buttons["chat.drawer.newChat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 20))
        newChat.tap()
        pause(1.5)
        let empty = app.staticTexts["Your Personal AI is listening"]
        XCTAssertTrue(empty.waitForExistence(timeout: 10), "New chat shows an empty chat")
        app = relaunch(app)
        XCTAssertTrue(app.staticTexts["Your Personal AI is listening"].waitForExistence(timeout: 20),
                      "a new chat the user left is still a new chat after a launch")
        attach(app, "new-chat-after-relaunch")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
