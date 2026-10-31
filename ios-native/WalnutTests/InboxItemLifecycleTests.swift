import XCTest
@testable import Walnut

@MainActor final class InboxItemLifecycleTests: XCTestCase {
    func testUnknownExecuteOnlyQueriesAndKeepsOriginalRequest() async throws {
        let fake = InboxItemFakeTransport(); fake.failExecute = true
        let store = InboxItemStore(transport: fake); let item = try InboxItemContractTests.item(); let key = InboxItemStoreTests.key
        store.seed([item], letterId: key.letter)
        let input = InboxFrozenInput(goal: "Review the update")
        let prepared = await store.beginPrepare(key, action: item.actions[2], input: input)
        let plan = try XCTUnwrap(prepared)
        let request = try XCTUnwrap(store.beginExecute(key, plan: plan, input: input))
        await store.deliver(key, request: request, lane: "task")
        XCTAssertEqual(fake.executeCount, 1)
        XCTAssertTrue(store.state(key).unknown.contains("task"))
        await store.query(key)
        XCTAssertEqual(fake.executeCount, 1)
        XCTAssertTrue(store.state(key).unknown.contains("task"), "an empty query is not proof that the request was not accepted")
        store.merge(.init(itemId: key.item, receipts: [try InboxItemStoreTests.receipt(requestId: "older-request")], currentTask: nil,
            readObservation: nil, restrictions: [], receipt: nil), key: key)
        XCTAssertTrue(store.state(key).unknown.contains("task"), "an older receipt must not clear a newer unknown request")
        store.merge(.init(itemId: key.item, receipts: [try InboxItemStoreTests.receipt(requestId: request.requestId)], currentTask: nil,
            readObservation: nil, restrictions: [], receipt: nil), key: key)
        XCTAssertFalse(store.state(key).unknown.contains("task"))
        XCTAssertNil(store.beginExecute(key, plan: plan, input: input), "a settled plan cannot be re-executed")
    }
    func testExplicitStalePlanRefusalAllowsReviewWithoutBlindReplay() async throws {
        let fake = InboxItemFakeTransport()
        fake.executionError = APIError.server(status: 409, code: "plan_changed", message: "This task changed. Review the action again.", serverHash: nil, serverContent: nil)
        let store = InboxItemStore(transport: fake); let item = try InboxItemContractTests.item(); let key = InboxItemStoreTests.key
        store.seed([item], letterId: key.letter)
        let input = InboxFrozenInput(goal: "Review the update")
        let prepared = await store.beginPrepare(key, action: item.actions[2], input: input)
        let request = try XCTUnwrap(store.beginExecute(key, plan: try XCTUnwrap(prepared), input: input))
        await store.deliver(key, request: request, lane: "task")
        XCTAssertTrue(store.state(key).unknown.isEmpty)
        XCTAssertNil(store.state(key).plan)
        XCTAssertTrue(store.canBegin(key, action: item.actions[2]))
        XCTAssertEqual(fake.executeCount, 1)
    }
    func testQueryFailureKeepsLastReceiptAndDraft() async throws {
        let fake = InboxItemFakeTransport(); fake.failQuery = true
        let store = InboxItemStore(transport: fake); let key = InboxItemStoreTests.key
        store.seed([try InboxItemContractTests.item()], letterId: key.letter)
        let receipt = try InboxItemStoreTests.receipt()
        store.merge(.init(itemId: key.item, receipts: [receipt], currentTask: nil, readObservation: nil, restrictions: [], receipt: nil), key: key)
        var draft = store.draft(key); draft.input.goal = "Keep this goal"; store.setDraft(draft, key: key)
        await store.query(key)
        XCTAssertEqual(store.state(key).receipts, [receipt])
        XCTAssertEqual(store.draft(key).input.goal, "Keep this goal")
        XCTAssertTrue(store.state(key).stale)
    }
    func testBackgroundStopsQueriesAndWrites() async throws {
        let fake = InboxItemFakeTransport(); let store = InboxItemStore(transport: fake); let key = InboxItemStoreTests.key
        let item = try InboxItemContractTests.item(); store.seed([item], letterId: key.letter)
        store.suspendForBackground()
        await store.query(key)
        XCTAssertEqual(fake.queryCount, 0)
        XCTAssertFalse(store.canBegin(key, action: item.actions[2]))
        store.resumeForForeground()
        await store.query(key)
        XCTAssertEqual(fake.queryCount, 1)
    }
    func testMirrorAndLocalOnlyAreReadOnlyWithoutDroppingHistory() async throws {
        let store = InboxItemStore(transport: InboxItemFakeTransport()); let key = InboxItemStoreTests.key
        let item = try InboxItemContractTests.item(); store.seed([item], letterId: key.letter)
        let letter = try JSONDecoder().decode(Letter.self, from: Data(#"{"id":"letter-one","subject":"Digest","type":"info"}"#.utf8))
        store.setAccess(letterId: key.letter, response: .init(letter: letter, servedFrom: "mirror"))
        XCTAssertFalse(store.canBegin(key, action: item.actions[2]))
        store.setAccess(letterId: key.letter, response: .init(letter: letter, capabilities: .init(itemActions: true, markRead: "local_only")))
        XCTAssertEqual(store.markReadRestriction(key), "Available on Mac only")
        XCTAssertFalse(store.canBegin(key, action: item.actions[0]))
        XCTAssertTrue(store.canBegin(key, action: item.actions[2]))
    }
    func testTaskPrepareDoesNotErasePhoneMailRestriction() async throws {
        let store = InboxItemStore(transport: InboxItemFakeTransport()); let key = InboxItemStoreTests.key
        let item = try InboxItemContractTests.item(); store.seed([item], letterId: key.letter)
        store.merge(.init(itemId: key.item, receipts: [], currentTask: nil, readObservation: nil,
            restrictions: [.init(code: "local_only", message: "Local only")], receipt: nil), key: key)
        _ = await store.beginPrepare(key, action: item.actions[2], input: .init(goal: "Review the update"))
        XCTAssertEqual(store.markReadRestriction(key), "Available on Mac only")
        XCTAssertFalse(store.canBegin(key, action: item.actions[0]))
    }
    func testConcurrentQueriesShareOneRequestAndBackgroundRejectsLateResponse() async throws {
        let fake = InboxItemFakeTransport(); fake.holdQuery = true
        let store = InboxItemStore(transport: fake); let key = InboxItemStoreTests.key
        store.seed([try InboxItemContractTests.item()], letterId: key.letter)
        fake.queryResponse = .init(itemId: key.item, receipts: [try InboxItemStoreTests.receipt()], currentTask: nil,
            readObservation: nil, restrictions: [], receipt: nil)
        let first = Task { await store.query(key) }
        let second = Task { await store.query(key) }
        for _ in 0..<500 where fake.queryGate == nil { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(fake.queryCount, 1)
        store.suspendForBackground()
        fake.queryGate?.resume(); fake.queryGate = nil
        await first.value; await second.value
        XCTAssertTrue(store.state(key).receipts.isEmpty)
        fake.holdQuery = false; store.resumeForForeground()
        await store.query(key)
        XCTAssertEqual(fake.queryCount, 2)
        XCTAssertEqual(store.state(key).receipts.count, 1)
        XCTAssertEqual(InboxItemStore.pendingQueryDelays.reduce(0, +), 30)
    }
    func testCurrentStatusTimestampUsesTimeNotStringOrderAndFailureKeepsHistory() async throws {
        let fake = InboxItemFakeTransport(); let store = InboxItemStore(transport: fake); let key = InboxItemStoreTests.key
        store.seed([try InboxItemContractTests.item()], letterId: key.letter)
        let receipt = try InboxItemStoreTests.receipt()
        let recent = InboxCurrentTaskStatus(taskId: "task-one", phase: "COMPLETE", status: "completed",
            observedAt: "2026-10-21T11:00:00+01:00", sessionId: nil, reason: nil)
        let older = InboxCurrentTaskStatus(taskId: "task-one", phase: "IN_PROGRESS", status: "running",
            observedAt: "2026-10-21T09:59:00Z", sessionId: nil, reason: nil)
        for status in [recent, older] {
            store.merge(.init(itemId: key.item, receipts: [receipt], currentTask: status, readObservation: nil,
                restrictions: [], receipt: nil), key: key)
        }
        XCTAssertEqual(store.state(key).currentTask, recent)
        fake.failQuery = true; await store.query(key)
        XCTAssertTrue(store.state(key).currentTaskStale)
        XCTAssertEqual(store.state(key).currentTask, recent)
        XCTAssertEqual(store.latest(key, lane: "task"), receipt)
    }
    func testStartedHistoryDoesNotClaimCurrentRunning() throws {
        let receipt = try InboxItemStoreTests.receipt()
        XCTAssertTrue(receipt.label.hasPrefix("Started at"))
        XCTAssertFalse(receipt.label.contains("Running"))
    }
}
