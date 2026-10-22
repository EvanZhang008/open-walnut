import XCTest

final class InboxItemLayoutUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    override func tearDown() { UITestLaunch.terminate(); super.tearDown() }
    @MainActor func testLargestTypeConfirmationKeepsKeyboardFooterReachableAndReturnDoesNotSubmit() throws {
        try checkGoalViewport(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"], name: "largest-type")
    }
    @MainActor func testDefaultTypeGoalViewportAndCancelledDraftRemainIntact() throws {
        try checkGoalViewport([], name: "default-type")
    }
    @MainActor private func checkGoalViewport(_ arguments: [String], name: String) throws {
        let app = try InboxItemActionsUITests.launch(arguments)
        InboxItemActionsUITests.openLetter(app)
        let create = InboxItemActionsUITests.element(app, "inbox.item.mail-0.create_task")
        InboxItemActionsUITests.reveal(app, create); create.tap()
        let goal = InboxItemActionsUITests.element(app, "inbox.item.confirm.goal")
        XCTAssertTrue(goal.waitForExistence(timeout: 15))
        XCTAssertEqual(goal.value as? String, "", "each launch must start with an independent blank goal")
        let approvedGoal = "Review the update\nKeep the existing source\nDo not execute this draft"
        InboxItemActionsUITests.reveal(app, goal); goal.tap(); goal.typeText(approvedGoal)
        XCTAssertEqual(goal.value as? String, approvedGoal)
        let review = InboxItemActionsUITests.element(app, "inbox.item.confirm.prepare")
        XCTAssertGreaterThan(goal.frame.height, 0, "the editor viewport must remain visible")
        XCTAssertLessThanOrEqual(goal.frame.maxY, review.frame.minY, "the editor viewport must stay above the footer while typing")
        XCTAssertGreaterThanOrEqual(goal.frame.minY, app.navigationBars.firstMatch.frame.maxY, "the editor viewport must stay below the title")
        XCTAssertTrue(review.isHittable, "the footer must stay above the keyboard")
        XCTAssertTrue(InboxItemActionsUITests.element(app, "inbox.item.confirm.cancel").isHittable)
        XCTAssertFalse(InboxItemActionsUITests.element(app, "inbox.item.confirm.execute").exists, "Return must not prepare or execute")
        let keyboard = XCTAttachment(screenshot: app.screenshot())
        keyboard.name = "\(name)-keyboard-and-reachable-footer"; keyboard.lifetime = .keepAlways; add(keyboard)
        InboxItemActionsUITests.element(app, "inbox.item.confirm.cancel").tap()
        XCTAssertTrue(create.exists)
        create.tap()
        XCTAssertTrue(goal.waitForExistence(timeout: 15))
        XCTAssertEqual(goal.value as? String, approvedGoal)
        XCTAssertFalse(InboxItemActionsUITests.element(app, "inbox.item.confirm.execute").exists)
    }
    @MainActor func testDarkDefaultAttachmentEditingKeepsExactSourceAndGoal() async throws {
        try await checkDarkAttachmentEditing([], item: "mail-2", number: 2, name: "dark-default")
    }
    @MainActor func testDarkLargestAttachmentEditingKeepsExactSourceAndGoal() async throws {
        try await checkDarkAttachmentEditing(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"],
            item: "mail-3", number: 3, name: "dark-largest")
    }
    @MainActor private func fixtureGET(_ url: URL, token: String? = nil) async throws -> (body: [String: Any], response: HTTPURLResponse) {
        let safe = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        guard safe.scheme == "http", ["localhost", "127.0.0.1"].contains(safe.host ?? ""),
              let port = safe.port, ![3456, 3457].contains(port) else {
            XCTFail("Only the isolated loopback fixture is permitted")
            throw NSError(domain: "InboxItemLayoutUITests", code: 1)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"; request.timeoutInterval = 10
        request.setValue("remote-http", forHTTPHeaderField: "x-walnut-origin")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200)
        return (try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]), http)
    }
    @MainActor private func captureDarkState(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
        let accessibility = XCTAttachment(string: app.debugDescription)
        accessibility.name = "\(name)-ax"; accessibility.lifetime = .keepAlways; add(accessibility)
    }
    @MainActor private func waitForDarkContinue(_ proceed: XCUIElement) {
        XCTAssertTrue(proceed.waitForExistence(timeout: 15))
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: proceed)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 15), .completed)
        XCTAssertTrue(proceed.isHittable)
    }
    @MainActor private func assertDarkGoalViewport(_ app: XCUIApplication, goal: XCUIElement) {
        let review = InboxItemActionsUITests.element(app, "inbox.item.confirm.prepare")
        let cancel = InboxItemActionsUITests.element(app, "inbox.item.confirm.cancel")
        XCTAssertGreaterThan(goal.frame.height, 0)
        XCTAssertGreaterThan(goal.frame.width, 0)
        XCTAssertGreaterThanOrEqual(goal.frame.minX, app.frame.minX)
        XCTAssertLessThanOrEqual(goal.frame.maxX, app.frame.maxX)
        XCTAssertGreaterThanOrEqual(goal.frame.minY, app.navigationBars.firstMatch.frame.maxY)
        XCTAssertLessThanOrEqual(goal.frame.maxY, review.frame.minY)
        XCTAssertTrue(review.isHittable); XCTAssertTrue(cancel.isHittable)
        XCTAssertEqual(review.label, "Review action")
        XCTAssertFalse(InboxItemActionsUITests.element(app, "inbox.item.confirm.execute").exists)
        XCTAssertFalse(InboxItemActionsUITests.element(app, "inbox.item.operationDetails").exists)
    }
    @MainActor private func checkDarkAttachmentEditing(_ arguments: [String], item: String, number: Int, name: String) async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["WALNUT_UITEST_INBOX_ITEMS"] == "1" else {
            XCTFail("Inbox fixture marker missing from the runner")
            throw NSError(domain: "InboxItemLayoutUITests", code: 2)
        }
        let root = try XCTUnwrap(URL(string: UITestLaunch.pairedServer(try XCTUnwrap(env["WALNUT_UITEST_SERVER"]))))
        let token = try XCTUnwrap(env["WALNUT_UITEST_TOKEN"])
        let inbox = try await fixtureGET(root.appendingPathComponent("api/v1/human-inbox"), token: token)
        let control = try XCTUnwrap(URL(string: try XCTUnwrap(inbox.response.value(forHTTPHeaderField: "x-inbox-fixture-control"))))
        let initial = try await fixtureGET(control.appendingPathComponent("state")).body
        let letterId = try XCTUnwrap(initial["letterId"] as? String)
        let targetA = try XCTUnwrap(initial["targetA"] as? String)
        let targetB = try XCTUnwrap(initial["targetB"] as? String)
        let itemIds = (0..<30).map({ "mail-\($0)" }) + ["thread-mail"]
        var initialReceiptsByItem: [String: Any] = [:]
        for itemId in itemIds {
            let result = try await fixtureGET(root.appendingPathComponent("api/v1/human-inbox/\(letterId)/items/\(itemId)/execution"), token: token).body
            let receipts = try XCTUnwrap(result["receipts"] as? [[String: Any]])
            if itemId == item { XCTAssertTrue(receipts.isEmpty, "The source item must start without executions") }
            initialReceiptsByItem[itemId] = receipts
        }
        let initialTasks = try XCTUnwrap(initial["tasks"] as? [[String: Any]])
        let initialTarget = try XCTUnwrap(initialTasks.first { ($0["id"] as? String) == targetB })
        XCTAssertEqual(initialTarget["phase"] as? String, "TODO")
        XCTAssertNil(initialTarget["session_id"]); XCTAssertNil(initialTarget["last_start"])
        XCTAssertEqual(try XCTUnwrap(initialTarget["session_ids"] as? [String]), [])
        let subject = "Fixture update \(number)"
        let app = try InboxItemActionsUITests.launch(arguments)
        InboxItemActionsUITests.openLetter(app)
        let source = InboxItemActionsUITests.element(app, "inbox.item.\(item).subject")
        InboxItemActionsUITests.reveal(app, source)
        XCTAssertEqual(source.label, subject)
        captureDarkState(app, "\(name)-source-subject")
        let card = InboxItemActionsUITests.element(app, "inbox.item.\(item)")
        let details = card.buttons["Source details"].firstMatch
        InboxItemActionsUITests.reveal(app, details); details.tap()
        let account = number % 2 == 0 ? "account-one" : "account-two"
        let sourceIdentity = card.staticTexts["Account: \(account)\nMessage: message-\(number)"].firstMatch
        XCTAssertTrue(sourceIdentity.waitForExistence(timeout: 15))
        InboxItemActionsUITests.reveal(app, sourceIdentity)
        captureDarkState(app, "\(name)-exact-source-account-message")
        let find = InboxItemActionsUITests.element(app, "inbox.item.\(item).find_task")
        InboxItemActionsUITests.reveal(app, find)
        XCTAssertEqual(find.label, "Find task for \(subject)")
        captureDarkState(app, "\(name)-source-find-before-tap")
        find.tap()
        let search = InboxItemActionsUITests.element(app, "inbox.item.tasks.search")
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        search.tap(); search.typeText(targetB)
        XCTAssertEqual(search.value as? String, targetB)
        let select = InboxItemActionsUITests.element(app, "inbox.item.tasks.select.\(targetB)")
        XCTAssertTrue(select.waitForExistence(timeout: 15))
        InboxItemActionsUITests.reveal(app, select); select.tap()
        XCTAssertTrue(select.label.contains("Selected task"))
        XCTAssertTrue(InboxItemActionsUITests.element(app, "inbox.item.tasks.preview.\(targetB)").exists)
        XCTAssertTrue(app.staticTexts["Selected task: Review the update"].exists)
        captureDarkState(app, "\(name)-exact-source-target-selector")
        let proceed = InboxItemActionsUITests.element(app, "inbox.item.tasks.continue")
        waitForDarkContinue(proceed); proceed.tap()
        let goal = InboxItemActionsUITests.element(app, "inbox.item.confirm.goal")
        XCTAssertTrue(goal.waitForExistence(timeout: 15))
        XCTAssertEqual(goal.label, "Work goal for \(subject)")
        XCTAssertEqual(goal.value as? String, "")
        XCTAssertTrue(app.staticTexts[subject].exists)
        XCTAssertTrue(app.staticTexts["Selected task"].exists)
        XCTAssertTrue(app.staticTexts["Review the update"].exists)
        captureDarkState(app, "\(name)-blank-goal-before-focus")
        let approvedGoal = "QA largest dark draft\nKeep the exact source\nDo not execute this draft"
        XCTAssertEqual(approvedGoal.count, 69)
        InboxItemActionsUITests.reveal(app, goal); goal.tap(); goal.typeText(approvedGoal)
        XCTAssertEqual(goal.value as? String, approvedGoal)
        assertDarkGoalViewport(app, goal: goal)
        captureDarkState(app, "\(name)-typed-exact-69")
        let cancel = InboxItemActionsUITests.element(app, "inbox.item.confirm.cancel")
        @MainActor func reopen(_ expected: String) {
            XCTAssertTrue(find.waitForExistence(timeout: 15))
            InboxItemActionsUITests.reveal(app, find); find.tap()
            XCTAssertTrue(search.waitForExistence(timeout: 15))
            XCTAssertEqual(search.value as? String, targetB)
            XCTAssertTrue(select.waitForExistence(timeout: 15))
            XCTAssertTrue(select.label.contains("Selected task"))
            XCTAssertTrue(app.staticTexts["Selected task: Review the update"].exists)
            waitForDarkContinue(proceed); proceed.tap()
            XCTAssertTrue(goal.waitForExistence(timeout: 15))
            XCTAssertEqual(goal.label, "Work goal for \(subject)")
            XCTAssertEqual(goal.value as? String, expected)
            XCTAssertTrue(app.staticTexts["Selected task"].exists)
            XCTAssertFalse(InboxItemActionsUITests.element(app, "inbox.item.confirm.execute").exists)
        }
        cancel.tap(); reopen(approvedGoal)
        captureDarkState(app, "\(name)-reopened-exact-69")
        InboxItemActionsUITests.reveal(app, goal); goal.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 15))
        assertDarkGoalViewport(app, goal: goal)
        goal.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.35)).tap()
        XCTAssertEqual(goal.value as? String, approvedGoal)
        captureDarkState(app, "\(name)-middle-caret-before-insertion")
        goal.typeText("!")
        let marked = try XCTUnwrap(goal.value as? String)
        captureDarkState(app, "\(name)-middle-insertion-exact-70")
        XCTAssertEqual(marked.count, 70)
        XCTAssertEqual(marked.filter { $0 == "!" }.count, 1)
        let markIndex = try XCTUnwrap(marked.firstIndex(of: "!"))
        let insertionOffset = marked.distance(from: marked.startIndex, to: markIndex)
        XCTAssertGreaterThan(insertionOffset, 0)
        XCTAssertLessThan(insertionOffset, approvedGoal.count)
        XCTAssertEqual(marked.replacingOccurrences(of: "!", with: ""), approvedGoal)
        assertDarkGoalViewport(app, goal: goal)
        let returnButtons = app.keyboards.buttons.matching(identifier: "Return")
        let keyboardAX = XCTAttachment(string: "Return identifier: Return\nMatched button count: \(returnButtons.count)\n\(returnButtons.debugDescription)\n\(app.keyboards.debugDescription)")
        keyboardAX.name = "\(name)-keyboard-return-selection-ax"; keyboardAX.lifetime = .keepAlways; add(keyboardAX)
        captureDarkState(app, "\(name)-keyboard-before-return-tap")
        guard returnButtons.count == 1 else {
            XCTFail("The actual keyboard must expose one Return button")
            throw NSError(domain: "InboxItemLayoutUITests", code: 3)
        }
        let returnButton = returnButtons.element(boundBy: 0)
        XCTAssertTrue(returnButton.exists); XCTAssertTrue(returnButton.isHittable)
        returnButton.tap()
        let edited = marked.replacingOccurrences(of: "!", with: "!\n")
        XCTAssertEqual(edited.count, 71)
        XCTAssertEqual(goal.value as? String, edited)
        assertDarkGoalViewport(app, goal: goal)
        captureDarkState(app, "\(name)-real-return-exact-71")
        cancel.tap(); reopen(edited)
        XCTAssertEqual((goal.value as? String)?.count, 71)
        captureDarkState(app, "\(name)-reopened-exact-71-selected-target")
        cancel.tap()
        var receiptsByItem: [String: Any] = [:]
        for itemId in itemIds {
            let result = try await fixtureGET(root.appendingPathComponent("api/v1/human-inbox/\(letterId)/items/\(itemId)/execution"), token: token).body
            let receipts = try XCTUnwrap(result["receipts"] as? [[String: Any]])
            let initialReceipts = try XCTUnwrap(initialReceiptsByItem[itemId] as? [[String: Any]])
            XCTAssertEqual(NSArray(array: receipts), NSArray(array: initialReceipts), "Editing must not change executions for \(itemId)")
            receiptsByItem[itemId] = receipts
        }
        let taskResponse = try await fixtureGET(root.appendingPathComponent("api/v1/tasks/\(targetB)"), token: token).body
        let task = (taskResponse["task"] as? [String: Any]) ?? taskResponse
        XCTAssertEqual(task["id"] as? String, targetB)
        XCTAssertEqual(task["phase"] as? String, "TODO")
        XCTAssertNil(task["session_id"]); XCTAssertNil(task["last_start"])
        XCTAssertEqual(try XCTUnwrap(task["session_ids"] as? [String]), [])
        let finalState = try await fixtureGET(control.appendingPathComponent("state")).body
        XCTAssertTrue(try XCTUnwrap(finalState["mailCalls"] as? [Any]).isEmpty)
        let starts = try XCTUnwrap(finalState["starts"] as? [[String: Any]])
        let startsJSON = String(decoding: try JSONSerialization.data(withJSONObject: starts, options: [.sortedKeys]), as: UTF8.self)
        XCTAssertFalse(startsJSON.contains(targetA)); XCTAssertFalse(startsJSON.contains(targetB))
        let finalTasks = try XCTUnwrap(finalState["tasks"] as? [[String: Any]])
        let finalTarget = try XCTUnwrap(finalTasks.first { ($0["id"] as? String) == targetB })
        XCTAssertEqual(NSDictionary(dictionary: finalTarget), NSDictionary(dictionary: initialTarget))
        let evidence: [String: Any] = ["initialTarget": initialTarget, "target": task,
            "initialReceiptsByItem": initialReceiptsByItem, "receiptsByItem": receiptsByItem,
            "state": finalState, "goal": edited, "insertionOffset": insertionOffset]
        let json = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
        let stateAttachment = XCTAttachment(string: String(decoding: json, as: UTF8.self))
        stateAttachment.name = "\(name)-read-only-state-no-execution"; stateAttachment.lifetime = .keepAlways; add(stateAttachment)
    }
    @MainActor func testTaskPreviewOpenAndReturnPreservesSelectorWithoutSelection() throws {
        let app = try InboxItemActionsUITests.launch(); InboxItemActionsUITests.openLetter(app)
        let find = InboxItemActionsUITests.element(app, "inbox.item.mail-2.find_task")
        InboxItemActionsUITests.reveal(app, find); find.tap()
        let search = InboxItemActionsUITests.element(app, "inbox.item.tasks.search")
        XCTAssertTrue(search.waitForExistence(timeout: 15)); search.tap(); search.typeText("Review the update")
        let preview = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "inbox.item.tasks.preview.")).firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 15)); preview.tap()
        InboxItemActionsUITests.element(app, "inbox.item.taskPreview.open").tap()
        XCTAssertTrue(app.navigationBars["Task details"].waitForExistence(timeout: 15))
        app.navigationBars.buttons["Done"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertEqual(search.value as? String, "Review the update")
        XCTAssertFalse(InboxItemActionsUITests.element(app, "inbox.item.tasks.continue").isEnabled)
    }
    @MainActor func testSourceCopyAndDisclosureDoNotHideOtherCards() throws {
        let app = try InboxItemActionsUITests.launch(["-AppleInterfaceStyle", "Dark"])
        InboxItemActionsUITests.openLetter(app)
        let first = InboxItemActionsUITests.element(app, "inbox.item.mail-0.subject")
        InboxItemActionsUITests.reveal(app, first)
        let more = app.buttons["Show more"].firstMatch
        XCTAssertTrue(more.isHittable); more.tap()
        XCTAssertTrue(app.buttons["Show less"].firstMatch.exists)
        let source = app.buttons["Source details"].firstMatch
        if source.isHittable {
            source.tap()
            XCTAssertTrue(app.buttons["Copy source"].firstMatch.waitForExistence(timeout: 5))
            app.buttons["Copy source"].firstMatch.tap()
            XCTAssertTrue(app.buttons["Copied"].firstMatch.exists)
        }
        XCTAssertTrue(InboxItemActionsUITests.element(app, "inbox.item.mail-1.subject").exists)
    }
}
