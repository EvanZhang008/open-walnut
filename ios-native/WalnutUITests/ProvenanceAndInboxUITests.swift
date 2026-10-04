import UIKit
import XCTest

/// Two TestFlight build 82 reports, driven the way a finger drives them.
///
///  1. The composer's `+` menu said "Cloud · Mac connected" / "Answers relay to
///     your Mac." while the Mac was computing the reply. The row's headline now
///     names the machine that answers, and a reply the cloud companion computed
///     on its own says so under the reply, live and after a relaunch.
///  2. The Inbox tab had no way to tell unread letters apart or to find them. It
///     now has an unread dot and a stronger title per unread row, and a filter row
///     (All, Unread, Action needed, then one chip per remaining letter type) whose
///     counts follow the web console's rules. Opening a letter marks it read at
///     once, and a read the relay could not deliver goes back to unread and is
///     retried until it lands.
///
/// The box is `tests/ui/mid-turn-stub-server.mjs`: `/__stub/status` picks what
/// `GET /api/v1/status` says (the primary, or the cloud companion with the Mac's
/// bridge up, down, or unreported, and whether the companion can answer alone),
/// `/__stub/answered-by` picks who answers the next turn, and `/__stub/inbox` seeds
/// the 40 invented letters of `tests/fixtures/inbox-parity/letters.json`.
///
/// Every screenshot is posted to the stub, which writes it on the host
/// (`WALNUT_STUB_SHOTS`), so a human can open it without xcresult archaeology.
final class ProvenanceAndInboxUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    /// Where the reply is computed, per status the phone can be told.
    private struct ProvenanceCase {
        let name: String
        let mode: String
        let cloudChat: String
        let headline: String
        let detail: String
    }

    private static let provenanceCases: [ProvenanceCase] = [
        .init(name: "live", mode: "live", cloudChat: "absent",
              headline: "Mac", detail: "Connected directly."),
        .init(name: "replica-mac-up", mode: "replica-mac", cloudChat: "available",
              headline: "Mac", detail: "Reached through the cloud relay."),
        .init(name: "replica-mac-down-cloud-available", mode: "replica-mac-down", cloudChat: "available",
              headline: "Cloud",
              detail: "Your Mac is offline, so the cloud server answers text messages for now. Mac sessions can't be reached."),
        .init(name: "replica-mac-down-cloud-unavailable", mode: "replica-mac-down", cloudChat: "unavailable",
              headline: "Mac offline",
              detail: "The cloud server can't answer without your Mac, so new messages get an error until it's back."),
        .init(name: "replica-mac-down-cloud-unreported", mode: "replica-mac-down", cloudChat: "absent",
              headline: "Mac offline",
              detail: "Your Mac isn't connected. The cloud server may answer on its own, without your Mac's sessions."),
        .init(name: "replica-bridges-unreported", mode: "replica-unknown", cloudChat: "absent",
              headline: "Mac · status unknown",
              detail: "Reached through the cloud relay, which can't say whether your Mac is connected."),
    ]

    private static let cloudReply =
        "Your Mac is offline, so this answer came from the cloud server. It has no Mac sessions."
    private static let macReply = "Working on it. Reading the first file now, and here is the answer."
    private static let caption = "Answered on Cloud"
    private static let axSize = "UICTContentSizeCategoryAccessibilityXXXL"

    // MARK: - 1. The + menu's "Running on" row, every state

    @MainActor
    func testTheRunningOnRowNamesTheMachineThatAnswersInEveryState() async throws {
        let stub = try await stubUnderTest()
        for c in Self.provenanceCases {
            try await stub.reset()
            try await stub.call("POST", "__stub/status?mode=\(c.mode)&cloudChat=\(c.cloudChat)")
            let app = try launchPaired()
            openTab(app, "Chat")
            _ = try await openHostRow(app)
            let lines = hostRowLines(app)
            XCTAssertEqual(lines.first, c.headline, "\(c.name): the row reads \(lines)")
            XCTAssertTrue(lines.contains(c.detail), "\(c.name): the detail line is not \"\(c.detail)\": \(lines)")
            if c.headline != "Cloud" {
                XCTAssertFalse(lines.contains("Cloud"), "\(c.name): the network path became the headline: \(lines)")
            }
            XCTAssertFalse(app.staticTexts["This Mac"].exists, "\(c.name): \"This Mac\" is still on screen")
            try await stub.screenshot(app, "provenance-\(c.name)")
            UITestLaunch.terminate()
        }
    }

    // MARK: - 2. "Answered on Cloud", live and after a relaunch

    /// Both deployed server generations: `cloud` says it on the frame AND the history
    /// row; `legacy` (the older companion's built-in agent) only names its engine on
    /// the turn end, so the phone's own memory is what carries it across the relaunch.
    @MainActor
    func testACloudAnswerIsCaptionedLiveAndAfterARelaunch() async throws {
        let stub = try await stubUnderTest()
        for mode in ["cloud", "legacy"] {
            try await stub.reset()
            try await stub.call("POST", "__stub/status?mode=replica-mac-down&cloudChat=available")
            try await stub.call("POST", "__stub/answered-by?mode=\(mode)")
            var app = try launchPaired()
            openTab(app, "Chat")
            send("Is the build green this morning?", app)
            try await stub.waitForHeldTurn()
            try await stub.call("POST", "__stub/finish-turn")
            XCTAssertTrue(text(app, Self.cloudReply).waitForExistence(timeout: 20), "\(mode): the reply never rendered")
            XCTAssertTrue(text(app, Self.caption).waitForExistence(timeout: 10), "\(mode): no caption at the turn end")
            // Under the reply, not somewhere else on screen.
            let reply = text(app, Self.cloudReply).frame
            let caption = text(app, Self.caption).frame
            XCTAssertGreaterThanOrEqual(caption.minY, reply.maxY - 2, "\(mode): the caption is not under the reply")
            try await stub.screenshot(app, "cloud-caption-\(mode)-live")
            // Settle the canonical refetch, then prove it kept the caption.
            try await Task.sleep(for: .seconds(2))
            XCTAssertTrue(text(app, Self.caption).exists, "\(mode): the refetch dropped the caption")

            UITestLaunch.terminate()
            app = try launchPaired()
            openTab(app, "Chat")
            try await openConversation(app, stub: stub)
            XCTAssertTrue(text(app, Self.cloudReply).waitForExistence(timeout: 20), "\(mode): the reply is gone after a relaunch")
            XCTAssertTrue(text(app, Self.caption).waitForExistence(timeout: 10), "\(mode): the caption is gone after a relaunch")
            try await stub.screenshot(app, "cloud-caption-\(mode)-after-relaunch")
            UITestLaunch.terminate()
        }
    }

    @MainActor
    func testAMacAnswerHasNoCaption() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.call("POST", "__stub/status?mode=replica-mac&cloudChat=available")
        let app = try launchPaired()
        openTab(app, "Chat")
        send("Is the build green this morning?", app)
        try await stub.waitForHeldTurn()
        try await stub.call("POST", "__stub/finish-turn")
        XCTAssertTrue(text(app, Self.macReply).waitForExistence(timeout: 20), "the reply never rendered")
        try await Task.sleep(for: .seconds(2))
        XCTAssertFalse(text(app, Self.caption).exists, "a reply the Mac computed says it was answered on Cloud")
        try await stub.screenshot(app, "mac-answer-no-caption")
    }

    // MARK: - 3. Inbox: unread state, filters, read retry, arrival, relaunch

    @MainActor
    func testInboxUnreadFiltersReadRetryArrivalAndRelaunch() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.call("POST", "__stub/inbox?seed=parity")
        var app = try launchPaired()
        openInbox(app)
        tapChip(app, "all")

        // Counts follow the console: 7 unread, 2 decisions nobody has seen.
        XCTAssertTrue(waitForValue(chip(app, "unread"), "7"), "Unread count: \(chip(app, "unread").value ?? "nil")")
        XCTAssertEqual(chip(app, "action_needed").value as? String, "2")
        // The tab badge is not in the accessibility tree on this iOS (the Inbox tab
        // reads only "Inbox"), so its presence is read off the pixels; its NUMBER
        // is `InboxStore.unreadCount`, the same count the Unread chip shows (7).
        XCTAssertTrue(inboxBadgeIsDrawn(app), "no badge on the Inbox tab with 7 unread letters: \(tabBarReadout(app))")
        // Pinned first.
        XCTAssertTrue(element(app, "inbox.row.lt-parity-004").waitForExistence(timeout: 20))
        XCTAssertLessThan(element(app, "inbox.row.lt-parity-004").frame.minY, element(app, "inbox.row.lt-parity-000").frame.minY)
        try await stub.screenshot(app, "inbox-01-all")

        tapChip(app, "unread")
        XCTAssertTrue(element(app, "inbox.row.lt-parity-001").waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "inbox.row.lt-parity-000").exists, "a read letter is listed under Unread")
        // The first unread row (on screen at any text size) draws the dot, and
        // VoiceOver hears "Unread" first. A List row merges its children into one
        // element, so the dot is checked on the pixels, not as a descendant.
        XCTAssertTrue(unreadDotIsDrawn(app, "inbox.row.lt-parity-001"), "an unread row draws no dot")
        XCTAssertTrue(rowSaysUnread(app, "inbox.row.lt-parity-001"), "VoiceOver does not hear Unread on an unread row")
        try await stub.screenshot(app, "inbox-02-unread")

        tapChip(app, "action_needed")
        XCTAssertTrue(element(app, "inbox.row.lt-parity-001").waitForExistence(timeout: 10))
        XCTAssertTrue(element(app, "inbox.row.lt-parity-019").exists)
        XCTAssertFalse(element(app, "inbox.row.lt-parity-004").exists)
        try await stub.screenshot(app, "inbox-03-action-needed")

        tapChip(app, "review")
        XCTAssertTrue(element(app, "inbox.row.lt-parity-002").waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "inbox.row.lt-parity-001").exists, "a decision is listed under Review")
        // A read, unpinned row: no dot drawn and nothing spoken.
        XCTAssertFalse(unreadDotIsDrawn(app, "inbox.row.lt-parity-002"), "a read row draws a dot")
        XCTAssertFalse(rowSaysUnread(app, "inbox.row.lt-parity-002"), "VoiceOver hears Unread on a read row")
        try await stub.screenshot(app, "inbox-04-review")

        // ── A read the relay refuses twice (503 bridge_offline), then takes ───────
        tapChip(app, "unread")
        try await stub.call("POST", "__stub/inbox-read-fail?count=2&status=503")
        element(app, "inbox.row.lt-parity-001").tap()
        XCTAssertTrue(element(app, "inbox.letter.subject").waitForExistence(timeout: 15), "the letter did not open")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let notice = element(app, "inbox.readRetryNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 8), "a read the server refused left no notice")
        XCTAssertTrue(element(app, "inbox.row.lt-parity-001").exists, "the row left Unread although its read failed")
        XCTAssertEqual(chip(app, "unread").value as? String, "7", "the count claims a read the server did not take")
        try await stub.screenshot(app, "inbox-05-read-refused-will-retry")
        XCTAssertTrue(waitForDisappearance(notice, timeout: 30), "the retry never landed")
        XCTAssertTrue(waitForValue(chip(app, "unread"), "6"), "the count did not drop after the retry landed")
        XCTAssertTrue(element(app, "inbox.row.lt-parity-001").exists, "the row just read left Unread under the reader's thumb")
        let server = try await stub.inboxState()
        XCTAssertEqual(server.letters.first { $0.id == "lt-parity-001" }?.read, true, "the server never got the read")
        try await stub.screenshot(app, "inbox-06-read-landed")

        // ── A new letter arrives while Unread is on ──────────────────────────────
        let arrived = try await stub.addLetter(type: "action_required")
        pullToRefresh(app)
        let newRow = element(app, "inbox.row.\(arrived)")
        // A synthesized pull can fall short of the refresh threshold; a person
        // whose pull did nothing pulls again.
        if !newRow.waitForExistence(timeout: 8) { pullToRefresh(app) }
        XCTAssertTrue(newRow.waitForExistence(timeout: 20), "the new letter never showed under Unread")
        XCTAssertLessThan(newRow.frame.minY, element(app, "inbox.row.lt-parity-001").frame.minY,
                          "the newest letter is not at the top of Unread")
        XCTAssertTrue(waitForValue(chip(app, "unread"), "7"))
        // Two unseen decisions at the start, one read above, one just arrived.
        XCTAssertEqual(chip(app, "action_needed").value as? String, "2")
        try await stub.screenshot(app, "inbox-07-new-letter-while-filtered")

        // ── The chosen filter survives a relaunch ────────────────────────────────
        UITestLaunch.terminate()
        app = try launchPaired()
        openInbox(app)
        XCTAssertTrue(chip(app, "unread").waitForExistence(timeout: 20))
        XCTAssertTrue(chip(app, "unread").isSelected, "the Unread filter was not remembered")
        XCTAssertFalse(element(app, "inbox.row.lt-parity-000").exists)
        try await stub.screenshot(app, "inbox-08-relaunch-keeps-unread")
    }

    @MainActor
    func testEachEmptyFilterSaysWhatWouldAppearThere() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.call("POST", "__stub/inbox?seed=parity&allRead=1")
        let app = try launchPaired()
        openInbox(app)
        let empties: [(chip: String, title: String)] = [
            ("unread", "No unread letters"), ("action_needed", "No decisions waiting"),
        ]
        for (raw, title) in empties {
            tapChip(app, raw)
            XCTAssertTrue(element(app, "inbox.empty.\(raw)").waitForExistence(timeout: 10), "\(raw): no empty state")
            XCTAssertTrue(app.staticTexts[title].exists, "\(raw): the empty state does not say \(title)")
            XCTAssertEqual(chip(app, raw).value as? String, "0")
            try await stub.screenshot(app, "inbox-empty-\(raw)")
        }
        element(app, "inbox.empty.showAll").tap()
        XCTAssertTrue(chip(app, "all").isSelected)
        XCTAssertTrue(element(app, "inbox.row.lt-parity-000").waitForExistence(timeout: 10))
        XCTAssertFalse(inboxBadgeIsDrawn(app), "an all-read inbox still draws a badge on its tab")
    }

    // MARK: - 4. Largest text size

    @MainActor
    func testTheInboxAndTheRunningOnRowAtTheLargestTextSize() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.call("POST", "__stub/inbox?seed=parity")
        try await stub.call("POST", "__stub/status?mode=replica-mac-down&cloudChat=available")
        let app = try launchPaired(["-UIPreferredContentSizeCategoryName", Self.axSize])
        openInbox(app)
        tapChip(app, "all")
        XCTAssertTrue(element(app, "inbox.row.lt-parity-004").waitForExistence(timeout: 20))
        try await stub.screenshot(app, "ax-inbox-all")
        tapChip(app, "unread")
        XCTAssertTrue(element(app, "inbox.row.lt-parity-001").waitForExistence(timeout: 10))
        let row = element(app, "inbox.row.lt-parity-001")
        XCTAssertLessThanOrEqual(row.frame.maxX, app.windows.firstMatch.frame.maxX + 1, "a row runs off the screen")
        try await stub.screenshot(app, "ax-inbox-unread")
        tapChip(app, "info")
        try await stub.screenshot(app, "ax-inbox-info-chip-scrolled")

        openTab(app, "Chat")
        _ = try await openHostRow(app)
        let lines = hostRowLines(app)
        XCTAssertEqual(lines.first, "Cloud", "at the largest size the row reads \(lines)")
        XCTAssertTrue(lines.contains(Self.provenanceCases[2].detail), "the long detail is cut at the largest size: \(lines)")
        try await stub.screenshot(app, "ax-provenance-cloud")
    }

    // MARK: - 5. The server stops answering, comes back, stops again

    /// At the largest text size: the chat's Offline banner says so, inset from the
    /// screen edges; one refresh after the server is back clears it; and the +
    /// menu's Running on row names the Mac as unreachable rather than a path that
    /// is gone.
    @MainActor
    func testAnUnreachableServerSaysSoRecoversAndSaysSoAgain() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.call("POST", "__stub/inbox?seed=parity")
        let app = try launchPaired(["-UIPreferredContentSizeCategoryName", Self.axSize])
        openInbox(app)
        // The filter persists across launches, so an earlier test's choice is still on.
        tapChip(app, "all")
        XCTAssertTrue(element(app, "inbox.row.lt-parity-004").waitForExistence(timeout: 20))

        let banner = try await makeServerUnreachable(app, stub)
        let window = app.windows.firstMatch.frame
        XCTAssertGreaterThanOrEqual(banner.frame.minX - window.minX, 10, "the banner text runs to the screen edge: \(banner.frame)")
        XCTAssertLessThanOrEqual(banner.frame.maxX, window.maxX - 10, "the banner text runs to the screen edge: \(banner.frame)")
        try await stub.screenshot(app, "offline-banner-ax")

        // Back: the next refresh reaches it and the banner goes.
        try await stub.call("POST", "__stub/offline?on=0")
        openInbox(app)
        pullToRefresh(app)
        openTab(app, "Chat")
        if !waitForDisappearance(banner, timeout: 8) {
            openInbox(app)
            pullToRefresh(app)
            openTab(app, "Chat")
        }
        XCTAssertTrue(waitForDisappearance(banner, timeout: 30), "the Offline banner stayed after the server came back")
        try await stub.screenshot(app, "offline-recovered-ax")

        // Unreachable again: the Running on row says so.
        _ = try await makeServerUnreachable(app, stub)
        _ = try await openHostRow(app)
        let lines = hostRowLines(app)
        XCTAssertEqual(lines.first, "Mac \u{00B7} unreachable", "the row reads \(lines)")
        XCTAssertTrue(lines.contains("Your Mac isn't responding right now."), "the row reads \(lines)")
        try await stub.screenshot(app, "offline-provenance-ax")
    }

    /// Stop the server answering, then do what a person does (refresh) until the
    /// app's two-failure gate flips it offline. Returns the chat's Offline banner.
    @MainActor
    private func makeServerUnreachable(_ app: XCUIApplication, _ stub: StubControl) async throws -> XCUIElement {
        try await stub.call("POST", "__stub/offline?on=1")
        let banner = text(app, "showing cached data")
        for _ in 0..<4 {
            openInbox(app)
            pullToRefresh(app)
            try await Task.sleep(for: .seconds(1))
            openTab(app, "Chat")
            if banner.waitForExistence(timeout: 6) { return banner }
        }
        XCTFail("the app never said it was offline after the server stopped answering")
        return banner
    }

    // MARK: - 6. Dark appearance (the runner flips the simulator; skipped otherwise)

    @MainActor
    func testDarkAppearanceScreens() async throws {
        guard ProcessInfo.processInfo.environment["WALNUT_UITEST_DARK"] == "1" else {
            throw XCTSkip("run with the simulator in dark appearance and WALNUT_UITEST_DARK=1")
        }
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.call("POST", "__stub/inbox?seed=parity")
        try await stub.call("POST", "__stub/status?mode=replica-mac-down&cloudChat=available")
        try await stub.call("POST", "__stub/answered-by?mode=cloud")
        let app = try launchPaired()
        openInbox(app)
        tapChip(app, "all")
        XCTAssertTrue(element(app, "inbox.row.lt-parity-001").waitForExistence(timeout: 20))
        try await stub.screenshot(app, "dark-inbox-all")
        tapChip(app, "unread")
        try await stub.screenshot(app, "dark-inbox-unread")

        openTab(app, "Chat")
        send("Is the build green this morning?", app)
        try await stub.waitForHeldTurn()
        try await stub.call("POST", "__stub/finish-turn")
        XCTAssertTrue(text(app, Self.caption).waitForExistence(timeout: 20))
        try await stub.screenshot(app, "dark-cloud-caption")
        _ = try await openHostRow(app)
        try await stub.screenshot(app, "dark-provenance-cloud")
    }

    // MARK: - Driving the app

    @MainActor
    private func launchPaired(_ extra: [String] = []) throws -> XCUIApplication {
        let (server, token) = try pairing()
        return UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token] + extra)
    }

    private func pairing() throws -> (server: String, token: String) {
        guard
            let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
            let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"],
            !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip(
                "no pairing reached the test runner: run this with WALNUT_UITEST_SERVER pointed at a running "
                    + "ios-native/tests/ui/mid-turn-stub-server.mjs (see run-ui-tests.sh)"
            )
        }
        return (server, token)
    }

    @MainActor
    private func openTab(_ app: XCUIApplication, _ name: String) {
        let tab = app.tabBars.buttons[name]
        XCTAssertTrue(tab.waitForExistence(timeout: 60), "the tab bar never appeared")
        tab.tap()
    }

    @MainActor
    private func openInbox(_ app: XCUIApplication) {
        openTab(app, "Inbox")
        XCTAssertTrue(element(app, "inbox.filterBar").waitForExistence(timeout: 30), "no filter row on the Inbox")
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    @MainActor
    private func chip(_ app: XCUIApplication, _ raw: String) -> XCUIElement {
        element(app, "inbox.filter.\(raw)")
    }

    @MainActor
    private func tapChip(_ app: XCUIApplication, _ raw: String) {
        let chip = chip(app, raw)
        XCTAssertTrue(chip.waitForExistence(timeout: 15), "no \(raw) chip")
        // Off the rail's edge at a large text size: bring it in the way a thumb would.
        let screen = app.windows.firstMatch.frame
        for _ in 0..<5 {
            let frame = chip.frame
            if frame.minX >= screen.minX, frame.maxX <= screen.maxX { break }
            let bar = element(app, "inbox.filterBar")
            if frame.maxX > screen.maxX { bar.swipeLeft() } else { bar.swipeRight() }
            usleep(400_000)
        }
        chip.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { chip.isSelected }, "the \(raw) chip did not select")
    }

    /// The composer's `+`, then the host row inside it.
    @MainActor
    private func openHostRow(_ app: XCUIApplication) async throws -> XCUIElement {
        let plus = element(app, "chat.plus")
        XCTAssertTrue(plus.waitForExistence(timeout: 45), "no composer + button")
        // The status probe lands a moment after the tab does.
        try await Task.sleep(for: .seconds(2))
        plus.tap()
        let row = element(app, "composer.hostRow")
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the + menu has no Running on row")
        return row
    }

    @MainActor
    private func send(_ text: String, _ app: XCUIApplication) {
        let field = element(app, "chat.composer")
        XCTAssertTrue(field.waitForExistence(timeout: 45), "the chat composer never appeared")
        field.tap()
        if !app.keyboards.element.waitForExistence(timeout: 10) {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        field.typeText(text)
        let sendButton = app.buttons["chat.send"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 15), "no send button")
        sendButton.tap()
    }

    /// Relaunch lands on a new chat; the drawer is the way back to the conversation.
    @MainActor
    private func openConversation(_ app: XCUIApplication, stub: StubControl) async throws {
        let id = try await stub.firstConversationID()
        let menu = element(app, "chat.menu")
        XCTAssertTrue(menu.waitForExistence(timeout: 30), "no drawer button")
        menu.tap()
        let row = element(app, "chat.drawer.conversation.\(id)")
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the conversation is not in the drawer")
        row.tap()
    }

    @MainActor
    private func pullToRefresh(_ app: XCUIApplication) {
        // Start on the first row, just under the pinned filter bar (a drag that
        // begins on the bar's horizontal rail can be kept by the rail), and pull
        // slowly with a hold at the bottom so the refresh control engages.
        let window = app.windows.firstMatch
        let bar = element(app, "inbox.filterBar")
        XCTAssertTrue(bar.waitForExistence(timeout: 10))
        let origin = window.coordinate(withNormalizedOffset: .zero)
        let x = window.frame.width / 2
        let startY = bar.frame.maxY - window.frame.minY + 40
        let start = origin.withOffset(CGVector(dx: x, dy: startY))
        let end = origin.withOffset(CGVector(dx: x, dy: startY + 360))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.6)
    }

    /// The `+` menu row's text lines, top to bottom. The row's identifier is handed to
    /// each of its children, so its texts are the static texts carrying it.
    @MainActor
    private func hostRowLines(_ app: XCUIApplication) -> [String] {
        app.staticTexts.matching(identifier: "composer.hostRow").allElementsBoundByIndex
            .sorted { $0.frame.minY < $1.frame.minY }
            .map(\.label)
    }

    /// Everything the tab bar says about itself (labels and values): where a badge
    /// is exposed differs by iOS version, so a check reads all of it.
    @MainActor
    private func tabBarReadout(_ app: XCUIApplication) -> [String] {
        let bar = app.tabBars.firstMatch
        guard bar.waitForExistence(timeout: 10) else { return [] }
        return ([bar] + bar.descendants(matching: .any).allElementsBoundByIndex)
            .filter { !$0.label.isEmpty || ($0.value as? String).map { !$0.isEmpty } == true }
            .map { "\($0.label)|\(($0.value as? String) ?? "")" }
    }

    /// Is the red badge drawn on the Inbox tab? Counts strongly red pixels in the
    /// tab button's own screenshot (the tab icons are brown, black or grey, so
    /// only the badge is red).
    @MainActor
    private func inboxBadgeIsDrawn(_ app: XCUIApplication) -> Bool {
        let tab = app.tabBars.buttons["Inbox"]
        guard tab.waitForExistence(timeout: 10), let image = tab.screenshot().image.cgImage else { return false }
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var red = 0
        for i in stride(from: 0, to: pixels.count, by: 4) {
            let r = Int(pixels[i]), g = Int(pixels[i + 1]), b = Int(pixels[i + 2])
            if r > 200, g < 90, b < 90 { red += 1 }
        }
        return red > 40
    }

    /// Is the walnut-tint unread dot drawn in this row? Read off a full-width strip
    /// of the screen at the row's height (the union of every element carrying the
    /// row's identifier), counting light-mode tint pixels (#8B5A2B). Nothing else
    /// in an unpinned row is drawn in the tint.
    @MainActor
    private func unreadDotIsDrawn(_ app: XCUIApplication, _ identifier: String) -> Bool {
        let parts = app.descendants(matching: .any).matching(identifier: identifier).allElementsBoundByIndex
        guard !parts.isEmpty else { return false }
        let rowFrame = parts.map(\.frame).reduce(parts[0].frame) { $0.union($1) }
        let shot = app.screenshot().image
        guard let image = shot.cgImage else { return false }
        let scale = shot.scale
        let strip = CGRect(x: 0, y: rowFrame.minY * scale, width: CGFloat(image.width), height: rowFrame.height * scale)
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !strip.isEmpty, let cropped = image.cropping(to: strip) else { return false }
        let width = cropped.width, height = cropped.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return false }
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))
        var tint = 0
        for i in stride(from: 0, to: pixels.count, by: 4) {
            let r = Int(pixels[i]), g = Int(pixels[i + 1]), b = Int(pixels[i + 2])
            if abs(r - 0x8B) < 28, abs(g - 0x5A) < 28, abs(b - 0x2B) < 28 { tint += 1 }
        }
        // A 10pt dot is about 700 pixels at 3x.
        return tint > 150
    }

    /// Does VoiceOver hear "Unread" for this row? Either the merged row element's
    /// label starts with it (the dot is the row's first child) or the dot is its
    /// own element under the row's identifier.
    @MainActor
    private func rowSaysUnread(_ app: XCUIApplication, _ identifier: String) -> Bool {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", identifier, "Unread"))
            .firstMatch.exists
    }

    /// Any element whose label or value carries `needle`. The timeline draws prose
    /// with TextKit, so a reply is not necessarily a `staticText`.
    @MainActor
    private func text(_ app: XCUIApplication, _ needle: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", needle, needle))
            .firstMatch
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            usleep(200_000)
        }
        return condition()
    }

    @MainActor
    private func waitForValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval = 15) -> Bool {
        waitUntil(timeout: timeout) { (element.value as? String) == value }
    }

    private func waitForDisappearance(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        waitUntil(timeout: timeout) { !element.exists }
    }

    // MARK: - The stub

    private func stubUnderTest() async throws -> StubControl {
        let (server, _) = try pairing()
        guard let base = URL(string: server) else { throw XCTSkip("unusable server URL \(server)") }
        let stub = StubControl(base: base)
        do {
            _ = try await stub.call("GET", "__stub/state")
        } catch {
            throw XCTSkip("\(server) is not the UI stub (no /__stub/state: \(error)); this test never runs against a real Walnut.")
        }
        return stub
    }

    struct StubControl: Sendable {
        let base: URL

        struct InboxState: Decodable {
            struct Row: Decodable { let id: String; let read: Bool? }
            let letters: [Row]
            let unreadCount: Int
        }

        @discardableResult
        func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
            let root = base.absoluteString.hasSuffix("/") ? base.absoluteString : base.absoluteString + "/"
            guard let url = URL(string: root + path) else {
                throw NSError(domain: "stub", code: -1, userInfo: [NSLocalizedDescriptionKey: "bad URL \(path)"])
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.timeoutInterval = 20
            if let body {
                request.httpBody = body
                request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else {
                throw NSError(domain: "stub", code: code, userInfo: [NSLocalizedDescriptionKey: "\(method) \(path) answered \(code)"])
            }
            return data
        }

        func reset() async throws { try await call("POST", "__stub/reset") }

        func inboxState() async throws -> InboxState {
            try JSONDecoder().decode(InboxState.self, from: try await call("GET", "__stub/inbox-state"))
        }

        func addLetter(type: String) async throws -> String {
            struct Added: Decodable { let id: String }
            return try JSONDecoder().decode(Added.self, from: try await call("POST", "__stub/inbox-add?type=\(type)")).id
        }

        func firstConversationID() async throws -> String {
            struct State: Decodable { struct Conv: Decodable { let id: String }; let conversations: [Conv] }
            let state = try JSONDecoder().decode(State.self, from: try await call("GET", "__stub/state"))
            guard let id = state.conversations.first?.id else {
                throw NSError(domain: "stub", code: -2, userInfo: [NSLocalizedDescriptionKey: "no conversation"])
            }
            return id
        }

        func waitForHeldTurn(timeout: TimeInterval = 45) async throws {
            struct State: Decodable { let turnHeld: String? }
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline {
                let state = try JSONDecoder().decode(State.self, from: try await call("GET", "__stub/state"))
                if state.turnHeld != nil { return }
                try await Task.sleep(for: .milliseconds(300))
            }
            XCTFail("the stub never received the message POST")
        }

        @MainActor
        func screenshot(_ app: XCUIApplication, _ name: String) async throws {
            let shot = app.screenshot()
            let attachment = XCTAttachment(screenshot: shot)
            attachment.name = name
            attachment.lifetime = .keepAlways
            XCTContext.runActivity(named: "screenshot \(name)") { $0.add(attachment) }
            try await call("POST", "__stub/screenshot?name=\(name)", body: shot.pngRepresentation)
        }
    }
}
