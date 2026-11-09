import XCTest

/// Review probes for the thread push work: states `ThreadPushLiveUITests` does not cover.
/// F: the VP's chat (no page) with one of the chat's own sheets open. H: another app tab in
/// front, then Back from the revealed page. I: two pushes in quick succession. J: a push for a
/// thread the fixture does not have. Same fixture and DEBUG link as `ThreadPushLiveUITests`.
final class ThreadPushReviewUITests: XCTestCase {

    private var fixture: ChatPlaceFixtureServer?
    private var app: XCUIApplication!
    private var shotIndex = 0

    private let vp = OrgThreadsFixture.vpTaskID
    private let ids = OrgThreadsFixture.threadIDs

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = true
        shotIndex = 0
        let server = try ChatPlaceFixtureServer()
        server.extraRoute = OrgThreadsFixture.route
        try server.start()
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    private func el(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func card(_ threadId: String) -> XCUIElement { el("org.thread.\(threadId)") }

    private func cardTitle(_ threadId: String) -> XCUIElement {
        card(threadId).descendants(matching: .any).matching(identifier: "org.thread.title").firstMatch
    }

    private var tabs: XCUIElement { app.segmentedControls["org.node.tabs"] }

    private func segment(_ prefix: String) -> XCUIElement {
        tabs.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func shot(_ name: String) {
        shotIndex += 1
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = String(format: "R%02d-%@", shotIndex, name)
        a.lifetime = .keepAlways
        add(a)
    }

    private func poll(_ seconds: TimeInterval, _ ok: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if ok() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        return ok()
    }

    private func viewport() -> (top: CGFloat, bottom: CGFloat)? {
        guard tabs.exists else { return nil }
        let jumps = el("org.threads.jumps")
        let top = max(tabs.frame.maxY, jumps.exists ? jumps.frame.maxY : 0)
        let bar = app.tabBars.firstMatch
        let bottom = bar.exists && bar.frame.height > 0 ? bar.frame.minY : app.windows.firstMatch.frame.maxY
        return (top, bottom)
    }

    private func inView(_ e: XCUIElement) -> Bool {
        guard e.exists, let v = viewport() else { return false }
        let f = e.frame
        return !f.isEmpty && f.minY >= v.top - 1 && f.maxY <= v.bottom + 1
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

    private func back() {
        let named = app.navigationBars.buttons["BackButton"]
        let b = named.waitForExistence(timeout: 5) ? named : app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(b.waitForExistence(timeout: 10), "no Back")
        b.tap()
    }

    /// Launch from a push (page up), then Back to the VP's chat.
    private func launchToVPChat(_ name: String) throws {
        app = try launchPaired(["-walnut.debugThreadPush", "\(vp) \(ids[0])"])
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 60), "the launch tap opened no VP page")
        XCTAssertTrue(card(ids[0]).waitForExistence(timeout: 20))
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 20), "no VP chat")
        XCTAssertTrue(el("org.node.page").waitForNonExistence(timeout: 10))
        shot("\(name)-vp-chat")
    }

    private func push(_ threadId: String) {
        let url = URL(string: "walnut://debug-thread-push?task=\(vp)&thread=\(threadId)&n=\(UUID().uuidString)")!
        XCUIDevice.shared.system.open(url)
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 1) { open.tap() }
    }

    private func expectRevealed(_ threadId: String, _ step: String, file: StaticString = #filePath, line: UInt = #line) {
        let mark = el("org.thread.revealed.\(threadId)")
        let marked = mark.waitForExistence(timeout: 12)
        shot("\(step)-\(marked ? "revealed" : "no-mark")")
        XCTAssertTrue(marked, "\(step): no reveal mark for \(threadId)", file: file, line: line)
        XCTAssertTrue(el("org.node.page").exists, "\(step): no VP page", file: file, line: line)
        XCTAssertTrue(poll(5) { segment("Threads").isSelected }, "\(step): Threads not in front", file: file, line: line)
        XCTAssertTrue(poll(8) { inView(cardTitle(threadId)) }, "\(step): \(threadId) not in view", file: file, line: line)
        shot("\(step)-settled")
    }

    // MARK: - Cases

    /// F. The VP's chat with its own Session Controls sheet up (no page), then a push: the page
    /// must come up with the thread visible, not under the sheet.
    func testFAPushWhileTheVPChatHasItsOwnSheetOpen() throws {
        try launchToVPChat("F")
        let menu = app.buttons["session.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "no session menu")
        menu.tap()
        let controls = app.buttons["session.controls"]
        XCTAssertTrue(controls.waitForExistence(timeout: 5), "no Session Controls item")
        controls.tap()
        let sheetBar = app.navigationBars["Session Controls"]
        XCTAssertTrue(sheetBar.waitForExistence(timeout: 10), "Session Controls did not open")
        shot("F-controls-sheet")
        push(ids[9])
        Thread.sleep(forTimeInterval: 4)
        shot("F-after-push")
        XCTAssertFalse(sheetBar.exists, "F: Session Controls is still up over the pushed thread")
        expectRevealed(ids[9], "F-push")
    }

    /// H. The Inbox tab in front, then a push: Chat comes forward with the page; Back goes to the
    /// VP's chat.
    func testHAPushWhileAnotherTabIsInFrontAndBackAfter() throws {
        try launchToVPChat("H")
        app.tabBars.buttons["Inbox"].tap()
        Thread.sleep(forTimeInterval: 1.5)
        shot("H-inbox")
        push(ids[6])
        expectRevealed(ids[6], "H-push")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 10), "H: Back did not land on the VP's chat")
        XCTAssertTrue(el("org.node.page").waitForNonExistence(timeout: 10), "H: Back left the page up")
        shot("H-back")
    }

    /// I. Two pushes a moment apart while the page is up: the second thread is the one shown.
    func testITwoQuickPushesShowTheSecond() throws {
        try launchToVPChat("I")
        el("org.bar.threads").tap()
        XCTAssertTrue(cardTitle(ids[0]).waitForExistence(timeout: 20))
        push(ids[4])
        push(ids[11])
        expectRevealed(ids[11], "I-second")
        Thread.sleep(forTimeInterval: 3)
        XCTAssertTrue(inView(cardTitle(ids[11])), "I: the second thread scrolled out of view later")
        shot("I-later")
    }

    /// J. A push for a thread the server no longer lists: the page says so.
    func testJAPushForAThreadNoLongerOpenSaysSo() throws {
        try launchToVPChat("J")
        push("th-7e0000ff")
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 20), "J: no page")
        let missing = el("org.threads.missing")
        XCTAssertTrue(missing.waitForExistence(timeout: 15), "J: no 'no longer open' line")
        shot("J-missing")
        XCTAssertTrue(poll(5) { segment("Threads").isSelected })
    }
}
