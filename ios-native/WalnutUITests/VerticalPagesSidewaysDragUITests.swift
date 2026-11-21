import XCTest

/// A SIDEWAYS DRAG ON A PAGE THAT SCROLLS UP AND DOWN MOVES NOTHING.
///
/// 2026-11-15 the user asked why he could swipe the Org page's Threads left and right; his
/// screenshot had every card slid right, its words cut at the edge. Before that fix a drag right
/// slid the whole page off and went Back: iOS 26's content pop (`ReadingPageSwipe.swift`).
/// 2026-11-20 he asked for all of them: "pages that scroll up and down, why do they have to move
/// sideways? These are all bugs, find every one and fix it."
///
/// So every such page is opened through real taps and dragged with a real finger, left, right and
/// left again across its middle (never from the screen's edge), and the page's main element must
/// stay where it was, inside the screen, with the page still shown: Main's chat, its Threads,
/// Tasks and Brief, the Inbox list and a letter, the Notes list and a note, and Settings. Each page
/// holds `WideText`'s shapes of his longest texts (`VerticalPagesFixture`). A list whose rows have
/// swipe actions on purpose (the Inbox's Read, a note's Pin and Delete) is dragged below its rows.
/// The page stays a second on screen before and after, so a screen recording of the run shows each.
/// `VerticalPagesWidthTests` checks each page's content width itself.
///
/// Paired to `ChatPlaceFixtureServer` (no Walnut, nobody's data). Nothing here sends a message.
final class VerticalPagesSidewaysDragUITests: XCTestCase {
    private typealias F = VerticalPagesFixture
    private var fixture: ChatPlaceFixtureServer?

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        let server = try ChatPlaceFixtureServer(options: F.options())
        server.extraRoutes = { method, target, _ in F.route(method, target) }
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

    private func labelled(_ app: XCUIApplication, containing words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    private func launchPaired() throws -> XCUIApplication {
        let token = "vertical-pages-fixture"
        let app = UITestLaunch.launch(["-walnut.serverUrl", try XCTUnwrap(fixture).url, "-walnut.deviceToken", token,
                                       "-walnut.deviceName", "someone's phone " + WideText.cjkThreadVideo + " " + WideText.unbrokenPath,
                                       // The proof video shows the finger and the path of each drag.
                                       "-walnut.debug.showTouches", "YES"])
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            app.buttons["setup.connect"].tap()
        }
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func open(_ app: XCUIApplication, _ tab: AppTab) {
        let button = app.tab(tab)
        XCTAssertTrue(button.waitForExistence(timeout: 30), "no \(tab.rawValue) tab")
        button.tap()
    }

    /// Where a finger drags across `target`: its middle, or `y` points down the window when given
    /// (below a list's rows, whose own swipe actions slide them on purpose).
    private func dragSideways(_ app: XCUIApplication, _ target: XCUIElement, y: CGFloat?, from: CGFloat, to: CGFloat) {
        let start: XCUICoordinate
        let end: XCUICoordinate
        if let y {
            let window = app.windows.firstMatch
            let width = window.frame.width
            let origin = window.coordinate(withNormalizedOffset: .zero)
            start = origin.withOffset(CGVector(dx: width * from, dy: y))
            end = origin.withOffset(CGVector(dx: width * to, dy: y + 4))
        } else {
            start = target.coordinate(withNormalizedOffset: CGVector(dx: from, dy: 0.45))
            end = target.coordinate(withNormalizedOffset: CGVector(dx: to, dy: 0.47))
        }
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.8)
    }

    /// Below `lastRow`, when the screen has room under it above the tab bar; else nil (the middle).
    private func below(_ app: XCUIApplication, _ lastRow: XCUIElement) -> CGFloat? {
        let window = app.windows.firstMatch.frame
        let y = lastRow.frame.maxY + 50 - window.minY
        return y < window.height - 170 ? y : nil
    }

    /// Drags `target` left, right and left again, and checks `marker` never left its place or the
    /// screen and `shown` (the page) is still there.
    private func assertStaysPut(_ app: XCUIApplication, _ page: String, drag target: XCUIElement, marker: XCUIElement,
                                shown: XCUIElement, y: CGFloat? = nil, file: StaticString = #filePath, line: UInt = #line) {
        let screen = app.windows.firstMatch.frame
        Thread.sleep(forTimeInterval: 1)
        attach(app, "\(page)-before")
        let before = marker.frame
        XCTAssertGreaterThanOrEqual(before.minX, screen.minX - 0.5, "\(page): starts off the left edge: \(before)", file: file, line: line)
        XCTAssertLessThanOrEqual(before.maxX, screen.maxX + 0.5, "\(page): runs past the right edge: \(before)", file: file, line: line)
        for (from, to, way) in [(0.85, 0.1, "left"), (0.15, 0.9, "right"), (0.85, 0.1, "left again")] {
            dragSideways(app, target, y: y, from: from, to: to)
            Thread.sleep(forTimeInterval: 0.6)
            let after = marker.frame
            print("[evidence] \(page): frame.minX before=\(before.minX) after=\(after.minX) (a drag \(way); screen \(screen.size))")
            XCTAssertTrue(shown.exists, "\(page): a drag \(way) took the page away", file: file, line: line)
            XCTAssertEqual(after.minX, before.minX, accuracy: 1, "\(page): a drag \(way) moved it sideways: \(before) -> \(after)",
                           file: file, line: line)
            XCTAssertLessThanOrEqual(after.maxX, screen.maxX + 0.5, "\(page): runs past the right edge after a drag \(way): \(after)",
                                     file: file, line: line)
        }
        attach(app, "\(page)-after-drags")
        Thread.sleep(forTimeInterval: 1)
    }

