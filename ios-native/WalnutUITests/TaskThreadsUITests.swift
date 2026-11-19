import XCTest

/// A leader task's Threads on the phone (additive, 2026-11-18; server `src/core/org/keeps-threads.ts`):
/// the session menu of a task with an open subtask offers "Turn On Threads", which stores them on
/// and shows the Threads sheet (`TaskThreadsSheet`); "Turn Off" there stores them off and the menu
/// offers to turn them on again. A thread push for a leader whose Threads are on opens its chat
/// with the sheet over it, as a VP's push opens the VP's page.
///
/// The app is paired to `ChatPlaceFixtureServer`; its ask ("Compare two laptops") plays the leader
/// here: this test gives it a subtask, serves its Threads switch (`PATCH /tasks/:id threads_on`)
/// and its threads (409 while off, as the server answers). The push enters through the DEBUG launch
/// argument `-walnut.debugThreadPush`, as `ThreadPushUITests` does.
final class TaskThreadsUITests: XCTestCase {

    private var fixture: ChatPlaceFixtureServer?
    private let state = LeaderState()

    private static let leaderID = ChatPlaceFixtureServer.askTaskID
    private static let leaderSession = ChatPlaceFixtureServer.askSessionID
    private static let leaderTitle = "Compare two laptops"
    private static let threadID = "th-7c0000a1"

    /// The leader's switch, read and written on the server's queue.
    final class LeaderState: @unchecked Sendable {
        private let lock = NSLock()
        private var on = false
        private(set) var patches: [Bool] = []
        var threadsOn: Bool { lock.lock(); defer { lock.unlock() }; return on }
        func set(_ value: Bool) { lock.lock(); on = value; patches.append(value); lock.unlock() }
        func start(on value: Bool) { lock.lock(); on = value; lock.unlock() }
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    // MARK: - The fixture

    private static let at = "2026-11-18T10:00:00.000Z"

    private static func leaderRow(_ on: Bool) -> [String: Any] {
        var row = ChatPlaceFixtureServer.taskRow(id: leaderID, title: leaderTitle, phase: "IN_PROGRESS")
        row["session_ids"] = [leaderSession]
        row["session_id"] = leaderSession
        if on { row["threads_on"] = true }
        return row
    }

    private static let workerRow: [String: Any] = {
        var row = ChatPlaceFixtureServer.taskRow(id: "task-fixture-garden-worker", title: "Measure the seedling light", phase: "IN_PROGRESS")
        row["parent_task_id"] = leaderID
        return row
    }()

    private static let thread: [String: Any] = [
        "id": threadID, "title": "Seedling light", "state": "answered",
        "reply": "The seedlings get four hours of light; a grow lamp on a timer would double it.",
        "messages": [[
            "id": "msg-\(threadID)", "at": at, "text": "The seedlings need more light.", "via": "chat",
            "answer": ["text": "A grow lamp on a timer would double it.", "at": at],
        ]],
        "createdAt": at, "updatedAt": at, "shown": true,
    ]

    private func startFixture(threadsOn: Bool) throws {
        state.start(on: threadsOn)
        let server = try ChatPlaceFixtureServer()
        let state = self.state
        server.extraRoutes = { method, target, body in
            let path = String(target.split(separator: "?", maxSplits: 1).first ?? "")
            let task = "/api/v1/tasks/\(Self.leaderID)"
            switch (method, path) {
            case ("GET", "/api/v1/tasks"):
                return (200, ["tasks": [Self.leaderRow(state.threadsOn), Self.workerRow], "syncedAt": Self.at])
            case ("GET", task):
                return (200, ["task": Self.leaderRow(state.threadsOn)])
            case ("PATCH", task):
                guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                      let on = json["threads_on"] as? Bool else {
                    return (400, ["error": ["code": "bad_request", "message": "threads_on must be a boolean"]])
                }
                state.set(on)
                return (200, ["task": Self.leaderRow(on)])
            case ("GET", "\(task)/threads"):
                guard state.threadsOn else {
                    return (409, ["error": ["code": "conflict", "message": "this task keeps no threads"]])
                }
                return (200, ["threads": [Self.thread], "closed_count": 0, "shown_count": 1])
            default:
                return nil
            }
        }
        try server.start()
        fixture = server
    }

