import XCTest

/// THE PHONE'S PINNED BOARD READS IN THE MAC'S ORDER, read off the screen.
///
/// The field report (TestFlight build 82, phone on a cloud replica): the Tasks tab's
/// Focus tier under `By project` listed its project groups in a different order from the
/// Mac's home panel for the same data. The rule now lives once
/// (`web/src/utils/pinned-tier-order.ts`, twinned by `PinnedTierOrder.swift`); the unit
/// suite `PinnedTierOrderTests` proves the model. This suite proves the SCREEN: the rows a
/// finger scrolls through, in the order they are drawn, against the order the web code
/// produced for the same neutral board (`tests/fixtures/pinned-tier-order/`).
///
/// The box is `tests/ui/mid-turn-stub-server.mjs` with `POST /__stub/board`, which
/// serves that board as the Mac, as a current replica (no `group_id` on rows; folders and
/// project order from the primary's push) or as an old replica (neither). Nothing here
/// reaches into the app.
///
/// RUN IT WITH `ios-native/tests/ui/run-ui-tests.sh` and the stub running (see
/// `MidTurnQueueUITests` for why a bare `xcodebuild` skips every case here).
final class BoardOrderParityUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// Every tier chip and both groupings, as the Mac draws them (date filter `All`).
    @MainActor
    func testEveryTierInBothGroupingsIsDrawnInTheMacsOrder() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.seedBoard(as: "primary")
        let app = try launchPaired()
        openTasks(app)
        try waitForBoard(app)
        setDate(app, "All")
        for tier in ["focus", "satellite", "backlog", "wait", "ct_later", "all"] {
            selectTier(app, tier)
            for (grouping, key) in [("By project", "project"), ("Custom order", "custom")] {
                setGrouping(app, grouping)
                let expected = try await stub.expected("\(tier)/\(key)/all")
                let drawn = readRows(app)
                XCTAssertEqual(drawn, expected, "\(tier) / \(grouping): the rows as drawn")
                if tier == "focus" {
                    try await stub.screenshot(app, "board-order-primary-\(tier)-\(key)")
                }
            }
        }
    }

    /// A current replica: its rows carry no `group_id`, so the folders can only come from
    /// the listing the primary pushed. The screen must not change.
    @MainActor
    func testACurrentReplicaDrawsTheSameOrder() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.seedBoard(as: "replica")
        let app = try launchPaired()
        openTasks(app)
        try waitForBoard(app)
        setDate(app, "All")
        selectTier(app, "focus")
        setGrouping(app, "By project")
        let expected = try await stub.expected("focus/project/all")
        XCTAssertEqual(readRows(app), expected)
        try await stub.screenshot(app, "board-order-replica-focus-project")
    }

    /// An old replica answers neither folders nor a project order. The phone then shows
    /// the closest order it can honestly draw: projects where their first open row
    /// appears, rows in pin order. This is what the phone shows until the companion is
    /// redeployed.
    @MainActor
    func testAnOldReplicaFallsBackToFirstAppearance() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.seedBoard(as: "old-replica")
        let app = try launchPaired()
        openTasks(app)
        try waitForBoard(app)
        setDate(app, "All")
        selectTier(app, "focus")
        setGrouping(app, "By project")
        let byProject = try await stub.expected("focus/project/all")
        XCTAssertEqual(readRows(app), byProject)
        try await stub.screenshot(app, "board-order-old-replica-focus-project")
        setGrouping(app, "Custom order")
        let custom = try await stub.expected("focus/custom/all")
        XCTAssertEqual(readRows(app), custom)
    }

    // MARK: - Driving the board

    private func openTasks(_ app: XCUIApplication) {
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 60), "the tab bar never appeared")
        tasks.tap()
    }

    /// The board has drawn the stub's rows (a fixture id, not a cached one from a previous
    /// pairing).
    private func waitForBoard(_ app: XCUIApplication) throws {
        let chip = app.descendants(matching: .any)["board.chip.all"]
        XCTAssertTrue(chip.waitForExistence(timeout: 45), "the board's chip rail never appeared")
        chip.tap()
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'board.row.t'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 45), "no fixture row reached the board")
    }

    private func selectTier(_ app: XCUIApplication, _ tier: String) {
        let chip = app.descendants(matching: .any)["board.chip.\(tier)"]
        scrollToTop(app)
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "no chip for \(tier)")
        chip.tap()
    }

    /// Cycle a view-bar chip until it shows `label` (each tap moves to the next value).
    private func cycle(_ app: XCUIApplication, _ identifier: String, to label: String) {
        scrollToTop(app)
        let chip = app.buttons[identifier]
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "no \(identifier)")
        for _ in 0..<3 where !chip.label.contains(label) {
            chip.tap()
        }
        XCTAssertTrue(chip.label.contains(label), "\(identifier) never read \(label): \(chip.label)")
    }

    private func setGrouping(_ app: XCUIApplication, _ label: String) {
        cycle(app, "board.view.grouping", to: label)
    }

    private func setDate(_ app: XCUIApplication, _ label: String) {
        cycle(app, "board.view.date", to: label)
    }

    /// Back to the top of the board: the view bar (header row three) scrolls with the
    /// rows, so it is on screen exactly when the list is at its top.
    private func scrollToTop(_ app: XCUIApplication) {
        let viewBar = app.buttons["board.view.grouping"]
        for _ in 0..<8 {
            if viewBar.exists, viewBar.isHittable, viewBar.frame.minY > 0 { break }
            app.swipeDown(velocity: .fast)
        }
        Thread.sleep(forTimeInterval: 0.6)
    }

    /// Every `board.row.*` from the top of the board to its foot, in DRAWN order: each
    /// screenful is read by frame, and screenfuls are stitched where they overlap. A lazy
    /// list only has the rows near the viewport, so one read cannot see a long tier.
    private func readRows(_ app: XCUIApplication) -> [String] {
        scrollToTop(app)
        var seen: [String] = []
        var unchanged = 0
        for _ in 0..<40 {
            let pass = drawnRowIds(app)
            let before = seen.count
            for (index, id) in pass.enumerated() where !seen.contains(id) {
                // Insert after the nearest row above it that is already known.
                if let anchor = pass[..<index].last(where: { seen.contains($0) }),
                   let at = seen.firstIndex(of: anchor) {
                    seen.insert(id, at: at + 1)
                } else {
                    seen.insert(id, at: 0)
                }
            }
            unchanged = seen.count == before ? unchanged + 1 : 0
            if unchanged >= 2 { break }
            app.swipeUp(velocity: .slow)
        }
        return seen
    }

    /// The rows in the hierarchy right now, top to bottom, from ONE snapshot (a query per
    /// element would be two round trips per row).
    private func drawnRowIds(_ app: XCUIApplication) -> [String] {
        guard let root = try? app.snapshot() else { return [] }
        let prefix = "board.row."
        var found: [(id: String, y: CGFloat)] = []
        var stack: [XCUIElementSnapshot] = [root]
        while let node = stack.popLast() {
            if node.identifier.hasPrefix(prefix), !node.frame.isEmpty {
                found.append((String(node.identifier.dropFirst(prefix.count)), node.frame.minY))
            }
            stack.append(contentsOf: node.children)
        }
        var ids: [String] = []
        for entry in found.sorted(by: { $0.y < $1.y }) where !ids.contains(entry.id) {
            ids.append(entry.id)
        }
        return ids
    }

    // MARK: - Pairing and the stub

    private func launchPaired() throws -> XCUIApplication {
        let (server, token) = try pairing()
        return UITestLaunch.launch([
            "-walnut.serverUrl", server,
            "-walnut.deviceToken", token,
        ])
    }

    private func pairing() throws -> (server: String, token: String) {
        guard
            let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
            let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"],
            !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip(
                "no pairing reached the test runner: run this through "
                    + "ios-native/tests/ui/run-ui-tests.sh with WALNUT_UITEST_SERVER pointed "
                    + "at a running tests/ui/mid-turn-stub-server.mjs"
            )
        }
        return (server, token)
    }

    /// The throwaway server, proved to BE the throwaway server: a live Walnut has no
    /// `/__stub/state`, so a pairing at a real box skips instead of reading its board.
    private func stubUnderTest() async throws -> StubControl {
        let (server, _) = try pairing()
        guard let base = URL(string: server) else { throw XCTSkip("unusable server URL \(server)") }
        let stub = StubControl(base: base)
        do {
            _ = try await stub.call("GET", "__stub/state")
        } catch {
            throw XCTSkip("\(server) is not the stub (no /__stub/state: \(error))")
        }
        return stub
    }

    struct StubControl {
        let base: URL

        @discardableResult
        func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
            let root = base.absoluteString.hasSuffix("/") ? base.absoluteString : base.absoluteString + "/"
            guard let url = URL(string: root + path) else {
                throw NSError(domain: "stub", code: -1, userInfo: [
                    NSLocalizedDescriptionKey: "unusable control URL \(root)\(path)",
                ])
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
                throw NSError(domain: "stub", code: code, userInfo: [
                    NSLocalizedDescriptionKey: "\(method) \(path) answered \(code)",
                ])
            }
            return data
        }

        func reset() async throws { try await call("POST", "__stub/reset") }

        func seedBoard(as who: String) async throws {
            try await call("POST", "__stub/board?seed=pinned-tier-order&as=\(who)")
        }

        func expected(_ view: String) async throws -> [String] {
            struct Answer: Decodable { let ids: [String] }
            let data = try await call("GET", "__stub/board-expected?view=\(view)")
            return try JSONDecoder().decode(Answer.self, from: data).ids
        }

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
