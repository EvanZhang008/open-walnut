import XCTest
@testable import Walnut

/// Every pure rule the board is built on. The layout is the simulator's job;
/// what is pinned here is the arithmetic and the semantics: which band a row is
/// in, in what order, what its second line says, what a tapped tier token does,
/// what the two filters (grouping, date) admit, and where a new task lands.
final class TaskBoardModelTests: XCTestCase {

    // MARK: - Fixtures

    /// The clock every date-filter test measures against. Fixed, and passed in as
    /// `now`, so "in the future" is a property of the fixture rather than of the
    /// day the suite happens to run.
    private static let now = WalnutTask.parseISO("2026-08-27T12:00:00Z")!

    private func task(
        _ id: String, title: String = "a task", project: String = "",
        status: String = "todo", phase: String = "TODO", pinned: Bool? = true,
        start: String? = nil, due: String? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: title, status: status, phase: phase,
            priority: "none", project: project, dueDate: due,
            createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
            completedAt: status == "done" ? "2026-08-27T01:00:00Z" : nil,
            starred: nil, pinned: pinned, tags: nil, summary: nil,
            startDate: start
        )
    }

    private func session(
        _ id: String, taskId: String?, status: String = "idle",
        lastActive: String = "2026-08-27T00:00:00Z", host: String = "",
        description: String? = nil
    ) -> WalnutSession {
        WalnutSession(
            id: id, title: "Session: walnut — hello", taskId: taskId, taskTitle: "t",
            project: nil, host: host, processStatus: status, model: nil, mode: nil,
            startedAt: "2026-08-26T00:00:00Z", lastActiveAt: lastActive,
            messageCount: 3, cwd: nil, pinned: true, focusTier: nil, description: description
        )
    }

    // MARK: - A session IS a task that has a session

    /// The join is by TASK id and keeps the LATEST session per task — the whole
    /// premise of one row type. Two sessions on one task must never become two
    /// rows, which is what the old parallel session list did.
    func testLatestSessionPerTaskCollapsesManySessionsToOneRow() {
        let sessions = [
            session("old", taskId: "t1", lastActive: "2026-08-20T00:00:00Z"),
            session("new", taskId: "t1", lastActive: "2026-08-27T00:00:00Z"),
            session("other", taskId: "t2"),
        ]
        let latest = BoardModel.latestSessionByTask(sessions)
        XCTAssertEqual(latest.count, 2, "two tasks → two rows, not three sessions")
        XCTAssertEqual(latest["t1"]?.id, "new", "the newest session represents the task")
    }

    func testTasklessSessionsAreNotJoinedToAnyTask() {
        let latest = BoardModel.latestSessionByTask([
            session("s1", taskId: nil), session("s2", taskId: ""),
        ])
        XCTAssertTrue(latest.isEmpty, "a session with no owning task joins nothing")
    }

    /// The row identity is the TASK, so a newer session arriving for the same
    /// task cannot make an expanded row collapse (its id would have changed).
    func testRowIdentityIsTheTaskNotTheSession() {
        let a = BoardRow(task: task("t1"), session: session("s1", taskId: "t1"))
        let b = BoardRow(task: task("t1"), session: session("s2", taskId: "t1"))
        XCTAssertEqual(a.id, b.id)
        XCTAssertEqual(a.id, "t1")
        // A session-only row falls back to the session id — it has nothing else.
        XCTAssertEqual(BoardRow(task: nil, session: session("s9", taskId: nil)).id, "s9")
    }

    // MARK: - Row state (derived only from fields the projection carries)

    func testStateMapsEveryProcessStatus() {
        XCTAssertEqual(BoardModel.state(task: task("t"), session: session("s", taskId: "t", status: "running")), .running)
        XCTAssertEqual(BoardModel.state(task: task("t"), session: session("s", taskId: "t", status: "idle")), .waiting)
        XCTAssertEqual(BoardModel.state(task: task("t"), session: session("s", taskId: "t", status: "stopped")), .ended)
        XCTAssertEqual(BoardModel.state(task: task("t"), session: session("s", taskId: "t", status: "error")), .failed)
        XCTAssertEqual(BoardModel.state(task: task("t"), session: nil), .none,
            "no session = no state, never a fake one")
    }

    /// AGENT_COMPLETE outranks the process status on purpose: a CLI can idle for
    /// hours after handing back, and "waiting" would bury the one row that owes a
    /// human a look.
    func testHandedBackOutranksTheProcessStatus() {
        for status in ["running", "idle", "stopped", "error"] {
            XCTAssertEqual(
                BoardModel.state(
                    task: task("t", phase: "AGENT_COMPLETE"),
                    session: session("s", taskId: "t", status: status)
                ),
                .handedBack,
                "phase AGENT_COMPLETE must win over process_status=\(status)"
            )
        }
        // But only with a session: a phase alone is not a session state.
        XCTAssertEqual(BoardModel.state(task: task("t", phase: "AGENT_COMPLETE"), session: nil), .none)
    }

    func testEveryStateHasNonEmptyWording() {
        for state in [BoardRowState.running, .waiting, .handedBack, .ended, .failed, .none] {
            XCTAssertFalse(state.word.isEmpty)
            XCTAssertFalse(state.word.contains("\n"), "the row's second line is ONE line")
        }
    }

    // MARK: - Short age

    func testShortAgeUnits() {
        XCTAssertEqual(BoardModel.shortAge(0), "0s")
        XCTAssertEqual(BoardModel.shortAge(59), "59s")
        XCTAssertEqual(BoardModel.shortAge(60), "1m")
        XCTAssertEqual(BoardModel.shortAge(59 * 60), "59m")
        XCTAssertEqual(BoardModel.shortAge(60 * 60), "1h")
        XCTAssertEqual(BoardModel.shortAge(23 * 3600), "23h")
        XCTAssertEqual(BoardModel.shortAge(24 * 3600), "1d")
        XCTAssertEqual(BoardModel.shortAge(9 * 24 * 3600), "9d")
        // A clock skew (a stamp in the future) must not render "-3s".
        XCTAssertEqual(BoardModel.shortAge(-500), "0s")
    }

    func testShortAgeIsAlwaysShortEnoughForTheRowLine() {
        for seconds in [0, 1, 90, 3_600, 100_000, 10_000_000] {
            XCTAssertLessThanOrEqual(BoardModel.shortAge(TimeInterval(seconds)).count, 5)
        }
    }

    // MARK: - Band assembly + ORDER

    /// The bands follow the SPLIT's order, which is `pin_order` — the mechanism
    /// that makes a new task appear at the foot of its band.
    func testBandsFollowTheSplitOrderNotTheTaskListOrder() {
        // Tasks list is deliberately in the WRONG order for the band.
        let tasks = [task("c"), task("a"), task("b")]
        let bands = BoardModel.bands(
            tasks: tasks, sessions: [],
            tierOf: ["a": "focus", "b": "focus", "c": "focus"],
            tierOrder: ["focus": ["a", "b", "c"]],
            customTiers: []
        )
        XCTAssertEqual(bands.first?.rows.map(\.id), ["a", "b", "c"],
            "the band renders in pin order, which is what puts a new pin last")
    }

    /// A pin the split hasn't caught up with (an optimistic local write) still
    /// renders, and it renders LAST — which is also where the server will put it.
    func testAPinTheSplitHasNotSeenYetLandsAtTheFoot() {
        let ids = BoardModel.orderedIds(splitOrder: ["a", "b"], extras: ["b", "fresh"])
        XCTAssertEqual(ids, ["a", "b", "fresh"])
    }

    func testOrderedIdsNeverDuplicates() {
        XCTAssertEqual(BoardModel.orderedIds(splitOrder: ["a", "a", "b"], extras: ["b", "a"]), ["a", "b"])
    }

    func testBandsAreInTheDesktopReadingOrderWithCustomTiersLast() {
        let tasks = ["f", "s", "b", "w", "c"].map { task($0) }
        let bands = BoardModel.bands(
            tasks: tasks, sessions: [],
            tierOf: ["f": "focus", "s": "satellite", "b": "backlog", "w": "wait", "c": "ct_abc12345"],
            tierOrder: ["focus": ["f"], "satellite": ["s"], "backlog": ["b"], "wait": ["w"], "ct_abc12345": ["c"]],
            customTiers: [FocusTierInfo(id: "ct_abc12345", label: "Deep Work")]
        )
        XCTAssertEqual(bands.map(\.bandId), ["focus", "satellite", "backlog", "wait", "ct_abc12345"])
        XCTAssertEqual(bands.last?.label, "Deep Work", "a custom tier shows its label, never its ct_ id")
    }

    func testEmptyBandsAreDropped() {
        let bands = BoardModel.bands(
            tasks: [task("f")], sessions: [],
            tierOf: ["f": "focus"], tierOrder: ["focus": ["f"]], customTiers: []
        )
        XCTAssertEqual(bands.map(\.bandId), ["focus"], "an empty tier is not a heading")
    }

    /// A tier bucket can name a task this projection no longer has (deleted
    /// elsewhere). It must be dropped, not rendered as a blank row.
    func testATierIdWithNoMatchingTaskIsDroppedNotBlank() {
        let bands = BoardModel.bands(
            tasks: [task("alive")], sessions: [],
            tierOf: ["alive": "focus", "ghost": "focus"],
            tierOrder: ["focus": ["ghost", "alive"]], customTiers: []
        )
        XCTAssertEqual(bands.first?.rows.map(\.id), ["alive"])
    }

    // MARK: - The heading count

    /// The number on a heading is what you can SEE in the band — toggling
    /// `hide done` changes it, which is the feedback that the toggle worked. A
    /// count including hidden rows would disagree with the rows below it.
    func testHeadingCountMatchesTheVisibleRows() {
        let tasks = [task("a"), task("b", status: "done", phase: "COMPLETE"), task("c")]
        let order = ["focus": ["a", "b", "c"]]
        let tierOf = ["a": "focus", "b": "focus", "c": "focus"]

        let shown = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: tierOf, tierOrder: order, customTiers: []
        )
        XCTAssertEqual(shown.first?.count, 3)
        XCTAssertEqual(shown.first?.rows.count, 3)
        XCTAssertEqual(shown.first?.hiddenDone, 0)

        let hidden = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: tierOf, tierOrder: order,
            customTiers: [], hiddenDoneTiers: ["focus"]
        )
        XCTAssertEqual(hidden.first?.count, 2, "the count follows the rows")
        XCTAssertEqual(hidden.first?.rows.count, 2)
        XCTAssertEqual(hidden.first?.hiddenDone, 1, "and says how many it is suppressing")
    }

    // MARK: - Done stays in place

    /// The load-bearing rule: completing a task does NOT move it. Its position
    /// is the memory of where the work happened, so it stays exactly where it was
    /// (struck through) rather than folding to the bottom of the band.
    func testCompletingATaskDoesNotMoveItWithinItsBand() {
        let order = ["focus": ["a", "b", "c"]]
        let tierOf = ["a": "focus", "b": "focus", "c": "focus"]
        let before = BoardModel.bands(
            tasks: [task("a"), task("b"), task("c")], sessions: [],
            tierOf: tierOf, tierOrder: order, customTiers: []
        )
        // Same tasks; the MIDDLE one is now done.
        let after = BoardModel.bands(
            tasks: [task("a"), task("b", status: "done", phase: "COMPLETE"), task("c")],
            sessions: [], tierOf: tierOf, tierOrder: order, customTiers: []
        )
        XCTAssertEqual(before.first?.rows.map(\.id), after.first?.rows.map(\.id),
            "a completion must not reorder the band")
        XCTAssertEqual(after.first?.rows[1].isDone, true, "it is struck through IN PLACE")
    }

    /// `hide done` is PER BAND: hiding in Focus must not silently hide the done
    /// rows in Satellite, which the user isn't even looking at.
    func testHideDoneAffectsOnlyItsOwnBand() {
        let tasks = [
            task("f1"), task("f2", status: "done", phase: "COMPLETE"),
            task("s1"), task("s2", status: "done", phase: "COMPLETE"),
        ]
        let bands = BoardModel.bands(
            tasks: tasks, sessions: [],
            tierOf: ["f1": "focus", "f2": "focus", "s1": "satellite", "s2": "satellite"],
            tierOrder: ["focus": ["f1", "f2"], "satellite": ["s1", "s2"]],
            customTiers: [], hiddenDoneTiers: ["focus"]
        )
        XCTAssertEqual(bands.first(where: { $0.bandId == "focus" })?.rows.map(\.id), ["f1"])
        XCTAssertEqual(bands.first(where: { $0.bandId == "satellite" })?.rows.map(\.id), ["s1", "s2"])
    }

    /// A band that is ALL done and hiding must still render its heading, or the
    /// `show done` toggle that would bring the rows back would be gone too.
    func testABandHidingEveryRowKeepsItsHeading() {
        let bands = BoardModel.bands(
            tasks: [task("d", status: "done", phase: "COMPLETE")], sessions: [],
            tierOf: ["d": "focus"], tierOrder: ["focus": ["d"]],
            customTiers: [], hiddenDoneTiers: ["focus"]
        )
        XCTAssertEqual(bands.map(\.bandId), ["focus"])
        XCTAssertEqual(bands.first?.rows.count, 0)
        XCTAssertEqual(bands.first?.hiddenDone, 1, "the heading can say what to un-hide")
    }

    // MARK: - The tail band: EVERY task no tier claimed

    /// THE board's completeness guarantee, and the bug the user reported.
    ///
    /// A task with no tier and NO session used to have no row anywhere: the tier
    /// bands are built from the split, and the tail band was session-gated, so a
    /// plain task fell between them. Create a task, have the tier write not land
    /// (or land and then get overwritten by a split that hasn't caught up), and
    /// the task existed in the store, in search, in every other view — and was
    /// missing from the one screen whose whole job is showing tasks.
    ///
    /// A tier decides WHICH band a task is in. It must never decide WHETHER.
    func testATaskWithNoTierAndNoSessionStillHasARow() {
        let bands = BoardModel.bands(
            tasks: [task("plain", pinned: false)], sessions: [],
            tierOf: [:], tierOrder: [:], customTiers: []
        )
        XCTAssertEqual(bands.map(\.bandId), [BoardModel.activeTierId],
            "a bare task is still a task — it cannot be absent from the board")
        XCTAssertEqual(bands.first?.rows.map(\.id), ["plain"])
    }

    /// The same guarantee stated over a whole mixed set: every task id in, every
    /// task id out. This is the assertion that catches a future filter growing a
    /// new hole, whatever shape it takes.
    func testEveryTaskAppearsSomewhereOnTheBoard() {
        let tasks = [
            task("filed"), task("loose", pinned: false),
            task("busy", pinned: false), task("finished", status: "done", phase: "COMPLETE"),
        ]
        let bands = BoardModel.bands(
            tasks: tasks,
            sessions: [session("s", taskId: "busy", status: "running")],
            // Only ONE task is claimed by a tier; the other three have no tier at all.
            tierOf: ["filed": "focus"], tierOrder: ["focus": ["filed"]], customTiers: []
        )
        let shown = Set(bands.flatMap(\.rows).map(\.id))
        XCTAssertEqual(shown, Set(tasks.map(\.id)),
            "the board is a task list: no task may be missing from it")
    }

    /// Live work sorts to the top of the tail (that is what the band was born
    /// for), then everything else by recency, with done rows last.
    func testTheTailPutsLiveWorkFirstThenRecencyThenDone() {
        let tasks = [
            task("pinned"),
            task("loose1", pinned: false),
            task("loose2", pinned: false),
            task("quiet", pinned: false),
            task("finished", status: "done", phase: "COMPLETE", pinned: false),
        ]
        let sessions = [
            session("a", taskId: "loose1", status: "running", lastActive: "2026-08-27T01:00:00Z"),
            session("b", taskId: "loose2", status: "idle", lastActive: "2026-08-27T05:00:00Z"),
            session("c", taskId: "quiet", status: "stopped", lastActive: "2026-08-27T09:00:00Z"),
        ]
        let bands = BoardModel.bands(
            tasks: tasks, sessions: sessions,
            tierOf: ["pinned": "focus"], tierOrder: ["focus": ["pinned"]], customTiers: []
        )
        XCTAssertEqual(bands.map(\.bandId), ["focus", BoardModel.activeTierId])
        let tail = bands.last?.rows.map(\.id) ?? []
        // loose2 (idle=live, newer) and loose1 (running) lead; `quiet`'s session
        // is stopped so it sorts on recency alone; the done row sinks.
        XCTAssertEqual(tail.prefix(2).sorted(), ["loose1", "loose2"],
            "a live session sorts above a task with none")
        XCTAssertEqual(tail.last, "finished", "a completed task never buries the top")
        XCTAssertEqual(Set(tail), ["loose1", "loose2", "quiet", "finished"])
    }

    /// A session whose owning task never reached the projection still gets a row
    /// rather than disappearing. Unlike a task, a taskless session has nothing
    /// else representing it anywhere, so even a stopped one keeps its row.
    func testATasklessSessionStillGetsARow() {
        let bands = BoardModel.bands(
            tasks: [], sessions: [
                session("orphan", taskId: nil, status: "running"),
                session("dead", taskId: nil, status: "stopped"),
            ],
            tierOf: [:], tierOrder: [:], customTiers: []
        )
        XCTAssertEqual(bands.map(\.bandId), [BoardModel.activeTierId])
        XCTAssertEqual(bands.first?.rows.first?.id, "orphan", "live work leads")
        XCTAssertEqual(Set(bands.first?.rows.map(\.id) ?? []), ["orphan", "dead"])
        XCTAssertEqual(bands.first?.rows.first?.canRetier, false,
            "a session with no task has nothing to pin, so it shows no tier picker")
    }

    /// A query that hides a tier row must not push it into the tail band — the
    /// row would then appear twice as the query narrows. Claiming happens when a
    /// band OWNS an id, before the search filter runs.
    func testASearchHiddenTierRowDoesNotReappearInTheTail() {
        let bands = BoardModel.bands(
            tasks: [task("filed", title: "Alpha"), task("other", title: "Beta", pinned: false)],
            sessions: [],
            tierOf: ["filed": "focus"], tierOrder: ["focus": ["filed"]],
            customTiers: [], query: "Beta"
        )
        let shown = bands.flatMap(\.rows).map(\.id)
        XCTAssertEqual(shown, ["other"], "the filtered-out tier row stays filtered out")
        XCTAssertEqual(shown.count, Set(shown).count, "no id may render twice")
    }

    func testAPinnedTaskIsNeverAlsoInTheUnpinnedTail() {
        let bands = BoardModel.bands(
            tasks: [task("t")], sessions: [session("s", taskId: "t", status: "running")],
            tierOf: ["t": "focus"], tierOrder: ["focus": ["t"]], customTiers: []
        )
        XCTAssertEqual(bands.map(\.bandId), ["focus"], "one row, one band — never two")
    }

    // MARK: - Search

    func testSearchMatchesTitleProjectAndHost() {
        let row = BoardRow(
            task: task("t", title: "fix the pipe flag", project: "marina"),
            session: session("s", taskId: "t", host: "clouddev")
        )
        for query in ["pipe", "PIPE", "marina", "clouddev"] {
            XCTAssertTrue(BoardModel.matches(row, query: query), "must match \(query)")
        }
        XCTAssertFalse(BoardModel.matches(row, query: "nonsense"))
        XCTAssertTrue(BoardModel.matches(row, query: ""), "an empty query matches everything")
    }

    func testSearchFiltersBandsAndDropsEmptyOnes() {
        let bands = BoardModel.bands(
            tasks: [task("a", title: "alpha"), task("b", title: "beta")], sessions: [],
            tierOf: ["a": "focus", "b": "satellite"],
            tierOrder: ["focus": ["a"], "satellite": ["b"]],
            customTiers: [], query: "alpha"
        )
        XCTAssertEqual(bands.map(\.bandId), ["focus"])
        XCTAssertEqual(bands.first?.rows.map(\.id), ["a"])
    }

    // MARK: - The date filter ("Now"), ported from the desktop

    /// The desktop's rule, and the distinction the whole filter turns on
    /// (`TodoPanel.matchesDateFilter` case `'now'` → `isDeferredByStart`): a START
    /// date in the future means "not yet", so the row goes away. A DUE date in the
    /// past means "late", so the row absolutely stays: the day you most need to
    /// see a task is the day it was due, and a date filter that hid overdue work
    /// would hide exactly the rows a person opened the board for.
    func testNowHidesAFutureStartButNeverAPastDue() {
        let deferred = BoardRow(task: task("later", start: "2026-09-01T00:00:00Z"), session: nil)
        let overdue = BoardRow(task: task("late", due: "2026-08-01T00:00:00Z"), session: nil)

        XCTAssertTrue(BoardModel.isDeferred(deferred, filter: .now, now: Self.now),
            "a start date in the future is the ONE thing Now hides")
        XCTAssertFalse(BoardModel.isDeferred(overdue, filter: .now, now: Self.now),
            "a due date is a deadline: it marks a row overdue, it never hides one")

        // …and All hides neither, which is what makes it the safe default.
        XCTAssertFalse(BoardModel.isDeferred(deferred, filter: .all, now: Self.now))
        XCTAssertFalse(BoardModel.isDeferred(overdue, filter: .all, now: Self.now))
    }

    /// A start date that has already arrived is not deferred. The boundary, both
    /// sides of it, because `>` vs `>=` here is the difference between a task
    /// appearing the moment it starts and appearing a body pass later.
    func testNowShowsATaskWhoseStartDateHasArrived() {
        for start in ["2026-08-27T11:59:59Z", "2026-08-27T12:00:00Z", "2026-08-01T00:00:00Z"] {
            let row = BoardRow(task: task("t", start: start), session: nil)
            XCTAssertFalse(BoardModel.isDeferred(row, filter: .now, now: Self.now),
                "start \(start) has arrived, so the task is actionable now")
        }
    }

    /// No start date = nothing says "later" = always shown. This is the common
    /// case by far (most tasks never get a start date), so if it were wrong the
    /// filter would empty the board.
    func testATaskWithNoStartDateIsAlwaysShownUnderNow() {
        let row = BoardRow(task: task("plain"), session: nil)
        XCTAssertFalse(BoardModel.isDeferred(row, filter: .now, now: Self.now))
        // A session-only row has no task and therefore no dates at all.
        let sessionOnly = BoardRow(task: nil, session: session("s", taskId: nil))
        XCTAssertFalse(BoardModel.isDeferred(sessionOnly, filter: .now, now: Self.now),
            "a taskless session cannot be deferred: there is no start date to read")
    }

    /// A DONE row is exempt, matching the desktop (`t.status !== 'done' &&
    /// !matchesDateFilter(…)`). It matters more here: hiding completions is what
    /// each band's own `hide done` toggle is for, and a date filter that quietly
    /// did it too would make that toggle look broken.
    func testNowDoesNotHideADoneTaskEvenWithAFutureStart() {
        let row = BoardRow(
            task: task("done", status: "done", phase: "COMPLETE", start: "2026-09-01T00:00:00Z"),
            session: nil
        )
        XCTAssertFalse(BoardModel.isDeferred(row, filter: .now, now: Self.now),
            "hiding completions belongs to `hide done`, not to the date filter")
    }

    /// End to end through `bands`: the deferred row leaves the board under Now and
    /// comes back under All. Both groupings, because the filter runs inside
    /// `admits` which BOTH band builders call, and a filter that only bit on one
    /// grouping would be a hole you could switch a row into.
    func testNowRemovesADeferredRowFromBothGroupings() {
        let tasks = [
            task("ready", title: "ready now"),
            task("later", title: "starts in september", start: "2026-09-01T00:00:00Z"),
        ]
        for grouping in BoardGrouping.allCases {
            let now = BoardModel.bands(
                tasks: tasks, sessions: [],
                tierOf: ["ready": "focus", "later": "focus"],
                tierOrder: ["focus": ["ready", "later"]], customTiers: [],
                grouping: grouping, dateFilter: .now, now: Self.now
            )
            XCTAssertEqual(Set(now.flatMap(\.rows).map(\.id)), ["ready"],
                "\(grouping): Now must hide the deferred row")

            let all = BoardModel.bands(
                tasks: tasks, sessions: [],
                tierOf: ["ready": "focus", "later": "focus"],
                tierOrder: ["focus": ["ready", "later"]], customTiers: [],
                grouping: grouping, dateFilter: .all, now: Self.now
            )
            XCTAssertEqual(Set(all.flatMap(\.rows).map(\.id)), ["ready", "later"],
                "\(grouping): All must show it again")
        }
    }

    // MARK: - Project grouping (the desktop's "By project")

    /// Inbox ("") leads, then projects A→Z, and every task lands in EXACTLY one
    /// band. "Exactly one" is the assertion that matters: a project band is
    /// defined over all tasks, so a bug that double-counted would show the same
    /// task under two headings on one screen.
    func testProjectGroupingPutsEveryTaskInExactlyOneBand() {
        let tasks = [
            task("m1", project: "marina"), task("a1", project: "acme"),
            task("i1", project: ""), task("m2", project: "marina"),
            task("i2", project: "", pinned: false),
        ]
        let bands = BoardModel.bands(
            tasks: tasks, sessions: [],
            tierOf: ["m1": "focus"], tierOrder: ["focus": ["m1"]], customTiers: [],
            grouping: .project, now: Self.now
        )
        XCTAssertEqual(bands.map(\.bandId), ["proj:", "proj:acme", "proj:marina"],
            "Inbox leads, then A→Z, the order the rest of the app already uses")
        XCTAssertEqual(bands.first?.label, NewTaskSeed.inboxHeader,
            "the empty project reads as Inbox, never as a blank heading")

        let ids = bands.flatMap(\.rows).map(\.id)
        XCTAssertEqual(Set(ids), Set(tasks.map(\.id)), "every task appears")
        XCTAssertEqual(ids.count, Set(ids).count, "and none appears twice")
        XCTAssertEqual(bands.first(where: { $0.bandId == "proj:marina" })?.count, 2)
    }

    /// A session whose owning task never reached the projection is real work
    /// someone started, and project grouping must not be where it falls through:
    /// it files under the project the SESSION reports, Inbox when it reports none.
    func testProjectGroupingKeepsASessionWithNoOwningTask() {
        let bands = BoardModel.bands(
            tasks: [], sessions: [
                session("orphan", taskId: nil, status: "running"),
                session("ghost", taskId: "gone-from-projection", status: "idle"),
            ],
            tierOf: [:], tierOrder: [:], customTiers: [],
            grouping: .project, now: Self.now
        )
        // ONE id space (R25): the row for a session whose task is missing from the
        // projection is keyed by the OWNING TASK it names, not by the session UUID —
        // that mismatch is what made the search dedup miss it and draw the task twice.
        // A session that owns nothing keeps its own id, because it has nothing else.
        XCTAssertEqual(Set(bands.flatMap(\.rows).map(\.id)), ["orphan", "gone-from-projection"],
            "a taskless session has nothing else representing it anywhere, so it keeps its row")
        XCTAssertEqual(
            Set(bands.flatMap(\.rows).compactMap(\.session?.id)), ["orphan", "ghost"],
            "the session behind each row is untouched — only the row's KEY changed"
        )
        XCTAssertEqual(bands.map(\.bandId), ["proj:"],
            "a session with no project reports Inbox, same rule as BoardRow.project")
    }

    /// The create ring at the foot of a band files into THAT band, which is now
    /// stated by the band itself (`createSeed`) instead of inferred from its id.
    /// A project band seeds the project with the pin left unspecified: adding
    /// under a project heading is about the project, and silently choosing a tier
    /// there would be a second decision the user never made.
    func testAProjectBandsCreateSeedFilesIntoThatProject() {
        let bands = BoardModel.bands(
            tasks: [task("m", project: "marina"), task("i", project: "")], sessions: [],
            tierOf: [:], tierOrder: [:], customTiers: [],
            grouping: .project, now: Self.now
        )
        let marina = bands.first { $0.bandId == "proj:marina" }
        XCTAssertEqual(marina?.createSeed, NewTaskSeed(project: "marina", pin: .unspecified))
        XCTAssertNil(marina?.createSeed?.pin.wireFocusTier,
            "a project band must never send a focus_tier: `proj:marina` is not a tier")

        let inbox = bands.first { $0.bandId == "proj:" }
        XCTAssertEqual(inbox?.createSeed, NewTaskSeed(project: "", pin: .unspecified),
            "the Inbox heading files into the empty project, not into one called \"Inbox\"")
    }

    /// The tail band has NO create affordance, and that is now a property of the
    /// band rather than a `bandId != activeTierId` check in the view. It is the
    /// COMPLEMENT of the others, so "create here" has no destination to mean.
    func testTheTailBandOffersNoCreateAffordance() {
        let bands = BoardModel.bands(
            tasks: [task("filed"), task("loose", pinned: false)], sessions: [],
            tierOf: ["filed": "focus"], tierOrder: ["focus": ["filed"]], customTiers: [],
            now: Self.now
        )
        let tail = bands.first { $0.bandId == BoardModel.activeTierId }
        XCTAssertNotNil(tail, "the tail band renders")
        XCTAssertNil(tail?.createSeed, "the complement of every tier has no create destination")
        // Every OTHER band has one, so the view never has to ask why.
        for band in bands where band.bandId != BoardModel.activeTierId {
            XCTAssertNotNil(band.createSeed, "\(band.bandId) must offer a create ring")
        }
    }

    /// The tail band folds its done rows like every other band (2026-08-29).
    ///
    /// It could not until then, because `unfiledRows` never read the hide-done set, and
    /// the heading hid the toggle to avoid shipping a control that does nothing. That
    /// asymmetry landed on the worst possible band: the tail is the COMPLEMENT of every
    /// tier, which on the real board is 2,903 of 3,161 rows, so the one place a
    /// completed backlog actually buries live work was the one place it could not be
    /// folded away.
    func testTheTailBandHidesItsDoneRowsLikeEveryOtherBand() {
        let tasks = [
            task("filed"),
            task("loose1", pinned: false),
            task("loose2", status: "done", phase: "COMPLETE", pinned: false),
            task("loose3", status: "done", phase: "COMPLETE", pinned: false),
        ]
        let visible = BoardModel.bands(
            tasks: tasks, sessions: [],
            tierOf: ["filed": "focus"], tierOrder: ["focus": ["filed"]], customTiers: [],
            now: Self.now
        )
        let shown = visible.first { $0.bandId == BoardModel.activeTierId }
        XCTAssertEqual(shown?.rows.map(\.id), ["loose1", "loose2", "loose3"],
            "with the toggle off a completed task stays exactly where it was")
        XCTAssertEqual(shown?.hiddenDone, 0)

        let folded = BoardModel.bands(
            tasks: tasks, sessions: [],
            tierOf: ["filed": "focus"], tierOrder: ["focus": ["filed"]], customTiers: [],
            hiddenDoneTiers: [BoardModel.activeTierId], now: Self.now
        )
        let tail = folded.first { $0.bandId == BoardModel.activeTierId }
        XCTAssertEqual(tail?.rows.map(\.id), ["loose1"])
        XCTAssertEqual(tail?.hiddenDone, 2, "the heading says what to un-hide")
        // The tier band above is untouched: the set is per band, as always.
        XCTAssertEqual(folded.first(where: { $0.bandId == "focus" })?.rows.map(\.id), ["filed"])
    }

    /// Folding every row in the tail still leaves the band, so the `show done (N)`
    /// toggle that brings them back is still on screen. Same rule the tier bands got.
    func testATailBandHidingEveryRowKeepsItsHeading() {
        let bands = BoardModel.bands(
            tasks: [task("d", status: "done", phase: "COMPLETE", pinned: false)], sessions: [],
            tierOf: [:], tierOrder: [:], customTiers: [],
            hiddenDoneTiers: [BoardModel.activeTierId], now: Self.now
        )
        XCTAssertEqual(bands.map(\.bandId), [BoardModel.activeTierId])
        XCTAssertEqual(bands.first?.rows.count, 0)
        XCTAssertEqual(bands.first?.hiddenDone, 1)
    }

    /// Folding done rows does NOT give the tail a create destination. The two are
    /// different questions: `hide done` is about the rows you are looking at, creating
    /// is about where a new row would go, and the complement of every tier still has
    /// nowhere to mean.
    func testFoldingTheTailStillOffersNoCreateAffordance() {
        let bands = BoardModel.bands(
            tasks: [task("loose", status: "done", phase: "COMPLETE", pinned: false)],
            sessions: [], tierOf: [:], tierOrder: [:], customTiers: [],
            hiddenDoneTiers: [BoardModel.activeTierId], now: Self.now
        )
        XCTAssertNil(bands.first(where: { $0.bandId == BoardModel.activeTierId })?.createSeed)
    }

    /// A tier band still seeds its own tier, verbatim: the same guarantee
    /// `CreateWithTierTests` states from the create side, restated here now that
    /// the seed comes off the band instead of being rebuilt from its id.
    func testATierBandsCreateSeedNamesItsOwnTier() {
        let ids = ["f", "s", "b", "w"]
        let tiers = ["focus", "satellite", "backlog", "wait"]
        let bands = BoardModel.bands(
            tasks: zip(ids, tiers).map { task($0.0) }, sessions: [],
            tierOf: Dictionary(uniqueKeysWithValues: zip(ids, tiers)),
            tierOrder: Dictionary(uniqueKeysWithValues: tiers.enumerated().map { ($0.element, [ids[$0.offset]]) }),
            customTiers: [], now: Self.now
        )
        XCTAssertEqual(bands.map(\.bandId), tiers)
        for band in bands {
            XCTAssertEqual(band.createSeed?.pin, .tier(band.bandId))
            XCTAssertEqual(band.createSeed?.pin.wireFocusTier, band.bandId)
            XCTAssertEqual(band.createSeed?.project, "", "a tier says where on the board, not which project")
        }
    }

    /// THE strongest guarantee on this screen: the grouping control changes the
    /// HEADINGS, never the population. Set equality of row ids across both
    /// groupings over the same inputs, including the awkward cases (a task no tier
    /// claims, a done task, a taskless session, a project called like a tier).
    ///
    /// It has to be stated explicitly because the two builders are separate code
    /// paths: tier bands are the split's buckets plus a complement band, project
    /// bands are one pass over everything. Either one could grow a hole on its own.
    func testSwitchingGroupingNeverLosesARow() {
        let tasks = [
            task("filed", project: "marina"),
            task("loose", project: "acme", pinned: false),
            task("inbox", project: ""),
            task("done", project: "marina", status: "done", phase: "COMPLETE"),
            // A project named exactly like a built-in tier, the collision the
            // `proj:` prefix exists for.
            task("tricky", project: "focus", pinned: false),
        ]
        let sessions = [
            session("live", taskId: "loose", status: "running"),
            session("orphan", taskId: nil, status: "idle"),
        ]
        let tierOf = ["filed": "focus", "done": "backlog"]
        let tierOrder = ["focus": ["filed"], "backlog": ["done"]]

        func rowIds(_ grouping: BoardGrouping, dateFilter: BoardDateFilter, query: String) -> Set<String> {
            BoardModel.rowIds(BoardModel.bands(
                tasks: tasks, sessions: sessions, tierOf: tierOf, tierOrder: tierOrder,
                customTiers: [], query: query, grouping: grouping,
                dateFilter: dateFilter, now: Self.now
            ))
        }

        // Same inputs, both groupings, across every filter combination the bar can
        // produce: the populations must be identical every time.
        for dateFilter in BoardDateFilter.allCases {
            for query in ["", "marina", "a"] {
                XCTAssertEqual(
                    rowIds(.tier, dateFilter: dateFilter, query: query),
                    rowIds(.project, dateFilter: dateFilter, query: query),
                    "date=\(dateFilter) query=\"\(query)\": switching grouping changed WHICH rows exist"
                )
            }
        }
        // And the population is the whole set, so "identical" isn't two empties.
        XCTAssertEqual(
            rowIds(.tier, dateFilter: .all, query: ""),
            Set(tasks.map(\.id) + ["orphan"])
        )
    }

    /// Band ids are unique within a grouping. They are SwiftUI identities (the
    /// `ForEach`, the scroll anchor, the hide-done set), so a duplicate would drop
    /// a whole band's rows or teleport the rail to the wrong heading.
    func testBandIdsAreUniqueInBothGroupings() {
        let tasks = [
            task("a", project: "focus"), task("b", project: "Focus"),
            task("c", project: ""), task("d", pinned: false),
        ]
        for grouping in BoardGrouping.allCases {
            let ids = BoardModel.bands(
                tasks: tasks, sessions: [],
                tierOf: ["a": "focus"], tierOrder: ["focus": ["a"]], customTiers: [],
                grouping: grouping, now: Self.now
            ).map(\.bandId)
            XCTAssertEqual(Set(ids).count, ids.count, "\(grouping) produced duplicate band ids: \(ids)")
        }
    }

    /// `hide done` is keyed by BAND id, and a project literally called "focus"
    /// must not inherit the Focus tier's switch. That is the entire reason
    /// project bands are namespaced.
    func testHideDoneIsKeyedByBandIdSoAProjectCannotCollideWithATier() {
        let tasks = [
            task("t1", project: "focus"),
            task("t2", project: "focus", status: "done", phase: "COMPLETE"),
        ]
        let bands = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: [:], tierOrder: [:], customTiers: [],
            grouping: .project, hiddenDoneTiers: ["focus"], now: Self.now
        )
        XCTAssertEqual(bands.map(\.bandId), [BoardModel.projectBandPrefix + "focus"])
        XCTAssertEqual(bands.first?.rows.map(\.id), ["t1", "t2"],
            "the tier's key must not hide the same-named project's done row")
        XCTAssertEqual(bands.first?.hiddenDone, 0)

        // The project's OWN key does hide it.
        let hidden = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: [:], tierOrder: [:], customTiers: [],
            grouping: .project, hiddenDoneTiers: [BoardModel.projectBandPrefix + "focus"],
            now: Self.now
        )
        XCTAssertEqual(hidden.first?.rows.map(\.id), ["t1"])
        XCTAssertEqual(hidden.first?.hiddenDone, 1, "and the heading says what to un-hide")
    }

    // MARK: - The filter bar's own vocabulary and persistence

    /// The words on the phone's controls are the desktop's words. Both surfaces
    /// call the same thing the same thing, or "align the features" is only half
    /// done.
    func testFilterLabelsMatchTheDesktopVocabulary() {
        XCTAssertEqual(BoardGrouping.tier.label, "Tier")
        XCTAssertEqual(BoardGrouping.project.label, "By project")
        XCTAssertEqual(BoardDateFilter.all.label, "All")
        XCTAssertEqual(BoardDateFilter.now.label, "Now")
    }

    /// Every raw value rides an accessibility identifier (`board.group.<raw>` /
    /// `board.date.<raw>`), and automation matches those as REGEXES.
    func testFilterRawValuesAreAutomationSafe() {
        for raw in BoardGrouping.allCases.map(\.rawValue) + BoardDateFilter.allCases.map(\.rawValue) {
            XCTAssertFalse(raw.isEmpty)
            XCTAssertTrue(raw.allSatisfy { $0.isLetter || $0.isNumber },
                "\(raw) must stay inside [A-Za-z0-9] to be addressable")
        }
    }

    /// A stored preference round-trips, and anything unrecognized (an older build,
    /// a hand-edited defaults plist) falls back to the default rather than to
    /// nothing: a preference is never worth an empty screen.
    func testStoredFilterPreferencesRoundTripAndSurviveGarbage() {
        for grouping in BoardGrouping.allCases {
            XCTAssertEqual(BoardFilterPrefs.grouping(grouping.rawValue), grouping)
        }
        for filter in BoardDateFilter.allCases {
            XCTAssertEqual(BoardFilterPrefs.dateFilter(filter.rawValue), filter)
        }
        for junk in ["", "none", "project ", "NOW", "overdue", "this-week"] {
            XCTAssertEqual(BoardFilterPrefs.grouping(junk), BoardFilterPrefs.defaultGrouping)
            XCTAssertEqual(BoardFilterPrefs.dateFilter(junk), BoardFilterPrefs.defaultDateFilter)
        }
    }

    /// The board opens on TIER + ALL, which is where this surface deliberately
    /// disagrees with the desktop (project + now). Tier because the tier split IS
    /// the board's structure; All because `now` HIDES rows and the last bug on
    /// this screen was a task that existed everywhere except here.
    func testTheBoardOpensOnTierAndAll() {
        XCTAssertEqual(BoardFilterPrefs.defaultGrouping, .tier)
        XCTAssertEqual(BoardFilterPrefs.defaultDateFilter, .all)
    }

    /// An empty board must say WHY it is empty. "Nothing pinned yet" over a board
    /// full of deferred work is a lie that sends the user hunting for a bug, so
    /// the `Now` case names the filter: the control to undo it is one row above.
    func testTheEmptyBoardBlamesTheFilterThatEmptiedIt() {
        XCTAssertTrue(
            TasksView.boardEmptyText(query: "", dateFilter: .now).contains("All"),
            "a Now-emptied board must point at the control that undoes it"
        )
        XCTAssertEqual(
            TasksView.boardEmptyText(query: "", dateFilter: .all),
            "Nothing pinned yet — pin a task to put it on the board."
        )
        // A live query outranks both: the user typed something, that is the reason.
        for filter in BoardDateFilter.allCases {
            XCTAssertEqual(
                TasksView.boardEmptyText(query: "alpha", dateFilter: filter),
                "No matches on the board."
            )
        }
    }

    // MARK: - One task, one row (the search-on-the-board dedup)

    /// A search on the board shows the matching bands AND (historically) the
    /// matching open tasks below them. The exclusion is what keeps a task that
    /// belongs to both sets from rendering TWICE on one screen — the exact
    /// confusion ("task and session feel too separate") this redesign removes.
    ///
    /// Note what changed when the tail band stopped being session-gated: the
    /// board now contains EVERY open task, so `rowIds` covers both rows and the
    /// supplementary hit list comes back empty. That is the point — the appended
    /// hits existed to patch a hole in the board (dogfood R17: a task the user
    /// knew existed showed "No local matches"), and the hole is gone. The
    /// mechanism stays because it is what makes "no row twice" true by
    /// construction rather than by the tail happening to be narrow.
    func testASearchOnTheBoardNeverShowsOneTaskTwice() {
        let pinned = task("pinned", title: "alpha work", project: "marina")
        let loose = task("loose", title: "alpha elsewhere", project: "marina", pinned: false)
        let bands = BoardModel.bands(
            tasks: [pinned, loose], sessions: [],
            tierOf: ["pinned": "focus"], tierOrder: ["focus": ["pinned"]],
            customTiers: [], query: "alpha"
        )
        XCTAssertEqual(bands.first?.rows.map(\.id), ["pinned"])
        XCTAssertEqual(bands.last?.rows.map(\.id), ["loose"],
            "the unpinned match is on the board itself now, not only in the hit list")

        let alreadyShown = BoardModel.rowIds(bands)
        XCTAssertEqual(alreadyShown, ["loose", "pinned"])

        let hits = TasksView.sections(
            from: [pinned, loose], query: "alpha", excluding: alreadyShown
        )
        XCTAssertEqual(hits.flatMap(\.tasks).map(\.id), [],
            "both rows are already on screen — appending either would be a duplicate")
    }

    func testRowIdsCoversEveryBandIncludingTheUnpinnedTail() {
        let bands = BoardModel.bands(
            tasks: [task("p"), task("u", pinned: false)],
            sessions: [session("s", taskId: "u", status: "running")],
            tierOf: ["p": "focus"], tierOrder: ["focus": ["p"]], customTiers: []
        )
        XCTAssertEqual(BoardModel.rowIds(bands), ["p", "u"])
    }

    func testRowIdsOfNoBandsIsEmpty() {
        XCTAssertTrue(BoardModel.rowIds([]).isEmpty)
    }

    // MARK: - ONE id space under board.row.* (the search duplicate's direct cause)

    /// The measured defect (R25): a row whose owning task is missing from the phone's
    /// slim projection was keyed by the CLI SESSION UUID (`board.row.a1d81a24-…`) while
    /// every other row was keyed by the task id. Nothing else on the screen speaks that
    /// id space, so the server's hit for the same task (`mro772x3-1599`) matched nothing
    /// and the task drew twice, 55pt apart.
    ///
    /// The session already carries its owner, so the row can be keyed by the task in
    /// both cases and the session id is a last resort rather than a parallel space.
    func testASessionOnlyRowIsKeyedByItsOwningTaskNotTheSessionUUID() {
        let uuid = "a1d81a24-58cc-4372-a567-0e02b2c3d479"
        let row = BoardRow(task: nil, session: session(uuid, taskId: "mro772x3-1599"))
        XCTAssertEqual(row.owningTaskId, "mro772x3-1599")
        XCTAssertEqual(row.id, "mro772x3-1599", "board.row.<session uuid> was the duplicate's cause")
    }

    /// The last resort is still there: a session that owns nothing has nothing else to be.
    func testASessionThatOwnsNothingStillFallsBackToItsOwnId() {
        let unowned: [String?] = [nil, ""]
        for taskId in unowned {
            let row = BoardRow(task: nil, session: session("s9", taskId: taskId))
            XCTAssertNil(row.owningTaskId)
            XCTAssertEqual(row.id, "s9")
        }
    }

    /// Keyed by the task, whichever half of the row carries it.
    func testTheOwningTaskWinsOverTheSessionsOpinion() {
        let row = BoardRow(task: task("t1"), session: session("s1", taskId: "t1"))
        XCTAssertEqual(row.owningTaskId, "t1")
        XCTAssertEqual(row.id, "t1")
    }

    /// A whole board's worth: the tail band's session-only row lands in the same id space
    /// as every task row, so `rowIds` (and therefore the local-section exclusion) can see
    /// it at all.
    func testTheBoardsRowIdsAreOneSpace() {
        let uuid = "a1d81a24-58cc-4372-a567-0e02b2c3d479"
        let bands = BoardModel.bands(
            tasks: [task("p")],
            sessions: [
                session("s-known", taskId: "p", status: "running"),
                session(uuid, taskId: "mro772x3-1599", status: "running"),
            ],
            tierOf: ["p": "focus"], tierOrder: ["focus": ["p"]], customTiers: []
        )
        XCTAssertEqual(BoardModel.rowIds(bands), ["p", "mro772x3-1599"])
        XCTAssertFalse(BoardModel.rowIds(bands).contains(uuid), "the UUID id space is gone")
    }

    /// `searchDedupIds` is the SUPERSET the server-hit dedup needs: every id one row can
    /// be recognised by, so a hit is dropped regardless of which id the row was keyed by.
    func testSearchDedupIdsCarryEveryIdARowAnswersTo() {
        let uuid = "a1d81a24-58cc-4372-a567-0e02b2c3d479"
        let bands = BoardModel.bands(
            tasks: [task("p")],
            sessions: [
                session("s-known", taskId: "p", status: "running"),
                session(uuid, taskId: "mro772x3-1599", status: "running"),
            ],
            tierOf: ["p": "focus"], tierOrder: ["focus": ["p"]], customTiers: []
        )
        let ids = BoardModel.searchDedupIds(bands)
        XCTAssertTrue(ids.isSuperset(of: BoardModel.rowIds(bands)), "it must not lose a row key")
        for expected in ["p", "s-known", "mro772x3-1599", uuid] {
            XCTAssertTrue(ids.contains(expected), "\(expected) is an id a visible row answers to")
        }
    }

    func testSearchDedupIdsOfNoBandsIsEmpty() {
        XCTAssertTrue(BoardModel.searchDedupIds([]).isEmpty)
    }

    /// The default (no exclusion) must be byte-for-byte the old behaviour — every
    /// other filter calls this and none of them wants a dedup.
    func testSectionsWithoutAnExclusionIsUnchanged() {
        let rows = [task("a", title: "alpha", project: "marina"), task("b", title: "alpha", project: "")]
        let sections = TasksView.sections(from: rows, query: "alpha")
        XCTAssertEqual(sections.map(\.project), ["Inbox", "marina"], "headers A→Z, Inbox for \"\"")
        XCTAssertEqual(sections.flatMap(\.tasks).count, 2)
    }

    // MARK: - The floating band bar's chips (which replaced the letter rail)
    //
    // Six tests died here with the rail (2026-08-29, T84): they pinned that its
    // glyphs were unique across bands, one character long, inside [A-Z0-9] for
    // every script, and that the digit fallback took over when a label had no
    // usable ASCII letter left. Nothing they protected still exists — there is no
    // glyph, no per-band single character, no `board.rail.<glyph>` identifier — so
    // they are not replaced one-for-one. What they were ULTIMATELY protecting (an
    // ASCII, unique, stable identifier per band) is now the chip's job and is
    // pinned harder below, by `testBandChipIdentifiersAreAsciiAndDistinct` and by
    // the slug tests at the foot of this file: the rail could only ever manage
    // uniqueness within one render, while a slug is stable across launches.

    /// The chips ARE the bands: same order, same labels, same counts, plus a
    /// leading `All` carrying their sum. Stated as equality against `bands` rather
    /// than against a hand-written list, because the failure this rules out is the
    /// two drifting apart — a chip row built from its own query is how the board
    /// would get a second opinion about what a band contains.
    func testChipsMirrorTheBandsPlusAnAllChip() {
        let bands = BoardModel.bands(
            tasks: [task("a"), task("b"), task("c"), task("loose", pinned: false)],
            sessions: [],
            tierOf: ["a": "focus", "b": "focus", "c": "backlog"],
            tierOrder: ["focus": ["a", "b"], "backlog": ["c"]], customTiers: []
        )
        let chips = BoardModel.chips(bands)
        guard let all = chips.first else { return XCTFail("the All chip must always exist") }
        // Unwrapped before asserting on `bandId`: `chips.first?.bandId` is a DOUBLE
        // optional, and `XCTAssertNil` on `.some(.none)` does not mean what it reads
        // as.
        XCTAssertNil(all.bandId, "All leads, and it selects no band")
        XCTAssertEqual(all.label, "All")
        XCTAssertEqual(all.count, 4, "All carries the whole board's rows")

        let bandChips = Array(chips.dropFirst())
        XCTAssertEqual(bandChips.count, bands.count, "one chip per band, no more")
        XCTAssertEqual(bandChips.compactMap(\.bandId), bands.map(\.bandId),
            "same bands, same order — and every one of them has a band id")
        XCTAssertEqual(bandChips.map(\.label), bands.map(\.label))
        XCTAssertEqual(bandChips.map(\.count), bands.map(\.count))
    }

    /// A chip's count is the band's VISIBLE count, so `hide done` moves both
    /// together. A chip that counted hidden rows would disagree with the heading
    /// immediately below it.
    func testChipCountsFollowTheVisibleRowsLikeTheHeadingDoes() {
        let tasks = [task("a"), task("b", status: "done", phase: "COMPLETE")]
        let bands = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: ["a": "focus", "b": "focus"],
            tierOrder: ["focus": ["a", "b"]], customTiers: [], hiddenDoneTiers: ["focus"]
        )
        let chips = BoardModel.chips(bands)
        XCTAssertEqual(chips.first?.count, 1, "All counts what the board shows")
        XCTAssertEqual(chips.last?.count, bands.first?.count)
    }

    func testAnEmptyBoardStillOffersTheAllChip() {
        // The bar has to render on an empty board: it holds the grouping/date
        // controls, and a `Now` that hid every row must never also hide the control
        // that turns it off.
        let chips = BoardModel.chips([])
        XCTAssertEqual(chips.count, 1)
        guard let all = chips.first else { return XCTFail("the All chip must always exist") }
        XCTAssertNil(all.bandId)
        XCTAssertEqual(all.count, 0)
    }

    /// Tapping a chip narrows the board to that band, and it does so by FILTERING
    /// the assembled bands — one code path decides membership. The assertion is
    /// identity of the rows, not just of the count.
    func testSelectingABandChipNarrowsTheBoardToThatBandOnly() {
        let bands = BoardModel.bands(
            tasks: [task("a"), task("b"), task("c")], sessions: [],
            tierOf: ["a": "focus", "b": "backlog", "c": "backlog"],
            tierOrder: ["focus": ["a"], "backlog": ["b", "c"]], customTiers: []
        )
        let narrowed = BoardModel.filtered(bands, selected: "backlog")
        XCTAssertEqual(narrowed.map(\.bandId), ["backlog"])
        XCTAssertEqual(narrowed.first?.rows.map(\.id), ["b", "c"],
            "the rows are the band's own, untouched — not a re-query")
        XCTAssertEqual(BoardModel.selectedChip(bands, selected: "backlog"), "backlog")
    }

    func testTheAllChipShowsTheWholeBoard() {
        let bands = BoardModel.bands(
            tasks: [task("a"), task("b")], sessions: [],
            tierOf: ["a": "focus", "b": "backlog"],
            tierOrder: ["focus": ["a"], "backlog": ["b"]], customTiers: []
        )
        XCTAssertEqual(BoardModel.filtered(bands, selected: nil).map(\.bandId),
                       bands.map(\.bandId))
        XCTAssertNil(BoardModel.selectedChip(bands, selected: nil))
    }

    /// A selected band can vanish under the user: its last row completed, `hide
    /// done` swallowed it, a query narrowed it away, the grouping replaced every
    /// band id at once. Answering "no bands" there would show an empty board with
    /// no explanation, which is the disappearing-task failure mode one level up. So
    /// an unknown selection falls back to the WHOLE board, and the lit chip falls
    /// back to All so the bar never disagrees with the rows.
    func testASelectionThatNoLongerExistsFallsBackToTheWholeBoard() {
        let bands = BoardModel.bands(
            tasks: [task("a"), task("b")], sessions: [],
            tierOf: ["a": "focus", "b": "backlog"],
            tierOrder: ["focus": ["a"], "backlog": ["b"]], customTiers: []
        )
        for stale in ["wait", "ct_gone99", BoardModel.projectBandPrefix + "marina", ""] {
            XCTAssertEqual(
                BoardModel.filtered(bands, selected: stale).map(\.bandId),
                bands.map(\.bandId),
                "a selection of \(stale) must not empty the board"
            )
            XCTAssertNil(BoardModel.selectedChip(bands, selected: stale),
                "and the All chip is what reads as selected")
        }
        // Including when there is no board at all.
        XCTAssertTrue(BoardModel.filtered([], selected: "focus").isEmpty)
    }

    /// The chips' own identity has to be unique or SwiftUI's `ForEach` drops one.
    /// `All` uses a sentinel that a band id cannot collide with because band ids are
    /// either a tier id or `proj:`-prefixed.
    func testChipIdentitiesAreUnique() {
        let bands = BoardModel.bands(
            tasks: [task("a", project: "marina"), task("b", project: "acme")],
            sessions: [], tierOf: [:], tierOrder: [:], customTiers: [],
            grouping: .project, now: Self.now
        )
        let ids = BoardModel.chips(bands).map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "duplicate chip identity: \(ids)")
    }

    /// Every chip's accessibility identifier: ASCII, regex-safe, and DISTINCT even
    /// for the CJK names that the old fold made ambiguous. `board.chip.all` is
    /// spelled out because a flow taps it by name.
    func testBandChipIdentifiersAreAsciiAndDistinct() {
        XCTAssertEqual(TaskBoardList.chipId(nil), "board.chip.all")
        XCTAssertEqual(TaskBoardList.chipId("focus"), "board.chip.focus")

        let bandIds = ["focus", "satellite", "backlog", "wait", "ct_abc12345",
                       BoardModel.activeTierId]
            + ["", "marina", "工作", "生活", "a|b", "café"]
                .map { BoardModel.projectBandPrefix + $0 }
        let ids = bandIds.map { TaskBoardList.chipId($0) } + [TaskBoardList.chipId(nil)]
        XCTAssertEqual(Set(ids).count, ids.count, "two chips share an identifier: \(ids)")
        let safe = try! NSRegularExpression(pattern: "^[A-Za-z0-9._-]+$")
        for id in ids {
            XCTAssertNotNil(
                safe.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)),
                "\(id) is not regex-safe"
            )
        }
    }

    // Expansion is GONE (2026-08-28). A board row's tap opens the session
    // directly; the tier picker and the task's own page moved to the row's
    // swipe/long-press gestures, so there is no expanded state left to toggle.

    // MARK: - Tier tokens → mutation

    func testTokensCoverEveryChoicePlusUnpinAndMarkTheCurrentOne() {
        let choices = TasksStore.builtinTiers.map { (id: $0.id, label: $0.label) }
        let tokens = BoardModel.tokens(current: "backlog", choices: choices)
        XCTAssertEqual(tokens.map(\.id), ["focus", "satellite", "backlog", "wait", "unpin"])
        XCTAssertEqual(tokens.filter(\.selected).map(\.tierId), ["backlog"],
            "exactly one token reads as selected")
        XCTAssertEqual(tokens.last?.isUnpin, true)
        XCTAssertEqual(tokens.last?.selected, false, "Unpin is an action, never a state")
    }

    func testAnUnpinnedRowHasNoSelectedToken() {
        let tokens = BoardModel.tokens(
            current: nil, choices: TasksStore.builtinTiers.map { (id: $0.id, label: $0.label) }
        )
        XCTAssertTrue(tokens.filter(\.selected).isEmpty)
    }

    func testTokenIdsAreAutomationSafe() {
        let tokens = BoardModel.tokens(
            current: nil,
            choices: [("focus", "Focus"), ("ct_abc12345", "Deep Work")]
        )
        for token in tokens {
            XCTAssertFalse(token.id.contains("|"), "\(token.id) would read as a regex alternation")
            XCTAssertFalse(token.id.isEmpty)
        }
    }

    /// The whole mutation rule: a token maps to exactly one action, and the token
    /// that is already selected costs no request.
    func testTappingATierTokenMapsToTheRightMutation() {
        let choices = TasksStore.builtinTiers.map { (id: $0.id, label: $0.label) }
        let tokens = BoardModel.tokens(current: "focus", choices: choices)

        let focus = tokens.first { $0.tierId == "focus" }!
        XCTAssertEqual(BoardModel.action(for: focus, current: "focus"), .noop,
            "tapping the tier you are already in must not spend a request")

        let wait = tokens.first { $0.tierId == "wait" }!
        XCTAssertEqual(BoardModel.action(for: wait, current: "focus"), .setTier("wait"))

        let unpin = tokens.first(where: \.isUnpin)!
        XCTAssertEqual(BoardModel.action(for: unpin, current: "focus"), .unpin)
        XCTAssertEqual(BoardModel.action(for: unpin, current: nil), .noop,
            "unpinning something that isn't pinned is nothing")
    }

    func testTappingAnyTierOnAnUnpinnedRowSetsThatTier() {
        for tier in ["focus", "satellite", "backlog", "wait", "ct_abc12345"] {
            let token = BoardModel.TierToken(tierId: tier, label: tier, selected: false, isUnpin: false)
            XCTAssertEqual(BoardModel.action(for: token, current: nil), .setTier(tier))
        }
    }

    // MARK: - A row created at a band's foot STAYS at that band's foot

    /// The locate-me handler exists to answer "I created it, where did it go?" by
    /// switching to a filter that shows the new row. On the board that help is the
    /// opposite of helpful: the row was created at the foot of the band the user is
    /// looking at, so relocating them throws away the thing the create ring
    /// promises. Caught in the real UI — typing into the Backlog ring created the
    /// task and then jumped the screen to All Open.
    func testCreatingFromABandsFootDoesNotRelocateTheUser() {
        XCTAssertFalse(
            TasksView.shouldRelocateToNewTask(
                inlineAddActive: false, openAddGroup: nil, openCreateBand: "backlog"
            ),
            "the row is at the foot of the band the user is looking at — stay there"
        )
        // Same under project grouping, where the open band is `proj:<name>`: the
        // rule reads PRESENCE, never the id's shape, so a project ring behaves
        // exactly like a tier ring.
        XCTAssertFalse(
            TasksView.shouldRelocateToNewTask(
                inlineAddActive: false, openAddGroup: nil,
                openCreateBand: BoardModel.projectBandPrefix + "marina"
            ),
            "a project band's ring anchors the user just as a tier band's does"
        )
    }

    func testEveryOpenAddRowSuppressesTheRelocation() {
        XCTAssertFalse(TasksView.shouldRelocateToNewTask(
            inlineAddActive: true, openAddGroup: nil, openCreateBand: nil))
        XCTAssertFalse(TasksView.shouldRelocateToNewTask(
            inlineAddActive: false, openAddGroup: .tier("focus"), openCreateBand: nil))
        XCTAssertFalse(TasksView.shouldRelocateToNewTask(
            inlineAddActive: false, openAddGroup: nil, openCreateBand: "focus"))
    }

    /// With nothing open the help is still wanted: a task created from the toolbar
    /// `+` has no on-screen home, so the list should go find it.
    func testWithNoAddRowOpenTheRelocationStillHappens() {
        XCTAssertTrue(TasksView.shouldRelocateToNewTask(
            inlineAddActive: false, openAddGroup: nil, openCreateBand: nil))
    }

    // MARK: - Automation-safe band ids

    /// Every band id becomes an accessibility identifier, and automation matches
    /// those as REGEXES. Band ids used to be tier ids only; under project grouping
    /// they carry whatever the user called their project, which is exactly the
    /// hazard that once made an element unaddressable in this app.
    func testBandIdentifierSlugsAreRegexSafe() {
        let ids = ["focus", "ct_abc12345", BoardModel.activeTierId]
            + ["", "marina", "a|b", "walnut (v2)", "docs.and+more", "工作"]
                .map { BoardModel.projectBandPrefix + $0 }
        for bandId in ids {
            let slug = TaskBoardList.slug(bandId)
            XCTAssertFalse(slug.contains("|"), "\(bandId) → \(slug): a pipe reads as an alternation")
            XCTAssertTrue(slug.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" }, slug)
        }
    }

    func testBandAnchorIdsAreDistinctPerBand() {
        let ids = (["focus", "satellite", "ct_abc12345"]
            + ["proj:", "proj:marina", "proj:acme"]).map(TaskBoardList.anchorId)
        XCTAssertEqual(Set(ids).count, 6)
    }

    /// The anchor keeps the RAW band id while the accessibility id folds it. Two
    /// projects differing only in punctuation share a slug, and a scroll anchor
    /// that collided would teleport the rail to the wrong heading.
    func testAnchorIdsStayDistinctWhereSlugsCollide() {
        let a = BoardModel.projectBandPrefix + "walnut-ios"
        let b = BoardModel.projectBandPrefix + "walnut.ios"
        XCTAssertEqual(TaskBoardList.slug(a), TaskBoardList.slug(b), "the slugs DO collide")
        XCTAssertNotEqual(TaskBoardList.anchorId(a), TaskBoardList.anchorId(b),
            "so the scroll anchor must not be built from the slug")
    }

    // MARK: - The fold has to be ASCII, not "alphanumeric"

    /// The 2026-08-29 hole. `slug` folded with `isLetter || isNumber`, which are
    /// UNICODE-aware and answer TRUE for CJK ideographs — so a project named in
    /// Chinese passed through unchanged and shipped `board.heading.proj_<CJK>`,
    /// outside the [A-Za-z0-9._-] the repo requires because automation matches ids
    /// as regexes. The fold looked right and kept the one thing it existed to remove.
    ///
    /// `testBandIdentifierSlugsAreRegexSafe` above did not catch it: its assertion
    /// was `allSatisfy { isLetter || isNumber || "_" }` — the SAME Unicode-aware
    /// predicate as the code, so the test agreed with the bug. That is the trap this
    /// case exists to close: assert the CHARACTER SET, never re-use the
    /// implementation's own test.
    func testCJKProjectNamesFoldToAsciiOnlyIdentifiers() {
        for name in ["工作", "日本語のプロジェクト", "한국어", "café", "проект", "٣٤٥"] {
            let bandId = BoardModel.projectBandPrefix + name
            let slug = TaskBoardList.slug(bandId)
            XCTAssertTrue(
                slug.unicodeScalars.allSatisfy { $0.isASCII },
                "\(name) → \(slug): a non-ASCII id is unaddressable by automation"
            )
            XCTAssertTrue(
                slug.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_" },
                "\(name) → \(slug) must stay inside [a-z0-9_]"
            )
        }
    }

    /// The ids the board actually SHIPS for a CJK project, asserted at the same
    /// place they are built rather than on `slug` alone: the heading, the band's
    /// hide-done toggle, the count, the create ring and now the band chip all
    /// interpolate it.
    func testEveryBandIdentifierOfACJKProjectIsAsciiSafe() {
        let bandId = BoardModel.projectBandPrefix + "工作"
        let slug = TaskBoardList.slug(bandId)
        let safe = try! NSRegularExpression(pattern: "^[A-Za-z0-9._-]+$")
        for id in ["board.heading.\(slug)", "board.hideDone.\(slug)",
                   "board.count.\(slug)", "board.create.\(slug)",
                   "board.createRow.\(slug)", TaskBoardList.chipId(bandId)] {
            XCTAssertNotNil(
                safe.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)),
                "\(id) is not regex-safe"
            )
        }
    }

    // MARK: - The slug must be UNIQUE, not merely ASCII

    /// This case REPLACES `testTwoCJKProjectsShareASlugButKeepDistinctAnchors`,
    /// which pinned the opposite and was overturned on purpose (2026-08-29, T84).
    ///
    /// That test asserted the collision was "by design": `工作` and `生活` both
    /// folded to `proj___`, and the argument was that a slug only identifies an
    /// element for automation while the app's own identity (`anchorId`) stayed
    /// distinct. The argument was wrong about the consequence. Automation taps the
    /// FIRST match, so a flow aimed at 生活's heading, its `hide done`, its count,
    /// its create ring or its chip silently drove 工作's instead — it did something
    /// plausible with the wrong band, which is worse than failing to find anything.
    /// Ambiguity is not a cheaper kind of unaddressable.
    func testTwoCJKProjectsGetDistinctSlugs() {
        let a = BoardModel.projectBandPrefix + "工作"
        let b = BoardModel.projectBandPrefix + "生活"
        XCTAssertNotEqual(TaskBoardList.slug(a), TaskBoardList.slug(b),
            "two CJK projects must not share one identifier: \(TaskBoardList.slug(a))")
        // The anchor stays distinct too — it always was, and it is still the app's
        // own identity, keyed on the RAW id.
        XCTAssertNotEqual(TaskBoardList.anchorId(a), TaskBoardList.anchorId(b))
    }

    /// Distinctness over a set of names that all fold to the SAME underscores, which
    /// is the whole family the old fold collapsed.
    func testEveryNonAsciiProjectNameGetsItsOwnSlug() {
        let names = ["工作", "生活", "日本語", "한국어", "проект", "café", "naïve", "٣٤٥", "工作 "]
        let slugs = names.map { TaskBoardList.slug(BoardModel.projectBandPrefix + $0) }
        XCTAssertEqual(Set(slugs).count, names.count, "collision among \(slugs)")
        for slug in slugs {
            XCTAssertTrue(slug.unicodeScalars.allSatisfy { $0.isASCII }, slug)
            XCTAssertTrue(
                slug.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_" },
                "\(slug) must stay inside [a-z0-9_]"
            )
        }
    }

    /// STABLE, which is the property an accessibility identifier lives or dies by.
    /// The hash must be arithmetic over the bytes and nothing else: Swift's own
    /// `hashValue` is seeded per process, so an id built from it would differ every
    /// launch and a flow that tapped it would fail for reasons nobody can
    /// reproduce. Asserted as repeated calls AND as a literal, because "same twice
    /// in one process" is exactly what a seeded hash would also satisfy.
    func testSlugsAreStableAcrossCallsAndPinnedToLiterals() {
        let bandId = BoardModel.projectBandPrefix + "工作"
        let first = TaskBoardList.slug(bandId)
        for _ in 0..<5 {
            XCTAssertEqual(TaskBoardList.slug(bandId), first, "the slug drifted between calls")
        }
        // FNV-1a/32 over the lowercased UTF-8 bytes, low 16 bits, 4 lowercase hex.
        // A literal so a change of hash function has to be a deliberate edit here
        // (and it would be a breaking change for any flow already using the id).
        XCTAssertEqual(first, "proj____7174")
        XCTAssertEqual(TaskBoardList.slug(BoardModel.projectBandPrefix + "生活"), "proj____b903")
        XCTAssertEqual(TaskBoardList.shortHash("工作"), "09dd")
        XCTAssertEqual(TaskBoardList.shortHash(""), "9dc5",
            "the empty string is the FNV offset basis (0x811C9DC5), low 16 bits — no special case")
    }

    /// A REAL 16-bit hash collision, kept as a test because it is the reason the
    /// suffix is appended to the folded body instead of replacing it.
    ///
    /// `日本語` and `проект` both hash to `c13c` — found by measurement in a
    /// nine-name sample, not by construction. Their slugs are still distinct because
    /// the fold's own length survives (`proj_____c13c` vs `proj________c13c`), so a
    /// future "simplify this to just the hash" would break exactly here.
    func testAHashCollisionIsStillDistinguishedByTheFoldedBody() {
        let a = BoardModel.projectBandPrefix + "日本語"
        let b = BoardModel.projectBandPrefix + "проект"
        XCTAssertEqual(TaskBoardList.shortHash(a), TaskBoardList.shortHash(b),
            "these two really do collide on 16 bits — that is the premise")
        XCTAssertNotEqual(TaskBoardList.slug(a), TaskBoardList.slug(b),
            "the folded body must keep them apart when the hash cannot")
    }

    /// The hash rides the LOWERCASED name, so case-only differences collide exactly
    /// as they already do for ASCII (`Focus` and `focus` have always shared a slug).
    /// One fold rule, not two.
    func testSlugCaseFoldingIsConsistentBetweenAsciiAndNonAscii() {
        XCTAssertEqual(TaskBoardList.slug("proj:Marina"), TaskBoardList.slug("proj:marina"))
        XCTAssertEqual(TaskBoardList.slug("proj:CAFÉ"), TaskBoardList.slug("proj:café"))
    }

    /// A PURE-ASCII name keeps the id it shipped with, byte for byte. Shipped flows
    /// tap `board.createRow.backlog` and `board.create.focus`, so the hash suffix is
    /// a fix for the names that became ambiguous, never a new format for every id.
    func testAsciiNamesKeepTheirExistingSlugsByteForByte() {
        let unchanged: [String: String] = [
            "focus": "focus",
            "satellite": "satellite",
            "backlog": "backlog",
            "wait": "wait",
            "unpinned": "unpinned",
            "ct_abc12345": "ct_abc12345",
            "proj:": "proj_",
            "proj:marina": "proj_marina",
            "proj:walnut (v2)": "proj_walnut__v2_",
            "proj:docs.and+more": "proj_docs_and_more",
            "proj:a|b": "proj_a_b",
        ]
        for (bandId, expected) in unchanged {
            XCTAssertEqual(TaskBoardList.slug(bandId), expected,
                "\(bandId) changed identifier — existing automation depends on it")
            XCTAssertFalse(TaskBoardList.slug(bandId).contains(TaskBoardList.shortHash(bandId)),
                "\(bandId) grew a hash suffix it does not need")
        }
        XCTAssertEqual(BoardModel.activeTierId, "unpinned",
            "the tail band's id is one of the ASCII ids pinned above")
    }

    /// The residual cost, kept on purpose and stated so nobody 'fixes' it by
    /// hashing everything: two ASCII names differing only in punctuation still
    /// collide, because closing that would rename ids automation already uses. The
    /// anchor is what keeps the APP's identity distinct in that case, which is why
    /// `testAnchorIdsStayDistinctWhereSlugsCollide` must keep passing.
    func testAsciiPunctuationCollisionsAreStillAcceptedAndCoveredByTheAnchor() {
        let a = BoardModel.projectBandPrefix + "walnut-ios"
        let b = BoardModel.projectBandPrefix + "walnut.ios"
        XCTAssertEqual(TaskBoardList.slug(a), TaskBoardList.slug(b))
        XCTAssertNotEqual(TaskBoardList.anchorId(a), TaskBoardList.anchorId(b))
    }
}

