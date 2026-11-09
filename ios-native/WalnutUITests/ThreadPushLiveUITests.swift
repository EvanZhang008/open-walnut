import XCTest

/// A thread push tapped while the app runs, with the VP's page already up (the P1 case of the
/// thread push work, `OrgNodePageLink`): the page stays, its Threads view comes forward, and the
/// pushed thread is scrolled into view and marked, whatever was in front of it (another thread,
/// the Tasks or the Brief view, a task's session or a Follow up opened from the page).
///
/// The tap enters through the DEBUG link `walnut://debug-thread-push?...` (`DebugThreadPushLink`),
/// which does what the notification delegate does with a tapped thread push: the server's payload
/// read by `ThreadDeepLink.target`, then `ThreadDeepLink.shared.arm` with the tap source, at the
/// moment it arrives. The app is paired to `ChatPlaceFixtureServer` with `OrgThreadsFixture` (a VP
/// with a chat, fourteen threads for the user, one worker, a Brief).
///
/// Each case asserts by accessibility identifier: the page (`org.node.page`), the selected view
/// (`org.node.tabs`), the card (`org.thread.<id>`) with its title on screen, and the reveal mark
/// (`org.thread.revealed.<id>`, DEBUG only), and attaches a screenshot at each step.
final class ThreadPushLiveUITests: XCTestCase {

    private var fixture: ChatPlaceFixtureServer?
    private var app: XCUIApplication!
    /// Steps whose reveal mark never showed: reported at the end, so the rest still runs.
    private var revealMisses: [String] = []
    private var shotIndex = 0

    private let vp = OrgThreadsFixture.vpTaskID
    private let ids = OrgThreadsFixture.threadIDs

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        revealMisses = []
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

    private func shot(_ name: String) {
        shotIndex += 1
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = String(format: "%02d-%@", shotIndex, name)
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

    /// Where the page's content shows: under the view switch and the Threads view's pinned jump
    /// bar (`org.threads.jumps`), above the tab bar.
    private func viewport() -> (top: CGFloat, bottom: CGFloat)? {
        guard tabs.exists else { return nil }
        let jumps = el("org.threads.jumps")
        let top = max(tabs.frame.maxY, jumps.exists ? jumps.frame.maxY : 0)
        let bar = app.tabBars.firstMatch
        let bottom = bar.exists && bar.frame.height > 0 ? bar.frame.minY : app.windows.firstMatch.frame.maxY
        return (top, bottom)
    }

    /// The element sits on screen in the page's viewport, judged by frames. Not `isHittable`: on
    /// these pages it reads false for a title drawn in plain view (measured 2026-11-08, three
    /// runs), the harness reading `ComposerAttachmentMenuUITests` already records. That a touch
    /// reaches the card is proven by `touchChanges`, a real tap.
    private func inView(_ e: XCUIElement) -> Bool {
        guard e.exists, let v = viewport() else { return false }
        let f = e.frame
        return !f.isEmpty && f.minY >= v.top - 1 && f.maxY <= v.bottom + 1
    }

    /// What `inView` measured, for a failure's message.
    private func whereIs(_ e: XCUIElement) -> String {
        guard e.exists else { return "the element does not exist" }
        guard let v = viewport() else { return "no view switch (org.node.tabs)" }
        return "frame \(e.frame), viewport \(v.top) to \(v.bottom)"
    }

    /// A touch at the centre of `e`, by coordinate (what a finger does, whatever covers it), that
    /// must change its label: the proof that what is in view also takes a touch.
    private func touchChanges(_ e: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(e.waitForExistence(timeout: 5), "\(what) is not on the card", file: file, line: line)
        XCTAssertTrue(poll(5) { inView(e) }, "\(what) is not in view: \(whereIs(e))", file: file, line: line)
        let before = e.label
        touch(e)
        XCTAssertTrue(poll(5) { e.exists && e.label != before }, "a touch on \(what) changed nothing (\(before))",
                      file: file, line: line)
    }

    /// A finger at the centre of `e`: a coordinate tap, which `isHittable` does not gate.
    private func touch(_ e: XCUIElement) {
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: e.frame.midX, dy: e.frame.midY))
            .tap()
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

