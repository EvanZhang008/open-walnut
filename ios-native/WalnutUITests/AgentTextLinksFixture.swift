import Foundation
import UIKit
import XCTest

struct AgentTextFixtureRead {
    let seq: Int
    let path: String
    let query: [String: String]
    let status: Int
    let bytes: Int
    let done: Bool
    let cancelled: Bool
    let fault: String

    init(_ entry: [String: Any]) {
        let items = URLComponents(string: "http://fixture.test/" + (entry["query"] as? String ?? ""))?.queryItems ?? []
        var query: [String: String] = [:]
        for item in items where query[item.name] == nil { query[item.name] = item.value ?? "" }
        self.query = query
        seq = entry["seq"] as? Int ?? 0
        path = entry["path"] as? String ?? ""
        status = entry["status"] as? Int ?? 0
        bytes = entry["bytes"] as? Int ?? 0
        done = entry["done"] as? Bool ?? false
        cancelled = entry["cancelled"] as? Bool ?? false
        fault = entry["fault"] as? String ?? "off"
    }

    var served: Bool { status == 200 && done }

    func isDocument(_ letter: String, turn: Int?) -> Bool {
        path == "/api/v1/human-inbox/\(letter)/body" && query["frame"] == "1" && query["refs"] == "1"
            && query["turn"] == turn.map(String.init)
    }
}

enum AgentTextFixtureClient {
    static func reads(_ state: [String: Any]) -> [AgentTextFixtureRead] {
        (state["observed"] as? [[String: Any]] ?? []).map(AgentTextFixtureRead.init)
    }

    static func call(_ url: URL, method: String, body: Data?) throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = method; request.timeoutInterval = 15; request.httpBody = body
        let complete = DispatchSemaphore(value: 0)
        let result = ResultBox()
        URLSession.shared.dataTask(with: request) { data, response, error in
            result.data = data; result.response = response as? HTTPURLResponse; result.error = error; complete.signal()
        }.resume()
        guard complete.wait(timeout: .now() + 20) == .success else { throw NSError(domain: "AgentTextFixtureClient", code: 2) }
        if let error = result.error { throw error }
        guard result.response?.statusCode == 200, let data = result.data else {
            throw NSError(domain: "AgentTextFixtureClient", code: result.response?.statusCode ?? 3)
        }
        return data
    }

    private final class ResultBox: @unchecked Sendable { var data: Data?; var response: HTTPURLResponse?; var error: Error? }
}

extension AgentTextLinksUITests {
    @MainActor func link(in scope: XCUIElement, _ label: String, contains: Bool = false) -> XCUIElement {
        links(in: scope, label, contains: contains).firstMatch
    }

    @MainActor func links(in scope: XCUIElement, _ label: String, contains: Bool) -> XCUIElementQuery {
        scope.links.matching(contains ? NSPredicate(format: "label CONTAINS %@", label) : NSPredicate(format: "label == %@", label))
    }

