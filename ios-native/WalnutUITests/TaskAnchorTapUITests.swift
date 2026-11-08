import XCTest

/// Task citations in chat (native and rich) open the right task; unknown, conflicting and code ones stay text.
final class TaskAnchorTapUITests: XCTestCase {

    private static let prose = (id: "mfxprose-a001", title: "Fixture prose reference")
    private static let backtick = (id: "mfxtick0-a002", title: "Fixture backtick reference")
    private static let anchor = (id: "mfxanchr-a003", title: "Fixture raw anchor")
    private static let rich = (id: "mfxrichd-a004", title: "Fixture rich card anchor")
    private static let unknownLabel = "Gone fixture task"
    private static let conflictLabel = "Conflict fixture label"
    private static let richUnknownLabel = "Gone rich task"
    private static let richConflictLabel = "Conflict rich label"
    private static let longCode = #"send <task-ref id="mfxprose-a001" label="Old title"/>"#
    private static let richLongCode = #"send <task-ref id="mfxrichd-a004"/>"#
    private static let fencedSample = #"<a href="/tasks/mfxanchr-a003" class="task-link">Sample anchor</a>"#
    private static let richPreSample = "Rich pre sample"
    /// Served only by the late-board fixture, so no earlier test's cached board knows it.
    private static let late = (id: "mfxlate0-" + UUID().uuidString.lowercased(), title: "Fixture late board title")
    private static let lateLabel = "Late fixture label"

