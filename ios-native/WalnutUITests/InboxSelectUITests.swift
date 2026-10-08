import XCTest

/// Marking letters without opening them, the way Mail does, driven like a finger
/// drives it (2026-10-08 report: "the red dot never goes away", with no way to
/// mark several letters read at once):
///
///  - swiping a row right marks it read, and again unread;
///  - Select (the button, or two fingers dragged down the rows) picks letters, and
///    the bar marks the picked ones read or unread, or every letter on screen read;
///  - a tap outside Select mode still opens the letter (inside `List(selection:)` a
///    tap selects, so this is the regression to watch).
///
/// Every outcome is checked on the server too, through the stub's own record.
/// Same box as `ProvenanceAndInboxUITests`: `tests/ui/mid-turn-stub-server.mjs`
/// seeding the 40 parity letters (7 unread).
final class InboxSelectUITests: XCTestCase {

    private typealias Stub = ProvenanceAndInboxUITests.StubControl

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    // MARK: - Swipe

    @MainActor
    func testSwipingARowRightMarksItReadThenUnreadWithoutOpeningIt() async throws {
        let (app, stub) = try await seededInbox()
        tapChip(app, "unread")
        let (id, row) = try await topUnreadRow(app, stub)

        swipeRightAndAct(app, row)
        XCTAssertTrue(waitForValue(chip(app, "unread"), "6"), "a right swipe did not mark the letter read")
        XCTAssertFalse(element(app, "inbox.letter.menu").exists, "the swipe opened the letter")
        let readLanded = await serverRead(stub, id, true)
        XCTAssertTrue(readLanded, "the server never got the read")
        // Under Unread the row stays until the filter changes, so it can be swiped back.
        XCTAssertTrue(row.exists, "the row just read left Unread under the thumb")
        try await stub.screenshot(app, "select-01-swiped-read")

        swipeRightAndAct(app, row)
        XCTAssertTrue(waitForValue(chip(app, "unread"), "7"), "a second right swipe did not mark it unread")
        let unreadLanded = await serverRead(stub, id, false)
        XCTAssertTrue(unreadLanded, "the server never got the unread")
    }

    // MARK: - Tap still opens

    @MainActor
    func testATapOutsideSelectModeStillOpensTheLetter() async throws {
        let (app, stub) = try await seededInbox()
        tapChip(app, "unread")
        let (id, row) = try await topUnreadRow(app, stub)
        row.tap()
        XCTAssertTrue(element(app, "inbox.letter.subject").waitForExistence(timeout: 15), "the tap did not open the letter")
        let opened = await serverRead(stub, id, true)
        XCTAssertTrue(opened, "opening did not mark the letter read")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(element(app, "inbox.select").waitForExistence(timeout: 10), "back from the letter, the list is in Select mode")
        XCTAssertFalse(element(app, "inbox.selection.bar").exists)
        // And again: the selection the first tap made is gone, so a second open works.
        row.tap()
        XCTAssertTrue(element(app, "inbox.letter.subject").waitForExistence(timeout: 15), "a second tap did not open the letter")
    }

    // MARK: - Select button