/// The Tasks tab's THREE header entries, and the fallback for a filter that no
/// longer has one.
///
/// The header was six smart-list cards over `TaskFilter.allCases`; it is now Pin |
/// All Tasks | Calendar. The enum cases all stayed (stored preferences,
/// `identifierKey` suffixes in shipped ids, the store's own slices), so the entry
/// set and the filter set are deliberately different sizes and this is where that
/// difference is pinned.
final class TasksNavEntryTests: XCTestCase {

    func testThereAreExactlyThreeEntriesInReadingOrder() {
        XCTAssertEqual(TasksNavEntry.allCases.map(\.title), ["Pin", "All Tasks", "Calendar"])
        XCTAssertEqual(TasksNavEntry.allCases.map(\.filter), [.sessions, .allOpen, .calendar])
    }

    /// `Pin` IS the board, and the board is `TaskFilter.sessions` — the case keeps
    /// its old name so every stored preference and `tasks.compactChip.sessions`-era
    /// id still resolves.
    func testPinIsTheBoardFilter() {
        XCTAssertEqual(TasksNavEntry.pin.filter, TaskFilter.sessions)
        XCTAssertEqual(TasksNavEntry.entry(for: .sessions), TasksNavEntry.pin)
    }

    func testEveryFilterWithAnEntryResolvesToItself() {
        for entry in TasksNavEntry.allCases {
            XCTAssertEqual(TasksNavEntry.resolve(entry.filter), entry.filter)
            XCTAssertEqual(TasksNavEntry.entry(for: entry.filter), entry)
        }
    }

