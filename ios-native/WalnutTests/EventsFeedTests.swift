import XCTest
@testable import Walnut

/// Pure logic of the live events feed — the frame parser, the snapshot →
/// upsert → delete reducer state machine, and the optimistic task-edit
/// projection. Tested against the REAL app code via @testable import.
final class EventsFeedTests: XCTestCase {

    // MARK: - Fixtures

    private func makeTask(
        _ id: String, title: String = "t", status: String = "todo",
        priority: String = "none", project: String = "", dueDate: String? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: title, status: status, phase: "TODO",
            priority: priority, project: project, dueDate: dueDate,
            createdAt: "2026-08-07T00:00:00Z", updatedAt: "2026-08-07T00:00:00Z",
            completedAt: nil, starred: nil, pinned: nil, tags: nil, summary: nil
        )
    }

    private func makeSession(_ id: String, status: String = "idle") -> WalnutSession {
        WalnutSession(
            id: id, title: "Session: demo — hi", taskId: nil, taskTitle: nil,
            project: nil, host: "", processStatus: status, model: nil, mode: nil,
            startedAt: "2026-08-07T00:00:00Z", lastActiveAt: "2026-08-07T00:00:00Z",
            messageCount: 1, cwd: nil, pinned: nil, focusTier: nil, description: nil
        )
    }

    // MARK: - EventsFrameParser

    func testParserAssemblesFrames() {
        var parser = EventsFrameParser()
        XCTAssertNil(parser.consume(line: "event: task-upsert"))
        XCTAssertNil(parser.consume(line: "data: {\"id\":\"a\"}"))
        let frame = parser.consume(line: "")
        XCTAssertEqual(frame?.event, "task-upsert")
        XCTAssertEqual(frame?.data, "{\"id\":\"a\"}")
        // Parser resets for the next frame.
        XCTAssertNil(parser.consume(line: "data: x"))
        XCTAssertEqual(parser.consume(line: "")?.event, "message")
    }

    func testParserIgnoresPingsAndJoinsMultilineData() {
        var parser = EventsFrameParser()
        XCTAssertNil(parser.consume(line: ": ping"))
        XCTAssertNil(parser.consume(line: "event: snapshot"))
        XCTAssertNil(parser.consume(line: "data: line1"))
        XCTAssertNil(parser.consume(line: "data: line2"))
        let frame = parser.consume(line: "")
        XCTAssertEqual(frame?.data, "line1\nline2")
        // A blank line with no data is not a frame.
        XCTAssertNil(parser.consume(line: ""))
    }

    // MARK: - Reducer: snapshot → upsert → delete state machine

    func testUpsertInsertsNewTaskAtHead() {
        let rows = [makeTask("a"), makeTask("b")]
        let result = EventsFeedReducer.upsertTask(rows, makeTask("c"))
        XCTAssertTrue(result.changed)
        XCTAssertEqual(result.rows.map(\.id), ["c", "a", "b"])
    }

    func testUpsertReplacesInPlace() {
        let rows = [makeTask("a"), makeTask("b", status: "todo")]
        let result = EventsFeedReducer.upsertTask(rows, makeTask("b", status: "done"))
        XCTAssertTrue(result.changed)
        XCTAssertEqual(result.rows.map(\.id), ["a", "b"]) // position stable
        XCTAssertEqual(result.rows[1].status, "done")
    }

    func testUpsertSameValueReportsUnchanged() {
        // Same-value writes must be skippable — an unchanged @Observable
        // assignment still invalidates SwiftUI (freeze-battle rule).
        let rows = [makeTask("a")]
        let result = EventsFeedReducer.upsertTask(rows, makeTask("a"))
        XCTAssertFalse(result.changed)
    }

    func testDeleteRemovesRowAndUnknownIdIsUnchanged() {
        let rows = [makeTask("a"), makeTask("b")]
        let removed = EventsFeedReducer.deleteTask(rows, id: "a")
        XCTAssertTrue(removed.changed)
        XCTAssertEqual(removed.rows.map(\.id), ["b"])
        let noop = EventsFeedReducer.deleteTask(removed.rows, id: "zzz")
        XCTAssertFalse(noop.changed)
        XCTAssertEqual(noop.rows.map(\.id), ["b"])
    }

    func testSessionUpsertMirrorsTaskSemantics() {
        let rows = [makeSession("s1", status: "idle")]
        let updated = EventsFeedReducer.upsertSession(rows, makeSession("s1", status: "running"))
        XCTAssertTrue(updated.changed)
        XCTAssertEqual(updated.rows[0].processStatus, "running")
        let inserted = EventsFeedReducer.upsertSession(updated.rows, makeSession("s2"))
        XCTAssertEqual(inserted.rows.map(\.id), ["s2", "s1"])
        let noop = EventsFeedReducer.upsertSession(inserted.rows, makeSession("s2"))
        XCTAssertFalse(noop.changed)
    }

    /// The full lifecycle in arrival order: upsert-new → upsert-change →
    /// delete, interleaved across both entity kinds.
    func testSnapshotUpsertDeleteSequence() {
        var tasks = [makeTask("t1")]
        var sessions = [makeSession("s1")]

        // upsert new task
        (tasks, _) = EventsFeedReducer.upsertTask(tasks, makeTask("t2", status: "in_progress"))
        // change it
        (tasks, _) = EventsFeedReducer.upsertTask(tasks, makeTask("t2", status: "done"))
        // delete the original
        (tasks, _) = EventsFeedReducer.deleteTask(tasks, id: "t1")
        // session flips status
        (sessions, _) = EventsFeedReducer.upsertSession(sessions, makeSession("s1", status: "running"))

        XCTAssertEqual(tasks.map(\.id), ["t2"])
        XCTAssertEqual(tasks[0].status, "done")
        XCTAssertEqual(sessions[0].processStatus, "running")
    }

    // MARK: - Wire decode (snapshot frame field names)

    func testSnapshotRowsDecodeFromProjectionShape() throws {
        // Exact field names from docs/reference/api-v1.md (snake_case rows).
        let taskJSON = """
        {"id":"tk-1","title":"Fix bug","status":"in_progress","phase":"IN_PROGRESS",
         "priority":"important","project":"walnut","due_date":"2026-08-09",
         "created_at":"2026-08-07T00:00:00Z","updated_at":"2026-08-08T00:00:00Z","pinned":true}
        """
        let task = try JSONDecoder().decode(WalnutTask.self, from: Data(taskJSON.utf8))
        XCTAssertEqual(task.id, "tk-1")
        XCTAssertEqual(task.statusKind, .inProgress)
        XCTAssertEqual(task.dueDate, "2026-08-09")

        let sessionJSON = """
        {"id":"sid-1","host":"","process_status":"running","task_id":"tk-1",
         "started_at":"2026-08-08T00:00:00Z","last_active_at":"2026-08-08T01:00:00Z",
         "message_count":5}
        """
        let session = try JSONDecoder().decode(WalnutSession.self, from: Data(sessionJSON.utf8))
        XCTAssertEqual(session.statusKind, .running)
        XCTAssertEqual(session.taskId, "tk-1")
    }

    func testTranscriptAgentFieldDecodes() throws {
        let json = """
        {"role":"assistant","text":"Task","timestamp":"2026-08-08T00:00:00Z",
         "kind":"tool","detail":"explore the repo","agent":"code-reviewer"}
        """
        let row = try JSONDecoder().decode(SessionTranscript.Message.self, from: Data(json.utf8))
        XCTAssertEqual(row.agent, "code-reviewer")
        // Plain tool rows without the field stay nil (additive contract).
        let plain = """
        {"role":"assistant","text":"Bash","timestamp":"2026-08-08T00:00:00Z","kind":"tool"}
        """
        let plainRow = try JSONDecoder().decode(SessionTranscript.Message.self, from: Data(plain.utf8))
        XCTAssertNil(plainRow.agent)
    }

    // MARK: - Optimistic edit projection (PATCH apply/rollback halves)

    @MainActor
    func testApplyEditStatusAndClearDue() {
        let base = makeTask("t", status: "todo", dueDate: "2026-08-09")
        let done = TasksStore.applyEdit(.init(status: "done"), to: base)
        XCTAssertEqual(done.status, "done")
        XCTAssertNotNil(done.completedAt) // done stamps a completion time
        XCTAssertEqual(done.dueDate, "2026-08-09") // untouched fields survive

        let cleared = TasksStore.applyEdit(.init(dueDate: ""), to: base)
        XCTAssertNil(cleared.dueDate) // "" = explicit clear
        XCTAssertEqual(cleared.status, "todo")
    }

    @MainActor
    func testApplyEditIsRollbackSymmetric() {
        // The rollback path compares the CURRENT row against the optimistic
        // projection to decide "still ours" — the projection must therefore be
        // deterministic for identical inputs, except the updated_at stamp.
        let base = makeTask("t", title: "old", priority: "none", project: "")
        let edit = TasksStore.TaskEdit(priority: "important", project: "walnut", title: "new")
        let a = TasksStore.applyEdit(edit, to: base)
        let b = TasksStore.applyEdit(edit, to: base)
        XCTAssertEqual(a.title, "new")
        XCTAssertEqual(a.priority, b.priority)
        XCTAssertEqual(a.project, b.project)
        XCTAssertEqual(a.id, base.id)
    }

    @MainActor
    func testTaskEditIsEmpty() {
        XCTAssertTrue(TasksStore.TaskEdit().isEmpty)
        XCTAssertFalse(TasksStore.TaskEdit(status: "done").isEmpty)
        XCTAssertFalse(TasksStore.TaskEdit(dueDate: "").isEmpty) // clear is an edit
    }

    /// P1-3 regression: applyEdit stamps `updatedAt` (and possibly
    /// `completedAt`) from `now`, so two computations straddling a second are
    /// UNEQUAL — a rollback guard that recomputes the optimistic row can never
    /// match and silently stops rolling back. updateTask must compare against
    /// the stored optimistic instance.
    @MainActor
    func testApplyEditAcrossSecondsIsUnequal_soRollbackMustUseStoredInstance() {
        let base = makeTask("t", status: "todo")
        let edit = TasksStore.TaskEdit(status: "done")
        let t1 = Date(timeIntervalSince1970: 1_754_600_000)
        let t2 = t1.addingTimeInterval(1) // clock crossed a second mid-PATCH
        let optimistic = TasksStore.applyEdit(edit, to: base, now: t1)
        let recomputed = TasksStore.applyEdit(edit, to: base, now: t2)
        XCTAssertNotEqual(optimistic, recomputed,
            "timestamps differ across seconds — a recomputed guard is always false")

        // The guard semantics updateTask now uses: compare the CURRENT row
        // against the STORED optimistic instance. Same instance → roll back.
        var tasks = [optimistic]
        if let idx = tasks.firstIndex(where: { $0.id == base.id }), tasks[idx] == optimistic {
            tasks[idx] = base
        }
        XCTAssertEqual(tasks[0], base, "rollback must fire when our optimistic row is still current")

        // And when a feed upsert already replaced the row with newer server
        // truth, the guard must NOT clobber it back.
        let serverRow = makeTask("t", status: "in_progress")
        var tasks2 = [serverRow]
        if let idx = tasks2.firstIndex(where: { $0.id == base.id }), tasks2[idx] == optimistic {
            tasks2[idx] = base
        }
        XCTAssertEqual(tasks2[0], serverRow, "server truth must survive the failed-PATCH rollback")
    }

    /// P1-A regression: a task-delete frame must also clear the matching
    /// pendingCreated overlay — otherwise a phone-created task deleted on the
    /// desktop is resurrected by the overlay on the next snapshot/refresh.
    @MainActor
    func testTaskDeleteClearsPendingCreatedOverlay() {
        let store = TasksStore()
        let created = makeTask("phone-created")
        store.tasks = [created]
        store._registerPendingCreatedForTesting(created)
        XCTAssertTrue(store.pendingCreatedIds.contains("phone-created"))

        store._applyFeedMutationsForTesting([.taskDelete(id: "phone-created")])
        XCTAssertFalse(store.tasks.contains(where: { $0.id == "phone-created" }))
        XCTAssertFalse(store.pendingCreatedIds.contains("phone-created"),
            "overlay must die with the delete")
        // The next server merge must NOT resurrect the row.
        let merged = store._mergePendingForTesting(into: [])
        XCTAssertFalse(merged.contains(where: { $0.id == "phone-created" }))
    }

    /// P1-C regression: a feed task-upsert arriving while a PATCH for the same
    /// id is in flight must not visibly flash the row back to the pre-edit
    /// value — the in-flight edit is replayed on top of the server row.
    @MainActor
    func testFeedUpsertMidPatchReplaysInFlightEdit() {
        let store = TasksStore()
        let base = makeTask("t-inflight", status: "todo", priority: "none")
        let edit = TasksStore.TaskEdit(status: "done")
        store.tasks = [TasksStore.applyEdit(edit, to: base)]
        store._setInFlightEditForTesting(id: "t-inflight", edit: edit)

        // Server emits the row for an unrelated reason (priority change),
        // content still pre-edit for OUR field.
        let serverRow = makeTask("t-inflight", status: "todo", priority: "important")
        store._applyFeedMutationsForTesting([.taskUpsert(serverRow)])

        let row = store.tasks.first(where: { $0.id == "t-inflight" })
        XCTAssertEqual(row?.status, "done", "optimistic edit must not flash back mid-PATCH")
        XCTAssertEqual(row?.priority, "important", "the server's unrelated change still lands")

        // Once the PATCH settles the edit is gone — upserts apply verbatim.
        store._setInFlightEditForTesting(id: "t-inflight", edit: nil)
        store._applyFeedMutationsForTesting([.taskUpsert(serverRow)])
        XCTAssertEqual(store.tasks.first(where: { $0.id == "t-inflight" })?.status, "todo")
    }

    /// P1-B regression: 401/403 must be terminal like 404 (no infinite
    /// reconnect loop on a revoked token), while transient statuses keep the
    /// backoff-reconnect path.
    func testTerminalFeedStatuses() {
        XCTAssertTrue(EventsFeedClient.isTerminalStatus(404))
        XCTAssertTrue(EventsFeedClient.isTerminalStatus(401))
        XCTAssertTrue(EventsFeedClient.isTerminalStatus(403))
        for transient in [500, 502, 503, 429, -1] {
            XCTAssertFalse(EventsFeedClient.isTerminalStatus(transient), "\(transient) must reconnect")
        }
    }

    // MARK: - Small helpers

    @MainActor
    func testIsoDayFormatsDate() {
        var comps = DateComponents()
        comps.year = 2026; comps.month = 8; comps.day = 9
        let date = Calendar.current.date(from: comps)!
        XCTAssertEqual(TaskDetailSheet.isoDay(date), "2026-08-09")
    }

    func testFriendlyControlErrorLadder() {
        let upgrade = APIError.server(status: 400, code: "session_control_needs_upgrade",
                                      message: "daemon predates", serverHash: nil, serverContent: nil)
        XCTAssertTrue(SessionControlsSheet.friendlyControlError(upgrade).contains("upgrading"))
        let offline = APIError.server(status: 503, code: "bridge_offline",
                                      message: "no bridge", serverHash: nil, serverContent: nil)
        XCTAssertTrue(SessionControlsSheet.friendlyControlError(offline).contains("isn't reachable"))
        let conflict = APIError.server(status: 409, code: "conflict",
                                       message: "effort not supported", serverHash: nil, serverContent: nil)
        XCTAssertEqual(SessionControlsSheet.friendlyControlError(conflict), "effort not supported")
    }
}
