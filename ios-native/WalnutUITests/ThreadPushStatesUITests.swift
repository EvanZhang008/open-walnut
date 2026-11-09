import XCTest

/// A thread push tapped in the states the first review round found open (2026-11-08):
///
///  - K: the VP's chat with one of its own sheets up (Task Details, then Session Controls).
///  - L: a sheet on another tab (the Tasks draft) and the app's own work card list.
///  - M: a Follow up half written when a push for another thread comes: its words come back.
///  - N: a thread closed long ago, past the closed ones a list read brings, is found by its id.
///  - O: VP B's thread pushed while VP A's page is up, and back.
///  - P: he goes Back while a slow push read is on its way: the push gives way to him.
///  - Q: a cold launch whose open fails puts the last place back under its notice.
///  - R: a cold launch where the tap reaches the app after its first frame (the real order):
///    the last chat never shows before the VP's page.
///  - S: offline with the page up: the page still opens on the thread, and says it is offline.
///
/// Same fixture and DEBUG links as `ThreadPushLiveUITests` (`OrgThreadsFixture`, with a second
/// VP, a slow one, and an old closed thread). Screenshots at each step.
final class ThreadPushStatesUITests: XCTestCase {

    private var fixture: ChatPlaceFixtureServer?
    private var app: XCUIApplication!
    private var shotIndex = 0

    private let vp = OrgThreadsFixture.vpTaskID
    private let ids = OrgThreadsFixture.threadIDs

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        shotIndex = 0
        let server = try ChatPlaceFixtureServer()
        server.extraRoute = OrgThreadsFixture.route
        server.answerDelay = OrgThreadsFixture.slowAnswer
        try server.start()
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    // MARK: - Helpers

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

    private func titled(_ text: String) -> XCUIElement {
        app.navigationBars.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func shot(_ name: String) {
        shotIndex += 1
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = String(format: "S%02d-%@", shotIndex, name)
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

    private func whereIs(_ e: XCUIElement) -> String {
        guard e.exists else { return "the element does not exist" }
        guard let v = viewport() else { return "no view switch (org.node.tabs)" }
        return "frame \(e.frame), viewport \(v.top) to \(v.bottom)"
    }

    private func touch(_ e: XCUIElement) {
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: e.frame.midX, dy: e.frame.midY))
            .tap()
    }