    /// The fallback. A persisted filter the header can no longer show would leave
    /// the nav row with nothing selected over a list the user cannot switch away
    /// from — a soft dead end. Today / In Progress / Done are exactly those.
    func testAFilterWithNoEntryFallsBackToPin() {
        for orphan in [TaskFilter.today, .inProgress, .done] {
            XCTAssertNil(TasksNavEntry.entry(for: orphan), "\(orphan) should have no chip")
            XCTAssertEqual(TasksNavEntry.resolve(orphan), TasksNavEntry.pin.filter,
                "\(orphan) must fall back to Pin, not to an unselected header")
        }
    }

    /// Every `TaskFilter` either has an entry or resolves to one, so no reachable
    /// state renders a header with nothing selected. This is the assertion that
    /// catches a future case being added without a decision about the header.
    func testEveryFilterIsEitherAnEntryOrResolvesToOne() {
        for filter in TaskFilter.allCases {
            XCTAssertNotNil(TasksNavEntry.entry(for: TasksNavEntry.resolve(filter)),
                "\(filter) resolves to a filter with no header entry")
        }
    }

    /// The ids automation taps. ASCII by construction, and spelled out because a
    /// flow matches them as literal regexes.
    func testNavEntryIdentifiers() {
        XCTAssertEqual(TasksNavEntry.pin.identifier, "tasks.nav.pin")
        XCTAssertEqual(TasksNavEntry.all.identifier, "tasks.nav.all")
        XCTAssertEqual(TasksNavEntry.calendar.identifier, "tasks.nav.calendar")
        let safe = try! NSRegularExpression(pattern: "^[A-Za-z0-9._-]+$")
        for entry in TasksNavEntry.allCases {
            let id = entry.identifier
            XCTAssertNotNil(
                safe.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)), id
            )
        }
    }

    /// The compact bar keys its chips off `TaskFilter.identifierKey`, so those ids
    /// have to survive the header rebuild verbatim.
    func testCompactChipIdentifiersAreUnchangedForTheThreeEntries() {
        XCTAssertEqual(TasksNavEntry.pin.filter.identifierKey, "sessions")
        XCTAssertEqual(TasksNavEntry.all.filter.identifierKey, "all")
        XCTAssertEqual(TasksNavEntry.calendar.filter.identifierKey, "calendarview")
    }
}

