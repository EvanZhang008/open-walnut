import XCTest
@testable import Walnut

#if canImport(UIKit) || INBOX_TRANSPORT_LOGIC
private final class InboxItemRequestProbe: URLProtocol {
    static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
    }
    override func stopLoading() {}
}
#endif

@MainActor final class InboxItemFakeTransport: InboxItemTransport {
    var executeCount = 0
    var queryCount = 0
    var failExecute = false
    var executionError: Error?
    var executeGate: CheckedContinuation<Void, Never>?
    var holdExecute = false
    var failQuery = false
    var preparedInput: InboxItemPrepareRequest?
    var prepareResponse: InboxItemPrepareResponse?
    var prepareGate: CheckedContinuation<Void, Never>?
    var holdPrepare = false
    var queryResponse: InboxItemExecutionResponse?
    var queryGate: CheckedContinuation<Void, Never>?
    var holdQuery = false
    func prepareInboxItem(letterId: String, itemId: String, request: InboxItemPrepareRequest) async throws -> InboxItemPrepareResponse {
        preparedInput = request
        if holdPrepare { await withCheckedContinuation { prepareGate = $0 } }
        if let prepareResponse { return prepareResponse }
        return .init(plan: try InboxItemStoreTests.plan(), projects: [.init(name: "")], source: .init(kind: "mail", account: "account-one", message: "message-one"),
            existingWork: nil, restrictions: [], receipts: [], currentTask: nil)
    }
    func executeInboxItem(letterId: String, itemId: String, request: InboxItemExecuteRequest) async throws -> InboxItemExecutionResponse {
        executeCount += 1
        if holdExecute { await withCheckedContinuation { executeGate = $0 } }
        if let executionError { throw executionError }
        if failExecute { throw URLError(.networkConnectionLost) }
        return .init(itemId: itemId, receipts: [try InboxItemStoreTests.receipt(requestId: request.requestId)], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil)
    }
    func inboxItemExecution(letterId: String, itemId: String) async throws -> InboxItemExecutionResponse {
        queryCount += 1
        if holdQuery { await withCheckedContinuation { queryGate = $0 } }
        if failQuery { throw URLError(.timedOut) }
        return queryResponse ?? .init(itemId: itemId, receipts: [], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil)
    }
    func inboxItemTasks(letterId: String, itemId: String, query: String, offset: Int) async throws -> InboxTaskPage {
        .init(tasks: [], total: 0, offset: offset, limit: 25, hasMore: false)
    }
    func inboxItemTask(letterId: String, itemId: String, taskId: String) async throws -> InboxTaskPreview {
        .init(id: taskId, title: "Review update", project: "", phase: "TODO", description: "Compare the saved goal", summary: nil, activity: nil, updatedAt: nil)
    }
}