    @MainActor
    func testSelectMarksThePickedLettersThenMarkAllReadClearsTheRest() async throws {
        let (app, stub) = try await seededInbox()
        // Picked under Unread, where the unread rows sit together on screen.
        tapChip(app, "unread")
        XCTAssertTrue(waitForValue(chip(app, "unread"), "7"))
        let unread = try await unreadIds(stub)
        XCTAssertTrue(element(app, "inbox.row.\(unread[0])").waitForExistence(timeout: 20))
        // The two unread rows drawn highest, whatever order the stub keeps.
        let onScreen = unread.filter { element(app, "inbox.row.\($0)").exists }
            .sorted { element(app, "inbox.row.\($0)").frame.minY < element(app, "inbox.row.\($1)").frame.minY }

        tap(app, "inbox.select")
        XCTAssertTrue(app.navigationBars["Select Letters"].waitForExistence(timeout: 5), "Select did not say what it is for")
        XCTAssertTrue(element(app, "inbox.selection.markAllRead").exists, "no Mark All Read with nothing picked")
        let picked = Array(onScreen.prefix(2))
        XCTAssertEqual(picked.count, 2, "fewer than two unread rows on screen")
        for id in picked { element(app, "inbox.row.\(id)").tap() }
        XCTAssertTrue(app.navigationBars["2 Selected"].waitForExistence(timeout: 5), "the title does not count the picks")
        XCTAssertFalse(element(app, "inbox.letter.menu").exists, "a tap in Select mode opened a letter")
        try await stub.screenshot(app, "select-02-two-picked")

        tap(app, "inbox.selection.markRead")
        XCTAssertTrue(element(app, "inbox.select").waitForExistence(timeout: 5), "Mark Read did not leave Select mode")
        XCTAssertTrue(waitForValue(chip(app, "unread"), "5"), "Mark Read did not mark the two letters read")
        for id in picked {
            let landed = await serverRead(stub, id, true)
            XCTAssertTrue(landed, "\(id) never reached the server as read")
        }

        // Mark All Read under All: every letter on screen, the read ones cost nothing.
        tapChip(app, "all")
        tap(app, "inbox.select")
        tap(app, "inbox.selection.markAllRead")
        XCTAssertTrue(waitForValue(chip(app, "unread"), "0"), "Mark All Read left letters unread")
        let state = try await stub.inboxState()
        XCTAssertEqual(state.unreadCount, 0, "the server still holds unread letters")
        try await stub.screenshot(app, "select-03-all-read")

        // Done without marking leaves everything as it was.
        tap(app, "inbox.select")
        tap(app, "inbox.selectDone")
        XCTAssertTrue(element(app, "inbox.select").waitForExistence(timeout: 5))
    }

    // MARK: - Two fingers

    @MainActor
    func testTwoFingersDraggedDownTheRowsSelectThem() async throws {
        let (app, stub) = try await seededInbox()
        tapChip(app, "unread")
        let unread = try await unreadIds(stub)
        XCTAssertTrue(element(app, "inbox.row.\(unread[0])").waitForExistence(timeout: 20))
        // The top three rows as drawn, whatever order the stub keeps.
        let onScreen = unread.map { element(app, "inbox.row.\($0)") }.filter(\.exists).sorted { $0.frame.minY < $1.frame.minY }
        XCTAssertGreaterThanOrEqual(onScreen.count, 3, "fewer than three unread rows on screen")
        let first = onScreen[0], third = onScreen[2]

        try MultiTouch.twoFingerDrag(
            from: CGPoint(x: first.frame.midX - 20, y: first.frame.midY),
            to: CGPoint(x: first.frame.midX - 20, y: third.frame.midY)
        )
        XCTAssertTrue(element(app, "inbox.selectDone").waitForExistence(timeout: 5),
                      "two fingers dragged down the rows did not start Select mode")
        XCTAssertFalse(element(app, "inbox.letter.menu").exists, "the drag opened a letter")
        let title = app.navigationBars.firstMatch.identifier
        XCTAssertTrue(title.hasSuffix("Selected"), "the drag selected no rows (title \(title))")
        try await stub.screenshot(app, "select-04-two-finger-drag")

        tap(app, "inbox.selection.markRead")
        let picked = Int(title.split(separator: " ").first ?? "") ?? 0
        XCTAssertGreaterThanOrEqual(picked, 2, "the drag picked fewer than two rows")
        XCTAssertTrue(waitForValue(chip(app, "unread"), String(7 - picked)), "the dragged rows were not marked read")
    }

    // MARK: - Driving the app

