import XCTest
import SwiftUI
@testable import Walnut

/// The board's status sections (Watching, Needs you, To read, Working, Waiting / snoozed, Completed):
/// which row goes where, in what order, what is open by default and how that is stored, and
/// the Watch write. The model is `BoardStatusSections.swift`; `BoardModel.assemble` is where
/// the bands give their rows up to it.
final class BoardStatusSectionsTests: XCTestCase {

    private static let now = WalnutTask.parseISO("2026-08-27T12:00:00Z")!

    private func task(
        _ id: String, project: String = "", status: String = "todo", phase: String = "TODO",
        pinned: Bool? = true, updated: String = "2026-08-27T00:00:00Z",
        completed: String? = nil, start: String? = nil, waitUntil: String? = nil,
        watched: String? = nil, userState: String? = nil, user: WalnutUserStatus? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: "task \(id)", status: status, phase: phase,
            priority: "none", project: project, dueDate: nil,
            createdAt: "2026-08-20T00:00:00Z", updatedAt: updated,
            completedAt: completed ?? (status == "done" ? updated : nil),
            starred: nil, pinned: pinned, tags: nil, summary: nil,
            startDate: start,
            userStatus: user ?? userState.map { WalnutUserStatus(state: $0) },
            waitUntil: waitUntil, watchedAt: watched
        )
    }

    private func session(_ id: String, taskId: String, lastActive: String) -> WalnutSession {
        WalnutSession(
            id: id, title: "s", taskId: taskId, taskTitle: "t", project: nil, host: "",
            processStatus: "idle", model: nil, mode: nil, startedAt: "2026-08-20T00:00:00Z",
            lastActiveAt: lastActive, messageCount: 1, cwd: nil, pinned: true,
            focusTier: nil, description: nil
        )
    }

    private func board(
        _ tasks: [WalnutTask], tierOf: [String: String]? = nil, sessions: [WalnutSession] = [],
        query: String = "", grouping: BoardGrouping = .tier, date: BoardDateFilter = .now,
        scope: String? = nil
    ) -> BoardAssembly {
        let pinned = tasks.filter { $0.pinned == true }.map(\.id)
        let tiers = tierOf ?? Dictionary(uniqueKeysWithValues: pinned.map { ($0, "focus") })
        var order: [String: [String]] = [:]
        for id in pinned { if let tier = tiers[id] { order[tier, default: []].append(id) } }
        return BoardModel.assemble(
            tasks: tasks, sessions: sessions, tierOf: tiers, tierOrder: order, customTiers: [],
            query: query, grouping: grouping, dateFilter: date, scope: scope,
            statusSections: true, now: Self.now
        )
    }

    private func bandIds(_ b: BoardAssembly) -> [String] { b.bands.flatMap { $0.rows.map(\.id) } }

    // MARK: - Membership

    /// Each row of the view is drawn exactly once, in its state's section: done in Completed,
    /// the user's turn in Needs you (the user status first, the phase as the fallback, never
    /// a done row), WAITING or a later start (under Now) in Waiting / snoozed, the rest in the
    /// bands under Working. Both groupings agree.
    func testEveryRowLandsInExactlyOneSection() {
        let tasks = [
            task("open"),
            task("needsPhase", phase: "NEED_ACTION"),
            task("needsStatus", phase: "IN_PROGRESS", userState: "needs"),
            task("notNeeds", phase: "NEED_ACTION", userState: "waiting"),
            task("doneNeeds", status: "done", phase: "COMPLETE", userState: "needs"),
            task("parked", phase: "WAITING"),
            task("parkedNeeds", phase: "WAITING", userState: "needs"),
            task("later", start: "2026-09-01"),
        ]
        for grouping in [BoardGrouping.tier, .project] {
            let b = board(tasks, grouping: grouping)
            let s = b.sections
            XCTAssertTrue(s.active)
            XCTAssertEqual(Set(bandIds(b)), ["open", "notNeeds"], "\(grouping)")
            XCTAssertEqual(Set(s.needs.map(\.id)), ["needsPhase", "needsStatus", "parkedNeeds"], "\(grouping)")
            XCTAssertEqual(Set(s.waiting.map(\.id)), ["parked", "later"], "\(grouping)")
            XCTAssertEqual(s.done.map(\.id), ["doneNeeds"], "\(grouping)")
            XCTAssertEqual(s.workingCount, 2)
            let drawn = bandIds(b) + s.needs.map(\.id) + s.waiting.map(\.id) + s.done.map(\.id)
            XCTAssertEqual(drawn.count, Set(drawn).count, "a row drawn twice (\(grouping))")
            XCTAssertEqual(Set(drawn), Set(tasks.map(\.id)), "a row lost (\(grouping))")
        }
    }

    /// To read sits right under Needs you: a stored `read`, or an older server's `waiting` with
    /// `toRead`; a snoozed status stays under Waiting / snoozed whatever it holds, and a needs
    /// row is never To read.
    func testToReadHoldsWhatThereIsToReadAndNothingSnoozed() {
        let tasks = [
            task("read", phase: "NEED_ACTION", updated: "2026-08-25T00:00:00Z",
                 user: .init(state: "read", waitingOn: "It finished, and its result is there to read", toRead: "result")),
            task("legacy", phase: "NEED_ACTION", updated: "2026-08-26T00:00:00Z",
                 user: .init(state: "waiting", waitingOn: "It answered your message", toRead: "answer")),
            task("snoozed", phase: "WAITING",
                 user: .init(state: "waiting", snoozed: .init(until: "2026-09-01"), toRead: "result")),
            task("needs", phase: "NEED_ACTION", user: .init(state: "needs", ask: "Pick one", toRead: "result")),
            task("open"),
        ]
        let s = board(tasks).sections
        XCTAssertEqual(s.read.map(\.id), ["legacy", "read"], "latest activity first")
        XCTAssertEqual(s.needs.map(\.id), ["needs"])
        XCTAssertEqual(s.waiting.map(\.id), ["snoozed"])
        XCTAssertEqual(BoardStatusSection.allCases.filter { s.isShown($0) }, [.needs, .read, .working, .waiting])
        XCTAssertEqual(s.count(.read), 2)
        // A To read row never wears the needs dot, whatever its phase.
        XCTAssertNil(BoardModel.dot(tasks[0]))
        XCTAssertNil(BoardModel.dot(tasks[1]))
    }

    /// The mark follows the row's group: under To read, Waiting / snoozed or Completed no row
    /// wears the needs dot, even one whose phase alone (an older server) would ask for it.
    /// Unread still shows everywhere.
    func testTheRowMarkFollowsItsSectionNotThePhase() {
        let phaseOnly = task("p", phase: "NEED_ACTION")
        XCTAssertEqual(BoardModel.dot(phaseOnly), .needsAction)
        XCTAssertEqual(BoardModel.dot(phaseOnly, in: nil), .needsAction)
        XCTAssertEqual(BoardModel.dot(phaseOnly, in: .needs), .needsAction)
        for section in [BoardStatusSection.read, .waiting, .done] {
            XCTAssertNil(BoardModel.dot(phaseOnly, in: section), "\(section)")
        }
        var unread = task("u", phase: "NEED_ACTION")
        unread.unread = true
        XCTAssertEqual(BoardModel.dot(unread, in: .waiting), .unread)
        // A snoozed status is Waiting, never Needs you, so its row sits under Waiting / snoozed.
        let snoozed = task("s", start: "2026-09-01", user: .init(state: "waiting", snoozed: .init(until: "2026-09-01", ask: "Approve")))
        XCTAssertFalse(BoardModel.needsHuman(snoozed))
        XCTAssertEqual(board([snoozed]).sections.waiting.map(\.id), ["s"])
    }

    /// The tier scope narrows Needs you, Waiting and Completed to the tier in view, and the
    /// rail's chips keep counting each tier's open work (Needs you rows included), so a chip
    /// does not change its number because the screen grew sections.
    func testTheScopeNarrowsTheStateSectionsAndTheRailKeepsItsCounts() {
        let tasks = [
            task("f1"), task("f2", phase: "NEED_ACTION"), task("fd", status: "done", phase: "COMPLETE"),
            task("s1"), task("s2", phase: "NEED_ACTION"), task("sw", phase: "WAITING"),
        ]
        let tierOf = ["f1": "focus", "f2": "focus", "fd": "focus", "s1": "satellite", "s2": "satellite", "sw": "satellite"]
        let all = board(tasks, tierOf: tierOf)
        XCTAssertEqual(all.rail.map(\.count), [4, 2, 2], "All, Focus, Satellite: open, not waiting")
        XCTAssertEqual(Set(all.sections.needs.map(\.id)), ["f2", "s2"])
        let focus = board(tasks, tierOf: tierOf, scope: "focus")
        XCTAssertEqual(focus.scope, "focus")
        XCTAssertEqual(focus.rail.map(\.count), all.rail.map(\.count))
        XCTAssertEqual(focus.sections.needs.map(\.id), ["f2"])
        XCTAssertEqual(focus.sections.done.map(\.id), ["fd"])
        XCTAssertTrue(focus.sections.waiting.isEmpty)
        XCTAssertEqual(bandIds(focus), ["f1"])
    }

    /// A tier whose rows all went to sections draws no empty band under Working, and its
    /// chip stays on the rail.
    func testAnEmptiedTierHasNoBandButKeepsItsChip() {
        let tasks = [task("a"), task("b", phase: "NEED_ACTION")]
        let b = board(tasks, tierOf: ["a": "focus", "b": "satellite"])
        XCTAssertEqual(b.bands.map(\.bandId), ["focus"])
        XCTAssertTrue(b.rail.contains { $0.bandId == "satellite" && $0.count == 1 })
        XCTAssertEqual(b.sections.workingCount, 1)
    }

    // MARK: - Watching

    /// Watching spans the whole projection: an unpinned task, a task in another tier than the
    /// one in view, a done task and a WAITING one. A watched task is in no other section and
    /// in no band.
    func testWatchingSpansTheWholeProjectionAndOwnsItsRows() {
        let tasks = [
            task("plain"),
            task("wPinned", watched: "2026-08-25T00:00:00Z"),
            task("wUnpinned", pinned: false, watched: "2026-08-24T00:00:00Z"),
            task("wOther", watched: "2026-08-26T00:00:00Z"),
            task("wDone", status: "done", phase: "COMPLETE", watched: "2026-08-23T00:00:00Z"),
            task("wNeeds", phase: "NEED_ACTION", watched: "2026-08-22T00:00:00Z"),
            task("wParked", phase: "WAITING", watched: "2026-08-21T00:00:00Z"),
            task("notWatched", watched: ""),
        ]
        let tierOf = ["plain": "focus", "wPinned": "focus", "wOther": "satellite", "wDone": "focus",
                      "wNeeds": "focus", "wParked": "focus", "notWatched": "focus"]
        let b = board(tasks, tierOf: tierOf, scope: "focus")
        XCTAssertEqual(b.sections.watching.map(\.id),
            ["wParked", "wNeeds", "wDone", "wUnpinned", "wPinned", "wOther"],
            "every watched task, oldest watch first")
        XCTAssertEqual(Set(bandIds(b)), ["plain", "notWatched"])
        XCTAssertTrue(b.sections.needs.isEmpty && b.sections.waiting.isEmpty && b.sections.done.isEmpty)
    }

    /// A new watch lands at the foot: Watching keeps the order the user added them, and a
    /// missing or unreadable time sorts last, ties by id.
    func testWatchingKeepsTheOrderTheUserAddedThem() {
        let rows = [
            BoardRow(task: task("c", watched: "2026-08-26T10:00:00.500Z")),
            BoardRow(task: task("a", watched: "2026-08-26T09:00:00Z")),
            BoardRow(task: task("z", watched: "not a date")),
            BoardRow(task: task("b", watched: "2026-08-26T09:00:00Z")),
        ]
        XCTAssertEqual(BoardStatusSectionModel.sorted(.watching, rows).map(\.id), ["a", "b", "c", "z"])
    }

    // MARK: - Order inside a section

    /// Needs you: latest activity first, where activity is the latest of the last edit and
    /// the session's last activity.
    func testNeedsYouPutsTheLatestActivityFirst() {
        let tasks = [
            task("old", phase: "NEED_ACTION", updated: "2026-08-20T00:00:00Z"),
            task("edited", phase: "NEED_ACTION", updated: "2026-08-26T00:00:00Z"),
            task("talked", phase: "NEED_ACTION", updated: "2026-08-19T00:00:00Z"),
        ]
        let b = board(tasks, sessions: [session("s", taskId: "talked", lastActive: "2026-08-27T08:00:00Z")])
        XCTAssertEqual(b.sections.needs.map(\.id), ["talked", "edited", "old"])
    }

    /// Waiting / snoozed: the soonest wake first (a WAITING clock, else a start date), then the
    /// rows with no clock by latest activity. A wait clock on a task that is not WAITING does
    /// not count.
    func testWaitingPutsTheSoonestWakeFirst() {
        let tasks = [
            task("noClockOld", phase: "WAITING", updated: "2026-08-20T00:00:00Z"),
            task("noClockNew", phase: "WAITING", updated: "2026-08-26T00:00:00Z"),
            task("clockLate", phase: "WAITING", waitUntil: "2026-09-10T00:00:00Z"),
            task("clockSoon", phase: "WAITING", waitUntil: "2026-08-28T00:00:00Z"),
            task("snoozed", start: "2026-09-01T00:00:00Z"),
            task("clockIgnored", start: "2026-09-05T00:00:00Z", waitUntil: "2026-08-27T13:00:00Z"),
        ]
        XCTAssertEqual(board(tasks).sections.waiting.map(\.id),
            ["clockSoon", "snoozed", "clockIgnored", "clockLate", "noClockNew", "noClockOld"])
    }

    /// Completed: the latest completion first.
    func testCompletedPutsTheLatestCompletionFirst() {
        let tasks = [
            task("first", status: "done", phase: "COMPLETE", completed: "2026-08-21T00:00:00Z"),
            task("last", status: "done", phase: "COMPLETE", completed: "2026-08-26T00:00:00Z"),
            task("middle", status: "done", phase: "COMPLETE", completed: "2026-08-24T00:00:00Z"),
        ]
        XCTAssertEqual(board(tasks).sections.done.map(\.id), ["last", "middle", "first"])
    }

    // MARK: - Project runs and the "Show N more" row

    /// Rows run by project in the order each project's first row appears; one project is one
    /// run (the view draws no label for it).
    func testProjectRunsFollowTheFirstRowOfEachProject() {
        let rows = ["b1", "a1", "b2", "i1", "a2"].map { id -> BoardRow in
            let project = id.hasPrefix("a") ? "acme" : id.hasPrefix("b") ? "marina" : ""
            return BoardRow(task: task(id, project: project))
        }
        let runs = BoardStatusSectionModel.projectRuns(rows)
        XCTAssertEqual(runs.map(\.project), ["marina", "acme", ""])
        XCTAssertEqual(runs.map { $0.rows.map(\.id) }, [["b1", "b2"], ["a1", "a2"], ["i1"]])
        XCTAssertEqual(runs.last?.label, "Inbox")
        XCTAssertEqual(BoardStatusSectionModel.projectRuns(Array(rows.prefix(1))).count, 1)
    }

    /// 30 rows, then "Show N more" for the next batch; a tap adds 30.
    func testASectionShowsThirtyRowsThenShowMore() {
        let rows = (0..<75).map { i in BoardRow(task: task(String(format: "r%02d", i), project: i < 40 ? "acme" : "marina")) }
        let runs = BoardStatusSectionModel.projectRuns(rows)
        let first = BoardStatusSectionModel.visibleRuns(runs, shown: 30)
        XCTAssertEqual(first.flatMap(\.rows).count, 30)
        XCTAssertEqual(first.map(\.project), ["acme"], "the run past the cut is not drawn")
        XCTAssertEqual(BoardStatusSectionModel.showMoreLabel(total: 75, shown: 30), "Show 30 more")
        let second = BoardStatusSectionModel.visibleRuns(runs, shown: 60)
        XCTAssertEqual(second.map { $0.rows.count }, [40, 20])
        XCTAssertEqual(BoardStatusSectionModel.showMoreLabel(total: 75, shown: 60), "Show 15 more")
        XCTAssertNil(BoardStatusSectionModel.showMoreLabel(total: 75, shown: 90))
        XCTAssertNil(BoardStatusSectionModel.showMoreLabel(total: 30, shown: 30))
    }

    // MARK: - Defaults, visibility and the words

    func testDefaultsAndWords() {
        XCTAssertEqual(BoardStatusSection.allCases.map(\.label),
            ["Watching", "Needs you", "To read", "Working", "Waiting / snoozed", "Completed"])
        XCTAssertEqual(BoardStatusSection.allCases.filter(\.defaultOpen), [.watching, .needs, .read, .working])
        XCTAssertEqual(BoardWatchItem.label(watched: false), "Watch")
        XCTAssertEqual(BoardWatchItem.label(watched: true), "Stop watching")
        XCTAssertEqual(BoardWatchItem.systemImage(watched: false), "eye")
        XCTAssertEqual(BoardWatchItem.systemImage(watched: true), "eye.slash")
    }

    /// Working always has its heading; every other section only when it holds a row.
    func testOnlyWorkingIsShownWhenEmpty() {
        let s = board([task("a")]).sections
        XCTAssertEqual(BoardStatusSection.allCases.filter { s.isShown($0) }, [.working])
        XCTAssertFalse(s.drawsRows)
        let full = board([task("a", phase: "NEED_ACTION"), task("b", status: "done", phase: "COMPLETE")]).sections
        XCTAssertEqual(BoardStatusSection.allCases.filter { full.isShown($0) }, [.needs, .working, .done])
        XCTAssertTrue(full.drawsRows)
        XCTAssertEqual(full.workingCount, 0)
    }

    // MARK: - Search turns the sections off

    /// While a query is live there are no sections at all (search shows its own results): the
    /// bands hold the matching rows as before, a watched or needs-you row included.
    func testAQueryTurnsTheSectionsOff() {
        let tasks = [task("1", watched: "2026-08-26T00:00:00Z"), task("2", phase: "NEED_ACTION"), task("3")]
        let b = board(tasks, query: "task")
        XCTAssertFalse(b.sections.active)
        XCTAssertEqual(BoardStatusSection.allCases.filter { b.sections.isShown($0) }, [])
        XCTAssertEqual(Set(bandIds(b)), ["1", "2", "3"])
    }

    // MARK: - The stored open state

    func testOpenStateRoundTripsAndStoresOnlyTheChanges() {
        XCTAssertEqual(BoardStatusSectionPrefs.decode("")[.waiting], false)
        XCTAssertEqual(BoardStatusSectionPrefs.decode("")[.watching], true)
        var raw = BoardStatusSectionPrefs.toggling(.done, raw: "")
        XCTAssertEqual(raw, #"{"done":true}"#)
        XCTAssertTrue(BoardStatusSectionPrefs.isOpen(.done, raw: raw))
        raw = BoardStatusSectionPrefs.toggling(.working, raw: raw)
        XCTAssertEqual(raw, #"{"done":true,"working":false}"#)
        XCTAssertFalse(BoardStatusSectionPrefs.isOpen(.working, raw: raw))
        raw = BoardStatusSectionPrefs.toggling(.done, raw: raw)
        raw = BoardStatusSectionPrefs.toggling(.working, raw: raw)
        XCTAssertEqual(raw, "", "every section back at its default stores nothing")
    }

    func testGarbageInTheStoreReadsAsTheDefaults() {
        for junk in ["not json", "[]", "3", #"{"done":"yes","waiting":1}"#] {
            for section in BoardStatusSection.allCases {
                XCTAssertEqual(BoardStatusSectionPrefs.isOpen(section, raw: junk), section.defaultOpen, junk)
            }
        }
        XCTAssertTrue(BoardStatusSectionPrefs.isOpen(.waiting, raw: #"{"waiting":true,"junk":5}"#))
    }

    /// Persisted across launches: read back through `@AppStorage`, the way TasksView reads
    /// it, against a private defaults suite.
    func testOpenStatePersistsThroughAppStorage() throws {
        let suite = "board-sections-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        func stored() -> AppStorage<String> {
            AppStorage(wrappedValue: "", BoardStatusSectionPrefs.openKey, store: defaults)
        }
        XCTAssertFalse(BoardStatusSectionPrefs.isOpen(.done, raw: stored().wrappedValue))
        stored().wrappedValue = BoardStatusSectionPrefs.toggling(.done, raw: stored().wrappedValue)
        XCTAssertEqual(defaults.string(forKey: BoardStatusSectionPrefs.openKey), #"{"done":true}"#)
        XCTAssertTrue(BoardStatusSectionPrefs.isOpen(.done, raw: stored().wrappedValue), "a new reader sees it")
    }

    // MARK: - The wire fields

    /// `watched_at` and `wait_until` decode, an older server sends neither, and every copy of
    /// a row the store makes keeps them.
    @MainActor
    func testWatchAndWaitFieldsDecodeAndSurviveRowCopies() throws {
        func decode(_ extra: String) throws -> WalnutTask {
            let json = #"{"id":"t","title":"t","status":"todo","phase":"WAITING","priority":"none","project":"""# + extra + "}"
            return try JSONDecoder().decode(WalnutTask.self, from: Data(json.utf8))
        }
        let t = try decode(#","watched_at":"2026-08-26T00:00:00Z","wait_until":"2026-08-30T00:00:00Z""#)
        XCTAssertEqual(t.watchedAt, "2026-08-26T00:00:00Z")
        XCTAssertEqual(t.waitUntil, "2026-08-30T00:00:00Z")
        let old = try decode("")
        XCTAssertNil(old.watchedAt)
        XCTAssertFalse(BoardStatusSectionModel.isWatched(old))
        XCTAssertEqual(TasksStore.withPinned(t, true).watchedAt, t.watchedAt)
        XCTAssertEqual(TasksStore.withPinned(t, true).waitUntil, t.waitUntil)
        XCTAssertEqual(TasksStore.applyEdit(.init(title: "x"), to: t).watchedAt, t.watchedAt)
        XCTAssertNil(TasksStore.applyEdit(.init(watchedAt: ""), to: t).watchedAt, "\"\" stops watching")
        XCTAssertEqual(TasksStore.applyEdit(.init(watchedAt: "2026-08-27T00:00:00Z"), to: old).watchedAt,
                       "2026-08-27T00:00:00Z")
        XCTAssertFalse(TasksStore.TaskEdit(watchedAt: "").isEmpty, "a stop is an edit")
    }
}

/// The Watch write: optimistic through the store, rolled back on a failed PATCH.
@MainActor
final class BoardWatchWriteTests: XCTestCase {

    private func row(_ id: String, watched: String? = nil) -> WalnutTask {
        WalnutTask(
            id: id, title: "t", status: "todo", phase: "TODO", priority: "none", project: "",
            dueDate: nil, createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z",
            completedAt: nil, starred: nil, pinned: true, tags: nil, summary: nil,
            watchedAt: watched
        )
    }

    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(nanoseconds: 10_000_000) }
    }

    func testWatchAppliesAtOnceAndSendsTheTime() async {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        let store = TasksStore(transport: mock)
        store.tasks = [row("t1")]
        let now = WalnutTask.parseISO("2026-08-27T12:00:00Z")!
        let write = Task { await store.setWatched(store.tasks[0], watched: true, now: now) }
        await waitFor { store.tasks[0].watchedAt != nil }
        XCTAssertEqual(store.tasks[0].watchedAt, "2026-08-27T12:00:00Z", "the row moves to Watching before the PATCH answers")
        gate.open()
        let error = await write.value
        XCTAssertNil(error)
        XCTAssertEqual(store.tasks[0].watchedAt, "2026-08-27T12:00:00Z")
        XCTAssertEqual(mock.calls.last?.args.last, "watched_at=2026-08-27T12:00:00Z")
    }

    func testStopWatchingSendsAnEmptyValue() async {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        store.tasks = [row("t1", watched: "2026-08-26T00:00:00Z")]
        let error = await store.setWatched(store.tasks[0], watched: false)
        XCTAssertNil(error)
        XCTAssertNil(store.tasks[0].watchedAt)
        XCTAssertEqual(mock.calls.last?.args.last, "watched_at=")
    }

    func testAFailedWatchRollsBack() async {
        let mock = MockTaskTransport()
        let gate = CheckedContinuationGate()
        mock.gate = gate
        mock.errorsByEndpoint["updateTask"] = APIError.server(
            status: 400, code: "bad_request", message: "at least one updatable field is required",
            serverHash: nil, serverContent: nil
        )
        let store = TasksStore(transport: mock)
        store.tasks = [row("t1")]
        let write = Task { await store.setWatched(store.tasks[0], watched: true) }
        await waitFor { store.tasks[0].watchedAt != nil }
        XCTAssertNotNil(store.tasks[0].watchedAt, "optimistic first")
        gate.open()
        let error = await write.value
        XCTAssertNotNil(error, "the failure is reported")
        XCTAssertNil(store.tasks[0].watchedAt, "and the row goes back where it was")
    }
}