    private func launchPaired(_ extra: [String] = []) throws -> XCUIApplication {
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

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func titled(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.navigationBars.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// The leader's chat, opened the way a push tap opens it.
    private func openLeader() throws -> XCUIApplication {
        let app = try launchPaired(["-walnut.debugThreadPush", "\(Self.leaderID) \(Self.threadID)"])
        XCTAssertTrue(element(app, "session.menu").waitForExistence(timeout: 45), "no chat opened for the leader")
        XCTAssertTrue(titled(app, Self.leaderTitle).waitForExistence(timeout: 15), "the chat is not the leader's")
        return app
    }

    private func menuRow(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        let menu = element(app, "session.menu")
        XCTAssertTrue(menu.waitForExistence(timeout: 15))
        menu.tap()
        let row = app.buttons[id]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the session menu has no \(id)")
        return row
    }

    // MARK: - The tests

    /// Off → the menu turns them on and shows them → Turn Off stores them off → the menu offers
    /// to turn them on again.
    func testTheSessionMenuTurnsALeadersThreadsOnShowsThemAndTurnsThemOff() throws {
        try startFixture(threadsOn: false)
        let app = try openLeader()
        // Threads off: the push opened only the chat, no sheet over it.
        XCTAssertFalse(element(app, "task.threads.sheet").waitForExistence(timeout: 3), "a sheet opened while Threads are off")

        let on = menuRow(app, "session.threads")
        XCTAssertEqual(on.label, "Turn On Threads")
        shot(app, "1-menu-off")
        on.tap()
        let sheet = element(app, "task.threads.sheet")
        XCTAssertTrue(sheet.waitForExistence(timeout: 15), "turning Threads on showed no Threads")
        XCTAssertTrue(element(app, "org.thread.\(Self.threadID)").waitForExistence(timeout: 20), "the leader's thread is not shown")
        XCTAssertTrue(app.staticTexts["Seedling light"].exists, "the thread's title is not shown")
        XCTAssertEqual(state.patches, [true], "the switch was not stored on")
        shot(app, "2-threads-sheet")

        element(app, "task.threads.off").tap()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 15), "Turn Off left the sheet up")
        XCTAssertEqual(state.patches, [true, false], "the switch was not stored off")
        let again = menuRow(app, "session.threads")
        XCTAssertEqual(again.label, "Turn On Threads", "the menu still reads Threads on")
        XCTAssertFalse(app.buttons["session.threadsOff"].exists, "Turn Off Threads is still offered")
        shot(app, "3-menu-off-again")
    }

    /// On: the menu offers Threads and Turn Off, and a thread push opens the chat with the sheet.
    func testAThreadPushForALeaderWithThreadsOnOpensItsThreads() throws {
        try startFixture(threadsOn: true)
        let app = try openLeader()
        let sheet = element(app, "task.threads.sheet")
        XCTAssertTrue(sheet.waitForExistence(timeout: 20), "the push opened no Threads for the leader")
        XCTAssertTrue(element(app, "org.thread.\(Self.threadID)").waitForExistence(timeout: 20), "the pushed thread is not shown")
        shot(app, "4-push-opens-threads")
        element(app, "task.threads.done").tap()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10), "Done left the sheet up")

        let row = menuRow(app, "session.threads")
        XCTAssertEqual(row.label, "Threads")
        XCTAssertTrue(app.buttons["session.threadsOff"].exists, "no Turn Off Threads while on")
        row.tap()
        XCTAssertTrue(sheet.waitForExistence(timeout: 15), "the Threads row showed no Threads")
        XCTAssertEqual(state.patches, [], "opening the view wrote the switch")
    }
}