    /// A sheet resting at its half height takes a short drag on its content as a nudge of the
    /// sheet, never as a scroll: a person pulls it up by the grabber first, so does the test.
    @MainActor func raiseHalfSheet(over target: XCUIElement) {
        guard let app = appUnderTest else { return }
        let grabber = app.buttons["Sheet Grabber"].firstMatch
        guard grabber.exists, (grabber.value as? String) == "Half screen", target.frame.maxY > grabber.frame.maxY else { return }
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1, thenDragTo: top)
        let raised = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != 'Half screen'"), object: grabber)
        XCTAssertEqual(XCTWaiter.wait(for: [raised], timeout: 8), .completed, "the sheet stayed at its half height")
    }

    /// On screen and clear of the tab bar, judged by its frame. For a row that is a Button holding
    /// the link text: XCUITest read it not hittable while it was drawn in full (first v45 run), so
    /// the tap on the link's point that follows, and the viewer it must open, prove the tap works.
    @MainActor func makeVisible(_ target: XCUIElement, in container: XCUIElement) {
        XCTAssertTrue(target.waitForExistence(timeout: 20), "\(target) does not exist")
        let viewport = appUnderTest?.frame ?? container.frame
        func shown() -> Bool {
            let area = container.frame.intersection(viewport.insetBy(dx: 8, dy: 120))
            return area.contains(target.frame)
        }
        for _ in 0..<8 where !shown() && container.exists {
            let area = container.frame.intersection(viewport.insetBy(dx: 16, dy: 120))
            let up = target.frame.midY > area.midY
            let from = container.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
                dx: area.maxX - 16 - container.frame.minX,
                dy: area.midY - container.frame.minY))
            from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: up ? -140 : 140)))
        }
        XCTAssertTrue(shown(), "\(target.label) never came on screen")
    }

    @MainActor func makeHittable(_ target: XCUIElement, in container: XCUIElement) {
        XCTAssertTrue(target.waitForExistence(timeout: 20), "\(target) does not exist")
        let viewport = appUnderTest?.frame ?? container.frame
        // Hittable is not enough low in a half sheet: a tap in its bottom strip was once dropped, so the test raises the sheet first.
        if !target.isHittable || target.frame.maxY > viewport.maxY - 120 { raiseHalfSheet(over: target) }
        for _ in 0..<8 where !target.isHittable && container.exists {
            let visible = container.frame.intersection(viewport.insetBy(dx: 16, dy: 120))
            let area = visible.height >= 100 ? visible : viewport.insetBy(dx: 16, dy: 150)
            let up = target.frame.midY > area.midY
            let from = container.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
                dx: area.maxX - 16 - container.frame.minX,
                dy: area.midY - container.frame.minY))
            from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: up ? -140 : 140)))
        }
        XCTAssertTrue(target.isHittable, "\(target.label) never came on screen")
    }

    /// A wrapped link, or a button inside a thread card, reads not hittable while it is drawn in
    /// full (the middle of a wrapped link's frame is a gap in the text), so it is judged by its
    /// frame like a status row and pressed on the middle of its frame, a line made only of the
    /// link's own words once the path wraps over three lines. What must open or change proves the
    /// press landed.
    @MainActor func tapWrappedLink(_ link: XCUIElement, in container: XCUIElement) {
        makeVisible(link, in: container)
        link.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    @MainActor func tapReady(_ target: XCUIElement, in container: XCUIElement) {
        makeHittable(target, in: container)
        target.tap()
    }

    @MainActor func tap(_ target: XCUIElement, timeout: TimeInterval = 10) {
        XCTAssertTrue(target.waitForExistence(timeout: timeout), "\(target) does not exist")
        target.tap()
    }

    @MainActor func drag(from start: XCUICoordinate, by distance: CGFloat) {
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -distance)))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: distance)))
    }

    // MARK: - Driving the app

    @MainActor func launch() -> XCUIApplication {
        appUnderTest = UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token])
        return appUnderTest!
    }

    @MainActor func openBoard() -> XCUIApplication {
        let app = launch()
        tap(app.tabBars.buttons["Tasks"], timeout: 40)
        let board = app.buttons["tasks.empty.openBoard"].firstMatch
        let menu = app.buttons["tasks.menu"].firstMatch
        let anyRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'board.row.'")).firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 15) || board.waitForExistence(timeout: 10))
        let list = element(app, "tasks.list")
        let onScreen = list.waitForExistence(timeout: 5) && list.frame.intersection(app.frame).width > 100
        if !onScreen {
            if board.exists && board.isHittable { board.tap() } else if menu.exists && menu.isHittable { menu.tap() }
        }
        XCTAssertTrue(anyRow.waitForExistence(timeout: 25), "the board shows no rows")
        XCTAssertGreaterThan(list.frame.intersection(app.frame).width, 100, "the board drawer is not on screen")
        return app
    }

    @MainActor func boardRow(_ app: XCUIApplication, _ taskId: String) -> XCUIElement {
        let row = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'board.row.' AND identifier CONTAINS %@", taskId)).firstMatch
        makeHittable(row, in: app)
        return row
    }

    @MainActor func openSession() throws -> XCUIApplication {
        let app = openBoard()
        boardRow(app, fixture.taskId).tap()
        XCTAssertTrue(element(app, "chat.composer").waitForExistence(timeout: 30))
        return app
    }

    @MainActor func openTeam() throws -> XCUIApplication {
        let app = try openSession()
        tap(element(app, "session.menu"))
        tap(element(app, "session.taskDetails"))
        XCTAssertTrue(element(app, "task.team").waitForExistence(timeout: 20), "the task details show no team")
        return app
    }

    @MainActor func teamNeedLine(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        let team = element(app, "task.team")
        let line = team.staticTexts.matching(NSPredicate(
            format: "identifier == 'task.team.need' AND label CONTAINS %@", text)).firstMatch
        let scroll = element(app, "task.detail.scroll")
        XCTAssertTrue(scroll.waitForExistence(timeout: 15), "the task's detail scroll is missing")
        makeHittable(line, in: scroll)
        return line
    }

    @MainActor func briefLink(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        let label = NSPredicate(format: "label CONTAINS %@", text)
        let inside = element(app, "task.team.brief").links.matching(label).firstMatch
        if inside.waitForExistence(timeout: 10) { return inside }
        return app.links.matching(NSCompoundPredicate(andPredicateWithSubpredicates: [
            NSPredicate(format: "identifier == 'task.team.brief'"), label])).firstMatch
    }

    @MainActor func statusLinkPoint(_ line: XCUIElement, font style: UIFont.TextStyle, lastLine: Bool) -> XCUICoordinate {
        let base = UIFont.preferredFont(forTextStyle: style)
        let bold = UIFont(descriptor: base.fontDescriptor.withSymbolicTraits(.traitBold) ?? base.fontDescriptor, size: base.pointSize)
        let category = ["Take a look", "Can close", "Review", "Decide"].first { line.label.contains("\($0): ") } ?? "Decide"
        let x = (category + ": " as NSString).size(withAttributes: [.font: bold]).width + 14
        let y = lastLine ? line.frame.height - base.lineHeight / 2 - 1 : line.frame.height / 2
        return line.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    @MainActor func openOrgTasks(_ org: Org) throws -> XCUIApplication {
        let app = launch()
        tap(app.tabBars.buttons["Chat"], timeout: 40)
        tap(app.buttons["chat.menu"], timeout: 20)
        let picker = app.segmentedControls["chat.drawer.viewSwitch"]
        if picker.waitForExistence(timeout: 5), !picker.buttons["Org"].isSelected { picker.buttons["Org"].tap() }
        tap(element(app, "chat.drawer.org.project:\(org.project.lowercased())"), timeout: 30)
        tap(element(app, "org.bar.tasks"), timeout: 40)
        XCTAssertTrue(element(app, "org.tasks.mode").waitForExistence(timeout: 20), "the lead's Tasks page did not open")
        return app
    }

    @MainActor func openOrgThreads(_ org: Org) throws -> XCUIApplication {
        let app = launch()
        tap(app.tabBars.buttons["Chat"], timeout: 40)
        tap(app.buttons["chat.menu"], timeout: 20)
        let picker = app.segmentedControls["chat.drawer.viewSwitch"]
        if picker.waitForExistence(timeout: 5), !picker.buttons["Org"].isSelected { picker.buttons["Org"].tap() }
        tap(element(app, "chat.drawer.org.project:\(org.project.lowercased())"), timeout: 30)
        tap(element(app, "org.bar.threads"), timeout: 40)
        XCTAssertTrue(element(app, "org.node.page").waitForExistence(timeout: 20), "the lead's page did not open")
        return app
    }

    /// A path link inside one block (`block`: its identifier) of a thread card.
    @MainActor func threadPathLink(_ card: XCUIElement, in block: String, _ text: String) -> XCUIElement {
        let label = NSPredicate(format: "label CONTAINS %@", text)
        let scope = card.descendants(matching: .any).matching(identifier: block).firstMatch
        let inside = scope.links.matching(label).firstMatch
        if inside.waitForExistence(timeout: 10) { return inside }
        return card.links.matching(NSCompoundPredicate(andPredicateWithSubpredicates: [
            NSPredicate(format: "identifier == %@", block), label])).firstMatch
    }

    @MainActor func orgTaskRow(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        let row = app.buttons.matching(NSPredicate(format: "identifier == 'org.tasks.row' AND label CONTAINS %@", title)).firstMatch
        let scroll = app.scrollViews.containing(.any, identifier: "org.tasks.mode").firstMatch
        XCTAssertTrue(scroll.waitForExistence(timeout: 15), "the Org tasks scroll is missing")
        makeVisible(row, in: scroll)
        return row
    }

    @MainActor func orgLinkPoint(_ row: XCUIElement) -> XCUICoordinate {
        let footnote = UIFont.preferredFont(forTextStyle: .footnote)
        let title = UIFont.preferredFont(forTextStyle: .subheadline).lineHeight
        let category = ["Take a look", "Can close", "Review", "Decide"].first { row.label.contains("\($0): ") } ?? "Decide"
        let x = 30 + (category + ": " as NSString).size(withAttributes: [.font: footnote]).width + 14
        return row.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: 10 + title + 3 + footnote.lineHeight / 2))
    }

    @MainActor func openWorkCardNeeds() throws -> XCUIApplication {
        let app = launch()
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 40))
        app.open(try XCTUnwrap(URL(string: "walnut://work?list=needs")))
        XCTAssertTrue(element(app, "workcard.sheet").waitForExistence(timeout: 30), "the card link opened no work list")
        return app
    }

    @MainActor func workCardNeedLine(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        let line = element(app, "workcard.sheet").staticTexts.matching(NSPredicate(
            format: "identifier == 'task.team.need' AND label CONTAINS %@", text)).firstMatch
        makeHittable(line, in: element(app, "workcard.sheet"))
        return line
    }

    @MainActor func tapStatusLink(_ app: XCUIApplication, _ line: XCUIElement, at point: XCUICoordinate,
                                  file: Bool, name: String) throws {
        let pages = taskPagesOpen(app)
        let composer = element(app, "chat.composer").exists
        let placed = line.frame
        try capture(app, "\(name)-before")
        let reference = line.links.matching(NSPredicate(
            format: "label CONTAINS %@", file ? "readme.txt" : fixture.letters.target)).firstMatch
        if line.elementType == .staticText {
            XCTAssertTrue(reference.exists && reference.isHittable, "the status line's link is not reachable")
            reference.tap()
        } else { point.tap() }
        if file { expectTextViewer(app, showing: Self.lineTwo) } else { expectLetterSheet(app) }
        XCTAssertEqual(taskPagesOpen(app), pages, "the status line's link opened its task")
        XCTAssertEqual(element(app, "chat.composer").exists, composer, "the status line's link opened its task's session")
        try capture(app, "\(name)-opened")
        if file { closeTextViewer(app) } else { closeLetterSheet(app, returningTo: line, placedAt: placed) }
        XCTAssertTrue(line.waitForExistence(timeout: 10) && isBack(line, placedAt: placed), "Done did not return to the row")
        XCTAssertEqual(taskPagesOpen(app), pages, "closing opened the row's task")
        assertNothingOpens(app, "closing the status link's target")
    }

    @MainActor func openInbox() throws -> XCUIApplication {
        let app = launch()
        tap(app.tabBars.buttons["Inbox"], timeout: 40)
        XCTAssertTrue(element(app, "inbox.filterBar").waitForExistence(timeout: 30))
        let all = element(app, "inbox.filter.all")
        if all.waitForExistence(timeout: 5), all.isHittable { all.tap() }
        for id in [fixture.letters.html, fixture.letters.source, fixture.letters.target] {
            XCTAssertTrue(element(app, "inbox.row.\(id)").waitForExistence(timeout: 30), "letter \(id) is not in the inbox")
        }
        return app
    }

    @MainActor func sourceRow(_ app: XCUIApplication) -> XCUIElement {
        let row = element(app, "inbox.row.\(fixture.letters.source)")
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        XCTAssertTrue(row.isHittable, "the markdown letter's row is off screen")
        return row
    }

    @MainActor func previewLinkPoint(_ row: XCUIElement) -> XCUICoordinate {
        let body = UIFont.preferredFont(forTextStyle: .body).lineHeight
        let caption = UIFont.preferredFont(forTextStyle: .caption1).lineHeight
        return row.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: 60, dy: 2 + body + 4 + caption + 4 + caption / 2))
    }

    @MainActor func tapPreviewFileLink(_ row: XCUIElement) {
        let link = row.links.matching(NSPredicate(format: "label CONTAINS 'readme.txt'")).firstMatch
        if link.exists && link.isHittable { link.tap() } else { previewLinkPoint(row).tap() }
    }

    @MainActor func openLetter(_ app: XCUIApplication, _ id: String, _ text: String) throws -> XCUIElement {
        let row = element(app, "inbox.row.\(id)")
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0)).withOffset(CGVector(dx: 0, dy: 12)).tap()
        let opened = subject(app, text)
        XCTAssertTrue(opened.waitForExistence(timeout: 20), "the row did not open \(id)")
        XCTAssertFalse(textViewerOpen(app), "opening the letter opened a file")
        return opened
    }

    @MainActor func goBack(_ app: XCUIApplication) {
        let back = app.navigationBars.buttons["Inbox"].firstMatch
        if back.waitForExistence(timeout: 5) { back.tap() } else { app.navigationBars.buttons.element(boundBy: 0).tap() }
        XCTAssertTrue(element(app, "inbox.list").waitForExistence(timeout: 15))
    }

    @MainActor func bodyLink(_ app: XCUIApplication, label: String, contains: Bool = false) -> XCUIElement {
        let first = link(in: app, label, contains: contains)
        XCTAssertTrue(first.waitForExistence(timeout: 20), "no link for \(label)")
        let conversation = element(app, "inbox.letter.conversation")
        let box = conversation.exists ? conversation.frame : .null
        return links(in: app, label, contains: contains).allElementsBoundByIndex
            .first { !box.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) } ?? first
    }

    @MainActor func routedPage(_ app: XCUIApplication, marker: String, turn: Int?) throws -> XCUIElement {
        _ = try routedRead(turn: turn)
        let page = app.webViews.containing(NSPredicate(format: "label CONTAINS %@", marker)).firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 30), "no web view shows \(marker)")
        XCTAssertTrue(link(in: page, fixture.letters.target).waitForExistence(timeout: 30),
                      "\(marker): the routed document's letter link never appeared")
        return page
    }

    @discardableResult func routedRead(turn: Int?, after seq: Int = 0, fault: String? = nil) throws -> AgentTextFixtureRead {
        var found: AgentTextFixtureRead?
        let served = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            found = (try? self.reads())?.last {
                $0.seq > seq && $0.served && (fault == nil || $0.fault == fault) && $0.isDocument(self.fixture.letters.html, turn: turn)
            }
            return found != nil
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [served], timeout: 60), .completed, "the body route never served turn \(String(describing: turn))")
        return try XCTUnwrap(found)
    }

    // MARK: - What is on screen

    @MainActor func textViewerOpen(_ app: XCUIApplication) -> Bool { app.navigationBars["readme.txt"].exists }
    @MainActor func letterSheetOpen(_ app: XCUIApplication) -> Bool { element(app, "inbox.letterSheet.done").exists }
    @MainActor func readerOpen(_ app: XCUIApplication) -> Bool { element(app, "inbox.letter.document").exists }
    @MainActor func taskPagesOpen(_ app: XCUIApplication) -> Int {
        ["task.open.session", "task.open.loading", "task.open.done"].reduce(0) {
            $0 + app.descendants(matching: .any).matching(identifier: $1).count
        }
    }

    @MainActor func anythingOpen(_ app: XCUIApplication) -> Bool {
        textViewerOpen(app) || letterSheetOpen(app) || element(app, "session.files.viewer").exists
            || element(app, "task.open.session").exists || element(app, "task.open.loading").exists
    }

    @MainActor func assertNothingOpens(_ app: XCUIApplication, _ context: String) {
        XCTAssertFalse(anythingOpen(app), "\(context) opened something")
        let opens = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.anythingOpen(app) }, object: nil)
        opens.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [opens], timeout: 3), .completed, "\(context) opened something")
    }

    @MainActor func expectTextViewer(_ app: XCUIApplication, showing line: String) {
        XCTAssertTrue(app.navigationBars["readme.txt"].waitForExistence(timeout: 20), "no file viewer opened")
        let text = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", line)).firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 20), "the viewer does not show \(line)")
        XCTAssertFalse(element(app, "session.files.viewer.missing").exists)
        XCTAssertFalse(letterSheetOpen(app))
    }

    @MainActor func closeTextViewer(_ app: XCUIApplication) {
        tap(app.navigationBars["readme.txt"].buttons["Done"])
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.navigationBars["readme.txt"])
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 15), .completed, "the viewer did not close")
    }

    @MainActor func subject(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier == 'inbox.letter.subject' AND label CONTAINS %@", text)).firstMatch
    }

    @MainActor func expectLetterSheet(_ app: XCUIApplication) {
        XCTAssertTrue(element(app, "inbox.letterSheet.done").waitForExistence(timeout: 20), "no letter sheet opened")
        XCTAssertTrue(subject(app, fixture.letters.subjects.target).waitForExistence(timeout: 20), "the sheet is not the linked letter")
        XCTAssertFalse(textViewerOpen(app))
    }

    /// The row is hittable again, or (a Button row holding link text, which XCUITest never reads as
    /// hittable) it is back exactly where it was before the tap: same scroll position, same place.
    @MainActor func isBack(_ row: XCUIElement, placedAt placed: CGRect) -> Bool {
        if row.isHittable { return true }
        guard row.elementType == .button else { return false }
        return abs(row.frame.minX - placed.minX) < 2 && abs(row.frame.minY - placed.minY) < 2
    }

    @MainActor func closeLetterSheet(_ app: XCUIApplication, returningTo back: XCUIElement, placedAt placed: CGRect? = nil) {
        let done = element(app, "inbox.letterSheet.done"); tap(done)
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: done)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 15), .completed, "the letter sheet did not close")
        XCTAssertTrue(back.waitForExistence(timeout: 10), "Done did not return to the document the link was in")
        XCTAssertTrue(placed.map { isBack(back, placedAt: $0) } ?? back.isHittable, "Done did not preserve the tapped link's scroll position")
        XCTAssertFalse(subject(app, fixture.letters.subjects.target).exists, "the linked letter is still on screen")
    }

    /// A long press on the code's first word offers Copy (the text is selectable), and a sideways
    /// drag on its long line moves it (it scrolls, it does not wrap).
    @MainActor func expectSelectsAndScrolls(_ app: XCUIApplication, _ code: XCUIElement, _ shot: String) throws {
        let start = code.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 8, dy: 8))
        // A block's own header has a Copy too, so the selection menu is the one that comes with the press
        // and goes with the tap: the count of elements named Copy, before, during and after.
        let copies = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Copy'"))
        let copiesBefore = copies.count
        start.press(forDuration: 1.2)
        let offered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in copies.count > copiesBefore }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [offered], timeout: 15), .completed, "a long press on the code offered no Copy")
        try capture(app, shot + "-selected")
        start.tap() // on the code's first word, never a link around it
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in copies.count <= copiesBefore }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 15), .completed, "the selection menu stayed open")
        let reference = code.links.firstMatch
        XCTAssertTrue(reference.waitForExistence(timeout: 10), "\(shot): the code has no path to track while scrolling")
        let before = reference.frame.minX
        let from = code.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 260, dy: 8))
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: -220, dy: 0)))
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in reference.frame.minX < before - 40 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: 15), .completed, "\(shot): the code's path did not scroll sideways from \(before), now \(reference.frame.minX)")
        try capture(app, shot + "-scrolled")
    }

    @MainActor func capture(_ app: XCUIApplication, _ name: String) throws {
        let shot = app.screenshot(), attachment = XCTAttachment(screenshot: shot)
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        _ = try request("shot?name=" + name, method: "POST", body: shot.pngRepresentation)
    }

    @MainActor func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

    func state() throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: request("state")) as? [String: Any]) }

    func fileReads() throws -> Int {
        let tail = "/" + URL(fileURLWithPath: fixture.readme).pathComponents.suffix(2).joined(separator: "/")
        let requests = try XCTUnwrap(state()["requests"] as? [[String: Any]])
        return requests.filter { (($0["path"] as? String) ?? "").hasSuffix(tail) && ($0["status"] as? Int) == 200 }.count
    }

    func reads() throws -> [AgentTextFixtureRead] { AgentTextFixtureClient.reads(try state()) }

    /// Path lookups the app asked the server for (`/files/locate`) after observed request `seq`.
    func locates(after seq: Int) throws -> Int {
        try reads().filter { $0.seq > seq && $0.path == "/api/v1/files/locate" }.count
    }

    func lastSeq() throws -> Int { try state()["observedSeq"] as? Int ?? 0 }

    /// Every request for the fixture image after observed request `seq`, served or not.
    func mediaRequests(after seq: Int) throws -> Int {
        try reads().filter { $0.seq > seq && $0.path == "/api/v1/media" && $0.query["path"] == fixture.image }.count
    }

    /// Raw (`raw=1`) file-content reads of `path` so far; `served`: only the ones answered 200.
    func rawFileReads(of path: String, served: Bool) throws -> Int {
        let requests = try XCTUnwrap(state()["requests"] as? [[String: Any]])
        return requests.filter {
            ($0["path"] as? String) == path && ($0["raw"] as? Bool) == true && (!served || ($0["status"] as? Int) == 200)
        }.count
    }

    /// File-content reads of `path` so far, served or not.
    func fileContentReads(of path: String) throws -> Int {
        let requests = try XCTUnwrap(state()["requests"] as? [[String: Any]])
        return requests.filter { ($0["path"] as? String) == path }.count
    }

    func mediaReads() throws -> Int {
        try reads().filter { $0.path == "/api/v1/media" && $0.query["path"] == fixture.image && $0.served }.count
    }
}