/// The tier ORDER projection — the half of the split that a dictionary throws
/// away, and the reason a task created into a band appears at its FOOT.
@MainActor
final class TaskBoardTierOrderTests: XCTestCase {

    private func split(
        pinned: [String], focus: [String] = [], satellite: [String] = [],
        backlog: [String] = [], wait: [String] = [], custom: [String: [String]] = [:]
    ) -> FocusTierResult {
        FocusTierResult(
            pinnedTasks: pinned, focusTasks: focus, satelliteTasks: satellite,
            backlogTasks: backlog, waitTasks: wait, customTierTasks: custom
        )
    }

    func testTierOrderKeepsEachBucketsServerOrder() {
        let order = TasksStore.tierOrder(from: split(
            pinned: ["f1", "f2", "s1", "b1", "w1", "c1"],
            focus: ["f1", "f2"], satellite: ["s1"], backlog: ["b1"], wait: ["w1"],
            custom: ["ct_abc12345": ["c1"]]
        ))
        XCTAssertEqual(order["focus"], ["f1", "f2"], "pin_order, verbatim")
        XCTAssertEqual(order["satellite"], ["s1"])
        XCTAssertEqual(order["backlog"], ["b1"])
        XCTAssertEqual(order["wait"], ["w1"])
        XCTAssertEqual(order["ct_abc12345"], ["c1"])
    }

