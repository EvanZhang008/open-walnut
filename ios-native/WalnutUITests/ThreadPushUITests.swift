import XCTest

/// A tap on a thread push opens the chat of the task it names (`ThreadDeepLink.openThread`, an
/// `OrgNodeLink` request for its Threads page; server src/core/push/thread-push.ts), and a payload
/// that is not a thread push only opens the app. In the fixture Main is the org's CEO node, so a
/// tap for it opens its Threads page over its chat; the ask carries no Org role, so a tap for it
/// lands on its chat. These pin where a tap lands, and that a launch restore never covers it.
///
/// The tap enters through the DEBUG launch argument `-walnut.debugThreadPush "<taskId>
/// <threadId>"`, which makes the same `ThreadDeepLink.handle` call the notification delegate
/// makes (a banner cannot be tapped on cue here); a real `simctl push` tap is the manual check
/// on top. The app is paired to `ChatPlaceFixtureServer` (a Main and an ask, each with a session).
final class ThreadPushUITests: XCTestCase {

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

    private func launchPaired(_ extra: [String]) throws -> XCUIApplication {
        let server = try XCTUnwrap(fixture).url
        let token = "chat-place-fixture"
        let app = UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token] + extra)
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        return app
    }

    private func titled(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.navigationBars.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func tap(_ taskId: String) -> [String] { ["-walnut.debugThreadPush", "\(taskId) th-5e5e5e5e"] }

    /// A tap opens the tapped node's chat, also over the chat a launch would put back: the first
    /// tap opens Main (so Main is the remembered place), the second, in a new launch, the ask.
    func testATappedThreadPushOpensTheChatOfTheTaskItNames() throws {
        let first = try launchPaired(tap(ChatPlaceFixtureServer.mainTaskID))
        // Main is an Org node (the CEO): the tap opens its Threads page, over its chat.
        XCTAssertTrue(first.descendants(matching: .any)["org.node.page"].waitForExistence(timeout: 45),
                      "no Threads page opened for the tap")
        XCTAssertTrue(titled(first, "CEO").waitForExistence(timeout: 10), "the tap did not open Main's page")
        first.navigationBars.buttons["BackButton"].tap()
        XCTAssertTrue(first.buttons["session.title"].waitForExistence(timeout: 15), "no chat under the tapped page")
        XCTAssertTrue(titled(first, "CEO").waitForExistence(timeout: 10), "the chat under the page is not Main's")
        first.terminate()

        let app = try launchPaired(tap(ChatPlaceFixtureServer.askTaskID))
        XCTAssertTrue(app.buttons["session.title"].waitForExistence(timeout: 45), "no chat opened for the tap")
        XCTAssertTrue(titled(app, "Compare two laptops").waitForExistence(timeout: 10),
                      "the launch put back the last chat instead of the tapped one")
        Thread.sleep(forTimeInterval: 3)
        XCTAssertTrue(titled(app, "Compare two laptops").exists, "a late restore replaced the tapped chat")
    }

    /// A thread push missing its thread id is not ours: the app just opens on the chat it was on,
    /// as an older build does.
    func testAPushMissingItsThreadOnlyOpensTheApp() throws {
        // Leave the app on the chat itself.
        let first = try launchPaired([])
        // A chat over the chat is its peer, with no Back: the sidebar is the way off it.
        if first.buttons["session.title"].waitForExistence(timeout: 20) {
            first.leaveChatPeerForTheChat()
        }
        XCTAssertTrue(first.buttons["chat.menu"].waitForExistence(timeout: 30))
        first.terminate()

        let app = try launchPaired(["-walnut.debugThreadPush", ChatPlaceFixtureServer.askTaskID])
        XCTAssertTrue(app.buttons["chat.menu"].waitForExistence(timeout: 45), "the app never opened")
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            XCTAssertFalse(app.descendants(matching: .any)["chat.orgOpening"].exists, "something started opening")
            XCTAssertFalse(app.buttons["session.title"].exists, "a chat opened for a payload that is not ours")
            Thread.sleep(forTimeInterval: 0.5)
        }
    }
}