    /// `paired`: a relaunch of an app this test already paired, which shows no setup to wait for.
    private func launchPaired(_ extra: [String], paired: Bool = false) throws -> XCUIApplication {
        let server = try XCTUnwrap(fixture).url
        let token = "chat-place-fixture"
        let app = UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token] + extra)
        let tokenField = app.secureTextFields["setup.token"]
        if !paired, tokenField.waitForExistence(timeout: 5) {
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

    /// A launch from a push lands on the VP's page; Back goes to the VP's chat.
    private func launchToVPChat(_ name: String) throws {
        app = try launchPaired(["-walnut.debugThreadPush", "\(vp) \(ids[0])"])
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 60), "the launch tap opened no VP page")
        XCTAssertTrue(card(ids[0]).waitForExistence(timeout: 20), "the launch tap's page shows no threads")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 20), "no VP chat")
        XCTAssertTrue(el("org.node.page").waitForNonExistence(timeout: 10))
        shot("\(name)-vp-chat")
    }

    /// The VP's page opened from the chat's bar: no request of its own.
    private func openBarPage(_ name: String) throws {
        try launchToVPChat(name)
        el("org.bar.threads").tap()
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 15), "Threads on the bar opened no page")
        XCTAssertTrue(cardTitle(ids[0]).waitForExistence(timeout: 20), "the bar's page shows no threads")
        shot("\(name)-bar-page")
    }

    private func push(_ threadId: String, task: String? = nil) {
        let url = URL(string: "walnut://debug-thread-push?task=\(task ?? vp)&thread=\(threadId)&n=\(UUID().uuidString)")!
        XCUIDevice.shared.system.open(url)
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 1) { open.tap() }
    }

    private func openLink(_ raw: String) {
        XCUIDevice.shared.system.open(URL(string: raw)!)
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 1) { open.tap() }
    }

    /// The push's result: the VP's page, Threads in front, the thread in view and marked.
    private func expectRevealed(_ threadId: String, _ step: String, file: StaticString = #filePath, line: UInt = #line) {
        let marked = el("org.thread.revealed.\(threadId)").waitForExistence(timeout: 15)
        shot("\(step)-\(marked ? "revealed" : "no-mark")")
        XCTAssertTrue(marked, "\(step): no reveal mark for \(threadId)", file: file, line: line)
        XCTAssertTrue(el("org.node.page").exists, "\(step): no VP page", file: file, line: line)
        XCTAssertTrue(poll(5) { segment("Threads").isSelected }, "\(step): Threads not in front", file: file, line: line)
        XCTAssertTrue(poll(8) { inView(cardTitle(threadId)) },
                      "\(step): \(threadId) not in view: \(whereIs(cardTitle(threadId)))", file: file, line: line)
        shot("\(step)-settled")
    }

    // MARK: - K. The VP chat's own sheets

    func testKThePushClosesTheVPChatsOwnSheets() throws {
        try launchToVPChat("K")
        let menu = app.buttons["session.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "no session menu")
        menu.tap()
        let details = app.buttons["session.taskDetails"]
        XCTAssertTrue(details.waitForExistence(timeout: 5), "no Task Details item")
        details.tap()
        // The task's details sheet: its status toggle is there.
        let sheet = el("task.statusToggle")
        XCTAssertTrue(sheet.waitForExistence(timeout: 15), "Task Details did not open")
        shot("K-task-details")
        push(ids[9])
        // The reveal first: its mark lasts 2.5 s.
        expectRevealed(ids[9], "K-over-details")
        XCTAssertFalse(sheet.exists, "K: Task Details is still up over the page")

        // The chat again, its Session Controls up, another push.
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 15))
        menu.tap()
        let controls = app.buttons["session.controls"]
        XCTAssertTrue(controls.waitForExistence(timeout: 5), "no Session Controls item")
        controls.tap()
        let controlsBar = app.navigationBars["Session Controls"]
        XCTAssertTrue(controlsBar.waitForExistence(timeout: 10), "Session Controls did not open")
        shot("K-controls")
        push(ids[4])
        expectRevealed(ids[4], "K-over-controls")
        XCTAssertFalse(controlsBar.exists, "K: Session Controls is still up over the pushed thread")
        // Nothing comes back up after it closed.
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(controlsBar.exists, "K: Session Controls came back")
    }

    // MARK: - L. Sheets on another tab, and the app's own

    func testLThePushClosesSheetsOnOtherTabsAndTheWorkCardList() throws {
        try launchToVPChat("L")
        app.tabBars.buttons["Tasks"].tap()
        let plus = app.buttons["sessions.new"]
        // The Tasks tab may open on the session he last opened there: Back to its board.
        for _ in 0..<3 where !plus.waitForExistence(timeout: 5) {
            let named = app.navigationBars.buttons["BackButton"]
            if named.exists { named.tap() } else { app.navigationBars.buttons.element(boundBy: 0).tap() }
        }
        XCTAssertTrue(plus.waitForExistence(timeout: 15), "no + on the Tasks tab")
        plus.tap()
        let draft = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'newSessionChat.'")).firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 15), "the Tasks draft did not open")
        shot("L-tasks-draft")
        push(ids[5])
        expectRevealed(ids[5], "L-over-draft")
        XCTAssertFalse(draft.exists, "L: the Tasks draft is still up")
        XCTAssertTrue(poll(5) { app.tabBars.firstMatch.exists && app.tabBars.buttons["Chat"].isSelected },
                      "L: Chat is not the tab in front, or the tab bar stayed hidden")

        openLink("walnut://work?list=working")
        let list = el("workcard.sheet")
        XCTAssertTrue(list.waitForExistence(timeout: 15), "the work card link opened no list")
        shot("L-work-card")
        push(ids[3])
        expectRevealed(ids[3], "L-over-work-card")
        XCTAssertFalse(list.exists, "L: the work card list is still up")
    }

    // MARK: - M. A half-written Follow up

    func testMAPushKeepsAHalfWrittenFollowUp() throws {
        try openBarPage("M")
        // The second thread (the first is the review probes' own); drafts outlive a launch, so
        // whatever an earlier run left in it goes first, and this run leaves none.
        let thread = ids[1]
        let follow = card(thread).buttons["org.thread.followUp"]
        XCTAssertTrue(follow.waitForExistence(timeout: 10))
        bringIntoView(follow)
        XCTAssertTrue(poll(5) { inView(follow) }, "M: Follow up is not in view: \(whereIs(follow))")
        touch(follow)
        let input = el("org.thread.followUp.input")
        XCTAssertTrue(input.waitForExistence(timeout: 10), "Follow up opened no composer")
        input.tap()
        clear(input)
        let words = "Half a thought about the pricing page"
        input.typeText(words)
        shot("M-typing")
        push(ids[10])
        expectRevealed(ids[10], "M-push")
        XCTAssertTrue(input.waitForNonExistence(timeout: 10), "M: the composer is still up")

        // Back up the list to that thread: it says its follow up is kept.
        let list = el("org.threads")
        for _ in 0..<10 where !inView(cardTitle(thread)) { list.swipeDown() }
        XCTAssertTrue(poll(5) { inView(cardTitle(thread)) }, "M: the thread is not back in view")
        bringIntoView(follow)
        let kept = card(thread).descendants(matching: .any).matching(identifier: "org.thread.followUp.kept").firstMatch
        XCTAssertTrue(kept.waitForExistence(timeout: 5), "M: the card does not say its follow up is kept")
        shot("M-kept")
        XCTAssertTrue(poll(5) { inView(follow) }, "M: Follow up is not back in view: \(whereIs(follow))")
        touch(follow)
        XCTAssertTrue(input.waitForExistence(timeout: 10), "M: Follow up did not open again")
        XCTAssertTrue(poll(5) { (input.value as? String) == words }, "M: the words did not come back: \(input.value ?? "nil")")
        shot("M-restored")
        // Cancel keeps them too.
        app.navigationBars["Follow up"].buttons["Cancel"].tap()
        XCTAssertTrue(input.waitForNonExistence(timeout: 10))
        XCTAssertTrue(kept.waitForExistence(timeout: 5), "M: Cancel dropped the words")

        // Leave no draft behind for the next run.
        bringIntoView(follow)
        touch(follow)
        XCTAssertTrue(input.waitForExistence(timeout: 10), "M: Follow up did not open for the clean up")
        input.tap()
        clear(input)
        app.navigationBars["Follow up"].buttons["Cancel"].tap()
        XCTAssertTrue(kept.waitForNonExistence(timeout: 5), "M: an emptied follow up still reads as kept")
    }

    /// Small drags of the thread list until `e` sits whole in the viewport.
    private func bringIntoView(_ e: XCUIElement) {
        let list = el("org.threads")
        for _ in 0..<8 {
            guard e.exists, let v = viewport(), !inView(e) else { return }
            let below = e.frame.maxY > v.bottom
            let from = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: below ? 0.65 : 0.35))
            let to = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: below ? 0.4 : 0.6))
            from.press(forDuration: 0.05, thenDragTo: to)
        }
    }

    private func clear(_ input: XCUIElement) {
        let n = (input.value as? String)?.count ?? 0
        guard n > 0 else { return }
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: n + 2))
    }

    // MARK: - N. A thread closed long ago

    func testNAClosedThreadPastTheListIsFoundByItsId() throws {
        try openBarPage("N")
        let old = OrgThreadsFixture.oldClosedThreadID
        XCTAssertFalse(card(old).exists, "the list does not hold the old thread")
        push(old)
        expectRevealed(old, "N-push")
        XCTAssertFalse(el("org.threads.missing").exists, "N: the page called a thread the server has gone")
        XCTAssertTrue(cardTitle(old).label.contains(OrgThreadsFixture.oldClosedTitle))
    }

    // MARK: - O. Another VP's thread while one VP's page is up

    func testOAPushForAnotherVPWhileOnesPageIsUp() throws {
        try openBarPage("O")
        let other = OrgThreadsFixture.vp2ThreadIDs[4]
        push(other, task: OrgThreadsFixture.vp2TaskID)
        expectRevealed(other, "O-to-vp2")
        XCTAssertTrue(titled(OrgThreadsFixture.vp2Name).waitForExistence(timeout: 5), "O: the page is not the Design VP's")
        XCTAssertFalse(card(ids[0]).exists, "O: Growth VP's threads are on Design VP's page")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 10), "O: Back did not land on a VP chat")
        XCTAssertTrue(titled("Design").waitForExistence(timeout: 5), "O: Back did not land on Design VP's chat")
        shot("O-back-on-vp2-chat")
        el("org.bar.threads").tap()
        XCTAssertTrue(card(OrgThreadsFixture.vp2ThreadIDs[0]).waitForExistence(timeout: 15))
        push(ids[9])
        expectRevealed(ids[9], "O-back-to-vp1")
        XCTAssertTrue(titled(OrgThreadsFixture.vpName).waitForExistence(timeout: 5), "O: the page is not Growth VP's")
    }

    // MARK: - P. His own move wins over a slow push

    func testPHisBackWinsOverASlowPushRead() throws {
        try launchToVPChat("P")
        push("th-5e5e5e5e", task: OrgThreadsFixture.slowTaskID)
        let opening = el("chat.orgOpening")
        XCTAssertTrue(opening.waitForExistence(timeout: 4), "P: nothing says the chat is on its way")
        shot("P-opening-over-the-chat")
        // The VP's chat is a peer of the sidebar with no Back: he leaves it through the sidebar.
        app.leaveChatPeerForTheChat()
        XCTAssertTrue(el("chat.menu").waitForExistence(timeout: 10), "P: the sidebar did not reach the chat")
        XCTAssertTrue(opening.waitForNonExistence(timeout: 3), "P: the open still says it is on its way")
        // Past the slow read: nothing opens over where he went.
        Thread.sleep(forTimeInterval: OrgThreadsFixture.slowSeconds + 2)
        shot("P-after-the-read")
        XCTAssertFalse(app.buttons["session.title"].exists, "P: the push opened a chat over the one he picked")
        XCTAssertFalse(el("org.node.page").exists)
    }

    // MARK: - Q. A cold launch whose open fails

    func testQAFailedLaunchOpenPutsTheLastPlaceBack() throws {
        // The VP's chat is the place this launch leaves.
        try launchToVPChat("Q")
        app.terminate()
        app = try launchPaired(["-walnut.debugThreadPush", "task-fixture-gone th-5e5e5e5e"], paired: true)
        let notice = el("chat.orgOpenNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 45), "Q: the failed open says nothing")
        // The last place comes back under it while it is up (it goes after 8 s in view): both read
        // in one pass as soon as the place shows.
        let place = titled(OrgThreadsFixture.vpName)
        var restored = false, noticeWithIt = false
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            if place.exists { restored = true; noticeWithIt = notice.exists; break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertTrue(restored, "Q: the last place (the VP's chat) did not come back")
        XCTAssertTrue(noticeWithIt, "Q: the notice went with the restore")
        shot("Q-restored-under-notice")
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 30), "Q: the restored chat is not the VP's")
    }

    // MARK: - R. The tap after the first frame

    func testRATapAfterTheFirstFrameNeverShowsTheLastChatFirst() throws {
        // The ask's chat is the place this launch leaves.
        app = try launchPaired(["-walnut.debugThreadPush", "\(ChatPlaceFixtureServer.askTaskID) th-5e5e5e5e"])
        XCTAssertTrue(titled("Compare two laptops").waitForExistence(timeout: 45), "R: the ask did not open")
        app.terminate()

        app = try launchPaired(["-walnut.debugThreadPushLate", "\(vp) \(ids[6])"])
        var flashes = 0
        var paged = false
        // One look at a time for both: the last chat's title in the bar, or the VP's page. The
        // last chat never shows on the way. (The reveal's 2.5 s mark is not waited for here: a cold
        // app's first looks at its tree take longer than that; the scroll below is the proof.)
        let either = app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier == 'org.node.page' OR (elementType == %d AND label CONTAINS %@)",
            XCUIElement.ElementType.staticText.rawValue, "Compare two laptops"))
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !paged {
            for found in either.allElementsBoundByIndex {
                if found.identifier == "org.node.page" { paged = true } else { flashes += 1 }
            }
            if !paged { Thread.sleep(forTimeInterval: 0.1) }
        }
        XCTAssertTrue(paged, "R: the late tap opened no VP page")
        XCTAssertEqual(flashes, 0, "R: the last chat showed before the VP's page (\(flashes) looks)")
        XCTAssertTrue(poll(5) { segment("Threads").isSelected }, "R: Threads not in front")
        XCTAssertTrue(poll(10) { inView(cardTitle(ids[6])) }, "R: the thread is not in view: \(whereIs(cardTitle(ids[6])))")
        XCTAssertFalse(inView(cardTitle(ids[0])), "R: the page did not move to the thread (the first one is in view)")
        shot("R-late-settled")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 10), "R: Back did not land on the VP's chat")
    }

    // MARK: - S. Offline with the page up

    func testSOfflineThePageStillOpensOnTheThreadAndSaysSo() throws {
        try openBarPage("S")
        fixture?.stop()
        // Two failed reads in a row make the app offline: three pulls of the list.
        let list = el("org.threads")
        for _ in 0..<3 {
            list.swipeDown()
            Thread.sleep(forTimeInterval: 2)
        }
        shot("S-offline")
        push(ids[8])
        expectRevealed(ids[8], "S-push-offline")
        let notice = el("chat.orgOpenNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 5), "S: nothing says the page is offline")
        let words = notice.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] 'offline' OR label CONTAINS[c] 'reach Walnut'")).firstMatch
        XCTAssertTrue(words.exists, "S: the notice does not say the server is out of reach")
        shot("S-notice")
    }
}