@MainActor final class InboxItemStoreTests: XCTestCase {
    static let key = InboxItemStore.Key(letter: "letter-one", item: "mail-one")
    static func receipt(revision: Int = 1, requestId: String = "request-one", status: String = "success", intent: String = "create_task", taskId: String = "task-one") throws -> InboxItemReceipt {
        try JSONDecoder().decode(InboxItemReceipt.self, from: Data("""
        {"actionId":"create-one","requestId":"\(requestId)","planId":"plan-one","planVersion":1,"revision":\(revision),"updatedAt":"2026-10-21T10:00:00Z",
        "status":"\(status)","intent":"\(intent)","source":{"kind":"mail","account":"account-one","message":"message-one"},"input":{"goal":"Review the update"},
        "stage":"finished","taskId":"\(taskId)","startedAt":"2026-10-21T10:00:00Z","recovery":[]}
        """.utf8))
    }
    static func plan() throws -> InboxItemPlan {
        try JSONDecoder().decode(InboxItemPlan.self, from: Data("""
        {"id":"plan-one","version":1,"actionId":"create-one","intent":"create_task","letterId":"letter-one","itemId":"mail-one",
        "source":{"kind":"mail","account":"account-one","message":"message-one"},"input":{"goal":"Review the update"},
        "ops":[{"tool":"task_create","args":{"title":"Review"}},{"tool":"task_start","args":{"id":"task-one"}}],"taskId":"task-one",
        "createdAt":"2026-10-21T10:00:00Z","expiresAt":"2099-10-21T10:00:00Z"}
        """.utf8))
    }
    static func replacing<T: Codable>(_ value: T, fields: [String: Any]) throws -> T {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
        object.merge(fields) { _, new in new }
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }
    static func aiItem() throws -> InboxEmailItem {
        try JSONDecoder().decode(InboxEmailItem.self, from: Data("""
        {"id":"mail-one","subject":"Weekly update","summary":"Saved summary","source":{"kind":"mail","account":"account-one","message":"message-one"},
        "actions":[{"id":"ask-one","kind":"reply_ai","label":"Explain the update","question":"Explain the update"},
        {"id":"ask-two","kind":"reply_ai","label":"Compare the update","question":"Compare the update"}]}
        """.utf8))
    }
    static func aiPlan(_ actionId: String) throws -> InboxItemPlan {
        try replacing(plan(), fields: ["id": "plan-\(actionId)", "actionId": actionId, "intent": "reply_ai", "input": [:], "ops": []])
    }
    #if canImport(UIKit) || INBOX_TRANSPORT_LOGIC
    func testItemTransportSetsPhoneOriginAndNeverReplaysLostExecute() async throws {
        let savedURL = AppConfig.processServerURLOverride; let savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = URL(string: "http://127.0.0.1:59998")
        AppConfig.processTokenOverride = "fixture-phone-token"
        defer { AppConfig.processServerURLOverride = savedURL; AppConfig.processTokenOverride = savedToken }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [InboxItemRequestProbe.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        InboxItemRequestProbe.requests = []
        let request = InboxItemExecuteRequest(actionId: "create-one", requestId: "request-one", confirmed: true, planId: "plan-one", planVersion: 1)
        do {
            let _: InboxItemExecutionResponse = try await WalnutAPI().inboxItemRequest("POST", "/human-inbox/letter-one/items/mail-one/execute",
                body: request, timeout: 15, session: session)
            XCTFail("lost responses must throw")
        } catch {
            XCTAssertEqual(InboxItemRequestProbe.requests.count, 1)
            XCTAssertEqual(InboxItemRequestProbe.requests.first?.value(forHTTPHeaderField: "x-walnut-origin"), "remote-http")
            XCTAssertEqual(InboxItemRequestProbe.requests.first?.timeoutInterval, 15)
        }
    }
    #endif
    func testRevisionMergeCannotRollBackOrCrossSource() throws {
        let high = try Self.receipt(revision: 4)
        let low = try Self.receipt(revision: 2, status: "pending")
        XCTAssertEqual(InboxItemStore.mergeReceipts([high], [low], source: high.source), [high])
        let wrong = InboxMailSource(kind: "mail", account: "account-two", message: "message-one")
        XCTAssertEqual(InboxItemStore.mergeReceipts([], [high], source: wrong), [])
    }
    func testCanonicalTaskReceiptCanCrossAccountsButReadReceiptCannot() throws {
        let task = try Self.receipt()
        let otherSource = InboxMailSource(kind: "mail", account: "account-two", message: "message-two")
        XCTAssertEqual(InboxItemStore.mergeReceipts([], [task], source: otherSource, canonicalTask: true), [task])
        let read = try Self.receipt(intent: "mark_read")
        XCTAssertTrue(InboxItemStore.mergeReceipts([], [read], source: otherSource, canonicalTask: true).isEmpty)
    }
    func testTaskQueryIgnoresSameValueAndAnOldActionsBinding() throws {
        let store = InboxItemStore(transport: InboxItemFakeTransport())
        let item = try InboxItemContractTests.item(); let key = Self.key
        store.seed([item], letterId: key.letter)
        let find = try XCTUnwrap(item.actions.first { $0.intent == "find_task" })
        let create = try XCTUnwrap(item.actions.first { $0.intent == "create_task" })
        store.activateDraft(key, action: find)
        var draft = store.draft(key); draft.query = "exact-task"
        draft.selected = .init(id: "exact-task", title: "Review update", project: "", phase: "TODO")
        draft.input.selectedTaskId = "exact-task"; draft.listAnchor = "exact-task"
        store.setDraft(draft, key: key)
        store.setTaskQuery("exact-task", key: key, actionId: find.id)
        XCTAssertEqual(store.draft(key), draft)
        store.setTaskQuery("different", key: key, actionId: find.id)
        XCTAssertNil(store.draft(key).selected); XCTAssertNil(store.draft(key).input.selectedTaskId)
        store.activateDraft(key, action: create)
        let newDraft = store.draft(key)
        store.setTaskQuery("stale binding", key: key, actionId: find.id)
        XCTAssertEqual(store.draft(key), newDraft)
    }
    func testDraftSurvivesReceiptAndDetailRefresh() throws {
        let store = InboxItemStore(transport: InboxItemFakeTransport())
        store.seed([try InboxItemContractTests.item()], letterId: Self.key.letter)
        var draft = InboxItemStore.Draft(); draft.input.goal = "Keep this draft"; draft.query = "Review"; draft.listAnchor = "task-two"
        store.setDraft(draft, key: Self.key)
        let receipt = try Self.receipt()
        store.merge(.init(itemId: Self.key.item, receipts: [receipt], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: Self.key)
        store.seed([try InboxItemContractTests.item()], letterId: Self.key.letter)
        XCTAssertEqual(store.draft(Self.key), draft)
        XCTAssertEqual(store.latest(Self.key, lane: "task")?.taskId, "task-one")
    }
    func testMalformedItemCannotExecuteAndReceiptLanesRemainIndependent() throws {
        let store = InboxItemStore(transport: InboxItemFakeTransport()); let key = Self.key
        let bad = InboxItemContractTests.itemJSON.replacingOccurrences(of: #""intent":"mark_read""#, with: #""intent":"unknown_action""#)
        let item = try JSONDecoder().decode(InboxEmailItem.self, from: Data(bad.utf8))
        store.seed([item], letterId: key.letter)
        XCTAssertFalse(store.canBegin(key, action: item.actions[2]))
        let read = try Self.receipt(requestId: "read-request", intent: "mark_read")
        let task = try Self.receipt(requestId: "task-request", status: "failure")
        store.merge(.init(itemId: key.item, receipts: [read, task], currentTask: nil, readObservation: nil,
            restrictions: [], receipt: nil), key: key)
        XCTAssertEqual(store.latest(key, lane: "read")?.status, "success")
        XCTAssertEqual(store.latest(key, lane: "task")?.status, "failure")
    }
    func testPendingBeforeNetworkAndDoubleTapUsesOnlyOneRequest() async throws {
        let transport = InboxItemFakeTransport(); let store = InboxItemStore(transport: transport)
        let item = try InboxItemContractTests.item(); store.seed([item], letterId: Self.key.letter)
        let input = InboxFrozenInput(goal: "Review the update")
        let plan = await store.beginPrepare(Self.key, action: item.actions[2], input: input)
        XCTAssertNotNil(plan)
        let first = store.beginExecute(Self.key, plan: try XCTUnwrap(plan), input: input)
        XCTAssertNotNil(first)
        XCTAssertTrue(store.state(Self.key).busy.contains("task"))
        XCTAssertNil(store.beginExecute(Self.key, plan: try XCTUnwrap(plan), input: input))
        XCTAssertTrue(store.canBegin(Self.key, action: item.actions[0]))
        XCTAssertEqual(transport.executeCount, 0)
    }
    func testPlanRejectsArbitraryOperationAndWrongSource() throws {
        let item = try InboxItemContractTests.item(); let plan = try Self.plan()
        XCTAssertTrue(plan.isSafe(for: Self.key, source: item.source, action: item.actions[2]))
        XCTAssertFalse(plan.isSafe(for: Self.key, source: .init(kind: "mail", account: "other", message: "other"), action: item.actions[2]))
        let encoder = JSONEncoder()
        let json = String(data: try encoder.encode(plan), encoding: .utf8)!.replacingOccurrences(of: "task_start", with: "task_delete")
        let altered = try JSONDecoder().decode(InboxItemPlan.self, from: Data(json.utf8))
        XCTAssertFalse(altered.isSafe(for: Self.key, source: item.source, action: item.actions[2]))
    }
    func testPlanRequiresConfirmedHumanGoalAndReadSourceArguments() throws {
        let plan = try Self.plan()
        XCTAssertTrue(plan.matchesHumanInput(.init(goal: "  Review the update  ")))
        XCTAssertFalse(plan.matchesHumanInput(.init(goal: "Different goal")))
        let raw = String(data: try JSONEncoder().encode(plan), encoding: .utf8)!
        let wrongTargetJSON = raw.replacingOccurrences(of: #""id":"task-one""#, with: #""id":"other-task""#)
        let wrongTarget = try JSONDecoder().decode(InboxItemPlan.self, from: Data(wrongTargetJSON.utf8))
        XCTAssertFalse(wrongTarget.isSafe(for: Self.key, source: plan.source, action: try InboxItemContractTests.item().actions[2]))
        let retryJSON = raw.replacingOccurrences(of: "\"input\":{", with: "\"input\":{\"retryStart\":true,")
        let retry = try JSONDecoder().decode(InboxItemPlan.self, from: Data(retryJSON.utf8))
        let action = try InboxItemContractTests.item().actions[2]
        XCTAssertFalse(retry.isSafe(for: Self.key, source: retry.source, action: action), "retry must not create another task")
        let item = try InboxItemContractTests.item()
        let readJSON = """
        {"id":"read-plan","version":1,"actionId":"read-one","intent":"mark_read","letterId":"letter-one","itemId":"mail-one",
        "source":{"kind":"mail","account":"account-one","message":"message-one"},"input":{},
        "ops":[{"tool":"mail_mark_read","args":{"account":"account-two","messages":["message-one"],"read":true}}],
        "createdAt":"2026-10-21T10:00:00Z","expiresAt":"2099-10-21T10:00:00Z"}
        """
        let read = try JSONDecoder().decode(InboxItemPlan.self, from: Data(readJSON.utf8))
        XCTAssertFalse(read.isSafe(for: Self.key, source: item.source, action: item.actions[0]))
    }
    func testExecutionWireRequestContainsOnlyPlanReference() throws {
        let request = InboxItemExecuteRequest(actionId: "action-one", requestId: "request-one", confirmed: true, planId: "plan-one", planVersion: 1)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), Set(["actionId", "requestId", "confirmed", "planId", "planVersion"]))
    }
    func testRecoveryMatchesIntentAndKeepsFrozenInputAcrossLetters() throws {
        let item = try InboxItemContractTests.item()
        let receipt = try Self.replacing(Self.receipt(status: "failure"), fields: ["recovery": ["retry_start"],
            "actionId": "create-from-another-letter", "input": ["goal": "Keep the confirmed goal", "title": "Saved title", "project": "", "selectedTaskId": "task-one"]])
        XCTAssertEqual(InboxItemStore.recoveryAction(receipt, item: item)?.id, "create-one")
        let store = InboxItemStore(transport: InboxItemFakeTransport()); store.seed([item], letterId: Self.key.letter)
        XCTAssertEqual(store.recoveryDraft(Self.key, receipt: receipt, item: item)?.id, "create-one")
        XCTAssertEqual(store.draft(Self.key).input.goal, receipt.input.goal)
        XCTAssertEqual(store.draft(Self.key).input.selectedTaskId, receipt.input.selectedTaskId)
        XCTAssertEqual(store.draft(Self.key).input.title, receipt.input.title)
        XCTAssertTrue(store.draft(Self.key).input.retryStart == true)
        XCTAssertEqual(store.state(Self.key).source, item.source)
        let attach = try Self.replacing(receipt, fields: ["intent": "attach_task", "actionId": "attach-other"])
        XCTAssertEqual(InboxItemStore.recoveryAction(attach, item: item)?.id, "find-one")
        let wrongId = try Self.replacing(receipt, fields: ["actionId": "find-one"])
        XCTAssertEqual(InboxItemStore.recoveryAction(wrongId, item: item)?.id, "create-one")
    }
    func testFailedCreatePreparesOnlyStartOnTheExistingExactTask() async throws {
        let item = try InboxItemContractTests.item(); let fake = InboxItemFakeTransport()
        let store = InboxItemStore(transport: fake); store.seed([item], letterId: Self.key.letter)
        let receipt = try Self.replacing(Self.receipt(status: "failure"), fields: ["actionId": "create-from-another-letter", "execution": "not_started", "taskCreated": true, "recovery": ["retry_start"]])
        let action = try XCTUnwrap(store.recoveryDraft(Self.key, receipt: receipt, item: item))
        let input = store.draft(Self.key).input
        let plan = try Self.replacing(Self.plan(), fields: ["input": ["goal": "Review the update", "retryStart": true],
            "ops": [["tool": "task_start", "args": ["id": "task-one"]]],
            "task": ["id": "task-one", "title": "Saved task", "project": "", "phase": "TODO"]])
        fake.prepareResponse = .init(plan: plan, projects: [], source: receipt.source, existingWork: nil, restrictions: [], receipts: [receipt], currentTask: nil)
        let prepared = await store.beginPrepare(Self.key, action: action, input: input)
        XCTAssertEqual(fake.preparedInput?.actionId, "create-one"); XCTAssertTrue(fake.preparedInput?.retryStart == true)
        XCTAssertEqual(prepared?.taskId, receipt.taskId)
        XCTAssertEqual(prepared?.ops.map(\.tool), ["task_start"])
        XCTAssertEqual(prepared?.source, item.source)
        XCTAssertNotNil(store.beginExecute(Self.key, plan: try XCTUnwrap(prepared), input: input))
    }
    func testActionDraftsKeepCancelledGoalsWithoutBleedingSelectedTarget() throws {
        let store = InboxItemStore(transport: InboxItemFakeTransport()); let item = try InboxItemContractTests.item()
        store.seed([item], letterId: Self.key.letter)
        store.activateDraft(Self.key, action: item.actions[1])
        var attached = store.draft(Self.key)
        attached.input.goal = "Attach goal only"; attached.query = "Review"; attached.listAnchor = "target-a"
        attached.selected = .init(id: "target-a", title: "Target A", project: "", phase: "TODO")
        attached.input.selectedTaskId = "target-a"; store.setDraft(attached, key: Self.key)
        store.activateDraft(Self.key, action: item.actions[1])
        XCTAssertEqual(store.draft(Self.key), attached)
        store.activateDraft(Self.key, action: item.actions[2])
        XCTAssertNil(store.draft(Self.key).selected); XCTAssertNil(store.draft(Self.key).input.selectedTaskId)
        XCTAssertNil(store.draft(Self.key).input.goal)
        var created = store.draft(Self.key); created.input.goal = "Create goal only"
        store.setDraft(created, key: Self.key)
        store.activateDraft(Self.key, action: item.actions[1]); XCTAssertEqual(store.draft(Self.key), attached)
        store.activateDraft(Self.key, action: item.actions[2]); XCTAssertEqual(store.draft(Self.key), created)
        let otherKey = InboxItemStore.Key(letter: Self.key.letter, item: "mail-two")
        store.activateDraft(otherKey, action: item.actions[2]); XCTAssertNil(store.draft(otherKey).input.goal)
    }
    func testLatePreparationCannotRestoreAnotherActionsPlan() async throws {
        let fake = InboxItemFakeTransport(); fake.holdPrepare = true
        let store = InboxItemStore(transport: fake); let item = try InboxItemContractTests.item()
        store.seed([item], letterId: Self.key.letter); store.activateDraft(Self.key, action: item.actions[2])
        let pending = Task { await store.beginPrepare(Self.key, action: item.actions[2], input: .init(goal: "Review the update")) }
        for _ in 0..<500 where fake.prepareGate == nil { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotNil(fake.prepareGate)
        store.activateDraft(Self.key, action: item.actions[1])
        fake.prepareGate?.resume(); fake.prepareGate = nil
        let result = await pending.value
        XCTAssertNil(result); XCTAssertNil(store.state(Self.key).plan)
        XCTAssertNil(store.draft(Self.key).input.goal)
    }
    func testAIQuestionsHaveIndependentSuccessPendingAndUnknownLanes() async throws {
        let item = try Self.aiItem(); let fake = InboxItemFakeTransport(); fake.failExecute = true
        let store = InboxItemStore(transport: fake); store.seed([item], letterId: Self.key.letter)
        let first = try Self.aiPlan("ask-one")
        fake.prepareResponse = .init(plan: first, projects: [], source: try XCTUnwrap(item.source), existingWork: nil, restrictions: [], receipts: [], currentTask: nil)
        let prepared = await store.beginPrepare(Self.key, action: item.actions[0], input: .init())
        let request = try XCTUnwrap(store.beginExecute(Self.key, plan: try XCTUnwrap(prepared), input: .init()))
        XCTAssertFalse(store.canBegin(Self.key, action: item.actions[0]))
        XCTAssertTrue(store.canBegin(Self.key, action: item.actions[1]))
        await store.deliver(Self.key, request: request, lane: "ai:ask-one")
        XCTAssertTrue(store.state(Self.key).unknown.contains("ai:ask-one"))
        XCTAssertTrue(store.canBegin(Self.key, action: item.actions[1]))
        let success = try Self.replacing(Self.receipt(requestId: request.requestId, intent: "reply_ai"), fields: ["actionId": "ask-one", "delivery": "queued"])
        store.merge(.init(itemId: Self.key.item, receipts: [success], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: Self.key)
        XCTAssertFalse(store.canBegin(Self.key, action: item.actions[0]))
        XCTAssertTrue(store.canBegin(Self.key, action: item.actions[1]))
        XCTAssertEqual(store.latest(Self.key, action: item.actions[0])?.requestId, request.requestId)
        XCTAssertNil(store.latest(Self.key, action: item.actions[1]))
        let pending = try Self.replacing(Self.receipt(requestId: "ask-two-request", status: "pending", intent: "reply_ai"), fields: ["actionId": "ask-two"])
        store.merge(.init(itemId: Self.key.item, receipts: [pending], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: Self.key)
        XCTAssertFalse(store.canBegin(Self.key, action: item.actions[1]))
    }
    func testExpiredPlanReportsErrorAndAllowsReviewWithoutWriting() async throws {
        let fake = InboxItemFakeTransport(); let item = try InboxItemContractTests.item()
        let expired = try Self.replacing(Self.plan(), fields: ["expiresAt": "2000-01-01T00:00:00Z"])
        fake.prepareResponse = .init(plan: expired, projects: [], source: try XCTUnwrap(item.source), existingWork: nil, restrictions: [], receipts: [], currentTask: nil)
        let store = InboxItemStore(transport: fake); store.seed([item], letterId: Self.key.letter)
        let input = InboxFrozenInput(goal: "Review the update")
        let prepared = await store.beginPrepare(Self.key, action: item.actions[2], input: input)
        XCTAssertNil(store.beginExecute(Self.key, plan: try XCTUnwrap(prepared), input: input))
        XCTAssertEqual(store.state(Self.key).error, "This plan expired. Review the action again.")
        XCTAssertNil(store.state(Self.key).plan); XCTAssertEqual(fake.executeCount, 0)
        fake.prepareResponse = nil
        let fresh = await store.beginPrepare(Self.key, action: item.actions[2], input: input)
        XCTAssertNotNil(store.beginExecute(Self.key, plan: try XCTUnwrap(fresh), input: input))
    }
    func testExpiryIgnoresOldPlanTimerAndSubmittedPlan() async throws {
        let store = InboxItemStore(transport: InboxItemFakeTransport()); let item = try InboxItemContractTests.item()
        store.seed([item], letterId: Self.key.letter)
        let input = InboxFrozenInput(goal: "Review the update")
        let prepared = await store.beginPrepare(Self.key, action: item.actions[2], input: input)
        let plan = try XCTUnwrap(prepared)
        let future = try XCTUnwrap(InboxItemDate.parse("2100-01-01T00:00:00Z"))
        store.expirePlan(Self.key, planId: "different-plan", at: future)
        XCTAssertEqual(store.state(Self.key).plan, plan)
        XCTAssertNotNil(store.beginExecute(Self.key, plan: plan, input: input))
        store.expirePlan(Self.key, planId: plan.id, at: future)
        XCTAssertEqual(store.state(Self.key).plan, plan)
    }
    func testEditingGoalClearsOnlyTheOutdatedGoalRequirement() async throws {
        let fake = InboxItemFakeTransport(); let item = try InboxItemContractTests.item()
        let store = InboxItemStore(transport: fake); store.seed([item], letterId: Self.key.letter)
        store.activateDraft(Self.key, action: item.actions[2])
        let message = "Add a work goal before continuing."
        fake.prepareResponse = .init(plan: nil, projects: [], source: try XCTUnwrap(item.source), existingWork: nil,
            restrictions: [.init(code: "goal_required", message: message)], receipts: [], currentTask: nil)
        _ = await store.beginPrepare(Self.key, action: item.actions[2], input: .init())
        XCTAssertEqual(store.state(Self.key).error, message)
        var draft = store.draft(Self.key); draft.input.goal = "Review this update"; store.setDraft(draft, key: Self.key)
        XCTAssertNil(store.state(Self.key).error)
        XCTAssertFalse(store.state(Self.key).restrictions.contains { $0.code == "goal_required" })
        fake.prepareResponse = .init(plan: nil, projects: [], source: try XCTUnwrap(item.source), existingWork: nil,
            restrictions: [.init(code: "source_conflict", message: "Source already linked")], receipts: [], currentTask: nil)
        _ = await store.beginPrepare(Self.key, action: item.actions[2], input: draft.input)
        draft.input.goal = "Review this update carefully"; store.setDraft(draft, key: Self.key)
        XCTAssertEqual(store.state(Self.key).error, "Source already linked")
        XCTAssertTrue(store.state(Self.key).restrictions.contains { $0.code == "source_conflict" })
    }
    func testExistingSourceTaskSendRequiresExactTaskAndHumanGoal() throws {
        let item = try InboxItemContractTests.item()
        let send = try Self.replacing(Self.plan(), fields: ["ops": [["tool": "task_send", "args": ["to": "task-one"]]],
            "task": ["id": "task-one", "title": "Existing task", "project": "", "phase": "TODO"]])
        XCTAssertTrue(send.isSafe(for: Self.key, source: item.source, action: item.actions[2]))
        XCTAssertTrue(send.matchesHumanInput(.init(goal: "Review the update")))
        XCTAssertFalse(send.matchesHumanInput(.init(goal: "Another goal")))
        let wrongId = try Self.replacing(send, fields: ["ops": [["tool": "task_send", "args": ["to": "other-task"]]]])
        XCTAssertFalse(wrongId.isSafe(for: Self.key, source: item.source, action: item.actions[2]))
        let wrongTask = try Self.replacing(send, fields: ["task": ["id": "other-task", "title": "Other", "project": "", "phase": "TODO"]])
        XCTAssertFalse(wrongTask.isSafe(for: Self.key, source: item.source, action: item.actions[2]))
        let emptyGoal = try Self.replacing(send, fields: ["input": ["goal": " "]])
        XCTAssertFalse(emptyGoal.isSafe(for: Self.key, source: item.source, action: item.actions[2]))
        let retry = try Self.replacing(send, fields: ["input": ["goal": "Review the update", "retryStart": true]])
        XCTAssertFalse(retry.isSafe(for: Self.key, source: item.source, action: item.actions[2]))
    }
    func testAliasedReceiptSettlesOnlyItsExactUnknownRequest() async throws {
        let fake = InboxItemFakeTransport(); fake.failExecute = true
        let store = InboxItemStore(transport: fake); let item = try InboxItemContractTests.item()
        store.seed([item], letterId: Self.key.letter)
        let input = InboxFrozenInput(goal: "Review the update")
        let plan = await store.beginPrepare(Self.key, action: item.actions[2], input: input)
        let request = try XCTUnwrap(store.beginExecute(Self.key, plan: try XCTUnwrap(plan), input: input))
        await store.deliver(Self.key, request: request, lane: "task")
        let older = try Self.replacing(Self.receipt(requestId: "canonical-request"), fields: ["requestIds": ["different-request"]])
        store.merge(.init(itemId: Self.key.item, receipts: [older], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: Self.key)
        XCTAssertTrue(store.state(Self.key).unknown.contains("task"))
        let aliased = try Self.replacing(older, fields: ["revision": 2, "requestIds": [request.requestId]])
        store.merge(.init(itemId: Self.key.item, receipts: [aliased], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: Self.key)
        XCTAssertFalse(store.state(Self.key).unknown.contains("task")); XCTAssertNil(store.state(Self.key).unknownRequests["task"])
        store.merge(.init(itemId: Self.key.item, receipts: [older], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: Self.key)
        XCTAssertEqual(store.latest(Self.key, lane: "task")?.requestIds, [request.requestId])
    }
    func testEraseCancelsOldQueryAndDiscardsLatePrepareWithoutRestoringDrafts() async throws {
        let item = try InboxItemContractTests.item(); let fake = InboxItemFakeTransport()
        fake.holdPrepare = true; fake.holdQuery = true
        fake.queryResponse = .init(itemId: Self.key.item, receipts: [try Self.receipt()], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil)
        let store = InboxItemStore(transport: fake); store.seed([item], letterId: Self.key.letter)
        store.activateDraft(Self.key, action: item.actions[2])
        var draft = store.draft(Self.key); draft.input.goal = "Private old goal"; store.setDraft(draft, key: Self.key)
        let prepared = Task { await store.beginPrepare(Self.key, action: item.actions[2], input: .init(goal: "Review the update")) }
        let query = Task { await store.query(Self.key) }
        for _ in 0..<500 where fake.prepareGate == nil || fake.queryGate == nil { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotNil(fake.prepareGate); XCTAssertNotNil(fake.queryGate)
        store.eraseAll(); store.seed([item], letterId: Self.key.letter)
        fake.prepareGate?.resume(); fake.prepareGate = nil; fake.queryGate?.resume(); fake.queryGate = nil
        let result = await prepared.value; await query.value
        XCTAssertNil(result); XCTAssertTrue(store.state(Self.key).receipts.isEmpty)
        XCTAssertNil(store.state(Self.key).plan); XCTAssertNil(store.draft(Self.key).input.goal)
        store.activateDraft(Self.key, action: item.actions[2]); XCTAssertNil(store.draft(Self.key).input.goal)
    }
    func testEraseDiscardsLateExecuteAndDoesNotDeliverOldQueuedRequest() async throws {
        let fake = InboxItemFakeTransport(); let item = try InboxItemContractTests.item()
        let store = InboxItemStore(transport: fake); store.seed([item], letterId: Self.key.letter)
        let input = InboxFrozenInput(goal: "Review the update")
        let prepared = await store.beginPrepare(Self.key, action: item.actions[2], input: input)
        let request = try XCTUnwrap(store.beginExecute(Self.key, plan: try XCTUnwrap(prepared), input: input))
        fake.holdExecute = true
        let execution = Task { await store.deliver(Self.key, request: request, lane: "task") }
        for _ in 0..<500 where fake.executeGate == nil { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotNil(fake.executeGate)
        store.eraseAll(); store.seed([item], letterId: Self.key.letter)
        fake.executeGate?.resume(); fake.executeGate = nil; await execution.value
        XCTAssertTrue(store.state(Self.key).receipts.isEmpty); XCTAssertTrue(store.state(Self.key).submittedPlans.isEmpty)
        XCTAssertTrue(store.state(Self.key).unknownRequests.isEmpty); XCTAssertTrue(store.state(Self.key).busy.isEmpty)
        await store.deliver(Self.key, request: request, lane: "task")
        XCTAssertEqual(fake.executeCount, 1)
    }
    func testFailedReadAllowsOnlyAnExplicitReadRetryWhileAnotherLaneStaysAvailable() throws {
        let item = try InboxItemContractTests.item(); let store = InboxItemStore(transport: InboxItemFakeTransport())
        store.seed([item], letterId: Self.key.letter)
        let receipt = try Self.replacing(Self.receipt(status: "failure", intent: "mark_read"), fields: ["actionId": "read-one", "code": "read_unconfirmed", "recovery": ["check_status", "retry_mark_read"]])
        store.merge(.init(itemId: Self.key.item, receipts: [receipt], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: Self.key)
        XCTAssertTrue(receipt.canRetryRead); XCTAssertTrue(store.canBegin(Self.key, action: item.actions[0]))
        XCTAssertTrue(store.canBegin(Self.key, action: item.actions[2]))
        let pending = try Self.replacing(receipt, fields: ["status": "pending", "revision": 2])
        store.merge(.init(itemId: Self.key.item, receipts: [pending], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: Self.key)
        XCTAssertFalse(store.canBegin(Self.key, action: item.actions[0]))
    }
    func testUnconfirmedStartRequiresRecoveryReviewAndDoesNotUnlockAnOrdinaryAction() throws {
        let item = try InboxItemContractTests.item(); let store = InboxItemStore(transport: InboxItemFakeTransport())
        store.seed([item], letterId: Self.key.letter)
        let receipt = try Self.replacing(Self.receipt(status: "failure"), fields: ["execution": "unconfirmed", "code": "start_recovery_required", "recovery": ["check_status", "retry_start", "open_task"]])
        store.merge(.init(itemId: Self.key.item, receipts: [receipt], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: Self.key)
        XCTAssertTrue(receipt.needsQuery); XCTAssertTrue(receipt.canReviewStartRecovery)
        XCTAssertFalse(store.canBegin(Self.key, action: item.actions[2]))
        XCTAssertEqual(store.recoveryDraft(Self.key, receipt: receipt, item: item)?.id, item.actions[2].id)
        XCTAssertTrue(store.canBegin(Self.key, action: item.actions[2]))
        XCTAssertTrue(store.draft(Self.key).input.retryStart == true)
        let unknown = try Self.replacing(receipt, fields: ["code": "other_unknown", "revision": 2])
        store.merge(.init(itemId: Self.key.item, receipts: [unknown], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: Self.key)
        XCTAssertFalse(store.canBegin(Self.key, action: item.actions[2]))
    }
    func testReservedCreateRetryKeepsSourceAndDoesNotClaimTaskExists() throws {
        let item = try InboxItemContractTests.item(); let store = InboxItemStore(transport: InboxItemFakeTransport())
        store.seed([item], letterId: Self.key.letter)
        let receipt = try Self.replacing(Self.receipt(status: "failure"), fields: ["taskCreated": false, "execution": "not_started", "recovery": ["retry_create"],
            "input": ["goal": "Review the update", "title": "Reserved title", "project": "", "retryStart": true]])
        XCTAssertFalse(receipt.hasCreatedTask); XCTAssertEqual(receipt.label, "Could not create task")
        XCTAssertEqual(store.recoveryDraft(Self.key, receipt: receipt, item: item)?.id, "create-one")
        XCTAssertEqual(store.draft(Self.key).input.goal, receipt.input.goal)
        XCTAssertEqual(store.draft(Self.key).input.title, receipt.input.title)
        XCTAssertNil(store.draft(Self.key).input.retryStart)
        XCTAssertEqual(store.state(Self.key).source, receipt.source)
        let created = try Self.replacing(receipt, fields: ["taskCreated": true])
        XCTAssertTrue(created.hasCreatedTask); XCTAssertEqual(created.label, "Task created. Could not start.")
        XCTAssertTrue(try Self.receipt().hasCreatedTask)
    }
    func testChangedGoalInvalidatesPreparedPlan() async throws {
        let store = InboxItemStore(transport: InboxItemFakeTransport()); let item = try InboxItemContractTests.item()
        store.seed([item], letterId: Self.key.letter)
        let input = InboxFrozenInput(goal: "Review the update")
        let plan = await store.beginPrepare(Self.key, action: item.actions[2], input: input)
        var draft = store.draft(Self.key); draft.input.goal = "Different goal"; store.setDraft(draft, key: Self.key)
        XCTAssertNil(store.beginExecute(Self.key, plan: try XCTUnwrap(plan), input: input))
    }
}
