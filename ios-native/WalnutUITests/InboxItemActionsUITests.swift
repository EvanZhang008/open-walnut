import XCTest

/// Only the real isolated Inbox fixture is accepted, never the legacy UI stub.
final class InboxItemActionsUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    override func tearDown() { UITestLaunch.terminate(); super.tearDown() }
    @MainActor static func launch(_ extra: [String] = []) throws -> XCUIApplication {
        let env = ProcessInfo.processInfo.environment
        let marker = try XCTUnwrap(env["WALNUT_UITEST_INBOX_ITEMS"], "Inbox fixture marker missing from the runner")
        XCTAssertEqual(marker, "1")
        let server = UITestLaunch.pairedServer(try XCTUnwrap(env["WALNUT_UITEST_SERVER"], "Inbox fixture server missing from the runner"))
        let token = try XCTUnwrap(env["WALNUT_UITEST_TOKEN"], "Inbox fixture token missing from the runner")
        let url = try XCTUnwrap(URL(string: server))
        XCTAssertTrue(["localhost", "127.0.0.1"].contains(url.host ?? ""))
        XCTAssertNotEqual(url.port, 3456)
        return UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token] + extra)
    }
    @MainActor static func openLetter(_ app: XCUIApplication) {
        let inbox = app.tabBars.buttons["Inbox"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 40)); inbox.tap()
        let all = element(app, "inbox.filter.all")
        XCTAssertTrue(all.waitForExistence(timeout: 15)); all.tap()
        let row = app.staticTexts["Email item fixture"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15)); row.tap()
        XCTAssertTrue(element(app, "inbox.letter.subject").waitForExistence(timeout: 15))
    }
    @MainActor static func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }
    @MainActor static func reveal(_ app: XCUIApplication, _ element: XCUIElement) {
        for _ in 0..<40 {
            let visibleCenter = element.frame.midY
            if element.isHittable, visibleCenter > app.frame.height * 0.2, visibleCenter < app.frame.height * 0.72 { break }
            let upwards = !element.exists || visibleCenter > app.frame.midY
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: upwards ? 0.65 : 0.35))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: upwards ? 0.35 : 0.65))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        XCTAssertTrue(element.isHittable)
    }
    private struct Fixture: Sendable {
        let root: URL
        let token: String
        let control: URL
        let letterId: String
        let targetA: String
    }
    private func fixtureJSON(_ url: URL, token: String? = nil, fault: Bool? = nil) async throws -> (body: [String: Any], response: HTTPURLResponse) {
        let safe = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        guard safe.scheme == "http", ["localhost", "127.0.0.1"].contains(safe.host ?? ""),
              let port = safe.port, ![3456, 3457].contains(port) else {
            XCTFail("Only the isolated loopback fixture is permitted")
            throw NSError(domain: "InboxItemUITests", code: 2)
        }
        var request = URLRequest(url: url); request.timeoutInterval = 10
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.setValue("remote-http", forHTTPHeaderField: "x-walnut-origin")
        if let fault {
            request.httpMethod = "POST"
            request.setValue(fault ? "on" : "off", forHTTPHeaderField: "x-inbox-fixture-fault")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200)
        return (try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]), http)
    }
    private func fixture() async throws -> Fixture {
        let env = ProcessInfo.processInfo.environment
        XCTAssertEqual(env["WALNUT_UITEST_INBOX_ITEMS"], "1")
        let root = try XCTUnwrap(URL(string: UITestLaunch.pairedServer(try XCTUnwrap(env["WALNUT_UITEST_SERVER"]))))
        let token = try XCTUnwrap(env["WALNUT_UITEST_TOKEN"])
        let result = try await fixtureJSON(root.appendingPathComponent("api/v1/human-inbox"), token: token)
        let control = try XCTUnwrap(URL(string: try XCTUnwrap(result.response.value(forHTTPHeaderField: "x-inbox-fixture-control"))))
        let state = try await fixtureJSON(control.appendingPathComponent("state")).body
        return Fixture(root: root, token: token, control: control, letterId: try XCTUnwrap(state["letterId"] as? String),
            targetA: try XCTUnwrap(state["targetA"] as? String))
    }
    private func executions(_ fixture: Fixture, item: String) async throws -> [[String: Any]] {
        let url = fixture.root.appendingPathComponent("api/v1/human-inbox/\(fixture.letterId)/items/\(item)/execution")
        let result = try await fixtureJSON(url, token: fixture.token)
        return try XCTUnwrap(result.body["receipts"] as? [[String: Any]])
    }
    private func waitForReceipt(_ fixture: Fixture, item: String, action: String, status: String) async throws -> [String: Any] {
        for _ in 0..<60 {
            let receipts = try await executions(fixture, item: item)
            if let receipt = receipts.last(where: { ($0["actionId"] as? String) == action && ($0["status"] as? String) == status }) { return receipt }
            try await Task.sleep(for: .milliseconds(500))
        }
        XCTFail("The exact item action did not reach \(status)")
        throw NSError(domain: "InboxItemUITests", code: 1)
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    @MainActor private func waitEnabled(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 15))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
    }
    @MainActor func testNativeItemsAndPhoneMailRestriction() throws {
        let app = try Self.launch(); Self.openLetter(app)
        let first = Self.element(app, "inbox.item.mail-0.subject")
        Self.reveal(app, first)
        XCTAssertTrue(app.staticTexts["Email items (30)"].exists)
        let localOnly = app.staticTexts["Available on Mac only"].firstMatch
        XCTAssertTrue(localOnly.waitForExistence(timeout: 15))
        let mark = Self.element(app, "inbox.item.mail-0.mark_read")
        XCTAssertFalse(mark.isEnabled)
        XCTAssertTrue(Self.element(app, "inbox.item.mail-0.find_task").isEnabled)
        capture(app, "mail-0-native-actions-and-phone-restriction")
        let last = Self.element(app, "inbox.item.mail-29.subject")
        for _ in 0..<16 { app.swipeUp(velocity: .fast) }
        Self.reveal(app, last)
        XCTAssertTrue(last.isHittable)
        capture(app, "mail-29-native-density-bottom")
    }
    @MainActor func testConfirmedCreatePersistsExactTaskAndOneSource() async throws {
        let app = try Self.launch(); Self.openLetter(app)
        let create = Self.element(app, "inbox.item.mail-1.create_task")
        Self.reveal(app, create); create.tap()
        let goal = Self.element(app, "inbox.item.confirm.goal")
        XCTAssertTrue(goal.waitForExistence(timeout: 15)); Self.reveal(app, goal)
        goal.tap(); goal.typeText("Compare the fixture release notes")
        let prepare = Self.element(app, "inbox.item.confirm.prepare")
        XCTAssertTrue(prepare.isHittable); prepare.tap()
        let confirm = Self.element(app, "inbox.item.confirm.execute")
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap()
        if confirm.exists { XCTAssertFalse(confirm.isEnabled, "the submitted plan must not remain executable") }
        let env = ProcessInfo.processInfo.environment
        let root = UITestLaunch.pairedServer(try XCTUnwrap(env["WALNUT_UITEST_SERVER"]))
        let token = try XCTUnwrap(env["WALNUT_UITEST_TOKEN"])
        func get(_ route: String) async throws -> [String: Any] {
            var request = URLRequest(url: try XCTUnwrap(URL(string: root + "/api/v1" + route)))
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, _) = try await URLSession.shared.data(for: request)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        let list = try await get("/human-inbox")
        let letters = try XCTUnwrap(list["letters"] as? [[String: Any]])
        let letterId = try XCTUnwrap(letters.first(where: { ($0["subject"] as? String) == "Email item fixture" })?["id"] as? String)
        var receipt: [String: Any]?
        for _ in 0..<30 {
            let response = try await get("/human-inbox/\(letterId)/items/mail-1/execution")
            receipt = (response["receipts"] as? [[String: Any]])?.last(where: { ($0["intent"] as? String) == "create_task" })
            if receipt?["status"] as? String == "success" { break }
            try await Task.sleep(for: .milliseconds(500))
        }
        XCTAssertEqual(receipt?["status"] as? String, "success")
        let taskId = try XCTUnwrap(receipt?["taskId"] as? String)
        let taskResponse = try await get("/tasks/\(taskId)")
        let task = (taskResponse["task"] as? [String: Any]) ?? taskResponse
        XCTAssertEqual(task["id"] as? String, taskId)
        XCTAssertTrue((task["description"] as? String)?.contains("Compare the fixture release notes") == true)
        XCTAssertTrue((task["description"] as? String)?.contains("message-1") == true)
        XCTAssertFalse((task["description"] as? String)?.contains("Saved email summary") == true)
        XCTAssertNil(task["parent_task_id"])
        Self.element(app, "inbox.item.confirm.cancel").tap()
        let link = Self.element(app, "inbox.item.mail-1.taskLink")
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        capture(app, "mail-1-confirmed-exact-source-task-link")
    }
    @MainActor func testSelectorPreviewDoesNotSelectAndCancelKeepsGoal() throws {
        let app = try Self.launch(); Self.openLetter(app)
        let find = Self.element(app, "inbox.item.mail-0.find_task"); Self.reveal(app, find); find.tap()
        let search = Self.element(app, "inbox.item.tasks.search")
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        XCTAssertFalse(Self.element(app, "inbox.item.tasks.continue").isEnabled)
        search.tap(); search.typeText("Review the update")
        let preview = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "inbox.item.tasks.preview.")).firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 15)); preview.tap()
        XCTAssertTrue(app.staticTexts["Work goal"].waitForExistence(timeout: 15))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertEqual(search.value as? String, "Review the update")
        XCTAssertFalse(Self.element(app, "inbox.item.tasks.continue").isEnabled)
        capture(app, "mail-0-preview-return-without-selection")
        app.navigationBars.buttons["Cancel"].tap()
        XCTAssertTrue(Self.element(app, "inbox.item.mail-0.find_task").exists)
    }
    @MainActor func testAttachmentDraftDoesNotBecomeNewTaskGoalOrTarget() async throws {
        let fixture = try await fixture()
        let initial = try await executions(fixture, item: "mail-3")
        XCTAssertTrue(initial.isEmpty)
        let app = try Self.launch(); Self.openLetter(app)
        let find = Self.element(app, "inbox.item.mail-3.find_task")
        Self.reveal(app, find); find.tap()
        let exactSearch = Self.element(app, "inbox.item.tasks.search")
        XCTAssertTrue(exactSearch.waitForExistence(timeout: 15)); exactSearch.tap(); exactSearch.typeText(fixture.targetA)
        let select = Self.element(app, "inbox.item.tasks.select.\(fixture.targetA)")
        XCTAssertTrue(select.waitForExistence(timeout: 15)); XCTAssertTrue(select.isHittable); select.tap()
        let proceed = Self.element(app, "inbox.item.tasks.continue"); waitEnabled(proceed); proceed.tap()
        let goal = Self.element(app, "inbox.item.confirm.goal")
        XCTAssertTrue(goal.waitForExistence(timeout: 15)); Self.reveal(app, goal)
        XCTAssertTrue(app.staticTexts["Selected task"].exists)
        goal.tap(); goal.typeText("Attach-only fixture goal")
        capture(app, "mail-3-attachment-draft-target-a")
        Self.element(app, "inbox.item.confirm.cancel").tap()
        let create = Self.element(app, "inbox.item.mail-3.create_task")
        XCTAssertTrue(create.waitForExistence(timeout: 15)); Self.reveal(app, create); create.tap()
        XCTAssertTrue(goal.waitForExistence(timeout: 15))
        XCTAssertEqual(goal.value as? String, "")
        XCTAssertFalse(app.staticTexts["Selected task"].exists)
        XCTAssertFalse(app.staticTexts["Review the update"].exists)
        XCTAssertEqual(Self.element(app, "inbox.item.confirm.title").value as? String, "Fixture update 3")
        capture(app, "mail-3-create-has-no-attachment-target-or-goal")
        Self.element(app, "inbox.item.confirm.cancel").tap()
        Self.reveal(app, find); find.tap()
        let search = Self.element(app, "inbox.item.tasks.search")
        XCTAssertTrue(search.waitForExistence(timeout: 15)); waitEnabled(proceed); proceed.tap()
        XCTAssertTrue(goal.waitForExistence(timeout: 15))
        XCTAssertEqual(goal.value as? String, "Attach-only fixture goal")
        XCTAssertFalse(app.staticTexts["Add a work goal before continuing."].exists)
        XCTAssertTrue(app.staticTexts["Selected task"].exists)
        capture(app, "mail-3-return-restores-only-attachment-draft")
        Self.element(app, "inbox.item.confirm.cancel").tap()
        let receipts = try await executions(fixture, item: "mail-3")
        XCTAssertTrue(receipts.isEmpty, "Selecting and cancelling must not execute either action")
    }
    @MainActor func testFailedCreateRetriesStartOnSameTaskWithOriginalGoal() async throws {
        let fixture = try await fixture()
        let initial = try await executions(fixture, item: "mail-4")
        XCTAssertTrue(initial.isEmpty)
        let faultURL = fixture.control.appendingPathComponent("start-fault")
        addTeardownBlock { [self] in _ = try await fixtureJSON(faultURL, fault: false) }
        _ = try await fixtureJSON(faultURL, fault: true)
        let app = try Self.launch(); Self.openLetter(app)
        let create = Self.element(app, "inbox.item.mail-4.create_task")
        Self.reveal(app, create); create.tap()
        let goal = Self.element(app, "inbox.item.confirm.goal")
        XCTAssertTrue(goal.waitForExistence(timeout: 15)); Self.reveal(app, goal)
        let approvedGoal = "Retry only this fixture goal"
        goal.tap(); goal.typeText(approvedGoal)
        let prepare = Self.element(app, "inbox.item.confirm.prepare"); waitEnabled(prepare); prepare.tap()
        let confirm = Self.element(app, "inbox.item.confirm.execute"); waitEnabled(confirm)
        capture(app, "mail-4-first-frozen-create-plan"); confirm.tap()
        let failed = try await waitForReceipt(fixture, item: "mail-4", action: "create-4", status: "failure")
        XCTAssertEqual(failed["execution"] as? String, "not_started")
        XCTAssertEqual(failed["taskCreated"] as? Bool, true)
        XCTAssertTrue((failed["recovery"] as? [String])?.contains("retry_start") == true)
        let taskId = try XCTUnwrap(failed["taskId"] as? String)
        capture(app, "mail-4-real-start-refusal")
        Self.element(app, "inbox.item.confirm.cancel").tap()
        _ = try await fixtureJSON(faultURL, fault: false)
        let card = Self.element(app, "inbox.item.mail-4")
        let details = card.buttons["Show details"]
        XCTAssertTrue(details.waitForExistence(timeout: 15)); Self.reveal(app, details); details.tap()
        let retry = card.buttons["Retry start"]
        XCTAssertTrue(retry.waitForExistence(timeout: 15)); Self.reveal(app, retry); waitEnabled(retry); retry.tap()
        XCTAssertTrue(goal.waitForExistence(timeout: 15))
        XCTAssertEqual(goal.label, approvedGoal)
        waitEnabled(confirm)
        let expand = app.buttons["inbox.item.operationDetails"]
        XCTAssertTrue(expand.waitForExistence(timeout: 15)); Self.reveal(app, expand); expand.tap()
        XCTAssertTrue(app.staticTexts["Task ID: \(taskId)"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["1. task_start"].exists)
        XCTAssertFalse(app.staticTexts["1. task_create"].exists)
        capture(app, "mail-4-retry-original-goal-and-exact-task-plan")
        XCTAssertTrue(confirm.isHittable); confirm.tap()
        let started = try await waitForReceipt(fixture, item: "mail-4", action: "create-4", status: "success")
        XCTAssertEqual(started["execution"] as? String, "running")
        XCTAssertEqual(started["taskId"] as? String, taskId)
        let input = try XCTUnwrap(started["input"] as? [String: Any])
        XCTAssertEqual(input["goal"] as? String, approvedGoal)
        let source = try XCTUnwrap(started["source"] as? [String: Any])
        XCTAssertEqual(source["account"] as? String, "account-one"); XCTAssertEqual(source["message"] as? String, "message-4")
        let state = try await fixtureJSON(fixture.control.appendingPathComponent("state")).body
        let tasks = try XCTUnwrap(state["tasks"] as? [[String: Any]])
        XCTAssertEqual(tasks.filter { ($0["id"] as? String) == taskId }.count, 1)
        let sourceTasks = tasks.filter { ($0["description"] as? String)?.contains("Message: \"message-4\"") == true }
        XCTAssertEqual(sourceTasks.count, 1); XCTAssertEqual(sourceTasks.first?["id"] as? String, taskId)
        let receipts = try await executions(fixture, item: "mail-4")
        XCTAssertEqual(Set(receipts.compactMap { $0["taskId"] as? String }), Set([taskId]))
        XCTAssertEqual((state["mailCalls"] as? [Any])?.count, 0)
        capture(app, "mail-4-retry-started-with-one-source-task")
        Self.element(app, "inbox.item.confirm.cancel").tap()
    }
    @MainActor func testTwoAIQuestionsStayIndependentOfEachOtherAndTaskActions() async throws {
        let fixture = try await fixture()
        let initial = try await executions(fixture, item: "mail-5")
        XCTAssertTrue(initial.isEmpty)
        let app = try Self.launch(); Self.openLetter(app)
        let first = app.buttons["Ask AI: Explain fixture five for Fixture update 5"]
        let second = app.buttons["Ask AI: Compare fixture five for Fixture update 5"]
        Self.reveal(app, first); waitEnabled(first); first.tap()
        let firstReceipt = try await waitForReceipt(fixture, item: "mail-5", action: "ask-first-5", status: "success")
        XCTAssertEqual(firstReceipt["delivery"] as? String, "skipped")
        waitEnabled(second)
        let lockedFirst = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == false"), object: first)
        XCTAssertEqual(XCTWaiter.wait(for: [lockedFirst], timeout: 15), .completed)
        XCTAssertTrue(Self.element(app, "inbox.item.mail-5.find_task").isEnabled)
        XCTAssertTrue(Self.element(app, "inbox.item.mail-5.create_task").isEnabled)
        capture(app, "mail-5-first-ai-settled-second-remains-enabled")
        Self.reveal(app, second); second.tap()
        let secondReceipt = try await waitForReceipt(fixture, item: "mail-5", action: "ask-second-5", status: "success")
        XCTAssertEqual(secondReceipt["delivery"] as? String, "skipped")
        let lockedSecond = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == false"), object: second)
        XCTAssertEqual(XCTWaiter.wait(for: [lockedSecond], timeout: 15), .completed)
        XCTAssertTrue(Self.element(app, "inbox.item.mail-5.find_task").isEnabled)
        XCTAssertTrue(Self.element(app, "inbox.item.mail-5.create_task").isEnabled)
        let receipts = try await executions(fixture, item: "mail-5")
        XCTAssertEqual(receipts.count, 2)
        XCTAssertEqual(Set(receipts.compactMap { $0["actionId"] as? String }), Set(["ask-first-5", "ask-second-5"]))
        XCTAssertEqual(Set(receipts.compactMap { $0["requestId"] as? String }).count, 2)
        XCTAssertTrue(receipts.allSatisfy { ($0["intent"] as? String) == "reply_ai" && ($0["delivery"] as? String) == "skipped" && $0["taskId"] == nil })
        let state = try await fixtureJSON(fixture.control.appendingPathComponent("state")).body
        XCTAssertEqual((state["mailCalls"] as? [Any])?.count, 0)
        let card = Self.element(app, "inbox.item.mail-5")
        let details = card.buttons["Show details"]; Self.reveal(app, details); details.tap()
        XCTAssertTrue(card.staticTexts["Saved. Nothing was sent to the agent."].firstMatch.waitForExistence(timeout: 15))
        Self.reveal(app, second)
        XCTAssertTrue(card.staticTexts["Fixture update 5: Ask AI: Explain fixture five: Saved. Nothing was sent to the agent."].exists)
        XCTAssertTrue(card.staticTexts["Fixture update 5: Ask AI: Compare fixture five: Saved. Nothing was sent to the agent."].exists)
        XCTAssertFalse(first.isEnabled); XCTAssertFalse(second.isEnabled)
        capture(app, "mail-5-two-independent-ai-receipts-no-mail-operation")
    }
}
