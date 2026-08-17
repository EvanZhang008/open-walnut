import XCTest
@testable import Walnut

/// MOCK-LAYER tests (testing-ladder middle rung): the REAL TasksStore /
/// TaskDetailController mutation state machines against a scripted transport.
/// Every optimistic path asserts BOTH halves of the contract:
///   1. apply → the observed state flips BEFORE the request resolves
///      (gate-suspended transport), and
///   2. fail → revert: the exact original rows come back + an error message.
/// The pure projection halves (applyEdit, tierMap) live in EventsFeedTests /
/// FocusTierTests (unit rung); the live rung is the Maestro E2E flow.
@MainActor
final class OptimisticMutationTests: XCTestCase {

    private func makeTask(
        _ id: String, title: String = "t", status: String = "todo",
        pinned: Bool? = nil, updatedAt: String = "2026-08-16T00:00:00Z"
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: title, status: status, phase: "TODO",
            priority: "none", project: "", dueDate: nil,
            createdAt: "2026-08-16T00:00:00Z", updatedAt: updatedAt,
            completedAt: nil, starred: nil, pinned: pinned, tags: nil, summary: nil
        )
    }

    private func makeSession(_ id: String, title: String? = nil) -> WalnutSession {
        WalnutSession(
            id: id, title: title ?? "Session: demo — hi", taskId: nil, taskTitle: nil,
            project: nil, host: "", processStatus: "idle", model: nil, mode: nil,
            startedAt: "2026-08-16T00:00:00Z", lastActiveAt: "2026-08-16T00:00:00Z",
            messageCount: 1, cwd: nil, pinned: nil, focusTier: nil, description: nil
        )
    }

    private func makeStore(_ mock: MockTaskTransport) -> TasksStore {
        let store = TasksStore(transport: mock)
        return store
    }

    private let boom = APIError.server(
        status: 500, code: "internal", message: "server exploded",
        serverHash: nil, serverContent: nil
    )

    // MARK: - updateTask (status circle / rename / priority / due)

    /// Apply half: the row flips INSTANTLY while the PATCH is still hanging.
    func testUpdateTaskAppliesBeforeTransportResolves() async {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        let store = makeStore(mock)
        store.tasks = [makeTask("t1", status: "todo")]

        let patch = Task { try? await store.updateTask(id: "t1", edit: .init(status: "done")) }
        // Poll (≤2s) until the optimistic write lands — it happens before the
        // first suspension point inside the store, so this is quick.
        for _ in 0..<200 where store.tasks[0].status != "done" {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(store.tasks[0].status, "done",
            "status must flip optimistically while the PATCH is in flight")
        gate.open()
        _ = await patch.value
        XCTAssertEqual(store.tasks[0].status, "done")
    }

    /// Revert half: failure restores the original row and rethrows.
    func testUpdateTaskRevertsOnFailure() async {
        let mock = MockTaskTransport()
        mock.error = boom
        let store = makeStore(mock)
        let original = makeTask("t1", title: "old title", status: "todo")
        store.tasks = [original]

        do {
            _ = try await store.updateTask(id: "t1", edit: .init(title: "new title"))
            XCTFail("must rethrow")
        } catch { /* expected */ }
        XCTAssertEqual(store.tasks[0], original, "failed edit must restore the exact original row")
    }

    /// Rename is the same machine — assert the field specifically.
    func testTitleRenameOptimisticAndRevert() async {
        let mock = MockTaskTransport()
        mock.error = boom
        let store = makeStore(mock)
        store.tasks = [makeTask("t1", title: "before")]
        _ = try? await store.updateTask(id: "t1", edit: .init(title: "after"))
        XCTAssertEqual(store.tasks[0].title, "before")

        mock.error = nil
        _ = try? await store.updateTask(id: "t1", edit: .init(title: "after"))
        XCTAssertEqual(store.tasks[0].title, "after")
    }

    // MARK: - setPinned

    func testPinAppliesInstantlyAndSetsSatelliteTier() async {
        let mock = MockTaskTransport()
        let store = makeStore(mock)
        store.tasks = [makeTask("t1", pinned: nil)]

        let failure = await store.setPinned(store.tasks[0], pinned: true)
        XCTAssertNil(failure)
        XCTAssertEqual(store.tasks[0].pinned, true)
        XCTAssertEqual(store.tierId(for: "t1"), "satellite", "new pins land in the default tier")
        XCTAssertEqual(mock.callCount("pinTask"), 1)
        // No blocking list refetch on the success path (instant-first rule).
        XCTAssertEqual(mock.callCount("tasks"), 0)
    }

    func testPinRevertsOnFailure() async {
        let mock = MockTaskTransport()
        mock.errorsByEndpoint["pinTask"] = APIError.server(
            status: 409, code: "conflict", message: "Cannot pin a completed task",
            serverHash: nil, serverContent: nil
        )
        let store = makeStore(mock)
        store.tasks = [makeTask("t1", pinned: nil)]

        let failure = await store.setPinned(store.tasks[0], pinned: true)
        XCTAssertEqual(failure, "Completed tasks can't be pinned.")
        XCTAssertNotEqual(store.tasks[0].pinned, true, "failed pin must revert the flag")
        XCTAssertNil(store.tierId(for: "t1"), "failed pin must revert the tier map")
    }

    func testUnpinClearsTierAndRevertsOnFailure() async {
        let mock = MockTaskTransport()
        let store = makeStore(mock)
        store.tasks = [makeTask("t1", pinned: true)]
        store.taskTiers = ["t1": "focus"]

        // Success: tier entry cleared.
        let ok = await store.setPinned(store.tasks[0], pinned: false)
        XCTAssertNil(ok)
        XCTAssertNil(store.tierId(for: "t1"))

        // Failure: pinned flag AND tier entry restored.
        store.tasks = [makeTask("t1", pinned: true)]
        store.taskTiers = ["t1": "focus"]
        mock.errorsByEndpoint["unpinTask"] = boom
        let failure = await store.setPinned(store.tasks[0], pinned: false)
        XCTAssertNotNil(failure)
        XCTAssertEqual(store.tasks[0].pinned, true)
        XCTAssertEqual(store.tierId(for: "t1"), "focus")
    }

    // MARK: - setTier

    func testTierMoveOptimisticThenAdoptsServerSplit() async {
        let mock = MockTaskTransport()
        mock.tierSplitResult = FocusTierResult(
            pinnedTasks: ["t1"], focusTasks: ["t1"], satelliteTasks: [],
            backlogTasks: [], waitTasks: [], customTierTasks: [:]
        )
        let store = makeStore(mock)
        store.tasks = [makeTask("t1", pinned: true)]
        store.taskTiers = ["t1": "satellite"]

        let moveResult = await store.setTier(taskId: "t1", tier: "focus")
        XCTAssertNil(moveResult)
        XCTAssertEqual(store.tierId(for: "t1"), "focus")
        XCTAssertEqual(mock.calls.last, .init(name: "setTaskFocusTier", args: ["t1", "focus"]))
    }

    func testTierMoveRevertsOnFailure() async {
        let mock = MockTaskTransport()
        mock.errorsByEndpoint["setTaskFocusTier"] = APIError.server(
            status: 400, code: "bad_request", message: "Task is not pinned",
            serverHash: nil, serverContent: nil
        )
        let store = makeStore(mock)
        store.taskTiers = ["t1": "satellite"]

        let failure = await store.setTier(taskId: "t1", tier: "wait")
        XCTAssertEqual(failure, "Pin the task first, then choose a tier.")
        XCTAssertEqual(store.tierId(for: "t1"), "satellite", "failed move must revert the map")
    }

    // MARK: - batchSetDone

    func testBatchCompleteAppliesInstantlyRollsBackFailedIds() async {
        let mock = MockTaskTransport()
        mock.batchPhaseResult = BatchPhaseResult(
            changed: [BatchTaskRow(id: "t1", title: nil)],
            failed: [BatchFailure(id: "t2", error: "sync conflict")],
            syncFailed: nil
        )
        let store = makeStore(mock)
        let t2Original = makeTask("t2", status: "todo")
        store.tasks = [makeTask("t1", status: "todo"), t2Original]

        let summary = await store.batchSetDone(["t1", "t2"], done: true)
        XCTAssertNotNil(summary)
        XCTAssertTrue(summary!.contains("1 updated"))
        XCTAssertEqual(store.tasks.first(where: { $0.id == "t1" })?.status, "done",
            "successful id keeps the optimistic flip")
        XCTAssertEqual(store.tasks.first(where: { $0.id == "t2" }), t2Original,
            "failed id must roll back to its original row")
        // No blocking loadTasks() on the batch path anymore.
        XCTAssertEqual(mock.callCount("tasks"), 0)
    }

    func testBatchCompleteFullFailureRollsEverythingBack() async {
        let mock = MockTaskTransport()
        mock.error = boom
        let store = makeStore(mock)
        let originals = [makeTask("t1"), makeTask("t2")]
        store.tasks = originals

        let summary = await store.batchSetDone(["t1", "t2"], done: true)
        XCTAssertNotNil(summary)
        XCTAssertEqual(store.tasks, originals, "thrown batch must restore every row")
    }

    // MARK: - batchDelete / deleteTask

    func testBatchDeleteRemovesInstantlyRestoresFailures() async {
        let mock = MockTaskTransport()
        mock.batchDeleteResult = BatchDeleteResult(
            deleted: [BatchTaskRow(id: "t1", title: nil)],
            failed: [BatchFailure(id: "t2", error: "active sessions")]
        )
        let store = makeStore(mock)
        store.tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3")]

        let summary = await store.batchDelete(["t1", "t2"])
        XCTAssertNotNil(summary) // partial failure reported
        XCTAssertEqual(store.tasks.map(\.id), ["t2", "t3"],
            "t1 stays deleted; failed t2 reappears near its old position")
    }

    func testSingleDeleteOptimisticAndRevert() async {
        let mock = MockTaskTransport()
        let store = makeStore(mock)
        store.tasks = [makeTask("t1"), makeTask("t2")]

        let deleteResult = await store.deleteTask(id: "t1")
        XCTAssertNil(deleteResult)
        XCTAssertEqual(store.tasks.map(\.id), ["t2"])

        // Failure path: row comes back at its old index; 409 arms force.
        mock.errorsByEndpoint["deleteTask"] = APIError.server(
            status: 409, code: "conflict", message: "2 active sessions",
            serverHash: nil, serverContent: nil
        )
        let failure = await store.deleteTask(id: "t2")
        XCTAssertNotNil(failure)
        XCTAssertEqual(store.tasks.map(\.id), ["t2"], "failed delete must restore the row")
        XCTAssertTrue(store.deleteNeedsForceIds.contains("t2"),
            "409 must arm the force-delete ladder")
    }

    // MARK: - Session rename / archive

    func testSessionRenameOptimisticAndRevert() async {
        let mock = MockTaskTransport()
        let store = makeStore(mock)
        store.sessions = [makeSession("s1", title: "Old")]

        let renameOk = await store.renameSession(id: "s1", title: "New")
        XCTAssertNil(renameOk)
        XCTAssertEqual(store.sessions[0].title, "New")

        mock.errorsByEndpoint["patchSession"] = boom
        let renameFail = await store.renameSession(id: "s1", title: "Bad")
        XCTAssertNotNil(renameFail)
        XCTAssertEqual(store.sessions[0].title, "New", "failed rename must revert")
    }

    func testSessionArchiveRemovesRowAndRestoresOnFailure() async {
        let mock = MockTaskTransport()
        let store = makeStore(mock)
        store.sessions = [makeSession("s1"), makeSession("s2")]

        let archiveOk = await store.setSessionArchived(id: "s1", archived: true)
        XCTAssertNil(archiveOk)
        XCTAssertEqual(store.sessions.map(\.id), ["s2"], "archive removes the row instantly")

        mock.errorsByEndpoint["patchSession"] = boom
        let archiveFail = await store.setSessionArchived(id: "s2", archived: true)
        XCTAssertNotNil(archiveFail)
        XCTAssertEqual(store.sessions.map(\.id), ["s2"], "failed archive must restore the row")
    }

    // MARK: - TaskDetailController (star / description / note)

    private func makeDetail(starred: Bool? = nil, description: String? = nil, note: String? = nil) -> TaskDetail {
        TaskDetail(
            id: "t1", title: "t", status: "todo", phase: "TODO",
            priority: "none", project: "", description: description,
            summary: nil, note: note, tags: nil, starred: starred, pinned: nil,
            dependsOn: nil, isBlocked: nil, resolvedDependencies: nil,
            dependents: nil, children: nil, parent: nil, sessionIds: nil
        )
    }

    func testStarToggleOptimisticAndRevert() async {
        let mock = MockTaskTransport()
        mock.taskDetailResult = makeDetail(starred: false)
        let controller = TaskDetailController(taskId: "t1", transport: mock)
        await controller.load()

        mock.starResult = true
        await controller.toggleStar()
        XCTAssertEqual(controller.detail?.starred, true)

        mock.errorsByEndpoint["toggleTaskStar"] = boom
        await controller.toggleStar()
        XCTAssertEqual(controller.detail?.starred, true, "failed toggle must revert to starred")
        XCTAssertNotNil(controller.errorMessage)
    }

    func testDescriptionSaveOptimisticAndRevert() async {
        let mock = MockTaskTransport()
        mock.taskDetailResult = makeDetail(description: "old")
        let controller = TaskDetailController(taskId: "t1", transport: mock)
        await controller.load()

        // Success: text swaps instantly (synchronous), API behind.
        controller.saveDescription("new")
        XCTAssertEqual(controller.detail?.description, "new",
            "readback must show the new text before the PUT resolves")
        // Let the background PUT settle.
        for _ in 0..<200 where mock.callCount("setTaskField") == 0 {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(controller.detail?.description, "new")

        // Failure: revert + error.
        mock.errorsByEndpoint["setTaskField"] = boom
        controller.saveDescription("doomed")
        XCTAssertEqual(controller.detail?.description, "doomed") // optimistic
        for _ in 0..<200 where controller.errorMessage == nil {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(controller.detail?.description, "new", "failed save must revert")
        XCTAssertNotNil(controller.errorMessage)
    }

    // MARK: - REST refresh must not clobber an in-flight optimistic edit

    func testLoadTasksReplaysInFlightEditOverStaleProjection() async {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        let store = makeStore(mock)
        store.tasks = [makeTask("t1", status: "todo")]
        // The projection the refresh will serve still says todo (pre-edit).
        mock.tasksResponse = TasksResponse(
            tasks: [makeTask("t1", status: "todo")], syncedAt: "2026-08-16T00:00:02Z"
        )

        // Start a PATCH that hangs at the transport.
        mock.gate = gate
        let patch = Task { try? await store.updateTask(id: "t1", edit: .init(status: "done")) }
        for _ in 0..<200 where store.tasks[0].status != "done" {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        // A refresh lands mid-PATCH: the fetch itself must not be gated.
        mock.gate = nil
        await store.loadTasks()
        XCTAssertEqual(store.tasks[0].status, "done",
            "stale REST refresh must not flash the optimistic edit back")

        gate.open()
        _ = await patch.value
    }
}
