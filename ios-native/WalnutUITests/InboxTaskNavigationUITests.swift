import XCTest

final class InboxTaskNavigationUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    @MainActor
    func testTaskTitleAndMenuOpenTheTaskAndKeepTheReplyDraft() async throws {
        let stub = try await prepare()
        let app = try launch()
        openLetter(app, "lt-stub-reply-a")
        let field = element(app, "inbox.letter.replyField")
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("Keep this reply while I check the task.")
        let title = app.buttons["inbox.letter.taskTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 5), "the task title is not a button")
        title.tap()
        assertTask(app)
        try await stub.screenshot(app, "title-opens-task")
        closeTask(app)
        XCTAssertEqual(field.value as? String, "Keep this reply while I check the task.")
        element(app, "inbox.letter.menu").tap()
        app.buttons["View Task"].tap()
        assertTask(app)
        try await stub.screenshot(app, "menu-opens-task")
        closeTask(app)
        XCTAssertEqual(field.value as? String, "Keep this reply while I check the task.")
        XCTAssertTrue(element(app, "inbox.letter.subject").exists)
    }

    @MainActor
    func testACompletedTaskOutsideTheListStillOpensFromItsReference() async throws {
        let stub = try await prepare(mode: "completed")
        let app = try launch()
        openLetter(app, "lt-stub-reply-a")
        let reference = app.buttons["inbox.letter.taskRef.task-stub-work"]
        for _ in 0..<5 where !reference.isHittable { app.swipeUp() }
        XCTAssertTrue(reference.waitForExistence(timeout: 10))
        reference.tap()
        assertTask(app)
        XCTAssertEqual(app.buttons["task.statusToggle"].value as? String, "Done")
        try await stub.screenshot(app, "completed-task-outside-list")
        let status = app.buttons["task.statusToggle"]
        status.tap()
        let changed = NSPredicate(format: "value == %@", "To do")
        let reopened = expectation(for: changed, evaluatedWith: status)
        await fulfillment(of: [reopened], timeout: 15)
        status.tap()
        let restored = NSPredicate(format: "value == %@", "Done")
        let completed = expectation(for: restored, evaluatedWith: status)
        await fulfillment(of: [completed], timeout: 15)
        let session = app.buttons["task.session.sess-stub-lane"]
        for _ in 0..<4 where !session.isHittable { app.swipeUp() }
        XCTAssertTrue(session.waitForExistence(timeout: 15), "the session outside the list has no link")
        session.tap()
        XCTAssertTrue(element(app, "session.menu").waitForExistence(timeout: 20))
    }

    @MainActor
    func testMissingTaskAndFailedLookupCanBeDismissedAndRetried() async throws {
        let stub = try await prepare(mode: "missing")
        let app = try launch()
        openLetter(app, "lt-stub-reply-a")
        app.buttons["inbox.letter.taskTitle"].tap()
        XCTAssertTrue(app.staticTexts["This task no longer exists on the server."].waitForExistence(timeout: 15))
        try await stub.screenshot(app, "missing-task")
        closeTask(app)
        try await stub.call("POST", "__stub/work-session?on=1&taskMode=unavailable")
        element(app, "inbox.letter.menu").tap()
        app.buttons["View Task"].tap()
        XCTAssertTrue(app.buttons["inbox.task.retry"].waitForExistence(timeout: 15))
        try await stub.screenshot(app, "task-load-failed")
        try await stub.call("POST", "__stub/work-session?on=1&taskMode=completed")
        app.buttons["inbox.task.retry"].tap()
        assertTask(app)
        closeTask(app)
        app.buttons["inbox.letter.taskTitle"].tap()
        assertTask(app)
    }

    @MainActor
    func testNoTaskHasNoTaskActionAndAnUntitledTaskStillHasTheMenuAction() async throws {
        _ = try await prepare()
        let app = try launch()
        openLetter(app, "lt-stub-reply-c")
        XCTAssertFalse(app.buttons["inbox.letter.taskTitle"].exists)
        element(app, "inbox.letter.menu").tap()
        XCTAssertFalse(app.buttons["View Task"].exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.35)).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        element(app, "inbox.row.lt-stub-reply-b").tap()
        XCTAssertTrue(element(app, "inbox.letter.subject").waitForExistence(timeout: 15))
        element(app, "inbox.letter.menu").tap()
        app.buttons["View Task"].tap()
        assertTask(app)
    }

    @MainActor
    func testTheTaskTitleAndMenuAtTheLargestTextSize() async throws {
        let stub = try await prepare(mode: "long-title")
        let app = try launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        openLetter(app, "lt-stub-reply-a")
        let title = app.buttons["inbox.letter.taskTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertLessThanOrEqual(title.frame.maxX, app.windows.firstMatch.frame.maxX + 1)
        XCTAssertGreaterThanOrEqual(title.frame.height, 44)
        try await stub.screenshot(app, "large-text-task-link")
        title.tap()
        assertTask(app)
        closeTask(app)
        element(app, "inbox.letter.menu").tap()
        app.buttons["View Task"].tap()
        assertTask(app)
        try await stub.screenshot(app, "large-text-task-detail")
    }

    private func prepare(mode: String = "live") async throws -> ProvenanceAndInboxUITests.StubControl {
        guard let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
              let base = URL(string: UITestLaunch.pairedServer(server)) else {
            throw XCTSkip("run against mid-turn-stub-server.mjs with runner environment injected")
        }
        let stub = ProvenanceAndInboxUITests.StubControl(base: base)
        try await stub.call("GET", "__stub/state")
        try await stub.reset()
        try await stub.call("POST", "__stub/inbox?seed=parity")
        try await stub.call("POST", "__stub/letter-reply")
        try await stub.call("POST", "__stub/work-session?on=1&taskMode=\(mode)")
        return stub
    }

    @MainActor
    private func launch(_ extra: [String] = []) throws -> XCUIApplication {
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"])
        return UITestLaunch.launch([
            "-walnut.serverUrl", UITestLaunch.pairedServer(server),
            "-walnut.deviceToken", "inbox-task-test",
            "-walnut.resetLetterReplies", "YES",
        ] + extra)
    }

    @MainActor
    private func openLetter(_ app: XCUIApplication, _ id: String) {
        let inbox = app.tabBars.buttons["Inbox"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 45))
        inbox.tap()
        let all = element(app, "inbox.filter.all")
        XCTAssertTrue(all.waitForExistence(timeout: 20))
        all.tap()
        let row = element(app, "inbox.row.\(id)")
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(element(app, "inbox.letter.subject").waitForExistence(timeout: 15))
    }

    @MainActor
    private func assertTask(_ app: XCUIApplication) {
        XCTAssertTrue(element(app, "task.title").waitForExistence(timeout: 20), "the task detail never opened")
        XCTAssertTrue(app.buttons["task.newSession"].exists)
    }

    @MainActor
    private func closeTask(_ app: XCUIApplication) {
        let done = app.navigationBars.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.tap()
        XCTAssertTrue(element(app, "inbox.letter.subject").waitForExistence(timeout: 10))
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }
}
