import XCTest
@testable import Walnut

/// UNIT-LAYER tests (pure logic, no store I/O beyond MainActor state, no
/// network): the tier split → taskId map join, tier label resolution, and the
/// row badge derivation that Item 1 (pin shows WHERE it's pinned) rides on.
@MainActor
final class FocusTierTests: XCTestCase {

    private func makeTask(_ id: String, pinned: Bool? = nil, done: Bool = false) -> WalnutTask {
        WalnutTask(
            id: id, title: "t", status: done ? "done" : "todo", phase: done ? "COMPLETE" : "TODO",
            priority: "none", project: "", dueDate: nil,
            createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z",
            completedAt: nil, starred: nil, pinned: pinned, tags: nil, summary: nil
        )
    }

    private func split(
        pinned: [String], focus: [String] = [], satellite: [String] = [],
        backlog: [String] = [], wait: [String] = [], custom: [String: [String]] = [:]
    ) -> FocusTierResult {
        FocusTierResult(
            pinnedTasks: pinned, focusTasks: focus, satelliteTasks: satellite,
            backlogTasks: backlog, waitTasks: wait, customTierTasks: custom
        )
    }

    // MARK: - tierMap join

    func testTierMapJoinsAllBuckets() {
        let map = TasksStore.tierMap(from: split(
            pinned: ["a", "b", "c", "d", "e"],
            focus: ["a"], satellite: ["b"], backlog: ["c"], wait: ["d"],
            custom: ["ct_abc12345": ["e"]]
        ))
        XCTAssertEqual(map["a"], "focus")
        XCTAssertEqual(map["b"], "satellite")
        XCTAssertEqual(map["c"], "backlog")
        XCTAssertEqual(map["d"], "wait")
        XCTAssertEqual(map["e"], "ct_abc12345")
    }

    /// The server omits bucket arrays it considers empty (all-optional wire
    /// contract) and satellite is "not in any explicit bucket" by definition.
    func testTierMapDefaultsUnbucketedPinnedIdsToSatellite() {
        let map = TasksStore.tierMap(from: FocusTierResult(
            pinnedTasks: ["a", "b"], focusTasks: ["a"], satelliteTasks: nil,
            backlogTasks: nil, waitTasks: nil, customTierTasks: nil
        ))
        XCTAssertEqual(map["a"], "focus")
        XCTAssertEqual(map["b"], "satellite", "pinned but unbucketed = the default tier")
    }

    func testTierMapEmptySplitIsEmpty() {
        XCTAssertTrue(TasksStore.tierMap(from: split(pinned: [])).isEmpty)
    }

    // MARK: - Labels

    func testTierLabelsBuiltinsAndCustoms() {
        let store = TasksStore(transport: MockTaskTransport())
        store.customTiers = [FocusTierInfo(id: "ct_abc12345", label: "Deep Work")]
        XCTAssertEqual(store.tierLabel(for: "focus"), "Focus")
        XCTAssertEqual(store.tierLabel(for: "satellite"), "Satellite")
        XCTAssertEqual(store.tierLabel(for: "backlog"), "Backlog")
        XCTAssertEqual(store.tierLabel(for: "wait"), "Wait")
        XCTAssertEqual(store.tierLabel(for: "ct_abc12345"), "Deep Work")
        // Unknown/stale ct id must never leak a raw id into the UI.
        XCTAssertEqual(store.tierLabel(for: "ct_deleted99"), "Satellite")
    }

    // MARK: - Row badge derivation

    func testTierBadgeOnlyForPinnedRows() {
        let store = TasksStore(transport: MockTaskTransport())
        store.taskTiers = ["p1": "focus"]
        XCTAssertEqual(store.tierBadge(for: makeTask("p1", pinned: true)), "Focus")
        XCTAssertNil(store.tierBadge(for: makeTask("u1", pinned: nil)),
            "unpinned rows never show a tier badge")
        // Pinned but split not loaded yet → the server default, not nil.
        XCTAssertEqual(store.tierBadge(for: makeTask("p2", pinned: true)), "Satellite")
    }

    func testAllTierChoicesOrderBuiltinsFirst() {
        let store = TasksStore(transport: MockTaskTransport())
        store.customTiers = [FocusTierInfo(id: "ct_abc12345", label: "Deep Work")]
        XCTAssertEqual(
            store.allTierChoices.map(\.id),
            ["focus", "satellite", "backlog", "wait", "ct_abc12345"]
        )
    }

    // MARK: - loadFocusTiers (mock transport, same-value write skip)

    func testLoadFocusTiersAdoptsSplitAndRegistry() async {
        let mock = MockTaskTransport()
        mock.tierSplitResult = FocusTierResult(
            pinnedTasks: ["a"], focusTasks: ["a"], satelliteTasks: [],
            backlogTasks: [], waitTasks: [], customTierTasks: [:]
        )
        mock.customTiersResult = [FocusTierInfo(id: "ct_abc12345", label: "Deep Work")]
        let store = TasksStore(transport: mock)
        await store.loadFocusTiers()
        XCTAssertEqual(store.taskTiers, ["a": "focus"])
        XCTAssertEqual(store.customTiers.first?.label, "Deep Work")
    }

    // MARK: - Quick-add pin (applyPin: optimistic map + row flag + rollback)

    func testApplyPinWritesTierAndRowInstantlyAnnouncesWhere() async {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        store.tasks = [makeTask("t1", pinned: nil)]

        await store.applyPin(taskId: "t1", tier: "focus")
        XCTAssertEqual(store.tierId(for: "t1"), "focus")
        XCTAssertEqual(store.tasks[0].pinned, true, "row flag flips so the badge renders")
        XCTAssertEqual(store.transientNotice, "Pinned · Focus", "announces WHERE the pin landed")
        XCTAssertEqual(mock.callCount("pinTask"), 1)
        XCTAssertEqual(mock.callCount("setTaskFocusTier"), 1)
    }

    func testApplyPinRollsBackTierMapOnFailure() async {
        let mock = MockTaskTransport()
        mock.errorsByEndpoint["pinTask"] = APIError.badResponse
        let store = TasksStore(transport: mock)
        store.tasks = [makeTask("t1", pinned: nil)]

        await store.applyPin(taskId: "t1", tier: "focus")
        XCTAssertNil(store.tierId(for: "t1"), "failed pin must clear the optimistic tier")
        XCTAssertNil(store.transientNotice)
    }

    func testLoadFocusTiersFailureKeepsLastKnownMap() async {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        store.taskTiers = ["a": "focus"]
        mock.errorsByEndpoint["focusTasks"] = APIError.server(
            status: 404, code: "not_found", message: "old server",
            serverHash: nil, serverContent: nil
        )
        await store.loadFocusTiers()
        XCTAssertEqual(store.taskTiers, ["a": "focus"],
            "best-effort load must keep the last known tiers on failure")
    }
}