    /// The VP's Threads page, opened the way he opens it: a launch from a thread push lands on
    /// the VP's chat with its page, Back to the chat, then Threads on the chat's bar. The page then
    /// carries no request of its own.
    private func openThreadsPageFromTheBar(_ name: String) throws {
        app = try launchPaired(["-walnut.debugThreadPush", "\(vp) \(ids[0])"])
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 60), "the launch tap opened no VP page")
        XCTAssertTrue(card(ids[0]).waitForExistence(timeout: 20), "the launch tap's page shows no threads")
        shot("\(name)-launch-page")
        let named = app.navigationBars.buttons["BackButton"]
        let back = named.waitForExistence(timeout: 5) ? named : app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 10), "the page has no Back")
        back.tap()
        let bar = el("org.bar.threads")
        XCTAssertTrue(bar.waitForExistence(timeout: 20), "the VP's chat shows no Threads button")
        XCTAssertTrue(el("org.node.page").waitForNonExistence(timeout: 10), "Back left the page up")
        bar.tap()
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 15), "Threads on the bar opened no page")
        XCTAssertTrue(cardTitle(ids[0]).waitForExistence(timeout: 20), "the bar's page shows no threads")
        XCTAssertTrue(poll(10) { inView(cardTitle(ids[0])) },
                      "the bar's page does not start at its first thread: \(whereIs(cardTitle(ids[0])))")
        XCTAssertTrue(segment("Threads").isSelected)
        shot("\(name)-bar-page")
    }

    /// A tap on a push for `threadId` of the VP, now: the link the DEBUG hook takes.
    private func push(_ threadId: String) {
        let url = URL(string: "walnut://debug-thread-push?task=\(vp)&thread=\(threadId)&n=\(UUID().uuidString)")!
        XCUIDevice.shared.system.open(url)
        // Should the system ask before the link opens the app, say yes.
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 1) { open.tap() }
    }

    /// The push's result on screen: the same page, Threads in front, the thread in view and marked.
    private func expectRevealed(_ threadId: String, _ step: String, file: StaticString = #filePath, line: UInt = #line) {
        let mark = el("org.thread.revealed.\(threadId)")
        if mark.waitForExistence(timeout: 12) {
            shot("\(step)-revealed")
        } else {
            revealMisses.append(step)
            shot("\(step)-no-mark")
        }
        XCTAssertEqual(app.state, .runningForeground, "\(step): the app left the foreground", file: file, line: line)
        XCTAssertTrue(el("org.node.page").exists, "\(step): the VP's page is gone", file: file, line: line)
        XCTAssertTrue(segment("Threads").waitForExistence(timeout: 5), "\(step): no view switch", file: file, line: line)
        XCTAssertTrue(poll(5) { segment("Threads").isSelected }, "\(step): Threads did not come forward", file: file, line: line)
        XCTAssertTrue(card(threadId).waitForExistence(timeout: 10), "\(step): no card for \(threadId)", file: file, line: line)
        XCTAssertTrue(poll(8) { inView(cardTitle(threadId)) },
                      "\(step): the card for \(threadId) is not in view: \(whereIs(cardTitle(threadId)))", file: file, line: line)
        shot("\(step)-settled")
        // The shown card takes a touch: its Conversation toggle opens or closes.
        let toggle = card(threadId).buttons["org.thread.conversation"]
        touchChanges(toggle, "\(step): \(threadId)'s Conversation", file: file, line: line)
    }

    private func reportRevealMarks() {
        XCTAssertTrue(revealMisses.isEmpty, "no reveal mark seen after: \(revealMisses.joined(separator: ", "))")
    }

    // MARK: - Cases

    /// A. Threads open, a push for another thread of the same VP, further down: the page stays,
    /// and that thread scrolls into view, marked.
    func testAPushForAnotherThreadWhileThreadsIsOpenRevealsIt() throws {
        try openThreadsPageFromTheBar("A")
        let target = ids[9]
        XCTAssertTrue(card(target).exists, "the far thread is on the page")
        XCTAssertFalse(inView(cardTitle(target)), "the far thread starts out of view")
        push(target)
        expectRevealed(target, "A-push")
        reportRevealMarks()
    }

    /// B. The page on Tasks, then on Brief: each push brings Threads forward with its thread shown.
    func testBAPushWhileTasksOrBriefIsInFrontSwitchesToThreads() throws {
        try openThreadsPageFromTheBar("B")
        segment("Tasks").tap()
        XCTAssertTrue(el("org.tasks").waitForExistence(timeout: 10), "no Tasks view")
        XCTAssertTrue(el("org.tasks.row").waitForExistence(timeout: 15), "the Tasks view lists no work")
        shot("B-tasks")
        push(ids[7])
        expectRevealed(ids[7], "B-from-tasks")

        segment("Brief").tap()
        XCTAssertTrue(el("org.brief").waitForExistence(timeout: 10), "no Brief view")
        XCTAssertTrue(poll(5) { segment("Brief").isSelected })
        shot("B-brief")
        push(ids[11])
        expectRevealed(ids[11], "B-from-brief")
        reportRevealMarks()
    }

    /// C. One thread pushed, the list scrolled away from it, the same thread pushed again: shown again.
    func testCTheSameThreadPushedAgainAfterScrollingAwayIsShownAgain() throws {
        try openThreadsPageFromTheBar("C")
        let target = ids[12]
        push(target)
        expectRevealed(target, "C-first")

        let list = el("org.threads")
        for _ in 0..<8 where !inView(cardTitle(ids[0])) { list.swipeDown() }
        XCTAssertTrue(poll(5) { inView(cardTitle(ids[0])) }, "the list did not scroll back to the top")
        XCTAssertFalse(inView(cardTitle(target)), "the thread is still in view after scrolling away")
        shot("C-scrolled-away")
        // Past the first reveal's mark, so a mark seen now is the second push's.
        XCTAssertTrue(el("org.thread.revealed.\(target)").waitForNonExistence(timeout: 5))
        push(target)
        expectRevealed(target, "C-again")
        reportRevealMarks()
    }

    /// D. A task's session opened from the page's Tasks view, then a push: the session closes and
    /// the thread shows on Threads.
    func testDAPushClosesATaskSessionOpenedFromThePage() throws {
        try openThreadsPageFromTheBar("D")
        segment("Tasks").tap()
        let row = el("org.tasks.row")
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the Tasks view lists no work")
        XCTAssertTrue(poll(5) { inView(row) }, "the Tasks view's row is not in view: \(whereIs(row))")
        touch(row)
        let done = el("task.open.done")
        XCTAssertTrue(done.waitForExistence(timeout: 20), "the task's session did not open")
        shot("D-task-session")
        push(ids[8])
        // The reveal first: its mark lasts 2.5 s, and the card's touch fails under a session left up.
        expectRevealed(ids[8], "D-push")
        XCTAssertTrue(done.waitForNonExistence(timeout: 10), "D: the task's session is still up over the page")
        reportRevealMarks()
    }

    /// E. Follow up open on a thread, then a push for another one: the composer closes and the
    /// pushed thread shows.
    func testEAPushClosesAnOpenFollowUp() throws {
        try openThreadsPageFromTheBar("E")
        let follow = card(ids[0]).buttons["org.thread.followUp"]
        XCTAssertTrue(follow.waitForExistence(timeout: 10), "the first thread has no Follow up")
        // A touch where the first card's Follow up shows, by coordinate: the bar's page takes it.
        XCTAssertTrue(poll(5) { inView(follow) }, "the first thread's Follow up is not in view: \(whereIs(follow))")
        touch(follow)
        let input = el("org.thread.followUp.input")
        XCTAssertTrue(input.waitForExistence(timeout: 10), "Follow up opened no composer")
        input.tap()
        input.typeText("Checking in on this")
        shot("E-follow-up")
        push(ids[10])
        // The reveal first: its mark lasts 2.5 s (2026-11-08 run: shown and gone while these waited).
        expectRevealed(ids[10], "E-push")
        XCTAssertTrue(input.waitForNonExistence(timeout: 10), "E: the Follow up is still up over the page")
        XCTAssertTrue(poll(5) { app.keyboards.count == 0 }, "E: the keyboard stayed up")
        reportRevealMarks()
    }
}