    /// The server omits `satellite_tasks` when it considers it empty, but
    /// satellite is also "pinned and in no explicit bucket" — so it must be
    /// derived, or the default band would render unordered.
    func testSatelliteIsDerivedWhenTheServerOmitsIt() {
        let order = TasksStore.tierOrder(from: FocusTierResult(
            pinnedTasks: ["a", "b", "c"], focusTasks: ["a"], satelliteTasks: nil,
            backlogTasks: nil, waitTasks: nil, customTierTasks: nil
        ))
        XCTAssertEqual(order["satellite"], ["b", "c"], "in pinned_tasks order, which is pin_order")
        XCTAssertEqual(order["focus"], ["a"])
    }

    func testTierOrderAndTierMapAgreeOnEveryTask() {
        let result = split(
            pinned: ["a", "b", "c"], focus: ["a"], satellite: ["b"], wait: ["c"]
        )
        let map = TasksStore.tierMap(from: result)
        let order = TasksStore.tierOrder(from: result)
        for (taskId, tier) in map {
            XCTAssertTrue(order[tier]?.contains(taskId) == true,
                "\(taskId) is mapped to \(tier) but absent from that band's order")
        }
    }

    /// The move: the row leaves its old band and joins the FOOT of the new one,
    /// which is where the server's `pin_order = max + 1` will put it — so the row
    /// does not visibly hop when the authoritative split lands.
    func testMovingATierPutsTheRowAtTheFootOfItsNewBand() async {
        let mock = MockTaskTransport()
        // Server answers with the row already in wait, last.
        mock.tierSplitResult = FocusTierResult(
            pinnedTasks: ["x", "y", "moved"], focusTasks: ["x"],
            satelliteTasks: [], backlogTasks: [], waitTasks: ["y", "moved"],
            customTierTasks: [:]
        )
        let store = TasksStore(transport: mock)
        store.taskTiers = ["x": "focus", "y": "wait", "moved": "focus"]
        store.taskTierOrder = ["focus": ["x", "moved"], "wait": ["y"]]

        let error = await store.setTier(taskId: "moved", tier: "wait")
        XCTAssertNil(error)
        XCTAssertEqual(store.taskTierOrder["wait"], ["y", "moved"], "joins the foot")
        XCTAssertEqual(store.taskTierOrder["focus"], ["x"], "and leaves the old band")
    }

