import XCTest

/// The `@` and `/` lists in the two reply boxes outside the chat, driven by a finger
/// (2026-11-20, the user: "all the inbox like this should like input box ... the at works like
/// the slash works"): a letter's reply and an ask card's words box under a task's row. Each
/// test types `/` at the start of the box (a session runs a command only there), sees the asking
/// session's commands, picks one, types `@`, sees its tasks (never the box's own task), picks one
/// and sends; the stub's record says the session got a message that starts with the command and
/// carries the `<task-ref/>` tag.
///
/// The box is `tests/ui/mid-turn-stub-server.mjs` (run through `run-ui-tests.sh`):
/// `/__stub/letter-reply` seeds letter A from the lane session, `/__stub/work-session?on=1`
/// gives the phone its task and session, `&taskMode=asking` makes that task ask one thing, and
/// `GET /api/v1/slash-commands` answers three commands.
final class ReplySuggestUITests: XCTestCase {
    typealias Stub = LetterReplyUITests.LetterStub

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    // MARK: - The letter reply

    @MainActor
    func testTheLetterReplyListsTasksOnAtAndCommandsOnSlash() async throws {
        // Asking: the phone holds a second task, besides the one that wrote the letter.
        let stub = try await prepared(taskMode: "asking")
        let app = try launch()
        let tab = app.tab(.inbox)
        XCTAssertTrue(tab.waitForExistence(timeout: 60), "the tab bar never appeared")
        tab.tap()
        let all = element(app, "inbox.filter.all")
        if all.waitForExistence(timeout: 20), !all.isSelected { all.tap() }
        let row = element(app, "inbox.row.lt-stub-reply-b")
        if !row.waitForExistence(timeout: 30) { app.swipeDown() }
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no row for letter B")
        row.tap()
        let field = element(app, "inbox.letter.replyField")
        try await pickBothLists(app, stub, field: field, shots: "letter", excludes: "task:task-stub-work")

        element(app, "inbox.letter.send").tap()
        let sent = try await waitForPost(stub, path: "/api/v1/human-inbox/lt-stub-reply-b/human-reply")
        XCTAssertTrue(sent.contains(#"<task-ref id="task-stub-other" label="Stub release notes"/>"#), "sent: \(sent)")
        XCTAssertTrue(sent.hasPrefix("/review "), "the command does not start the message: \(sent)")
        XCTAssertFalse(sent.contains("@["), "a token went out instead of its tag: \(sent)")
    }

    // MARK: - The ask card

    @MainActor
    func testTheAskCardsBoxListsTasksOnAtAndCommandsOnSlash() async throws {
        let stub = try await prepared(taskMode: "asking")
        let app = try launch()
        let tasks = app.tab(.tasks)
        XCTAssertTrue(tasks.waitForExistence(timeout: 60), "the tab bar never appeared")
        tasks.tap()
        let scrim = element(app, "tasks.drawer.scrim")
        if !scrim.waitForExistence(timeout: 3) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "no board button on the Tasks page")
            menu.tap()
        }
        let field = element(app, "action.reply.ask-stub-ship.input")
        if !field.waitForExistence(timeout: 40) { app.swipeDown() }
        XCTAssertTrue(field.waitForExistence(timeout: 30), "the ask card's words box never showed")
        try await pickBothLists(app, stub, field: field, shots: "ask-card", excludes: "task:task-stub-work")

        element(app, "action.reply.ask-stub-ship.send").tap()
        let sent = try await waitForPost(stub, path: "/api/v1/sessions/sess-stub-lane/messages")
        // A command goes as typed, never inside `Answer to "..."`, so the session runs it.
        XCTAssertTrue(sent.hasPrefix("/review "), "the session would not run the command: \(sent)")
        XCTAssertFalse(sent.contains("Answer to"), "the command was wrapped: \(sent)")
        XCTAssertTrue(sent.contains(#"<task-ref id="task-stub-other" label="Stub release notes"/>"#), "sent: \(sent)")
        // Taken: the item leaves the row.
        XCTAssertTrue(waitUntil(timeout: 10) { !field.exists }, "the answered item stayed")
    }

    // MARK: - Shared steps

    /// `/` at the start of the box opens the session's commands, a pick puts `/review` in;
    /// then `@` opens the task list (the box's own task left out), a pick puts its token in.
    @MainActor
    private func pickBothLists(_ app: XCUIApplication, _ stub: Stub, field: XCUIElement, shots: String,
                               excludes: String? = nil, pick: String = "task:task-stub-other",
                               pickedToken: String = "@[Stub release notes]") async throws {
        focus(field, app)
        clear(field)
        field.typeText("/")
        let list = element(app, "composer.suggest.list")
        XCTAssertTrue(list.waitForExistence(timeout: 10), "no / list")
        XCTAssertEqual(element(app, "composer.suggest.header").label, "Commands")
        let review = element(app, "composer.suggest.row.command:review")
        XCTAssertTrue(review.waitForExistence(timeout: 15), "the session's commands never came")
        XCTAssertTrue(element(app, "composer.suggest.row.command:deploy-check").exists)
        try await stub.screenshot(app, "\(shots)-slash-list")
        field.typeText("re")
        XCTAssertTrue(waitUntil(timeout: 5) { !self.element(app, "composer.suggest.row.command:deploy-check").exists },
                      "typing did not narrow the commands")
        review.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { self.text(field) == "/review " }, "field: \(text(field))")
        XCTAssertTrue(waitUntil(timeout: 5) { !list.exists }, "the list stayed open after the pick")

        field.typeText("please check @")
        XCTAssertTrue(list.waitForExistence(timeout: 10), "no @ list")
        XCTAssertEqual(element(app, "composer.suggest.header").label, "Tasks and sessions")
        let row = element(app, "composer.suggest.row.\(pick)")
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no row \(pick) in the @ list")
        if let excludes {
            XCTAssertFalse(element(app, "composer.suggest.row.\(excludes)").exists, "the box offered its own task")
        }
        try await stub.screenshot(app, "\(shots)-at-list")
        row.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { self.text(field).contains(pickedToken) }, "field: \(text(field))")
        XCTAssertTrue(waitUntil(timeout: 5) { !list.exists }, "the list stayed open after the pick")
        XCTAssertTrue(text(field).hasPrefix("/review "), "field: \(text(field))")
        try await stub.screenshot(app, "\(shots)-picked")
    }

