import XCTest

/// What the thread push UI cases of the second review round share (`ThreadPushHoldUITests`,
/// `ThreadPushNavigationUITests`): the threads fixture paired, the DEBUG push link, and the
/// checks of where the push landed. Holds no tests itself.
class ThreadPushUITestCase: XCTestCase {

    var fixture: ChatPlaceFixtureServer?
    var app: XCUIApplication!
    private var shotIndex = 0

    let vp = OrgThreadsFixture.vpTaskID
    let ids = OrgThreadsFixture.threadIDs
    let vp2 = OrgThreadsFixture.vp2TaskID
    let ids2 = OrgThreadsFixture.vp2ThreadIDs

    /// The fixture's slow answers for this class.
    var answerDelay: (String, String) -> TimeInterval { OrgThreadsFixture.slowAnswer }
    var shotPrefix: String { "T" }

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        shotIndex = 0
        let server = try ChatPlaceFixtureServer()
        server.extraRoute = OrgThreadsFixture.route
        server.answerDelay = answerDelay
        try server.start()
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    // MARK: - Looking

    var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    func el(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    func card(_ threadId: String) -> XCUIElement { el("org.thread.\(threadId)") }

    func cardTitle(_ threadId: String) -> XCUIElement {
        card(threadId).descendants(matching: .any).matching(identifier: "org.thread.title").firstMatch
    }

    var tabs: XCUIElement { app.segmentedControls["org.node.tabs"] }

    func segment(_ prefix: String) -> XCUIElement {
        tabs.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    func titled(_ text: String) -> XCUIElement {
        app.navigationBars.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func shot(_ name: String) {
        shotIndex += 1
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = String(format: "%@%02d-%@", shotPrefix, shotIndex, name)
        a.lifetime = .keepAlways
        add(a)
    }

    func poll(_ seconds: TimeInterval, _ ok: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if ok() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        return ok()
    }

    func viewport() -> (top: CGFloat, bottom: CGFloat)? {
        guard tabs.exists else { return nil }
        let jumps = el("org.threads.jumps")
        let top = max(tabs.frame.maxY, jumps.exists ? jumps.frame.maxY : 0)
        let bar = app.tabBars.firstMatch
        let bottom = bar.exists && bar.frame.height > 0 ? bar.frame.minY : app.windows.firstMatch.frame.maxY
        return (top, bottom)
    }

    func inView(_ e: XCUIElement) -> Bool {
        guard e.exists, let v = viewport() else { return false }
        let f = e.frame
        return !f.isEmpty && f.minY >= v.top - 1 && f.maxY <= v.bottom + 1
    }

    func whereIs(_ e: XCUIElement) -> String {
        guard e.exists else { return "the element does not exist" }
        guard let v = viewport() else { return "no view switch (org.node.tabs)" }
        return "frame \(e.frame), viewport \(v.top) to \(v.bottom)"
    }

    func touch(_ e: XCUIElement) {
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: e.frame.midX, dy: e.frame.midY))
            .tap()
    }

    /// Small drags of the thread list until `e` sits whole in the viewport.
    func bringIntoView(_ e: XCUIElement) {
        let list = el("org.threads")
        for _ in 0..<8 {
            guard e.exists, let v = viewport(), !inView(e) else { return }
            let below = e.frame.maxY > v.bottom
            let from = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: below ? 0.65 : 0.35))
            let to = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: below ? 0.4 : 0.6))
            from.press(forDuration: 0.05, thenDragTo: to)
        }
    }

    /// Empty a text input whatever an earlier run left in it.
    func clear(_ input: XCUIElement) {
        let n = (input.value as? String)?.count ?? 0
        guard n > 0 else { return }
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: n + 2))
    }

    // MARK: - Getting there

    func launchPaired(_ extra: [String]) throws -> XCUIApplication {
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

    func back() {
        let named = app.navigationBars.buttons["BackButton"]
        let b = named.waitForExistence(timeout: 5) ? named : app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(b.waitForExistence(timeout: 10), "no Back")
        b.tap()
    }

    /// A launch from a push lands on the VP's page; Back goes to the VP's chat.
    func launchToVPChat(_ name: String) throws {
        app = try launchPaired(["-walnut.debugThreadPush", "\(vp) \(ids[0])"])
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 60), "the launch tap opened no VP page")
        XCTAssertTrue(card(ids[0]).waitForExistence(timeout: 20), "the launch tap's page shows no threads")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 20), "no VP chat")
        XCTAssertTrue(el("org.node.page").waitForNonExistence(timeout: 10))
        shot("\(name)-vp-chat")
    }

    /// The VP's page opened from the chat's bar.
    func openBarPage(_ name: String) throws {
        try launchToVPChat(name)
        el("org.bar.threads").tap()
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 15), "Threads on the bar opened no page")
        XCTAssertTrue(cardTitle(ids[0]).waitForExistence(timeout: 20), "the bar's page shows no threads")
        shot("\(name)-bar-page")
    }

    func push(_ threadId: String, task: String? = nil) {
        let url = URL(string: "walnut://debug-thread-push?task=\(task ?? vp)&thread=\(threadId)&n=\(UUID().uuidString)")!
        XCUIDevice.shared.system.open(url)
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 1) { open.tap() }
    }

    /// An item of the session menu (`session.menu`) of the chat in front: of a sheet's chat when
    /// one is up over another chat (the one he can tap).
    func sessionMenu(_ item: String) { menuItem(item, from: "session.menu") }

    /// An item of the composer's `+` of the chat in front (`chat.plus`).
    func plusMenu(_ item: String) { menuItem(item, from: "chat.plus") }

    private func menuItem(_ item: String, from button: String) {
        let menus = app.buttons.matching(identifier: button)
        XCTAssertTrue(menus.firstMatch.waitForExistence(timeout: 10), "no \(button)")
        var menu = menus.firstMatch
        _ = poll(5) {
            let all = menus.allElementsBoundByIndex
            if let front = all.last(where: { $0.isHittable }) { menu = front; return true }
            return false
        }
        menu.tap()
        let entry = app.buttons[item]
        XCTAssertTrue(entry.waitForExistence(timeout: 5), "no \(item) under \(button)")
        entry.tap()
    }

    // MARK: - Where it landed

    /// The push's result: the VP's page, Threads in front, the thread in view and marked. With
    /// `outline`, the outline he sees (2.5 s) must be seen drawn on it too: only where the reveal
    /// comes right after a tap of the test's own (a held push released by closing the sheet), since
    /// opening a URL from the test takes longer than the outline lasts.
    func expectRevealed(_ threadId: String, _ step: String, outline: Bool = false,
                        file: StaticString = #filePath, line: UInt = #line) {
        let drawn = el("org.thread.highlight.\(threadId)")
        let marked = el("org.thread.revealed.\(threadId)")
        var sawOutline = false, sawMark = false
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline, !(sawMark && (sawOutline || !outline)) {
            if outline, !sawOutline, drawn.exists { sawOutline = true }
            if !sawMark, marked.exists { sawMark = true }
        }
        shot("\(step)-\(sawMark ? "revealed" : "no-mark")")
        XCTAssertTrue(sawMark, "\(step): no reveal mark for \(threadId)", file: file, line: line)
        if outline {
            XCTAssertTrue(sawOutline, "\(step): the outline he sees was never drawn on \(threadId)", file: file, line: line)
        }
        XCTAssertTrue(el("org.node.page").exists, "\(step): no VP page", file: file, line: line)
        XCTAssertTrue(poll(5) { segment("Threads").isSelected }, "\(step): Threads not in front", file: file, line: line)
        XCTAssertTrue(poll(8) { inView(cardTitle(threadId)) },
                      "\(step): \(threadId) not in view: \(whereIs(cardTitle(threadId)))", file: file, line: line)
        shot("\(step)-settled")
    }

    /// While a sheet holds his work, a push waits: the sheet says so, and nothing moved under it.
    func expectHeld(_ step: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(el("nav.held").waitForExistence(timeout: 8), "\(step): the sheet does not say a push waits", file: file, line: line)
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'org.thread.highlight.'")).firstMatch.exists,
                       "\(step): a thread was revealed under the sheet", file: file, line: line)
        shot("\(step)-held")
    }
}