    func testAFailedTierMoveRestoresTheOrder() async {
        let mock = MockTaskTransport()
        mock.errorsByEndpoint["setTaskFocusTier"] = APIError.badResponse
        let store = TasksStore(transport: mock)
        store.taskTiers = ["moved": "focus"]
        store.taskTierOrder = ["focus": ["moved"], "wait": []]

        let error = await store.setTier(taskId: "moved", tier: "wait")
        XCTAssertNotNil(error)
        XCTAssertEqual(store.taskTiers["moved"], "focus", "the map rolls back")
        XCTAssertEqual(store.taskTierOrder["focus"], ["moved"], "and so does the order")
        XCTAssertEqual(store.taskTierOrder["wait"], [])
    }

    /// Create-at-foot, end to end through the store: a task born in a tier is in
    /// that band's order, last, on the very first frame.
    func testATaskCreatedIntoATierLandsAtTheFootOfThatBand() async throws {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        store.taskTiers = ["existing": "focus"]
        store.taskTierOrder = ["focus": ["existing"]]

        let created = try await store.createTask(title: "born in focus", pin: .tier("focus"))
        XCTAssertEqual(store.taskTierOrder["focus"], ["existing", created.id],
            "the create ring sits at the foot of the band and so does the row it makes")

        // And the board renders it there.
        let bands = BoardModel.bands(
            tasks: store.tasks, sessions: [],
            tierOf: store.taskTiers, tierOrder: store.taskTierOrder,
            customTiers: []
        )
        XCTAssertEqual(bands.first(where: { $0.bandId == "focus" })?.rows.last?.id, created.id)
    }

