import XCTest

/// Watching follows the open tier on the phone's board, as on the web's Home panel (2026-11-11,
/// the user: a watched task in Focus is Watching only inside Focus, one in Satellite only inside
/// Satellite). Against a fixture server the test runner hosts itself: one watched task in each
/// of Focus and Satellite, and a watched one that is not pinned.
final class WatchingTierUITests: XCTestCase {
    private static let focus = (id: "mfxwatch-f001", title: "Fixture watched in Focus")
    private static let satellite = (id: "mfxwatch-s002", title: "Fixture watched in Satellite")
    private static let unpinned = (id: "mfxwatch-u003", title: "Fixture watched, not pinned")
    private static let plain = (id: "mfxwatch-p004", title: "Fixture Focus row, not watched")

    private var fixture: ChatPlaceFixtureServer?

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        var options = ChatPlaceFixtureServer.Options()
        options.tasks = [
            Self.row(Self.focus, pinned: true, watched: "2026-11-01T08:00:00.000Z"),
            Self.row(Self.satellite, pinned: true, watched: "2026-11-01T09:00:00.000Z"),
            Self.row(Self.unpinned, pinned: false, watched: "2026-11-01T10:00:00.000Z"),
            Self.row(Self.plain, pinned: true, watched: nil),
        ]
        let server = try ChatPlaceFixtureServer(options: options)
        server.extraRoute = { method, path in
            guard method == "GET" else { return nil }
            switch path {
            case "/api/v1/focus/tasks":
                return (200, [
                    "pinned_tasks": [Self.focus.id, Self.plain.id, Self.satellite.id],
                    "focus_tasks": [Self.focus.id, Self.plain.id],
                    "satellite_tasks": [Self.satellite.id],
                    "wait_tasks": [] as [Any],
                    "custom_tier_tasks": [:] as [String: Any],
                ])
            case "/api/v1/focus/tiers":
                return (200, ["tiers": [] as [Any]])
            default:
                return nil
            }
        }
        try server.start()
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        UITestLaunch.terminate()
        super.tearDown()
    }

    private static func row(_ task: (id: String, title: String), pinned: Bool, watched: String?) -> [String: Any] {
        var row = ChatPlaceFixtureServer.taskRow(id: task.id, title: task.title, phase: "IN_PROGRESS")
        row["status"] = "in_progress"
        row["project"] = "Fixture"
        if pinned { row["pinned"] = true }
        if let watched { row["watched_at"] = watched }
        return row
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func launchOnBoard() -> XCUIApplication {
        let app = UITestLaunch.launch(["-walnut.serverUrl", fixture?.url ?? "", "-walnut.deviceToken", "chat-place-fixture"])
        let tokenField = app.secureTextFields["setup.token"]
        if tokenField.waitForExistence(timeout: 5) {
            tokenField.tap()
            tokenField.typeText("chat-place-fixture")
            app.buttons["setup.connect"].tap()
        }
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 60), "the tab bar never appeared")
        tasks.tap()
        if !element(app, "board.chip.all").waitForExistence(timeout: 5) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "no board button on the Tasks page")
            menu.tap()
        }
        XCTAssertTrue(element(app, "board.chip.all").waitForExistence(timeout: 45), "the board's chip rail never appeared")
        return app
    }

    /// Open one tier (nil: All) and wait until Watching holds exactly `ids`.
    private func assertWatching(_ app: XCUIApplication, tier: String?, holds ids: [String], step: String) {
        let chip = element(app, "board.chip.\(tier ?? "all")")
        XCTAssertTrue(chip.waitForExistence(timeout: 15), "no chip for \(tier ?? "all")")
        chip.tap()
        let watched = [Self.focus.id, Self.satellite.id, Self.unpinned.id]
        let deadline = Date().addingTimeInterval(20)
        var drawn: [String] = []
        repeat {
            drawn = watched.filter { element(app, "board.row.\($0)").exists }
            if Set(drawn) == Set(ids) { break }
            Thread.sleep(forTimeInterval: 0.3)
        } while Date() < deadline
        shot(app, step)
        XCTAssertEqual(Set(drawn), Set(ids), "\(step): the watched rows drawn")
        let count = element(app, "board.section.watching.count")
        if ids.isEmpty {
            XCTAssertFalse(count.exists, "\(step): a Watching heading with no rows")
        } else {
            XCTAssertTrue(count.waitForExistence(timeout: 5), "\(step): no Watching heading")
            XCTAssertEqual(count.label, "\(ids.count)", "\(step): the Watching count")
        }
    }

    func testWatchingShowsOnlyTheOpenTiersWatchedTasks() throws {
        let app = launchOnBoard()
        assertWatching(app, tier: nil, holds: [Self.focus.id, Self.satellite.id, Self.unpinned.id], step: "1-all")
        assertWatching(app, tier: "focus", holds: [Self.focus.id], step: "2-focus")
        // The tier's own rows are still there: only Watching narrowed.
        XCTAssertTrue(element(app, "board.row.\(Self.plain.id)").exists, "the Focus row left the board")
        assertWatching(app, tier: "satellite", holds: [Self.satellite.id], step: "3-satellite")
        assertWatching(app, tier: "focus", holds: [Self.focus.id], step: "4-focus-again")
        assertWatching(app, tier: nil, holds: [Self.focus.id, Self.satellite.id, Self.unpinned.id], step: "5-all-again")
    }
}