    @MainActor
    private func waitForPost(_ stub: Stub, path: String) async throws -> String {
        struct Row: Decodable { let method: String; let path: String; let text: String? }
        for _ in 0..<40 {
            let rows = try JSONDecoder().decode([Row].self, from: try await stub.call("GET", "__stub/requests"))
            if let hit = rows.last(where: { $0.method == "POST" && $0.path == path }) { return hit.text ?? "" }
            try await Task.sleep(for: .milliseconds(250))
        }
        XCTFail("nothing was posted to \(path)")
        return ""
    }

    @MainActor
    private func prepared(taskMode: String) async throws -> Stub {
        let (server, _) = try pairing()
        guard let base = URL(string: server) else { throw XCTSkip("unusable server URL \(server)") }
        let stub = Stub(base: base)
        do {
            try await stub.call("GET", "__stub/state")
        } catch {
            throw XCTSkip("\(server) is not the UI stub: \(error). This test never runs against a real Walnut.")
        }
        try await stub.call("POST", "__stub/reset")
        try await stub.call("POST", "__stub/work-session?on=1&taskMode=\(taskMode)")
        try await stub.call("POST", "__stub/letter-reply")
        return stub
    }

    private func pairing() throws -> (server: String, token: String) {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["WALNUT_UITEST_SERVER"], let token = env["WALNUT_UITEST_TOKEN"],
              !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip("no pairing reached the test runner: point WALNUT_UITEST_SERVER at a running "
                + "ios-native/tests/ui/mid-turn-stub-server.mjs (see run-ui-tests.sh)")
        }
        return (server, token)
    }

    @MainActor
    private func launch() throws -> XCUIApplication {
        let (server, token) = try pairing()
        return UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token,
                                    "-walnut.resetLetterReplies", "YES"])
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    @MainActor
    private func focus(_ field: XCUIElement, _ app: XCUIApplication) {
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.85)).tap()
        if !app.keyboards.element.waitForExistence(timeout: 10) {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.85)).tap()
            XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 10), "the keyboard never came up")
        }
    }

    /// A box keeps its draft across launches: start from an empty one.
    @MainActor
    private func clear(_ field: XCUIElement) {
        let words = text(field)
        guard !words.isEmpty else { return }
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: words.count + 2))
    }

    @MainActor
    private func text(_ field: XCUIElement) -> String { (field.value as? String) ?? "" }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return condition()
    }
}