    /// A NEW pin defaults to satellite, at that band's foot.
    func testPinningPutsTheRowAtTheFootOfSatellite() async {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        let task = WalnutTask(
            id: "fresh", title: "t", status: "todo", phase: "TODO", priority: "none",
            project: "", dueDate: nil, createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: false, tags: nil, summary: nil
        )
        store.tasks = [task]
        store.taskTierOrder = ["satellite": ["already"]]

        let error = await store.setPinned(task, pinned: true)
        XCTAssertNil(error)
        XCTAssertEqual(store.taskTierOrder["satellite"], ["already", "fresh"])
    }

    func testUnpinningRemovesTheRowFromEveryBandOrder() async {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        let task = WalnutTask(
            id: "gone", title: "t", status: "todo", phase: "TODO", priority: "none",
            project: "", dueDate: nil, createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: true, tags: nil, summary: nil
        )
        store.tasks = [task]
        store.taskTiers = ["gone": "focus"]
        store.taskTierOrder = ["focus": ["gone", "stays"]]

        let error = await store.setPinned(task, pinned: false)
        XCTAssertNil(error)
        XCTAssertEqual(store.taskTierOrder["focus"], ["stays"])
        XCTAssertNil(store.taskTiers["gone"])
    }
}

/// The board's smart-list card count. It used to be `sessions.count`, which was
/// right for a session list and is a lie for a board of pinned tasks.
@MainActor
final class TaskBoardCountTests: XCTestCase {

