import XCTest

/// A sideways drag on the Org page's Threads and Brief moves nothing (2026-11-15, the user: "为什么
/// ... 我可以左右滑 ... 它不就是上下的一个滑动吗"; his screenshot had every card slid right, its words
/// cut at the edge). Main's Threads and Brief here hold what showed it: long absolute paths of video
/// files, a long URL, a code line, a wide table, a task chip and a follow-up with its answer. Each
/// view is dragged left and right with a real finger; the card and the Brief's text stay where they
/// were, inside the screen. `OrgThreadsPageWidthTests` checks the page's scroll width itself.
///
/// Paired to `ChatPlaceFixtureServer` (no Walnut, nobody's data). Nothing here sends a message.
final class OrgThreadsSidewaysDragUITests: XCTestCase {
    private var fixture: ChatPlaceFixtureServer?
    private static let threadID = "th-7e0000d1"
    private static let path = "/Users/someone/.local/state/open-walnut/tasks/51f06886-908d-5ed0-a367-2c2f05e6d7b7/clips/router-dialog-folders-webkit.mp4"
    private static let url = "https://example.com/a/very/long/address/without/any/spaces/" + String(repeating: "segment-", count: 12) + "end"

    private static var longText: String {
        """
        Shipped: the router settings now open in one dialog in the middle of the screen, the same one from Apps › Mail and from the Org page.

        - Open the dialog, the folders load, tick two, save, open again: \(path)
        - A failed read and Try again: \(path.replacingOccurrences(of: "folders", with: "error-retry"))
        - \(url)

        ```
        walnut tools call task_send '{"in_reply_to":"rq-0000","title":"\(String(repeating: "long ", count: 30))"}'
        ```

        | Video | Path |
        |---|---|
        | folders | \(path) |
        """
    }

    private static func at(_ minutesAgo: Double) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(-minutesAgo * 60))
    }

    private static var thread: [String: Any] {
        [
            "id": threadID, "title": "Router settings: one dialog, folders load by themselves (shipped)",
            "state": "answered", "reply": longText, "tasks": [ChatPlaceFixtureServer.askTaskID],
            "createdAt": at(90), "updatedAt": at(5), "shown": true,
            "messages": [[
                "id": "tm-0000000d01", "at": at(30), "via": "follow-up",
                "text": "the folders should load by themselves, and open it as its own dialog " + path,
                "answer": ["text": "Handed back with two changes:\n\n- **Folders**: \(path)\n- \(url)", "at": at(29)],
            ]],
        ]
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        let server = try ChatPlaceFixtureServer()
        let main = "/api/v1/tasks/\(ChatPlaceFixtureServer.mainTaskID)"
        server.extraRoutes = { method, target, _ in
            guard method == "GET" else { return nil }
            let path = String(target.split(separator: "?", maxSplits: 1).first ?? "")
            if path == "\(main)/threads" {
                return (200, ["threads": [Self.thread], "closed_count": 0, "shown_count": 1])
            }
            if path == "\(main)/brief" {
                return (200, ["brief": ["text": "### Needs you\n- nothing\n### Working\n" + Self.longText + "\n### Waiting / snoozed\n- nothing", "at": Self.at(10)]])
            }
            return nil
        }
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

    private func launchPaired() throws -> XCUIApplication {
        let token = "chat-place-fixture"
        let app = UITestLaunch.launch(["-walnut.serverUrl", try XCTUnwrap(fixture).url, "-walnut.deviceToken", token])
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        return app
    }

    private func openMainChat(_ app: XCUIApplication) {
        let threads = element(app, "org.bar.threads")
        if threads.waitForExistence(timeout: 8) { return }
        app.leaveChatPeerForTheChat()
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

    /// Drags a finger across `target` sideways, held a moment at the end, then lets go.
    private func dragSideways(_ target: XCUIElement, from: CGFloat, to: CGFloat) {
        let start = target.coordinate(withNormalizedOffset: CGVector(dx: from, dy: 0.3))
        let end = target.coordinate(withNormalizedOffset: CGVector(dx: to, dy: 0.32))
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.8)
    }

    /// Drags `target` both ways and checks `marker` never left its place or the screen.
    private func assertStaysPut(_ app: XCUIApplication, drag target: XCUIElement, marker: XCUIElement, _ name: String) {
        let screen = app.windows.firstMatch.frame
        let before = marker.frame
        print("[evidence] \(name) before: \(before) on \(screen.size)")
        XCTAssertGreaterThanOrEqual(before.minX, screen.minX - 0.5, "\(name): starts off the left edge: \(before)")
        XCTAssertLessThanOrEqual(before.maxX, screen.maxX + 0.5, "\(name): runs past the right edge: \(before)")
        for (from, to, way) in [(0.85, 0.1, "left"), (0.15, 0.9, "right"), (0.85, 0.1, "left again")] {
            dragSideways(target, from: from, to: to)
            Thread.sleep(forTimeInterval: 0.6)
            let after = marker.frame
            print("[evidence] \(name) after a drag \(way): \(after)")
            XCTAssertEqual(after.minX, before.minX, accuracy: 0.5, "\(name): a drag \(way) moved it sideways: \(before) -> \(after)")
            XCTAssertLessThanOrEqual(after.maxX, screen.maxX + 0.5, "\(name): runs past the right edge after a drag \(way): \(after)")
        }
        attach(app, "\(name)-after-drags")
    }

    func testThreadsAndBriefDoNotMoveSideways() throws {
        let app = try launchPaired()
        openMainChat(app)
        element(app, "org.bar.threads").tap()
        XCTAssertTrue(element(app, "org.node.page").waitForExistence(timeout: 15), "Threads on the bar opened no page")
        let card = element(app, "org.thread.\(Self.threadID)")
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the long thread's card is not on the page")
        // Its summary open, so the long paths, the code and the table are on screen.
        let expand = element(app, "org.thread.summary.expand")
        if expand.waitForExistence(timeout: 3) { expand.tap() }
        Thread.sleep(forTimeInterval: 1)
        attach(app, "threads-long-paths")
        assertStaysPut(app, drag: card, marker: card, "threads card")

        let brief = app.segmentedControls["org.node.tabs"].buttons["Brief"]
        XCTAssertTrue(brief.waitForExistence(timeout: 10), "no Brief in the page's view switch")
        brief.tap()
        let text = element(app, "org.brief.text")
        XCTAssertTrue(text.waitForExistence(timeout: 15), "the Brief did not show")
        Thread.sleep(forTimeInterval: 1)
        attach(app, "brief-long-paths")
        assertStaysPut(app, drag: element(app, "org.brief"), marker: text, "brief text")
    }
}