    private var fixture: ChatPlaceFixtureServer?
    private var arguments: [String] = []

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        XCUIDevice.shared.appearance = .light
        do {
            fixture = try Self.startFixture()
        } catch {
            // A loaded runner can be slow to bring a listener up: once more on a miss.
            fixture = try Self.startFixture()
        }
    }

    override func tearDown() {
        XCUIDevice.shared.appearance = .light
        fixture?.stop()
        fixture = nil
        UITestLaunch.terminate()
        super.tearDown()
    }

    // MARK: - Synthetic fixture data

    private static func startFixture(tasksInitiallyHidden: Bool = false, lateCard: Bool = false) throws -> ChatPlaceFixtureServer {
        var options = ChatPlaceFixtureServer.Options()
        options.tasksInitiallyHidden = tasksInitiallyHidden
        var tasks = ([prose, backtick, anchor, rich] + (lateCard ? [late] : []))
            .map { ChatPlaceFixtureServer.taskRow(id: $0.id, title: $0.title) }
        for i in 0..<300 {
            tasks.append(ChatPlaceFixtureServer.taskRow(
                id: String(format: "mfxfill0-%04x", i), title: "Fixture board row \(i + 1)",
                phase: i % 3 == 0 ? "IN_PROGRESS" : "TODO"))
        }
        options.tasks = tasks
        var main = mainHistory()
        if lateCard {
            // A person's row between them keeps the citation rows out of a folded "updates" group.
            main.append(ChatPlaceFixtureServer.historyRow(role: "user", text: "And the late one?", at: time(100)))
            main.append(ChatPlaceFixtureServer.historyRow(role: "assistant", text: lateCitation, at: time(101)))
        }
        options.history = [
            ChatPlaceFixtureServer.mainSessionID: main,
            ChatPlaceFixtureServer.askSessionID: askHistory(),
        ]
        let server = try ChatPlaceFixtureServer(options: options)
        try server.start()
        return server
    }

    private static func time(_ minute: Int) -> String {
        String(format: "2026-11-02T%02d:%02d:00.000Z", 8 + minute / 60, minute % 60)
    }

    static let nativeCitations = """
    Where the fixture tasks stand:

    - Prose: <task-ref id="\(prose.id)" label="Old title"/> is next.
    - Backtick: `<task-ref id="\(backtick.id)" label="Old title"/>` is queued.
    - Anchor: <a href="/tasks/\(anchor.id)" class="task-link" data-task-id="\(anchor.id)">Old title</a> is done.
    - Unknown: <a href="/tasks/mzzzzzzz-ffff" class="task-link">\(unknownLabel)</a> was removed.
    - Conflict: <a href="/tasks/\(prose.id)" class="task-link" data-task-id="\(backtick.id)">\(conflictLabel)</a> stays text.
    - Long code: `\(longCode)` to try it.

    Sample markup, shown as written:

    ```html
    \(fencedSample)
    ```
    """

    static let richCitation = """
    <div><p>Owner: <a href="/tasks/\(rich.id)" class="task-link">Old title</a></p>\
    <p>Unknown: <a href="/tasks/mzzzzzzz-ffff" class="task-link">\(richUnknownLabel)</a></p>\
    <p>Conflict: <a href="/tasks/\(prose.id)" class="task-link" data-task-id="\(backtick.id)">\(richConflictLabel)</a></p>\
    <p>Sample: `\(richLongCode)`</p>\
    <pre><a href="/tasks/\(anchor.id)" class="task-link">\(richPreSample)</a></pre></div>
    """

    static let lateCitation = """
    <div><p>Late: <a href="/tasks/\(late.id)" class="task-link">\(lateLabel)</a></p></div>
    """

    private static func mainHistory() -> [[String: Any]] {
        var rows: [[String: Any]] = []
        for i in 0..<97 {
            let user = i % 2 == 0
            var text = user ? "Fixture question \(i / 2 + 1) about the weekend plan."
                : "Fixture answer \(i / 2 + 1): nothing to do yet."
            if i == 11 { text = "Earlier note: <task-ref id=\"\(prose.id)\" label=\"Old title\"/> was filed." }
            rows.append(ChatPlaceFixtureServer.historyRow(role: user ? "user" : "assistant", text: text, at: time(i)))
        }
        rows.append(ChatPlaceFixtureServer.historyRow(role: "user", text: "Where do the fixture tasks stand?", at: time(97)))
        rows.append(ChatPlaceFixtureServer.historyRow(role: "assistant", text: nativeCitations, at: time(98)))
        rows.append(ChatPlaceFixtureServer.historyRow(role: "assistant", text: richCitation, at: time(99)))
        return rows
    }

    private static func askHistory() -> [[String: Any]] {
        [
            ChatPlaceFixtureServer.historyRow(role: "user", text: "Which task holds the comparison?", at: time(0)),
            ChatPlaceFixtureServer.historyRow(
                role: "assistant",
                text: "It is in <a href=\"/tasks/\(anchor.id)\" class=\"task-link\">Old title</a> for now.",
                at: time(1)),
        ]
    }

    // MARK: - Launch and navigation

    private func launchPaired() throws -> XCUIApplication {
        let server = try XCTUnwrap(fixture).url
        let token = "task-anchor-fixture"
        arguments = ["-walnut.serverUrl", server, "-walnut.deviceToken", token]
        let app = UITestLaunch.launch(arguments)
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(token)
            let name = app.textFields["setup.deviceName"]
            if name.exists { name.tap(); name.typeText("lane-b") }
            app.buttons["setup.connect"].tap()
        }
        waitForChatOrSession(app)
        return app
    }

    private func waitForChatOrSession(_ app: XCUIApplication) {
        let deadline = Date().addingTimeInterval(60)
        while !app.buttons["chat.menu"].exists, !sessionTitle(app).exists, Date() < deadline {
            _ = app.buttons["chat.menu"].waitForExistence(timeout: 2)
        }
        XCTAssertTrue(app.buttons["chat.menu"].exists || sessionTitle(app).exists, "the chat never appeared")
        dismissUnsentSheet(app)
    }

    private func sessionTitle(_ app: XCUIApplication) -> XCUIElement { app.buttons["session.title"] }

    /// The shared simulator may hold another run's unsent voice items, whose sheet covers the chat at launch.
    private func dismissUnsentSheet(_ app: XCUIApplication) {
        let sheet = app.descendants(matching: .any)["talk.unsentSheet"]
        guard sheet.waitForExistence(timeout: 2) else { return }
        attach(app, "unsent-sheet-dismissed")
        let done = sheet.navigationBars.buttons["Done"].firstMatch
        if done.exists { done.tap() } else { app.buttons["Done"].firstMatch.tap() }
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10), "the Waiting to Send sheet stayed open")
    }

    /// The sidebar, open. A session is the page and the sidebar is its parent (chats are peers, there is no chat page to go
    /// back to), so the session page's leading button opens it; the older chat page's `chat.menu` is accepted too.
    private func showSidebar(_ app: XCUIApplication) {
        dismissUnsentSheet(app)
        let switcher = app.segmentedControls["chat.drawer.viewSwitch"]
        if switcher.exists { return }
        let menu = app.buttons.matching(NSPredicate(format: "identifier IN %@", ["chat.session.menu", "chat.menu"])).firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "no button opens the sidebar")
        menu.tap()
        XCTAssertTrue(switcher.waitForExistence(timeout: 10), "the sidebar did not open")
    }

    private func openDrawer(_ app: XCUIApplication, view: String) {
        showSidebar(app)
        let segment = app.segmentedControls["chat.drawer.viewSwitch"].buttons[view]
        if segment.exists, !segment.isSelected { segment.tap() }
    }

    private func openMain(_ app: XCUIApplication, waitingFor title: String? = TaskAnchorTapUITests.rich.title) {
        dismissUnsentSheet(app)
        // The app opens in Main's chat; only another page needs the sidebar.
        let onMain = sessionTitle(app).waitForExistence(timeout: 20) && titleName(sessionTitle(app)) == "CEO"
        if !onMain {
            openDrawer(app, view: "Org")
            let ceo = app.buttons["chat.drawer.org.ceo"]
            XCTAssertTrue(ceo.waitForExistence(timeout: 30), "no Main row in the sidebar's Org view")
            ceo.tap()
            XCTAssertTrue(sessionTitle(app).waitForExistence(timeout: 30), "Main's chat did not open")
        }
        if let title { _ = latestLink(app, title, inWeb: true) }
    }

    private func openAsk(_ app: XCUIApplication) {
        openDrawer(app, view: "Chats")
        let asks = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat.drawer.ask.'"))
        XCTAssertTrue(asks.firstMatch.waitForExistence(timeout: 30), "no ask in the drawer")
        asks.firstMatch.tap()
        XCTAssertTrue(sessionTitle(app).waitForExistence(timeout: 30), "the ask's chat did not open")
    }

    private func mainOpen(dark: Bool = false) throws -> XCUIApplication {
        if dark { XCUIDevice.shared.appearance = .dark }
        let app = try launchPaired()
        openMain(app)
        return app
    }

    // MARK: - Links and the task sheet

    private func contains(_ text: String) -> NSPredicate { NSPredicate(format: "label CONTAINS %@", text) }

    /// The band between the navigation bar and the composer, where a tap reaches the timeline.
    private func visibleBand(_ app: XCUIApplication, in container: XCUIElement? = nil) -> ClosedRange<CGFloat> {
        let window = app.windows.firstMatch.frame
        let root = container ?? app
        let bar = root.navigationBars.firstMatch
        let composer = root.descendants(matching: .any).matching(identifier: "chat.composer").firstMatch
        // Main's chat wears the Threads, Tasks and Brief bar under the navigation bar; the timeline starts below it.
        let orgBar = ["threads", "tasks", "brief"]
            .map { root.descendants(matching: .any)["org.bar.\($0)"].firstMatch }
            .filter { $0.exists && !$0.frame.isEmpty }
            .map { $0.frame.maxY }.max() ?? window.minY
        let top = max(bar.exists ? bar.frame.maxY + 4 : window.minY + 120, orgBar + 4)
        let bottom = composer.exists ? composer.frame.minY - 16 : window.maxY - 160
        return top...max(top, bottom)
    }

    private func onScreen(_ element: XCUIElement, _ band: ClosedRange<CGFloat>) -> Bool {
        let f = element.frame
        return element.exists && !f.isEmpty && band.contains(f.midY)
    }

    /// Links in the native text view never report hittable, so a link counts once its middle is in the band.
    private func tapMiddle(_ element: XCUIElement) {
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    /// The newest on-screen link naming `title`, scrolling toward it (or toward the newest rows) while it is off screen.
    private func latestLink(_ app: XCUIApplication, _ title: String, inWeb: Bool, timeout: TimeInterval = 150,
                            file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let query = (inWeb ? app.webViews.links : app.links).matching(contains(title))
        let deadline = Date().addingTimeInterval(timeout)
        var scrolls = 0
        while Date() < deadline {
            let band = visibleBand(app)
            let all = query.allElementsBoundByIndex
            if let hit = all.last(where: { onScreen($0, band) }) { return hit }
            if scrolls < 16, sessionTitle(app).exists {
                scrollToward(app, all.last, band, scrolls)
                scrolls += 1
            }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTFail("no on-screen link for \(title) (\(inWeb ? "rich card" : "native row"))", file: file, line: line)
        return query.firstMatch
    }

    /// Toward a link the tree already places; else down to the newest rows, then back up,
    /// since at a large text size the newest link can sit more than a screen above them.
    private func scrollToward(_ app: XCUIApplication, _ last: XCUIElement?, _ band: ClosedRange<CGFloat>, _ scrolls: Int) {
        let frame = last.flatMap { $0.exists && !$0.frame.isEmpty ? $0.frame : nil }
        if let f = frame, !band.contains(f.midY) {
            // A swipe's momentum carries a tall XXXL link past a short band both ways, so drag by the
            // distance to the band's middle and hold before lifting.
            let room = band.upperBound - band.lowerBound - 20
            let delta = max(-room, min(room, (band.lowerBound + band.upperBound) / 2 - f.midY))
            let startY = delta < 0 ? band.upperBound - 10 : band.lowerBound + 10
            let origin = app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
            let start = origin.withOffset(CGVector(dx: app.windows.firstMatch.frame.midX, dy: startY))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: delta)),
                        withVelocity: .slow, thenHoldForDuration: 0.5)
        } else if scrolls < 4 {
            app.swipeUp(velocity: .slow)
        } else {
            app.swipeDown(velocity: .slow)
        }
    }

    private func bringOnScreen(_ app: XCUIApplication, _ find: () -> XCUIElement?) {
        for attempt in 0..<8 {
            let band = visibleBand(app)
            let element = find()
            if let element, onScreen(element, band) { return }
            scrollToward(app, element, band, attempt)
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    private static let sampleNeedle = "Sample anchor</a>"

    /// The smallest element carrying the fenced sample, whatever type the reader exposes it as.
    private func fencedSampleNow(_ app: XCUIApplication) -> XCUIElement? {
        let predicate = NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", Self.sampleNeedle, Self.sampleNeedle)
        let found = app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
            .filter { $0.exists && !$0.frame.isEmpty }
        return found.min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    private func sampleText(_ element: XCUIElement) -> String {
        element.label.isEmpty ? ((element.value as? String) ?? "") : element.label
    }

    /// Where the sample sits depends on the text size, and a code block joins the tree only while it is on
    /// screen: look down first, then back up, giving each stop a moment for the tree to catch up.
    private func findFencedSample(_ app: XCUIApplication, step: String) -> XCUIElement? {
        for attempt in 0..<16 {
            let deadline = Date().addingTimeInterval(2.5)
            repeat {
                if let hit = fencedSampleNow(app) {
                    let note = XCTAttachment(string: "\(step): type \(hit.elementType.rawValue) frame \(hit.frame) text \(sampleText(hit))\n\n\(app.debugDescription)")
                    note.name = "fenced-sample-tree-\(step)"
                    note.lifetime = .keepAlways
                    add(note)
                    return hit
                }
                Thread.sleep(forTimeInterval: 0.5)
            } while Date() < deadline
            if attempt < 6 { app.swipeUp(velocity: .slow) } else { app.swipeDown(velocity: .slow) }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return nil
    }

    private func tapOpensTask(_ app: XCUIApplication, _ title: String, inWeb: Bool, shot: String,
                              linkText: String? = nil, file: StaticString = #filePath, line: UInt = #line) {
        let link = latestLink(app, linkText ?? title, inWeb: inWeb, file: file, line: line)
        attach(app, "\(shot)-before-tap")
        tapMiddle(link)
        let sheetTitle = app.buttons["task.title"]
        XCTAssertTrue(sheetTitle.waitForExistence(timeout: 20), "\(shot): the task sheet never opened", file: file, line: line)
        XCTAssertEqual(sheetTitle.label, title, "\(shot): another task opened", file: file, line: line)
        attach(app, "\(shot)-sheet")
        let done = app.navigationBars.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 10), "\(shot): no Done on the task sheet", file: file, line: line)
        done.tap()
        XCTAssertTrue(sheetTitle.waitForNonExistence(timeout: 10), "\(shot): the sheet stayed open", file: file, line: line)
        XCTAssertTrue(sessionTitle(app).waitForExistence(timeout: 10), "\(shot): not back on the chat", file: file, line: line)
        attach(app, "\(shot)-back")
    }

    private func assertNoSheet(_ app: XCUIApplication, _ why: String) {
        XCTAssertFalse(app.buttons["task.title"].waitForExistence(timeout: 3), "\(why) opened a task")
    }

    private func textViews(_ app: XCUIApplication, containing text: String) -> XCUIElementQuery {
        app.textViews.matching(NSPredicate(format: "value CONTAINS %@", text))
    }

    private func assertNativeTextOnly(_ app: XCUIApplication, step: String) {
        for label in [Self.unknownLabel, Self.conflictLabel] {
            XCTAssertTrue(textViews(app, containing: label).firstMatch.waitForExistence(timeout: 20), "\(step): \(label) is not shown")
            XCTAssertFalse(app.links.matching(contains(label)).firstMatch.exists, "\(step): \(label) became a link")
        }
        XCTAssertTrue(textViews(app, containing: Self.longCode).firstMatch.exists, "\(step): long code is not shown as written")
        // The fenced sample is the author's own markup and may sit in a text view of its own (the code block's
        // selectable text), so only a text view that is not that sample counts as prose showing a leak.
        for leak in ["data-task-id", "class=\"task-link\"", "walnut-task:", "&lt;"] {
            let prose = textViews(app, containing: leak).allElementsBoundByIndex
                .filter { $0.exists && !sampleText($0).contains(Self.fencedSample) }
            XCTAssertTrue(prose.isEmpty, "\(step): prose shows \(leak)")
        }
        let found = findFencedSample(app, step: step)
        XCTAssertNotNil(found, "\(step): the fenced sample is not shown as written")
        let text = found.map(sampleText) ?? ""
        XCTAssertTrue(text.contains(Self.fencedSample), "\(step): the fenced sample changed: \(text)")
        XCTAssertFalse(text.contains("walnut-task") || text.contains(Self.anchor.title),
                       "\(step): generated HTML in the fenced sample: \(text)")
        XCTAssertFalse(app.links.matching(contains("Sample anchor")).firstMatch.exists, "\(step): the fenced sample links")
        XCTAssertFalse(app.descendants(matching: .any).matching(contains("walnut-task:")).firstMatch.exists,
                       "\(step): a raw walnut-task URL is on screen")
    }

    private func assertRichTextOnly(_ app: XCUIApplication, step: String) {
        let web = app.webViews
        for label in [Self.richUnknownLabel, Self.richConflictLabel] {
            XCTAssertTrue(web.staticTexts.matching(contains(label)).firstMatch.waitForExistence(timeout: 20),
                          "\(step): the card does not show \(label)")
            XCTAssertFalse(web.links.matching(contains(label)).firstMatch.exists, "\(step): \(label) in the card became a link")
        }
        XCTAssertTrue(web.staticTexts.matching(contains(Self.richLongCode)).firstMatch.exists,
                      "\(step): the card's code is not shown as written")
        XCTAssertFalse(web.staticTexts.matching(contains("Old title")).firstMatch.exists, "\(step): the card shows the stale label")
        XCTAssertFalse(web.descendants(matching: .any).matching(contains("walnut-task:")).firstMatch.exists,
                       "\(step): a raw walnut-task URL is in the card")
    }

    // MARK: - I1: native citations

    func testNativeProseRefOpensItsTaskAndReopens() throws {
        let app = try mainOpen()
        attach(app, "main-light")
        tapOpensTask(app, Self.prose.title, inWeb: false, shot: "prose-ref")
        tapOpensTask(app, Self.prose.title, inWeb: false, shot: "prose-ref-reopen")
    }

    func testNativeBacktickRefOpensItsTask() throws {
        let app = try mainOpen()
        tapOpensTask(app, Self.backtick.title, inWeb: false, shot: "backtick-ref")
    }

    func testNativeRawAnchorOpensItsTask() throws {
        let app = try mainOpen()
        tapOpensTask(app, Self.anchor.title, inWeb: false, shot: "raw-anchor")
    }

    func testNativeUnknownConflictAndCodeStayText() throws {
        let app = try mainOpen()
        // At XXXL the rich card fills the screen, so the citation prose above it is out of the tree.
        _ = latestLink(app, Self.anchor.title, inWeb: false)
        assertNativeTextOnly(app, step: "native")
        bringOnScreen(app) { self.fencedSampleNow(app) }
        attach(app, "native-text-only")
        let sample = try XCTUnwrap(fencedSampleNow(app), "the fenced sample left the screen")
        XCTAssertTrue(onScreen(sample, visibleBand(app)), "the fenced sample is off screen")
        tapMiddle(sample)
        assertNoSheet(app, "the fenced sample")
    }

    func testNativeCitationsOpenAfterRelaunch() throws {
        var app = try mainOpen()
        app.terminate()
        app = UITestLaunch.launch(arguments)
        waitForChatOrSession(app)
        if !sessionTitle(app).waitForExistence(timeout: 10) { openMain(app) }
        attach(app, "main-relaunched")
        tapOpensTask(app, Self.anchor.title, inWeb: false, shot: "raw-anchor-relaunched")
        tapOpensTask(app, Self.prose.title, inWeb: false, shot: "prose-ref-relaunched")
    }

    func testNativeCitationsInDarkMode() throws {
        let app = try mainOpen(dark: true)
        attach(app, "main-dark")
        assertNativeTextOnly(app, step: "native dark")
        tapOpensTask(app, Self.backtick.title, inWeb: false, shot: "backtick-ref-dark")
    }

    func testAskRawAnchorOpensItsTask() throws {
        let app = try launchPaired()
        openAsk(app)
        _ = latestLink(app, Self.anchor.title, inWeb: false)
        attach(app, "ask-light")
        XCTAssertFalse(textViews(app, containing: "Old title").firstMatch.exists, "the ask shows the stale label")
        tapOpensTask(app, Self.anchor.title, inWeb: false, shot: "ask-raw-anchor")
        tapOpensTask(app, Self.anchor.title, inWeb: false, shot: "ask-raw-anchor-reopen")
    }

    // MARK: - I2: rich card citations

    func testRichCardAnchorOpensItsTaskAndReopens() throws {
        let app = try mainOpen()
        attach(app, "rich-light")
        tapOpensTask(app, Self.rich.title, inWeb: true, shot: "rich-card")
        tapOpensTask(app, Self.rich.title, inWeb: true, shot: "rich-card-reopen")
    }

    func testRichUnknownConflictStayTextAndThePreSampleOpensItsTask() throws {
        let app = try mainOpen()
        assertRichTextOnly(app, step: "rich")
        attach(app, "rich-text-only")
        // The sample keeps its author's words, as on the web, and its link opens the task it names.
        XCTAssertFalse(app.webViews.links.matching(contains(Self.anchor.title)).firstMatch.exists,
                       "the pre sample shows a generated title")
        tapOpensTask(app, Self.anchor.title, inWeb: true, shot: "rich-pre-sample", linkText: Self.richPreSample)
    }

    /// The card's last block is drawn whole: the pre box ends inside its web view, above the composer.
    func testRichCardEndsWithItsWholePreSample() throws {
        let app = try launchPaired()
        openMain(app, waitingFor: nil)
        let text = app.webViews.links.matching(contains(Self.richPreSample)).firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 45), "the card's pre sample is not shown")
        for _ in 0..<3 { app.swipeUp(velocity: .slow) }
        let web = app.webViews.containing(contains(Self.richPreSample)).firstMatch
        let composer = app.descendants(matching: .any).matching(identifier: "chat.composer").firstMatch
        let fits = NSPredicate { _, _ in
            text.exists && web.exists && composer.exists
                && text.frame.maxY + 6 <= web.frame.maxY
                && web.frame.maxY <= composer.frame.minY + 1
        }
        _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: fits, object: app)], timeout: 15)
        let facts = "text \(text.frame) web \(web.frame) composer \(composer.frame)"
        let note = XCTAttachment(string: facts)
        note.name = "pre-sample-frames"
        note.lifetime = .keepAlways
        add(note)
        attach(app, "rich-pre-sample-bottom")
        // The pre box pads its text by 8pt; 6pt of it must be inside the card and above the composer.
        XCTAssertLessThanOrEqual(text.frame.maxY + 6, web.frame.maxY, "the card clips its pre sample: \(facts)")
        XCTAssertLessThanOrEqual(web.frame.maxY, composer.frame.minY + 1, "the card ends under the composer: \(facts)")
    }

    func testRichCardInDarkModeAfterScrolling() throws {
        let app = try mainOpen(dark: true)
        attach(app, "rich-dark")
        assertRichTextOnly(app, step: "rich dark")
        app.swipeDown(velocity: .slow)
        app.swipeDown(velocity: .slow)
        attach(app, "rich-dark-scrolled-up")
        tapOpensTask(app, Self.rich.title, inWeb: true, shot: "rich-card-dark")
    }

    func testRichCardOpensAfterRelaunch() throws {
        var app = try mainOpen()
        app.terminate()
        app = UITestLaunch.launch(arguments)
        waitForChatOrSession(app)
        if !sessionTitle(app).waitForExistence(timeout: 10) { openMain(app) }
        tapOpensTask(app, Self.rich.title, inWeb: true, shot: "rich-card-relaunched")
    }

    func testRichCardTitleArrivesWhenTheBoardIsLate() throws {
        fixture?.stop()
        fixture = try Self.startFixture(tasksInitiallyHidden: true, lateCard: true)
        let app = try launchPaired()
        openMain(app, waitingFor: nil)
        // Before the board: the card shows the cited label as plain text.
        let label = app.webViews.staticTexts.matching(contains(Self.lateLabel)).firstMatch
        XCTAssertTrue(label.waitForExistence(timeout: 40), "the late card's label is not shown before the board")
        XCTAssertTrue(onScreen(label, visibleBand(app)), "the late card's label is off screen")
        XCTAssertFalse(app.webViews.links.matching(contains(Self.lateLabel)).firstMatch.exists,
                       "the label linked before the board knew its task")
        XCTAssertFalse(app.webViews.descendants(matching: .any).matching(contains(Self.late.title)).firstMatch.exists,
                       "the title showed before the board arrived")
        attach(app, "rich-before-board")
        tapMiddle(label)
        assertNoSheet(app, "the late card's label before the board")
        let server = try XCTUnwrap(fixture)
        let connected = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in server.taskEventsConnected }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [connected], timeout: 15), .completed,
                       "the task events feed never connected")
        XCTAssertTrue(server.revealTasks(), "the task events feed disconnected before publishing")
        tapOpensTask(app, Self.late.title, inWeb: true, shot: "rich-card-late-board")
        XCTAssertFalse(app.webViews.staticTexts.matching(contains(Self.lateLabel)).firstMatch.exists,
                       "the label stayed after the title arrived")
        tapOpensTask(app, Self.anchor.title, inWeb: false, shot: "raw-anchor-late-board")
    }

    // MARK: - Opt-in: a copy of real data behind a loopback proxy

    private struct RealCopy {
        let server: String
        let token: String
        let rowID: String
        let rowQuery: String
        let targetTitle: String
        let targetSession: String
        let targetPreview: String
    }

    /// The runner only receives SERVER/TOKEN/ROW_ID/ROW_QUERY, so target facts fall back to the proxy's state.
    private func realCopy() async throws -> RealCopy {
        let env = ProcessInfo.processInfo.environment
        func value(_ name: String) -> String? { env[name].map { $0.trimmingCharacters(in: .whitespaces) }.flatMap { $0.isEmpty ? nil : $0 } }
        guard let raw = value("WALNUT_UITEST_SERVER"), let token = value("WALNUT_UITEST_TOKEN"),
              let rowID = value("WALNUT_UITEST_ROW_ID"), let rowQuery = value("WALNUT_UITEST_ROW_QUERY")
        else { throw XCTSkip("Run against the loopback proxy of an ephemeral copy (WALNUT_UITEST_SERVER/TOKEN/ROW_ID/ROW_QUERY)") }
        let server = UITestLaunch.pairedServer(raw)
        guard let url = URL(string: server), url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? ""),
              let port = url.port, ![3456, 3457].contains(port)
        else { throw XCTSkip("only a loopback proxy on a non-production port, never the live server") }
        _ = try await proxyJSON(url, path: "api/config")
        var targetTitle = value("WALNUT_UITEST_TARGET_TITLE") ?? ""
        var targetSession = value("WALNUT_UITEST_TARGET_SESSION") ?? ""
        let state = try await proxyJSON(url, path: "__victim/state")
        if targetTitle.isEmpty { targetTitle = state["targetTitle"] as? String ?? "" }
        if targetSession.isEmpty { targetSession = state["targetSessionName"] as? String ?? "" }
        let targetPreview = state["targetPreview"] as? String ?? ""
        try requireReal(!targetTitle.isEmpty && !targetPreview.isEmpty, "the proxy has no target title or readable history preview")
        return RealCopy(server: server, token: token, rowID: rowID, rowQuery: rowQuery,
                        targetTitle: targetTitle, targetSession: targetSession, targetPreview: targetPreview)
    }

    private func proxyJSON(_ server: URL, path: String) async throws -> [String: Any] {
        var request = URLRequest(url: server.appendingPathComponent(path)); request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw NSError(domain: "TaskAnchorTapUITests", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "The isolated server is unavailable at \(path)"])
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], "the proxy answered no JSON")
    }

    private func requireReal(_ condition: Bool, _ message: String) throws {
        guard condition else {
            throw NSError(domain: "TaskAnchorTapUITests", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    private func launchReal(_ real: RealCopy) throws -> XCUIApplication {
        arguments = ["-walnut.serverUrl", real.server, "-walnut.deviceToken", real.token]
        let app = UITestLaunch.launch(arguments)
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText(real.token)
            let name = app.textFields["setup.deviceName"]
            if name.exists { name.tap(); name.typeText("lane-b") }
            app.buttons["setup.connect"].tap()
        }
        let deadline = Date().addingTimeInterval(60)
        while !app.buttons["chat.menu"].exists, !sessionTitle(app).exists, Date() < deadline {
            _ = app.buttons["chat.menu"].waitForExistence(timeout: 2)
        }
        try requireReal(app.buttons["chat.menu"].exists || sessionTitle(app).exists, "the paired chat never appeared")
        dismissUnsentSheet(app)
        try requireReal(!app.descendants(matching: .any)["talk.unsentSheet"].exists, "the Waiting to Send sheet stayed open")
        return app
    }

    private func openRealRow(_ app: XCUIApplication, _ real: RealCopy) throws {
        let tasks = app.tabBars.buttons["Tasks"]
        try requireReal(tasks.waitForExistence(timeout: 40), "the Tasks tab is missing")
        tasks.tap()
        let search = app.searchFields.firstMatch
        if !search.waitForExistence(timeout: 10) {
            let menu = app.buttons["tasks.menu"].firstMatch
            try requireReal(menu.waitForExistence(timeout: 10), "the Tasks drawer button is missing")
            menu.tap()
        }
        try requireReal(search.waitForExistence(timeout: 15), "the task search field is missing")
        search.tap(); search.typeText(real.rowQuery + "\n")
        let row = app.descendants(matching: .any).matching(NSPredicate(
            format: "(identifier BEGINSWITH 'board.row.' OR identifier BEGINSWITH 'tasks.row.') AND identifier CONTAINS %@",
            real.rowID)).firstMatch
        try requireReal(row.waitForExistence(timeout: 30), "the source task is not on the board or in the search results")
        for _ in 0..<4 where !row.isHittable { app.swipeUp(velocity: .slow) }
        try requireReal(row.isHittable, "the source task is outside the tappable area")
        attach(app, "real-search")
        row.tap()
        try requireReal(app.descendants(matching: .any)["chat.composer"].waitForExistence(timeout: 40), "the source session did not open")
        try requireReal(sessionTitle(app).waitForExistence(timeout: 20), "the source session title is missing")
    }

    private func latestRealLink(_ app: XCUIApplication, _ title: String) throws -> XCUIElement {
        let query = app.links.matching(contains(title))
        let deadline = Date().addingTimeInterval(45)
        var scrolls = 0
        while Date() < deadline {
            let band = visibleBand(app)
            let all = query.allElementsBoundByIndex
            if let hit = all.last(where: { onScreen($0, band) }) { return hit }
            if scrolls < 16, sessionTitle(app).exists {
                scrollToward(app, all.last, band, scrolls)
                scrolls += 1
            }
            Thread.sleep(forTimeInterval: 1)
        }
        throw NSError(domain: "TaskAnchorTapUITests", code: 3,
                      userInfo: [NSLocalizedDescriptionKey: "No on-screen citation for \(title)"])
    }

    /// The session title's name, without the status line that rides its label ("Name, Idle · host").
    private func titleName(_ title: XCUIElement) -> String {
        title.label.components(separatedBy: ", ").first ?? title.label
    }

    private func targetTitleButton(_ sheet: XCUIElement, _ real: RealCopy) -> XCUIElement {
        let session = real.targetSession.isEmpty ? real.targetTitle : real.targetSession
        return sheet.buttons.matching(NSPredicate(
            format: "identifier == 'session.title' AND (label CONTAINS %@ OR label CONTAINS %@)", session, real.targetTitle)).firstMatch
    }

    private func tapOpensTargetSession(_ app: XCUIApplication, _ real: RealCopy, source: String, shot: String) throws {
        let link = try latestRealLink(app, real.targetTitle)
        attach(app, "\(shot)-before-tap")
        tapMiddle(link)
        let sheet = app.descendants(matching: .any).matching(identifier: "task.open.session").firstMatch
        try requireReal(sheet.waitForExistence(timeout: 30), "\(shot): the target session sheet is missing")
        let opened = targetTitleButton(sheet, real)
        try requireReal(opened.waitForExistence(timeout: 30) && opened.isHittable, "\(shot): the target's session did not open on screen")
        let done = sheet.buttons.matching(identifier: "task.open.done").firstMatch
        try requireReal(done.waitForExistence(timeout: 10) && done.isHittable, "\(shot): it did not open as a tappable task sheet")
        let content = sheet.descendants(matching: .any).matching(NSPredicate(
            format: "value CONTAINS %@ OR label CONTAINS %@", real.targetPreview, real.targetPreview)).firstMatch
        try requireReal(content.waitForExistence(timeout: 30), "\(shot): the target history is not readable")
        try requireReal(onScreen(content, visibleBand(app, in: sheet)), "\(shot): the target answer is outside the reading area")
        try requireReal(!sheet.descendants(matching: .any).matching(identifier: "session.transcript.unreadable").firstMatch.exists,
                        "\(shot): the target conversation reports a read failure")
        attach(app, "\(shot)-sheet")
        done.tap()
        try requireReal(sheet.waitForNonExistence(timeout: 10), "\(shot): the sheet stayed open")
        try requireReal(sessionTitle(app).waitForExistence(timeout: 10), "\(shot): not back on the source session")
        try requireReal(titleName(sessionTitle(app)) == source, "\(shot): back on another session")
        attach(app, "\(shot)-back")
    }

    @MainActor
    func testRealCopyCitationOpensItsTaskAndComesBack() async throws {
        let real = try await realCopy()
        var app = try launchReal(real)
        dismissUnsentSheet(app)
        try openRealRow(app, real)
        let source = titleName(sessionTitle(app))
        _ = try latestRealLink(app, real.targetTitle)
        attach(app, "real-source-session")
        try tapOpensTargetSession(app, real, source: source, shot: "real-citation")
        try tapOpensTargetSession(app, real, source: source, shot: "real-citation-reopen")

        app.terminate()
        app = try launchReal(real)
        dismissUnsentSheet(app)
        if !(sessionTitle(app).waitForExistence(timeout: 20) && titleName(sessionTitle(app)) == source) {
            try openRealRow(app, real)
        }
        _ = try latestRealLink(app, real.targetTitle)
        attach(app, "real-source-relaunched")
        try tapOpensTargetSession(app, real, source: source, shot: "real-citation-relaunched")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        let method = self.name.split(separator: " ").last.map { String($0.dropLast()) } ?? "test"
        shot.name = "\(method)-\(name)"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