    private func task(_ id: String, pinned: Bool) -> WalnutTask {
        WalnutTask(
            id: id, title: "t", status: "todo", phase: "TODO", priority: "none",
            project: "", dueDate: nil, createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: pinned, tags: nil, summary: nil
        )
    }

    func testTheBoardCardCountsPinnedTasksNotSessions() {
        let store = TasksStore(transport: MockTaskTransport())
        store.tasks = [task("a", pinned: true), task("b", pinned: true), task("c", pinned: false)]
        store.taskTiers = ["a": "focus", "b": "wait"]
        XCTAssertEqual(store.count(for: .sessions), 2, "the card counts the board it opens")
    }

    /// Before the tier split lands there is no map, and a "0" over a full board
    /// would read as broken — fall back to the projection's own pin flag.
    func testTheBoardCardFallsBackToThePinFlagBeforeTheSplitLands() {
        let store = TasksStore(transport: MockTaskTransport())
        store.tasks = [task("a", pinned: true), task("b", pinned: true), task("c", pinned: false)]
        XCTAssertTrue(store.taskTiers.isEmpty)
        XCTAssertEqual(store.count(for: .sessions), 2)
    }

    func testAnEmptyStoreCountsZeroWithoutCrashing() {
        let store = TasksStore(transport: MockTaskTransport())
        XCTAssertEqual(store.count(for: .sessions), 0)
    }
}
