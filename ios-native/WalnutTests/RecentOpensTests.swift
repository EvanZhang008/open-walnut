import XCTest
@testable import Walnut

/// The Tasks drawer's "Recently opened": what it remembers, in what order, and what
/// a row turns into once it is matched against the live lists.
@MainActor
final class RecentOpensTests: XCTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func task(
        _ id: String, title: String = "Wire the board chips", project: String = "marina",
        status: String = "todo"
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: title, status: status, phase: "TODO",
            priority: "none", project: project, dueDate: nil,
            createdAt: "2026-08-29T00:00:00Z", updatedAt: "2026-08-29T00:00:00Z",
            completedAt: nil, starred: nil, pinned: true, tags: nil, summary: nil
        )
    }

    private func session(
        _ id: String, taskId: String?, taskTitle: String? = "Wire the board chips",
        project: String? = "marina", status: String = "running"
    ) -> WalnutSession {
        WalnutSession(
            id: id, title: "Session: walnut — chips", taskId: taskId, taskTitle: taskTitle,
            project: project, host: "", processStatus: status, model: nil, mode: nil,
            startedAt: "2026-08-29T00:00:00Z", lastActiveAt: "2026-08-29T01:00:00Z",
            messageCount: 3, cwd: nil, pinned: true, focusTier: nil, description: nil
        )
    }

    // MARK: - Recording

    func testASessionIsRememberedUnderItsTask() {
        let out = RecentOpens.recordingSession(session("s1", taskId: "t1"), at: t0, into: [], cap: 40)
        XCTAssertEqual(out.map(\.id), ["t1"])
        XCTAssertEqual(out.first?.taskId, "t1")
        XCTAssertEqual(out.first?.session?.id, "s1")
        XCTAssertNil(out.first?.task)
    }

    func testOpeningAgainMovesToTheTopWithoutADuplicate() {
        var list = RecentOpens.recordingTask(task("a"), at: t0, into: [], cap: 40)
        list = RecentOpens.recordingTask(task("b"), at: t0 + 1, into: list, cap: 40)
        list = RecentOpens.recordingTask(task("a"), at: t0 + 2, into: list, cap: 40)
        XCTAssertEqual(list.map(\.id), ["a", "b"])
        XCTAssertEqual(list.first?.openedAt, t0 + 2)
    }

    /// Opening the details of a task whose conversation was open must not forget the
    /// conversation: the row's tap still goes back to it.
    func testDetailsAfterASessionKeepTheSession() {
        var list = RecentOpens.recordingSession(session("s1", taskId: "t1"), at: t0, into: [], cap: 40)
        list = RecentOpens.recordingTask(task("t1"), at: t0 + 5, into: list, cap: 40)
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list.first?.session?.id, "s1")
        XCTAssertEqual(list.first?.task?.id, "t1")
        XCTAssertEqual(list.first?.openedAt, t0 + 5)
    }

    /// A newer session of the same task replaces the older one: the row goes back to
    /// the conversation the user was in LAST.
    func testTheLatestSessionOfATaskWins() {
        var list = RecentOpens.recordingSession(session("old", taskId: "t1"), at: t0, into: [], cap: 40)
        list = RecentOpens.recordingSession(session("new", taskId: "t1"), at: t0 + 1, into: list, cap: 40)
        XCTAssertEqual(list.map(\.id), ["t1"])
        XCTAssertEqual(list.first?.session?.id, "new")
    }

    func testASessionWithNoTaskIsKeyedBySessionAndFoldsIntoItsTaskLater() {
        var list = RecentOpens.recordingSession(session("s1", taskId: nil), at: t0, into: [], cap: 40)
        XCTAssertEqual(list.map(\.id), ["session:s1"])
        // An empty task id is the projection's "no task", not a task named "".
        list = RecentOpens.recordingSession(session("s1", taskId: ""), at: t0 + 1, into: list, cap: 40)
        XCTAssertEqual(list.map(\.id), ["session:s1"])
        list = RecentOpens.recordingSession(session("s1", taskId: "t9"), at: t0 + 2, into: list, cap: 40)
        XCTAssertEqual(list.map(\.id), ["t9"])
    }

    func testTheListIsCappedOldestFirst() {
        var list: [RecentOpen] = []
        for i in 0..<45 {
            list = RecentOpens.recordingTask(task("t\(i)"), at: t0 + Double(i), into: list, cap: 40)
        }
        XCTAssertEqual(list.count, 40)
        XCTAssertEqual(list.first?.id, "t44")
        XCTAssertEqual(list.last?.id, "t5")
    }

    /// What was opened before the saved file was read is newer than all of it.
    func testHydrationKeepsEarlyVisitsOnTop() {
        let early = RecentOpens.recordingTask(task("b"), at: t0 + 9, into: [], cap: 40)
        var saved = RecentOpens.recordingTask(task("c"), at: t0, into: [], cap: 40)
        saved = RecentOpens.recordingTask(task("b"), at: t0 + 1, into: saved, cap: 40)
        let merged = RecentOpens.merged(newer: early, older: saved, cap: 40)
        XCTAssertEqual(merged.map(\.id), ["b", "c"])
        XCTAssertEqual(merged.first?.openedAt, t0 + 9)
    }

    func testTheSavedFormRoundTrips() throws {
        var list = RecentOpens.recordingSession(session("s1", taskId: "t1"), at: t0, into: [], cap: 40)
        list = RecentOpens.recordingTask(task("t1", title: "\u{4E2D}\u{6587} title"), at: t0 + 1, into: list, cap: 40)
        list = RecentOpens.recordingSession(session("s2", taskId: nil), at: t0 + 2, into: list, cap: 40)
        let data = try JSONEncoder().encode(list)
        XCTAssertEqual(try JSONDecoder().decode([RecentOpen].self, from: data), list)
    }

    /// A store nobody hydrated keeps its history in memory only, and a disconnect
    /// forgets it.
    func testTheStoreRecordsRemovesAndErases() {
        let store = RecentOpens()
        store.recordTask(task("a"), at: t0)
        store.recordSession(session("s1", taskId: "b"), at: t0 + 1)
        XCTAssertEqual(store.entries.map(\.id), ["b", "a"])
        store.remove(id: "b")
        XCTAssertEqual(store.entries.map(\.id), ["a"])
        store.clear()
        XCTAssertTrue(store.entries.isEmpty)
        store.recordTask(task("c"), at: t0 + 2)
        store.eraseAll()
        XCTAssertTrue(store.entries.isEmpty)
    }

    // MARK: - Rows

    func testARowPrefersTheLiveTitleAndTheConversation() {
        let list = RecentOpens.recordingSession(
            session("s1", taskId: "t1", taskTitle: "Old name"), at: t0, into: [], cap: 40
        )
        let rows = RecentRow.rows(
            list, tasks: [task("t1", title: "Renamed")],
            sessions: [session("s1", taskId: "t1", status: "idle")], now: t0 + 120
        )
        XCTAssertEqual(rows.map(\.title), ["Renamed"])
        XCTAssertEqual(rows.first?.meta, "2m ago · marina")
        guard case .session(let opened)? = rows.first?.primary else {
            return XCTFail("a row whose conversation was opened goes back to it")
        }
        XCTAssertEqual(opened.processStatus, "idle", "the live session, not the snapshot")
    }

    func testARowForDetailsOnlyOpensTheDetails() {
        let list = RecentOpens.recordingTask(task("t1"), at: t0, into: [], cap: 40)
        let rows = RecentRow.rows(list, tasks: [], sessions: [], now: t0)
        XCTAssertEqual(rows.first?.title, "Wire the board chips", "the snapshot when the list lacks it")
        guard case .task(let opened)? = rows.first?.primary else {
            return XCTFail("details only: the tap reopens the details")
        }
        XCTAssertEqual(opened.id, "t1")
        XCTAssertEqual(rows.first?.meta, "now · marina")
    }

    func testAFinishedInboxTaskSaysSo() {
        let list = RecentOpens.recordingTask(task("t1", project: "", status: "done"), at: t0, into: [], cap: 40)
        let rows = RecentRow.rows(list, tasks: [], sessions: [], now: t0)
        XCTAssertEqual(rows.first?.meta, "now · Inbox · Done")
        XCTAssertEqual(rows.first?.isDone, true)
    }

    /// Opened only through its session and absent from the list: Task Details still
    /// has something to open, by id.
    func testASessionOnlyRowStillOffersTheTask() {
        let list = RecentOpens.recordingSession(session("s1", taskId: "t1"), at: t0, into: [], cap: 40)
        let rows = RecentRow.rows(list, tasks: [], sessions: [], now: t0)
        XCTAssertEqual(rows.first?.task?.id, "t1")
        XCTAssertEqual(rows.first?.task?.title, "Wire the board chips")
        XCTAssertEqual(rows.first?.session?.id, "s1", "the snapshot when the list lacks it")
    }

    /// Task Details opened from a session-only row records the sheet's placeholder,
    /// whose title is just "Task": the session's copy of the name must still win.
    func testAPlaceholderSnapshotDoesNotRenameTheRow() {
        var list = RecentOpens.recordingSession(session("s1", taskId: "t1"), at: t0, into: [], cap: 40)
        list = RecentOpens.recordingTask(
            SessionTaskRow.placeholder(id: "t1", title: nil), at: t0 + 1, into: list, cap: 40
        )
        let rows = RecentRow.rows(list, tasks: [], sessions: [], now: t0 + 1)
        XCTAssertEqual(rows.first?.title, "Wire the board chips")
    }

    func testASessionWithNoTaskOffersNoTask() {
        let list = RecentOpens.recordingSession(session("s1", taskId: nil, taskTitle: nil, project: nil), at: t0, into: [], cap: 40)
        let rows = RecentRow.rows(list, tasks: [], sessions: [], now: t0)
        XCTAssertNil(rows.first?.task)
        XCTAssertEqual(rows.first?.title, "walnut", "the session's own name, boilerplate stripped")
        XCTAssertEqual(rows.first?.meta, "now")
    }

    // MARK: - The edge swipe

    func testTheTasksEdgeZoneStaysInTheMarginBesideTheRows() {
        let zone = TasksView.recentsEdgeZone
        XCTAssertTrue(ChatDrawerGeometry.tracksDrag(
            startX: zone, translation: CGSize(width: 40, height: 0), isOpen: false, edgeZone: zone
        ))
        XCTAssertFalse(ChatDrawerGeometry.tracksDrag(
            startX: zone + 1, translation: CGSize(width: 40, height: 0), isOpen: false, edgeZone: zone
        ), "a drag that starts on a row is the row's swipe")
        XCTAssertFalse(ChatDrawerGeometry.tracksDrag(
            startX: 4, translation: CGSize(width: 20, height: 90), isOpen: false, edgeZone: zone
        ), "a scroll down the edge stays the list's")
    }

    func testTheEdgeSwipeOpensOnlyOnTheTabItself() {
        XCTAssertTrue(TasksView.recentsEdgeSwipeOpens(pushed: false, editing: false, filter: .sessions))
        XCTAssertFalse(TasksView.recentsEdgeSwipeOpens(pushed: true, editing: false, filter: .sessions))
        XCTAssertFalse(TasksView.recentsEdgeSwipeOpens(pushed: false, editing: true, filter: .sessions))
        XCTAssertFalse(TasksView.recentsEdgeSwipeOpens(pushed: false, editing: false, filter: .calendar))
    }
}