    func testEveryVerticalPageStaysPutWhenDraggedSideways() throws {
        let app = try launchPaired()
        app.openMainOrgChat()
        try orgPages(app)
        try inboxPages(app)
        try notesPages(app)
        settingsPage(app)
    }

    // MARK: - Main's chat, Threads, Tasks, Brief

    private func orgPages(_ app: XCUIApplication) throws {
        let window = app.windows.firstMatch
        let title = app.buttons["session.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 20), "Main's chat has no title")
        let newest = labelled(app, containing: F.chatMarker)
        XCTAssertTrue(newest.waitForExistence(timeout: 30), "the chat's newest message is not on the page")
        assertStaysPut(app, "chat", drag: window, marker: newest, shown: title)

        element(app, "org.bar.threads").tap()
        XCTAssertTrue(element(app, "org.node.page").waitForExistence(timeout: 15), "Threads on the bar opened no page")
        let card = element(app, "org.thread.\(F.threadID)")
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the long thread's card is not on the page")
        // Its summary open, so the long paths, the code and the table are on screen. By its place:
        // the card is one accessibility container, and XCUITest calls the button inside it not
        // hittable although a finger reaches it.
        let expand = element(app, "org.thread.summary.expand")
        XCTAssertTrue(expand.waitForExistence(timeout: 5), "the long summary has no Expand")
        expand.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let conversation = element(app, "org.thread.conversation")
        if conversation.waitForExistence(timeout: 3) {
            conversation.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap()
        }
        let page = element(app, "org.node.page")
        assertStaysPut(app, "threads", drag: element(app, "org.threads"), marker: card, shown: page)

        // The page's own Threads | Tasks | Brief switch, never the tab bar's Tasks.
        let orgTabs = app.segmentedControls["org.node.tabs"]
        let tasks = orgTabs.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 10), "no Tasks in the page's view switch")
        tasks.tap()
        let row = element(app, "org.tasks.row")
        XCTAssertTrue(row.waitForExistence(timeout: 20), "Main's Tasks lists none of the team's long tasks")
        assertStaysPut(app, "tasks", drag: element(app, "org.tasks"), marker: row, shown: page)

        orgTabs.buttons["Brief"].tap()
        let text = element(app, "org.brief.text")
        XCTAssertTrue(text.waitForExistence(timeout: 15), "the Brief did not show")
        assertStaysPut(app, "brief", drag: element(app, "org.brief"), marker: text, shown: page)

        // Back is still the swipe from the screen's left edge.
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)),
                   withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(page.waitForNonExistence(timeout: 5), "a swipe from the left edge no longer goes Back")
        attach(app, "edge-swipe-back")
    }

    // MARK: - Inbox and a letter

    private func inboxPages(_ app: XCUIApplication) throws {
        open(app, .inbox)
        let list = element(app, "inbox.list")
        XCTAssertTrue(list.waitForExistence(timeout: 30), "the Inbox list did not show")
        let all = element(app, "inbox.filter.all")
        if all.waitForExistence(timeout: 5), all.isHittable { all.tap() }
        let first = element(app, "inbox.row.\(F.letterIDs[0])")
        XCTAssertTrue(first.waitForExistence(timeout: 30), "the long letter is not in the Inbox")
        let last = element(app, "inbox.row.\(F.letterIDs[F.letterIDs.count - 1])")
        let y = last.waitForExistence(timeout: 10) ? below(app, last) : nil
        assertStaysPut(app, "inbox", drag: list, marker: first, shown: list, y: y)

        first.tap()
        let subject = element(app, "inbox.letter.subject")
        XCTAssertTrue(subject.waitForExistence(timeout: 20), "the letter did not open")
        let body = element(app, "inbox.letter.markdownBody")
        XCTAssertTrue(body.waitForExistence(timeout: 20), "the letter's long body is not on the page")
        assertStaysPut(app, "letter", drag: app.windows.firstMatch, marker: subject, shown: element(app, "inbox.letter.document"))
    }

    // MARK: - Notes and a note

    private func notesPages(_ app: XCUIApplication) throws {
        open(app, .notes)
        let note = app.staticTexts[F.noteName]
        XCTAssertTrue(note.waitForExistence(timeout: 30), "the long note is not in the Notes list")
        let notes = app.navigationBars["Notes"]
        let folder = app.staticTexts["Projects"]
        let lowest = folder.exists && folder.frame.maxY > note.frame.maxY ? folder : note
        let y = below(app, lowest)
        assertStaysPut(app, "notes", drag: app.windows.firstMatch, marker: note, shown: notes, y: y)

        note.tap()
        let editor = element(app, "note.editor")
        XCTAssertTrue(editor.waitForExistence(timeout: 20), "the note did not open")
        assertStaysPut(app, "note", drag: app.windows.firstMatch, marker: editor, shown: editor)
    }

    // MARK: - Settings

    private func settingsPage(_ app: XCUIApplication) {
        open(app, .settings)
        let status = element(app, "settings.status")
        XCTAssertTrue(status.waitForExistence(timeout: 20), "Settings did not show")
        assertStaysPut(app, "settings", drag: app.windows.firstMatch, marker: status, shown: app.navigationBars["Settings"])
    }
}