    @MainActor
    private func seededInbox() async throws -> (XCUIApplication, Stub) {
        let (server, token) = try pairing()
        guard let base = URL(string: server) else { throw XCTSkip("unusable server URL \(server)") }
        let stub = Stub(base: base)
        do {
            _ = try await stub.call("GET", "__stub/state")
        } catch {
            throw XCTSkip("\(server) is not the UI stub (no /__stub/state: \(error)); this test never runs against a real Walnut.")
        }
        try await stub.reset()
        try await stub.call("POST", "__stub/inbox?seed=parity")
        let app = UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token])
        let tab = app.tabBars.buttons["Inbox"]
        XCTAssertTrue(tab.waitForExistence(timeout: 60), "the tab bar never appeared")
        tab.tap()
        XCTAssertTrue(element(app, "inbox.filterBar").waitForExistence(timeout: 30), "no filter row on the Inbox")
        return (app, stub)
    }

    private func pairing() throws -> (server: String, token: String) {
        guard
            let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
            let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"],
            !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip("no pairing reached the test runner: run with WALNUT_UITEST_SERVER pointed at the UI stub (run-ui-tests.sh)")
        }
        return (server, token)
    }

    /// Unread letters in inbox order (the stub keeps the server's order).
    private func unreadIds(_ stub: Stub) async throws -> [String] {
        let ids = try await stub.inboxState().letters.filter { $0.read != true }.map(\.id)
        XCTAssertGreaterThanOrEqual(ids.count, 3, "the parity seed has fewer unread letters than this test needs")
        return ids
    }

    /// The unread row drawn highest on screen, whatever order the stub keeps.
    @MainActor
    private func topUnreadRow(_ app: XCUIApplication, _ stub: Stub) async throws -> (String, XCUIElement) {
        let ids = try await unreadIds(stub)
        XCTAssertTrue(element(app, "inbox.row.\(ids[0])").waitForExistence(timeout: 20), "the unread rows never showed")
        let top = ids.map { ($0, element(app, "inbox.row.\($0)")) }.filter { $0.1.exists }
            .min { $0.1.frame.minY < $1.1.frame.minY }
        return try XCTUnwrap(top, "no unread row on screen")
    }

    private func serverRead(_ stub: Stub, _ id: String, _ read: Bool, timeout: TimeInterval = 10) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let state = try? await stub.inboxState(),
               (state.letters.first { $0.id == id }?.read ?? false) == read { return true }
            try? await Task.sleep(for: .milliseconds(250))
        }
        return false
    }

    /// A right swipe far enough for the full-swipe action; a swipe that only
    /// uncovers the button gets the button tapped, as a thumb would.
    @MainActor
    private func swipeRightAndAct(_ app: XCUIApplication, _ row: XCUIElement) {
        row.swipeRight(velocity: .fast)
        let button = element(app, "inbox.swipe.read")
        if button.waitForExistence(timeout: 1), button.isHittable { button.tap() }
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    @MainActor
    private func tap(_ app: XCUIApplication, _ identifier: String) {
        let target = element(app, identifier)
        XCTAssertTrue(target.waitForExistence(timeout: 10), "no \(identifier)")
        target.tap()
    }

    @MainActor
    private func chip(_ app: XCUIApplication, _ raw: String) -> XCUIElement {
        element(app, "inbox.filter.\(raw)")
    }

    @MainActor
    private func tapChip(_ app: XCUIApplication, _ raw: String) {
        let chip = chip(app, raw)
        XCTAssertTrue(chip.waitForExistence(timeout: 15), "no \(raw) chip")
        // Off the rail's edge: bring it in the way a thumb would.
        let screen = app.windows.firstMatch.frame
        for _ in 0..<5 {
            let frame = chip.frame
            if frame.minX >= screen.minX, frame.maxX <= screen.maxX { break }
            let bar = element(app, "inbox.filterBar")
            if frame.maxX > screen.maxX { bar.swipeLeft() } else { bar.swipeRight() }
            usleep(400_000)
        }
        chip.tap()
    }

    @MainActor
    private func waitForValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval = 15) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (element.value as? String) == value { return true }
            usleep(200_000)
        }
        return (element.value as? String) == value
    }
}
