import XCTest
import SwiftUI
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
        for state in [BoardRowState.running, .waiting, .handedBack, .ended, .failed,
                      .earlierSession, .none] {
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

    /// The number on a heading is what you can SEE in the band — toggling the done
    /// fold changes it, which is the feedback that the toggle worked. A count
    /// including hidden rows would disagree with the rows below it.
    ///
    /// The DEFAULT half is what this case now leads with: nobody has expanded
    /// anything, so the heading reads the band's OPEN count.
    func testHeadingCountMatchesTheVisibleRows() {
        let tasks = [task("a"), task("b", status: "done", phase: "COMPLETE"), task("c")]
        let order = ["focus": ["a", "b", "c"]]
        let tierOf = ["a": "focus", "b": "focus", "c": "focus"]

        let folded = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: tierOf, tierOrder: order, customTiers: []
        )
        XCTAssertEqual(folded.first?.count, 2, "the default count is the OPEN count")
        XCTAssertEqual(folded.first?.rows.map(\.id), ["a", "c"])
        XCTAssertEqual(folded.first?.hiddenDone, 1, "and says how many it is suppressing")

        let shown = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: tierOf, tierOrder: order,
            customTiers: [], shownDoneTiers: ["focus"]
        )
        XCTAssertEqual(shown.first?.count, 3, "the count follows the rows")
        XCTAssertEqual(shown.first?.rows.count, 3)
        XCTAssertEqual(shown.first?.hiddenDone, 0)
    }

    /// Done rows fold in EVERY band of a default board, not just the one being looked
    /// at — the reported defect, stated as the number the screen shows: `Focus 75` over
    /// 16 open rows and `All 270` over 91, because 179 of 270 pinned rows were finished.
    func testEveryBandFoldsItsDoneRowsWithNoToggleAtAll() {
        let tasks = [
            task("f1"), task("f2", status: "done", phase: "COMPLETE"),
            task("s1"), task("s2", status: "done", phase: "COMPLETE"),
            task("b1", status: "done", phase: "COMPLETE"),
        ]
        let bands = BoardModel.bands(
            tasks: tasks, sessions: [],
            tierOf: ["f1": "focus", "f2": "focus", "s1": "satellite", "s2": "satellite",
                     "b1": "backlog"],
            tierOrder: ["focus": ["f1", "f2"], "satellite": ["s1", "s2"], "backlog": ["b1"]],
            customTiers: []
        )
        for band in bands {
            XCTAssertTrue(band.rows.allSatisfy { !$0.isDone },
                "\(band.bandId) drew a completed row on a board nobody has expanded")
        }
        XCTAssertEqual(bands.map { $0.count }, [1, 1, 0], "every heading counts open work")
        XCTAssertEqual(bands.map { $0.hiddenDone }, [1, 1, 1],
            "and every one of them says how many it is holding back")
    }

    /// The toggle is the ONLY thing that brings them back, and it brings back exactly
    /// the band it was tapped on — a fold nobody can undo would be a delete.
    func testExpandingOneBandBringsBackThatBandsDoneRowsOnly() {
        let tasks = [
            task("f1"), task("f2", status: "done", phase: "COMPLETE"),
            task("s1"), task("s2", status: "done", phase: "COMPLETE"),
        ]
        func bands(_ shown: Set<String>) -> [BoardBand] {
            BoardModel.bands(
                tasks: tasks, sessions: [],
                tierOf: ["f1": "focus", "f2": "focus", "s1": "satellite", "s2": "satellite"],
                tierOrder: ["focus": ["f1", "f2"], "satellite": ["s1", "s2"]],
                customTiers: [], shownDoneTiers: shown
            )
        }
        let expanded = bands(["focus"])
        XCTAssertEqual(expanded.first(where: { $0.bandId == "focus" })?.rows.map(\.id),
            ["f1", "f2"], "the expanded band shows its done row, in place")
        XCTAssertEqual(expanded.first(where: { $0.bandId == "focus" })?.hiddenDone, 0)
        XCTAssertEqual(expanded.first(where: { $0.bandId == "satellite" })?.rows.map(\.id),
            ["s1"], "the band nobody touched is still folded")

        // …and folding it again is the same board it started as, so the toggle is a
        // round trip rather than a one-way door.
        XCTAssertEqual(bands([]).map { $0.rows.map(\.id) },
                       [["f1"], ["s1"]])
        XCTAssertEqual(bands(["focus"]).map { $0.rows.map(\.id) },
                       [["f1", "f2"], ["s1"]])
    }

    // MARK: - Done stays in place

    /// The load-bearing rule: completing a task does NOT move it. Its position
    /// is the memory of where the work happened, so it stays exactly where it was
    /// (struck through) rather than folding to the bottom of the band.
    ///
    /// Stated on an EXPANDED band, which is where the rule is now observable: folded is
    /// the default, and a folded band has no position to argue about. The rule itself is
    /// untouched by the flip — what the fold decides is whether the row is drawn, never
    /// where.
    func testCompletingATaskDoesNotMoveItWithinItsBand() {
        let order = ["focus": ["a", "b", "c"]]
        let tierOf = ["a": "focus", "b": "focus", "c": "focus"]
        let before = BoardModel.bands(
            tasks: [task("a"), task("b"), task("c")], sessions: [],
            tierOf: tierOf, tierOrder: order, customTiers: [], shownDoneTiers: ["focus"]
        )
        // Same tasks; the MIDDLE one is now done.
        let after = BoardModel.bands(
            tasks: [task("a"), task("b", status: "done", phase: "COMPLETE"), task("c")],
            sessions: [], tierOf: tierOf, tierOrder: order, customTiers: [],
            shownDoneTiers: ["focus"]
        )
        XCTAssertEqual(before.first?.rows.map(\.id), after.first?.rows.map(\.id),
            "a completion must not reorder the band")
        XCTAssertEqual(after.first?.rows[1].isDone, true, "it is struck through IN PLACE")
    }

    /// The done fold is PER BAND in both directions: expanding Focus must not also
    /// unfold Satellite, which the user isn't even looking at.
    func testHideDoneAffectsOnlyItsOwnBand() {
        let tasks = [
            task("f1"), task("f2", status: "done", phase: "COMPLETE"),
            task("s1"), task("s2", status: "done", phase: "COMPLETE"),
        ]
        let bands = BoardModel.bands(
            tasks: tasks, sessions: [],
            tierOf: ["f1": "focus", "f2": "focus", "s1": "satellite", "s2": "satellite"],
            tierOrder: ["focus": ["f1", "f2"], "satellite": ["s1", "s2"]],
            customTiers: [], shownDoneTiers: ["satellite"]
        )
        XCTAssertEqual(bands.first(where: { $0.bandId == "focus" })?.rows.map(\.id), ["f1"])
        XCTAssertEqual(bands.first(where: { $0.bandId == "satellite" })?.rows.map(\.id), ["s1", "s2"])
    }

    /// A band that is ALL done and folded must still render its heading, or the
    /// `show done (N)` toggle that would bring the rows back would be gone too. With
    /// folding the default this is the shape of a whole finished band on a cold board,
    /// not an edge case someone has to reach by tapping.
    func testABandHidingEveryRowKeepsItsHeading() {
        let bands = BoardModel.bands(
            tasks: [task("d", status: "done", phase: "COMPLETE")], sessions: [],
            tierOf: ["d": "focus"], tierOrder: ["focus": ["d"]],
            customTiers: []
        )
        XCTAssertEqual(bands.map(\.bandId), ["focus"])
        XCTAssertEqual(bands.first?.rows.count, 0)
        XCTAssertEqual(bands.first?.hiddenDone, 1, "the heading can say what to un-hide")
    }

    // MARK: - The board IS the pinned working set (the tail band is gone)
    //
    // Every case in this section used to assert the OPPOSITE — that an unpinned
    // task, and a session owning nothing, landed in a trailing "Everything else"
    // band. That band was the COMPLEMENT of every tier: 2,903 of 3,161 rows on the
    // real store, rebuilt and re-sorted on every body pass, and summed into an
    // `All 3,175` chip over a working set of ~264.
    //
    // "已经有 pin 了,为什么还会有 all task" retired it. The board is the pinned
    // working set, so NOT being pinned is a complete answer to "why is this row not
    // here", and unpinned work is reached by SEARCH (a server query) rather than by
    // walking the store on the phone.
    //
    // The guarantee that mattered survives one scope smaller and is what these cases
    // now pin: a PINNED task can never be missing, whichever half of the tier split
    // knows about the pin. A tier still decides WHICH band, never WHETHER.

    /// THE board's completeness guarantee, restated for the pinned scope, and still
    /// the bug the user reported: a task pinned with NO tier anywhere (the split
    /// hasn't landed, or landed and was overwritten) must not fall between the
    /// bands. `pinned == true` alone is enough to put it on the board.
    func testAPinnedTaskWithNoTierAndNoSessionStillHasARow() {
        let bands = BoardModel.bands(
            tasks: [task("plain")], sessions: [],
            tierOf: [:], tierOrder: [:], customTiers: []
        )
        XCTAssertEqual(bands.map(\.bandId), [BoardModel.defaultTierId],
            "a pin with no tier lands in the tier the split is about to give it")
        XCTAssertEqual(bands.first?.rows.map(\.id), ["plain"])
    }

    /// The other half of the same rule, and the one this round adds: a task that is
    /// NOT pinned has no row at all. Stated over a mixed set so a future filter
    /// cannot quietly widen the board back to the store.
    func testAnUnpinnedTaskHasNoRowOnTheBoardAtAll() {
        let tasks = [
            task("filed"), task("loose", pinned: false),
            task("busy", pinned: false), task("finished", status: "done", phase: "COMPLETE"),
        ]
        let bands = BoardModel.bands(
            tasks: tasks,
            // `busy` even has a live session, which is the strongest claim an
            // unpinned task can make — and it is still not a pin.
            sessions: [session("s", taskId: "busy", status: "running")],
            tierOf: ["filed": "focus"], tierOrder: ["focus": ["filed"]], customTiers: [],
            // MEMBERSHIP is the question here, not the done fold, so the band `finished`
            // lands in (a pin with no tier takes the default one) is expanded — a folded
            // row would leave "pinned but finished" and "not pinned at all" looking alike.
            shownDoneTiers: [BoardModel.defaultTierId]
        )
        let shown = Set(bands.flatMap(\.rows).map(\.id))
        XCTAssertEqual(shown, ["filed", "finished"],
            "the board is the PINNED working set: an unpinned task is not on it")
        XCTAssertFalse(shown.contains("loose"))
        XCTAssertFalse(shown.contains("busy"),
            "a live session does not put an unpinned task back on the board")
    }

    /// Both halves of the split are read, because dropping an id one half names and
    /// the other has not caught up with is exactly how a row goes missing. The
    /// projection here says NOT pinned for `ordered` — the split's order array is the
    /// only evidence of the pin, and it is enough.
    func testEitherHalfOfTheTierSplitIsEnoughToPutARowOnTheBoard() {
        let bands = BoardModel.bands(
            tasks: [task("mapped", pinned: false), task("ordered", pinned: false)],
            sessions: [],
            tierOf: ["mapped": "focus"],
            tierOrder: ["backlog": ["ordered"]], customTiers: []
        )
        XCTAssertEqual(
            Set(bands.flatMap(\.rows).map(\.id)), ["mapped", "ordered"],
            "a tier named by EITHER half of the split is a pin the board must honour"
        )
        XCTAssertEqual(bands.first(where: { $0.bandId == "focus" })?.rows.map(\.id), ["mapped"])
        XCTAssertEqual(bands.first(where: { $0.bandId == "backlog" })?.rows.map(\.id), ["ordered"])
    }

    /// A tier id the board does not render (a custom tier deleted while a task still
    /// pointed at it) must fold to the default band rather than naming a band nothing
    /// draws — which would drop the row silently, the original defect one level down.
    func testAnUnknownTierFoldsToTheDefaultBandRatherThanVanishing() {
        let bands = BoardModel.bands(
            tasks: [task("orphaned")], sessions: [],
            tierOf: ["orphaned": "ct_deleted9"], tierOrder: [:], customTiers: []
        )
        XCTAssertEqual(bands.map(\.bandId), [BoardModel.defaultTierId])
        XCTAssertEqual(bands.first?.rows.map(\.id), ["orphaned"])
    }

    /// A session whose owning task never reached the slim projection still gets a
    /// row, because the SESSION's own pin flag is the only evidence available that
    /// the missing task belongs on the board. It files into the tier the session
    /// reports, which is the value the split would have given for that task.
    func testAPinnedSessionWhoseTaskIsMissingFromTheProjectionKeepsARow() {
        let bands = BoardModel.bands(
            tasks: [], sessions: [
                session("ghost", taskId: "gone-from-projection", status: "running"),
            ],
            tierOf: [:], tierOrder: [:], customTiers: []
        )
        XCTAssertEqual(bands.map(\.bandId), [BoardModel.defaultTierId])
        // ONE id space (R25): keyed by the OWNING TASK, never by the session UUID.
        XCTAssertEqual(bands.first?.rows.map(\.id), ["gone-from-projection"])
        XCTAssertEqual(bands.first?.rows.first?.canRetier, false,
            "the projection has no task to retier, so the row shows no tier picker")
    }

    /// A session that owns NOTHING has no row: there is no task to be pinned, so the
    /// board has nothing to say about it. 96 such sessions were a measured part of
    /// the `All 3,175` this round removes.
    func testASessionThatOwnsNoTaskHasNoRow() {
        let bands = BoardModel.bands(
            tasks: [], sessions: [
                session("orphan", taskId: nil, status: "running"),
                session("dead", taskId: "", status: "stopped"),
            ],
            tierOf: [:], tierOrder: [:], customTiers: []
        )
        XCTAssertTrue(bands.isEmpty, "a session with no owning task is not a board row")
    }

    /// The task's OWN flag outranks a session's memory of a pin: when the projection
    /// HAS the task and says it is not pinned, a session still reporting `pinned`
    /// must not resurrect it. Otherwise unpinning a task with a session would leave
    /// the row behind.
    func testAnUnpinnedTaskIsNotResurrectedByItsSessionsPinFlag() {
        let bands = BoardModel.bands(
            tasks: [task("unpinned-now", pinned: false)],
            sessions: [session("s", taskId: "unpinned-now", status: "running")],
            tierOf: [:], tierOrder: [:], customTiers: []
        )
        XCTAssertTrue(bands.isEmpty,
            "the projection's own pin flag is authoritative over a session's memory")
    }

    /// A query narrows what a band SHOWS and nothing else. It used to be able to push
    /// a search-hidden tier row into the tail (where it would appear twice as the
    /// query narrowed); with no tail there is nowhere for it to reappear, and this
    /// pins that the filtered row simply stays filtered out.
    func testASearchHiddenRowStaysHiddenAndNeverDrawsTwice() {
        let bands = BoardModel.bands(
            tasks: [task("filed", title: "Alpha"), task("other", title: "Beta")],
            sessions: [],
            tierOf: ["filed": "focus", "other": "backlog"],
            tierOrder: ["focus": ["filed"], "backlog": ["other"]],
            customTiers: [], query: "Beta"
        )
        let shown = bands.flatMap(\.rows).map(\.id)
        XCTAssertEqual(shown, ["other"], "the filtered-out row stays filtered out")
        XCTAssertEqual(shown.count, Set(shown).count, "no id may render twice")
    }

    /// One row, one band. `tierById` is the single answer to "which band owns this
    /// row", so a split bucket that still names a task some other tier now claims
    /// cannot draw it a second time.
    func testAPinnedTaskAppearsInExactlyOneBand() {
        let bands = BoardModel.bands(
            tasks: [task("t")], sessions: [session("s", taskId: "t", status: "running")],
            tierOf: ["t": "focus"],
            // A stale bucket still naming `t` under backlog: the map wins, and
            // backlog must not render a duplicate.
            tierOrder: ["focus": ["t"], "backlog": ["t"]], customTiers: []
        )
        XCTAssertEqual(bands.map(\.bandId), ["focus"], "one row, one band — never two")
        XCTAssertEqual(bands.flatMap(\.rows).map(\.id), ["t"])
    }

    /// The cost invariant, asserted as SHAPE rather than as a stopwatch: the number
    /// of rows the board builds is the size of the PINNED set, not of the store. This
    /// is the assertion that fails if a future change re-introduces a band defined as
    /// the complement of the others.
    func testTheBoardBuildsNoRowForTheStoreOnlyForThePinnedSet() {
        // 400 tasks, 20 of them pinned, plus 40 sessions of which half own nothing.
        var tasks: [WalnutTask] = []
        var tierOf: [String: String] = [:]
        var tierOrder: [String: [String]] = [:]
        let tiers = ["focus", "satellite", "backlog", "wait"]
        for i in 0..<400 {
            let isPinned = i % 20 == 0
            tasks.append(task("t-\(i)", title: "task \(i)", pinned: isPinned))
            if isPinned {
                let tier = tiers[i % tiers.count]
                tierOf["t-\(i)"] = tier
                tierOrder[tier, default: []].append("t-\(i)")
            }
        }
        let sessions = (0..<40).map { i in
            session("s-\(i)", taskId: i % 2 == 0 ? "t-\(i)" : nil, status: "running")
        }
        for grouping in BoardGrouping.allCases {
            let bands = BoardModel.bands(
                tasks: tasks, sessions: sessions, tierOf: tierOf, tierOrder: tierOrder,
                customTiers: [], grouping: grouping, now: Self.now
            )
            let rows = bands.flatMap(\.rows)
            XCTAssertEqual(
                rows.count, 20,
                "\(grouping): the board built \(rows.count) rows for 20 pinned tasks out of 400 — a full-store lane is back"
            )
            XCTAssertEqual(
                Set(rows.map(\.id)), Set(tierOf.keys),
                "\(grouping): the rows ARE the pinned set, by id"
            )
            // And the chip row cannot advertise the store either: `All` is the sum of
            // the bands' own visible counts, which is the board's row count.
            XCTAssertEqual(BoardModel.chips(bands).first?.count, 20,
                "\(grouping): the All chip counted something other than the board")
        }
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

    /// Inbox ("") leads, then projects A→Z, and every PINNED task lands in EXACTLY
    /// one band. "Exactly one" is the assertion that matters: a bug that
    /// double-counted would show the same task under two headings on one screen.
    ///
    /// It is also where the grouping control's own guarantee gets its teeth: project
    /// bands are handed the SAME rows the tier grouping assembled, so switching
    /// grouping cannot widen the population. `i2` is unpinned and appears under
    /// neither heading, which is exactly what used to go wrong — `projectBands` walked
    /// every task itself, and that second definition of membership is how switching
    /// grouping could put the whole store back on screen.
    func testProjectGroupingPutsEveryPinnedTaskInExactlyOneBand() {
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
        XCTAssertEqual(Set(ids), ["m1", "a1", "i1", "m2"], "every PINNED task appears")
        XCTAssertFalse(ids.contains("i2"),
            "project grouping must not be a second definition of what is on the board")
        XCTAssertEqual(ids.count, Set(ids).count, "and none appears twice")
        XCTAssertEqual(bands.first(where: { $0.bandId == "proj:marina" })?.count, 2)
    }

    /// A PINNED session whose owning task never reached the projection is real work
    /// someone started, and project grouping must not be where it falls through: it
    /// files under the project the SESSION reports, Inbox when it reports none. A
    /// session that owns nothing has no task to be pinned and therefore no row.
    func testProjectGroupingKeepsAPinnedSessionWhoseTaskIsMissing() {
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
        XCTAssertEqual(Set(bands.flatMap(\.rows).map(\.id)), ["gone-from-projection"],
            "the session names its owner, so the row is about that task")
        XCTAssertEqual(
            Set(bands.flatMap(\.rows).compactMap(\.session?.id)), ["ghost"],
            "the session behind the row is untouched — only the row's KEY changed"
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

    /// EVERY band the board renders can now be created into, and that is a
    /// consequence of the tail band going away rather than a new rule.
    ///
    /// `createSeed` is optional because the tail band was the one band that could not
    /// name a destination (it was the COMPLEMENT of every tier, so "create here" had no
    /// meaning), and saying so in DATA is what stopped the view from inferring the
    /// answer from the band's ID — the assumption that shipped
    /// `focus_tier: "proj:marina"`. With no complement band left, the optional is a
    /// guard rather than a branch, and this case pins that nothing on screen is missing
    /// its ring.
    func testEveryRenderedBandOffersACreateAffordance() {
        for grouping in BoardGrouping.allCases {
            let bands = BoardModel.bands(
                tasks: [
                    task("filed", project: "marina"),
                    task("other", project: ""),
                    task("done", status: "done", phase: "COMPLETE"),
                ],
                sessions: [],
                tierOf: ["filed": "focus", "done": "backlog"],
                tierOrder: ["focus": ["filed"], "backlog": ["done"]], customTiers: [],
                grouping: grouping, now: Self.now
            )
            XCTAssertFalse(bands.isEmpty, "\(grouping): nothing to assert about")
            for band in bands {
                XCTAssertNotNil(band.createSeed,
                    "\(grouping)/\(band.bandId) must offer a create ring")
            }
        }
    }

    /// The done fold applies to EVERY band and the heading says how many, both ways
    /// round. This used to be the tail band's asymmetry: `unfiledRows` never read the
    /// hide-done set, so the one band that actually buried live work under a completed
    /// backlog (2,903 of 3,161 rows) was the one band that could not be folded. That
    /// band is gone; the uniform rule is what is pinned now — and the fold is what the
    /// board opens on.
    func testEveryBandFoldsItsDoneRowsAndSaysHowMany() {
        let tasks = [
            task("live"),
            task("done1", status: "done", phase: "COMPLETE"),
            task("done2", status: "done", phase: "COMPLETE"),
        ]
        let tierOf = ["live": "satellite", "done1": "satellite", "done2": "satellite"]
        let tierOrder = ["satellite": ["live", "done1", "done2"]]

        let folded = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: tierOf, tierOrder: tierOrder,
            customTiers: [], now: Self.now
        )
        XCTAssertEqual(folded.first?.rows.map(\.id), ["live"])
        XCTAssertEqual(folded.first?.hiddenDone, 2, "the heading says what to un-hide")

        let visible = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: tierOf, tierOrder: tierOrder,
            customTiers: [], shownDoneTiers: ["satellite"], now: Self.now
        )
        XCTAssertEqual(visible.first?.rows.map(\.id), ["live", "done1", "done2"],
            "expanded, a completed task is exactly where it always was")
        XCTAssertEqual(visible.first?.hiddenDone, 0)
    }

    /// Folding every row in a band still leaves the band, so the `show done (N)`
    /// toggle that brings them back is still on screen.
    func testABandHidingEveryRowKeepsItsHeadingAndItsRing() {
        let bands = BoardModel.bands(
            tasks: [task("d", status: "done", phase: "COMPLETE")], sessions: [],
            tierOf: ["d": "backlog"], tierOrder: ["backlog": ["d"]], customTiers: [],
            now: Self.now
        )
        XCTAssertEqual(bands.map(\.bandId), ["backlog"])
        XCTAssertEqual(bands.first?.rows.count, 0)
        XCTAssertEqual(bands.first?.hiddenDone, 1)
        XCTAssertNotNil(bands.first?.createSeed,
            "hiding the rows must not also hide where a new one would go")
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
    /// HEADINGS, never the population. Set equality of row ids across both groupings
    /// over the same inputs, including the awkward cases (a pin with no tier, a done
    /// task, an unpinned task with a LIVE session, a session owning nothing, a project
    /// called like a tier).
    ///
    /// It used to have to be stated because the two builders were separate walks over
    /// the store and either could grow its own hole. It is now true by CONSTRUCTION —
    /// `projectBands` is handed the rows `bands` already assembled — and the case stays
    /// because that is precisely the property a future "let project grouping just query
    /// the store" would break, and it would break it by putting 2,800 unpinned rows
    /// back on the board.
    func testSwitchingGroupingNeverChangesThePopulation() {
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
                dateFilter: dateFilter,
                // `done` is expanded in BOTH groupings (it is a tier band under one and a
                // project band under the other), because the question here is the
                // POPULATION: a row folded on one side and drawn on the other would make
                // the two groupings differ for a reason that has nothing to do with
                // grouping, and a row folded on both would take `done` out of the case
                // entirely.
                shownDoneTiers: ["backlog", BoardModel.projectBandPrefix + "marina"],
                now: Self.now
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
        // And the population is the PINNED set, so "identical" is neither two empties
        // nor two copies of the store: `inbox` rides its own pin flag, `filed` and
        // `done` their tiers, while `loose` (live session, unpinned), `tricky`
        // (unpinned) and `orphan` (owns nothing) have no row in either grouping.
        XCTAssertEqual(
            rowIds(.tier, dateFilter: .all, query: ""),
            ["filed", "inbox", "done"]
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

    /// The done fold is keyed by BAND id, and a project literally called "focus"
    /// must not inherit the Focus tier's switch. That is the entire reason
    /// project bands are namespaced — and it matters MORE now that the switch is an
    /// expand: a key that leaked would show completions nobody asked to see.
    func testHideDoneIsKeyedByBandIdSoAProjectCannotCollideWithATier() {
        let tasks = [
            task("t1", project: "focus"),
            task("t2", project: "focus", status: "done", phase: "COMPLETE"),
        ]
        let bands = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: [:], tierOrder: [:], customTiers: [],
            grouping: .project, shownDoneTiers: ["focus"], now: Self.now
        )
        XCTAssertEqual(bands.map(\.bandId), [BoardModel.projectBandPrefix + "focus"])
        XCTAssertEqual(bands.first?.rows.map(\.id), ["t1"],
            "the TIER's key must not expand the same-named project's done row")
        XCTAssertEqual(bands.first?.hiddenDone, 1, "and the heading says what to un-hide")

        // The project's OWN key does expand it.
        let shown = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: [:], tierOrder: [:], customTiers: [],
            grouping: .project, shownDoneTiers: [BoardModel.projectBandPrefix + "focus"],
            now: Self.now
        )
        XCTAssertEqual(shown.first?.rows.map(\.id), ["t1", "t2"])
        XCTAssertEqual(shown.first?.hiddenDone, 0)
    }

    // MARK: - Folders nested inside their project (the desktop console's tree)
    //
    // The hierarchy is PROJECT → FOLDER → task, in that direction, on every surface:
    // `task_groups.project` makes a folder belong to exactly one project (moving a task
    // to another project clears its folder), the console draws the project header on the
    // outside with folder headers indented inside it, and the phone now mirrors that.
    // Folders on the OUTSIDE would shatter one project across as many sections as it has
    // folders, i.e. "By project" would stop grouping by project.
    //
    // The phone learns the tree from ONE request (`GET /v1/tasks/groups`) because the
    // slim task projection carries no `group_id` — task→folder is an INVERSION of
    // `member_ids`, which is why `BoardFolderIndex` exists and why it is built once per
    // adoption rather than per band rebuild.

    /// The folders behind every case below: two folders in `marina`, one in `acme`
    /// (which has no loose pinned rows at all), one in Inbox, and one EMPTY folder the
    /// server lists but the board has no rows for.
    private var folderFixture: [TaskFolder] {
        [
            TaskFolder(groupId: "g_beta", label: "Beta", memberIds: ["m2"], project: "marina"),
            TaskFolder(groupId: "g_alpha", label: "Alpha", memberIds: ["m3"], project: "marina"),
            TaskFolder(groupId: "g_cats", label: "Cats", memberIds: ["a1"], project: "acme"),
            TaskFolder(groupId: "g_taxes", label: "Taxes", memberIds: ["i2"], project: ""),
            TaskFolder(groupId: "g_empty", label: "Empty", memberIds: [], project: "marina"),
        ]
    }

    /// The rows those folders file: one loose + one foldered row in Inbox, one loose +
    /// two foldered in `marina`, and `acme`'s single row foldered (so its project band
    /// has nothing to render).
    private var folderFixtureTasks: [WalnutTask] {
        [
            task("i1", project: ""), task("i2", project: ""),
            task("m1", project: "marina"), task("m2", project: "marina"),
            task("m3", project: "marina"), task("a1", project: "acme"),
        ]
    }

    private func folderBands(
        tasks rows: [WalnutTask]? = nil,
        folders: [TaskFolder]? = nil,
        query: String = "",
        shownDoneTiers: Set<String> = [],
        grouping: BoardGrouping = .project
    ) -> [BoardBand] {
        BoardModel.bands(
            tasks: rows ?? folderFixtureTasks, sessions: [],
            tierOf: [:], tierOrder: [:], customTiers: [],
            query: query, grouping: grouping, shownDoneTiers: shownDoneTiers,
            folders: BoardFolderIndex.build(folders ?? folderFixture), now: Self.now
        )
    }

    /// The tree, stated as the ONE thing the board renders: a flat band array whose
    /// ORDER is the hierarchy. Inbox first, then projects A→Z; inside a project its
    /// loose rows first (under the project's own heading), then its folders A→Z.
    func testByProjectNestsEachProjectsFoldersUnderThatProject() {
        let bands = folderBands()
        XCTAssertEqual(bands.map(\.bandId), [
            "proj:", "folder:g_taxes",           // Inbox: loose, then its folder
            "folder:g_cats",                     // acme: no loose rows, so the folder leads
            "proj:marina", "folder:g_alpha", "folder:g_beta",
        ], "projects outside, folders inside, both in their own order")

        XCTAssertEqual(bands.map(\.label), [
            "Inbox", "Taxes", "Cats", "marina", "Alpha", "Beta",
        ], "a folder band is titled by the FOLDER, a project band by the project")

        // Every row is under the heading its folder puts it under.
        XCTAssertEqual(bands.map { $0.rows.map(\.id) }, [
            ["i1"], ["i2"], ["a1"], ["m1"], ["m3"], ["m2"],
        ])

        // The folder bands know which project they are drawn inside, and exactly one
        // band per project draws that project's heading.
        XCTAssertEqual(bands.compactMap { $0.nest?.projectLabel },
                       ["Inbox", "acme", "marina", "marina"])
        XCTAssertEqual(
            bands.filter { $0.nest?.leadsProject == true }.map(\.bandId), ["folder:g_cats"],
            "only the project with no loose band needs its heading drawn by a folder"
        )
        XCTAssertNil(bands.first?.nest, "a project band is not nested in anything")
    }

    /// THE guarantee the whole feature has to keep: nesting is a HEADING change, so the
    /// union of the project bands' rows is exactly the tier bands' rows — nothing lost
    /// in a folder, nothing drawn twice because two headings both claimed it.
    ///
    /// It is checked across the filter combinations the bar can produce, because each
    /// one is a separate path through the band builder (the query and the date filter
    /// are applied BEFORE the folder split, and a row dropped there must be dropped in
    /// both groupings).
    func testNoRowIsLostOrDuplicatedWhenFoldersNestTheProjectBands() {
        let rows = folderFixtureTasks + [
            task("done", project: "marina", status: "done", phase: "COMPLETE"),
            task("unpinned", project: "acme", pinned: false),
        ]
        let folders = folderFixture + [
            // A done row inside a folder, and a folder naming a task that is NOT on the
            // pinned board at all — the folder must not drag it back on.
            TaskFolder(groupId: "g_done", label: "Shipped", memberIds: ["done", "unpinned"], project: "marina"),
        ]
        // The bands `done` lands in, one per grouping (the default tier under `.tier`,
        // its FOLDER under `.project`) — expanded so the completed row is part of the
        // population this case compares, the same reason
        // `testSwitchingGroupingNeverChangesThePopulation` names two keys.
        let expanded: Set<String> = [BoardModel.defaultTierId, "folder:g_done"]
        for dateFilter in BoardDateFilter.allCases {
            for query in ["", "marina", "m", "nothing-matches-this"] {
                func ids(_ grouping: BoardGrouping) -> [String] {
                    BoardModel.bands(
                        tasks: rows, sessions: [], tierOf: [:], tierOrder: [:],
                        customTiers: [], query: query, grouping: grouping,
                        dateFilter: dateFilter, shownDoneTiers: expanded,
                        folders: BoardFolderIndex.build(folders), now: Self.now
                    ).flatMap { $0.rows.map(\.id) }
                }
                let nested = ids(.project)
                XCTAssertEqual(Set(nested), Set(ids(.tier)),
                    "date=\(dateFilter) query=\"\(query)\": the folder tree changed WHICH rows exist")
                XCTAssertEqual(nested.count, Set(nested).count,
                    "date=\(dateFilter) query=\"\(query)\": a row is drawn under two headings")
            }
        }
        // …and "identical" is not two empties: the pinned set is what both show.
        XCTAssertEqual(
            Set(folderBands(tasks: rows, folders: folders, shownDoneTiers: expanded)
                .flatMap { $0.rows.map(\.id) }),
            ["i1", "i2", "m1", "m2", "m3", "a1", "done"]
        )
        // Fold it back (the default) and `done` is the ONE row that leaves — the fold
        // takes completions out of the band and nothing else out of the board.
        XCTAssertEqual(
            Set(folderBands(tasks: rows, folders: folders).flatMap { $0.rows.map(\.id) }),
            ["i1", "i2", "m1", "m2", "m3", "a1"]
        )
    }

    /// Folders belong to `By project` only. The tier grouping is byte-identical with and
    /// without a hierarchy, so a folder can never reshape the board's native view.
    func testTheTierGroupingIsUnchangedByTheFolderHierarchy() {
        XCTAssertEqual(
            folderBands(grouping: .tier),
            folderBands(folders: [], grouping: .tier)
        )
    }

    /// The endpoint failing (or a server that predates it) must leave the board it drew
    /// before — the SAME band ids, labels and create seeds, so every shipped
    /// accessibility id and every stored `hide done` preference still means what it did.
    func testAnAbsentHierarchyLeavesExactlyTheFlatProjectBoard() {
        let flat = folderBands(folders: [])
        XCTAssertEqual(flat.map(\.bandId), ["proj:", "proj:acme", "proj:marina"])
        XCTAssertEqual(flat.compactMap { $0.nest }.count, 0, "no folder band, so no nesting")
        for band in flat {
            XCTAssertNotNil(band.createSeed, "\(band.bandId) lost its create ring")
        }
        XCTAssertEqual(Set(flat.flatMap { $0.rows.map(\.id) }),
                       Set(folderBands().flatMap { $0.rows.map(\.id) }),
                       "and the same rows are on screen either way")
    }

    /// A project every one of whose pinned rows is filed in a folder still says which
    /// project those folders are in. Without this the board would open on a folder
    /// heading with nothing above it — a name with no context, which is exactly what
    /// "which project is this?" looks like.
    func testAProjectWithNoLooseRowsStillDrawsItsHeadingOnTheFirstFolder() {
        let bands = folderBands(
            tasks: [task("a1", project: "acme")],
            folders: [TaskFolder(groupId: "g_cats", label: "Cats", memberIds: ["a1"], project: "acme")]
        )
        XCTAssertEqual(bands.map(\.bandId), ["folder:g_cats"], "the empty loose band is not rendered")
        XCTAssertEqual(bands.first?.nest?.leadsProject, true)
        XCTAssertEqual(bands.first?.nest?.projectLabel, "acme")
        XCTAssertEqual(bands.first?.nest?.projectBandId, "proj:acme",
            "the project heading keeps the id it has always had, so its automation id is unchanged")
    }

    /// Selecting a FOLDER chip leaves that one band on screen — and it must still be
    /// told which project it belongs to, because the project band that would have drawn
    /// that heading is exactly what the chip filtered away.
    func testSelectingAFolderChipKeepsTheProjectHeadingAboveIt() {
        let bands = folderBands()
        XCTAssertEqual(bands.first(where: { $0.bandId == "folder:g_beta" })?.nest?.leadsProject, false,
            "on the whole board `proj:marina` draws that heading")

        let only = BoardModel.filtered(bands, selected: "folder:g_beta")
        XCTAssertEqual(only.map(\.bandId), ["folder:g_beta"])
        XCTAssertEqual(only.first?.nest?.leadsProject, true,
            "with the project band gone, the surviving folder draws the heading")

        // The chips themselves are still one per rendered band, folders included, with
        // the band's own visible count — the rule that stops the bar and the board from
        // ever disagreeing.
        let chips = BoardModel.chips(bands)
        XCTAssertEqual(chips.count, bands.count + 1)
        XCTAssertNil(chips.first?.bandId, "the leading chip is All")
        XCTAssertEqual(chips.dropFirst().compactMap(\.bandId), bands.map(\.bandId))
        XCTAssertEqual(chips.first?.count, bands.reduce(0) { $0 + $1.count })
        XCTAssertEqual(chips.first(where: { $0.bandId == "folder:g_alpha" })?.label, "Alpha")
    }

    /// The create ring: a PROJECT band still files into that project (unchanged), and a
    /// FOLDER band has none at all. That absence is deliberate and it is the honest
    /// answer: v1 exposes no folder write (and folder writes are 501 on a replica), so a
    /// ring on a folder heading could only file the task into the surrounding project —
    /// landing it outside the folder the user tapped.
    func testAFolderBandHasNoCreateRingWhileItsProjectBandKeepsOne() {
        let bands = folderBands()
        let marina = bands.first { $0.bandId == "proj:marina" }
        XCTAssertEqual(marina?.createSeed, NewTaskSeed(project: "marina", pin: .unspecified))
        let inbox = bands.first { $0.bandId == "proj:" }
        XCTAssertEqual(inbox?.createSeed, NewTaskSeed(project: "", pin: .unspecified))
        for band in bands where band.nest != nil {
            XCTAssertNil(band.createSeed,
                "\(band.bandId) must not offer a destination it cannot file into")
        }
    }

    /// An EMPTY folder is valid server-side (create the folder, fill it later) and the
    /// listing includes it. The PINNED board draws no band for one: it has no rows and
    /// no ring, so the band would be a heading that does nothing.
    func testAnEmptyFolderDrawsNoBandOnThePinnedBoard() {
        XCTAssertFalse(folderBands().contains { $0.bandId == "folder:g_empty" })
        // Nor does a folder whose members are all UNPINNED — the board is the pinned
        // working set, and a folder cannot put a row back on it.
        let bands = folderBands(
            tasks: [task("u", project: "marina", pinned: false)],
            folders: [TaskFolder(groupId: "g_u", label: "Unpinned", memberIds: ["u"], project: "marina")]
        )
        XCTAssertTrue(bands.isEmpty)
    }

    /// The done fold is per BAND, and a folder band is a band: expanding one must not
    /// touch its project's loose rows or its sibling folders. Expressed as "the project
    /// band is the one expanded, the folder keeps the default fold", which is the
    /// direction a reader actually travels now.
    func testHideDoneFoldsOneFolderBandOnly() {
        let rows = [
            task("m1", project: "marina"),
            task("mdone", project: "marina", status: "done", phase: "COMPLETE"),
            task("f1", project: "marina"),
            task("fdone", project: "marina", status: "done", phase: "COMPLETE"),
        ]
        let folders = [TaskFolder(
            groupId: "g_alpha", label: "Alpha", memberIds: ["f1", "fdone"], project: "marina"
        )]
        let bands = folderBands(
            tasks: rows, folders: folders, shownDoneTiers: ["proj:marina"]
        )
        XCTAssertEqual(bands.map(\.bandId), ["proj:marina", "folder:g_alpha"])
        XCTAssertEqual(bands[0].rows.map(\.id), ["m1", "mdone"], "the expanded band shows its done row")
        XCTAssertEqual(bands[0].hiddenDone, 0)
        XCTAssertEqual(bands[1].rows.map(\.id), ["f1"],
            "the folder inside it keeps the default fold")
        XCTAssertEqual(bands[1].hiddenDone, 1, "and the folder heading says what to un-hide")
    }

    /// A folder band id can never collide with a project band id, even when the folder's
    /// own group id reads exactly like a project name — the two prefixes are the whole
    /// reason the ids are namespaced, one level deeper than `proj:` already was.
    func testFolderBandIdsCannotCollideWithProjectBandIds() {
        let bands = folderBands(
            tasks: [task("t1", project: "marina"), task("t2", project: "marina")],
            folders: [TaskFolder(groupId: "marina", label: "marina", memberIds: ["t2"], project: "marina")]
        )
        XCTAssertEqual(bands.map(\.bandId), ["proj:marina", "folder:marina"])
        XCTAssertEqual(Set(bands.map(\.bandId)).count, 2)
        // And their automation ids stay distinct too, which is the property a shared
        // slug would quietly break (automation taps the FIRST match).
        XCTAssertNotEqual(
            TaskBoardList.slug(bands[0].bandId), TaskBoardList.slug(bands[1].bandId)
        )
    }

    /// The folder heading's accessibility id is built from the folder's own id, and it
    /// must stay inside [A-Za-z0-9_] whatever the server called the folder — automation
    /// matches ids as REGEXES, and the app's ASCII fold is the one guard against a
    /// non-ASCII id that looks folded (`AutomationIdentifiers`).
    func testFolderAutomationIdsAreAsciiAndStable() {
        // A real server id, and two that are not.
        for folderId in ["g_ab12cd34-9f0e", "工作", "café|(x)"] {
            let slug = TaskBoardList.slug(folderId)
            XCTAssertFalse(slug.isEmpty)
            XCTAssertTrue(
                slug.allSatisfy { $0.isASCIILetterOrDigit || $0 == "_" },
                "board.folder.\(slug) is not automation-safe"
            )
            XCTAssertEqual(slug, TaskBoardList.slug(folderId), "and it is stable")
        }
        XCTAssertEqual(TaskBoardList.slug("g_ab12cd34-9f0e"), "g_ab12cd34_9f0e")
        // Two folder names that differ only outside ASCII still get distinct ids (the
        // CJK collision the hash suffix exists for).
        XCTAssertNotEqual(TaskBoardList.slug("工作"), TaskBoardList.slug("生活"))
    }

    /// The inversion, including the two shapes that would otherwise put one row under
    /// two headings: a folder listing the same task twice, and two folders both claiming
    /// it. `folderOf` is a dictionary, so exactly one folder can win — which is what
    /// keeps the union invariant true no matter what the server sends.
    func testTheFolderIndexInvertsMembershipToOneFolderPerTask() {
        let index = BoardFolderIndex.build([
            TaskFolder(groupId: "g1", label: "One", memberIds: ["t1", "t2", "t2"], project: "p"),
            TaskFolder(groupId: "g2", label: "Two", memberIds: ["t2"], project: "p"),
            TaskFolder(groupId: "g3", label: "", memberIds: [], project: "p"),
            TaskFolder(groupId: "", label: "no id", memberIds: ["t9"], project: "p"),
        ])
        XCTAssertEqual(index.folderOf["t1"], "g1")
        XCTAssertEqual(index.folderOf.count, 2, "t2 is claimed once, and the id-less folder claims nothing")
        XCTAssertNil(index.folderOf["t9"])
        XCTAssertEqual(index.labelOf["g3"], "g3",
            "a folder with no label falls back to its id — a blank heading reads as a bug")
        XCTAssertNil(index.labelOf[""])
        XCTAssertTrue(BoardFolderIndex.empty.isEmpty)
        XCTAssertFalse(index.isEmpty)
    }

    /// The wire shape, decoded from the bytes the server actually sends — and the
    /// defensive half: a server that omits a field costs the phone that ONE fact, never
    /// the whole hierarchy (a thrown decode blanks every folder and silently flattens
    /// the board).
    func testTaskFolderDecodesTheWireShapeAndToleratesMissingFields() throws {
        let json = """
        { "groups": [
          { "group_id": "g_a", "label": "Alpha", "hidden": false,
            "member_ids": ["t1", "t2"], "project": "marina" },
          { "group_id": "g_b", "label": "Nested", "hidden": true,
            "member_ids": [], "project": "", "parent_id": "g_a" },
          { "group_id": "g_c", "label": "Sparse" }
        ] }
        """
        struct Wrapper: Decodable { let groups: [TaskFolder] }
        let groups = try JSONDecoder().decode(Wrapper.self, from: Data(json.utf8)).groups
        XCTAssertEqual(groups.map(\.groupId), ["g_a", "g_b", "g_c"])
        XCTAssertEqual(groups[0].memberIds, ["t1", "t2"])
        XCTAssertEqual(groups[0].project, "marina")
        XCTAssertNil(groups[0].parentId)
        XCTAssertEqual(groups[1].parentId, "g_a", "nesting is decoded even though one level is drawn")
        XCTAssertTrue(groups[1].hidden)
        XCTAssertEqual(groups[2].memberIds, [], "a missing member list is no members, not a failure")
        XCTAssertFalse(groups[2].hidden)
        XCTAssertEqual(groups[2].project, "", "and a missing project reads as Inbox")
    }

    /// A HIDDEN folder still shows its rows. The flag is the desktop list's collapse
    /// affordance; honouring it here would drop pinned rows off the only board that
    /// promises to carry them, in the one place nobody would think to look.
    func testAHiddenFolderStillDrawsItsRows() {
        let bands = folderBands(
            tasks: [task("t1", project: "marina")],
            folders: [TaskFolder(
                groupId: "g_h", label: "Hidden", hidden: true,
                memberIds: ["t1"], project: "marina"
            )]
        )
        XCTAssertEqual(bands.flatMap { $0.rows.map(\.id) }, ["t1"])
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

    /// A search on the board shows the matching bands AND the matching open tasks
    /// below them, and the exclusion is what keeps a task belonging to both sets from
    /// rendering TWICE on one screen — the exact confusion ("task and session feel too
    /// separate") this redesign removes.
    ///
    /// This is also where SEARCH takes over the job the tail band used to do, which is
    /// the whole reason removing that band is not a loss of reach: the pinned match is
    /// a board row, the UNPINNED match is a hit row below the bands, and neither is
    /// both. Dogfood R17's complaint (a task the user knew existed answered "No local
    /// matches") is answered by the hit list, not by putting the store on the board.
    func testASearchOnTheBoardShowsPinnedRowsAndUnpinnedHitsExactlyOnce() {
        let pinned = task("pinned", title: "alpha work", project: "marina")
        let loose = task("loose", title: "alpha elsewhere", project: "marina", pinned: false)
        let bands = BoardModel.bands(
            tasks: [pinned, loose], sessions: [],
            tierOf: ["pinned": "focus"], tierOrder: ["focus": ["pinned"]],
            customTiers: [], query: "alpha"
        )
        XCTAssertEqual(bands.flatMap(\.rows).map(\.id), ["pinned"],
            "the board shows the PINNED match and nothing else")

        let alreadyShown = BoardModel.rowIds(bands)
        XCTAssertEqual(alreadyShown, ["pinned"])

        let hits = TasksView.sections(
            from: [pinned, loose], query: "alpha", excluding: alreadyShown
        )
        XCTAssertEqual(hits.flatMap(\.tasks).map(\.id), ["loose"],
            "the unpinned match is reachable BELOW the bands — the board row is not repeated there")
    }

    func testRowIdsCoversEveryBandOnTheBoard() {
        let bands = BoardModel.bands(
            tasks: [task("p"), task("q")],
            sessions: [session("s", taskId: "q", status: "running")],
            tierOf: ["p": "focus"], tierOrder: ["focus": ["p"]], customTiers: []
        )
        XCTAssertEqual(BoardModel.rowIds(bands), ["p", "q"],
            "`q` rides its own pin flag into the default band, and rowIds must see both bands")
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

    /// A whole board's worth: the session-only row (a PINNED session whose task never
    /// reached the projection) lands in the same id space as every task row, so
    /// `rowIds` — and therefore the local-section exclusion — can see it at all.
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
    ///
    /// `All` means the whole PINNED BOARD, and the unpinned `loose` in the fixture is
    /// what says so: it used to ride the tail band and be counted, which is how the
    /// chip came to read "All 3,175" over a working set of ~264. The arithmetic did not
    /// change; no band is the store any more.
    func testChipsMirrorTheBandsPlusAnAllChipCountingOnlyTheBoard() {
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
        XCTAssertEqual(all.count, 3, "All carries the board's own rows — 3 pinned, not 4 tasks")
        XCTAssertEqual(all.count, bands.flatMap(\.rows).count,
            "the All chip's count IS the board's row count, stated against the rows themselves")

        let bandChips = Array(chips.dropFirst())
        XCTAssertEqual(bandChips.count, bands.count, "one chip per band, no more")
        XCTAssertEqual(bandChips.compactMap(\.bandId), bands.map(\.bandId),
            "same bands, same order — and every one of them has a band id")
        XCTAssertEqual(bandChips.map(\.label), bands.map(\.label))
        XCTAssertEqual(bandChips.map(\.count), bands.map(\.count))
    }

    /// A chip's count is the band's VISIBLE count, so the done fold moves both
    /// together. A chip that counted hidden rows would disagree with the heading
    /// immediately below it.
    ///
    /// This is the reported defect at chip scale: the bar said `Focus 75` over 16 open
    /// rows because the fold was opt-out. Default folded, the chip is the OPEN count,
    /// and it grows by exactly the N in `show done (N)` when that band is expanded.
    func testChipCountsFollowTheVisibleRowsLikeTheHeadingDoes() {
        let tasks = [task("a"), task("b", status: "done", phase: "COMPLETE")]
        func chips(_ shown: Set<String>) -> [BoardModel.BandChip] {
            BoardModel.chips(BoardModel.bands(
                tasks: tasks, sessions: [], tierOf: ["a": "focus", "b": "focus"],
                tierOrder: ["focus": ["a", "b"]], customTiers: [], shownDoneTiers: shown
            ))
        }
        XCTAssertEqual(chips([]).first?.count, 1, "All counts what the board shows")
        XCTAssertEqual(chips([]).last?.count, 1, "and so does the band's own chip")
        XCTAssertEqual(chips(["focus"]).first?.count, 2, "expanding the band grows both")
        XCTAssertEqual(chips(["focus"]).last?.count, 2)
    }

    /// The invariant, stated at the number the user reads: **`All` is the sum of what the
    /// bands show, and on a default board that is the OPEN count.** Both halves are
    /// asserted against the rows rather than against a constant, and then against the
    /// count of open tasks in the fixture, so a fold that dropped a row from a band but
    /// not from the chip (or the reverse) fails here.
    func testTheAllChipIsTheOpenCountAndTheSumOfTheBandsAtTheSameTime() {
        let tasks = [
            task("f1"), task("f2", status: "done", phase: "COMPLETE"),
            task("f3"), task("s1"), task("s2", status: "done", phase: "COMPLETE"),
            task("b1", status: "done", phase: "COMPLETE"),
            task("w1"),
        ]
        let tierOf = ["f1": "focus", "f2": "focus", "f3": "focus", "s1": "satellite",
                      "s2": "satellite", "b1": "backlog", "w1": "wait"]
        let tierOrder = ["focus": ["f1", "f2", "f3"], "satellite": ["s1", "s2"],
                         "backlog": ["b1"], "wait": ["w1"]]
        let open = tasks.count { !$0.isDone }

        let bands = BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: tierOf, tierOrder: tierOrder, customTiers: []
        )
        let all = BoardModel.chips(bands).first
        XCTAssertEqual(all?.count, bands.reduce(0) { $0 + $1.count },
            "All must be the sum of the band counts")
        XCTAssertEqual(all?.count, bands.flatMap(\.rows).count,
            "…which is the number of rows the board is drawing")
        XCTAssertEqual(all?.count, open, "…which on a default board is the OPEN count (4 of 7)")

        // Expand every band and All grows by exactly the folded rows it was holding
        // back — the same rows, still counted once.
        let expandedAll = BoardModel.chips(BoardModel.bands(
            tasks: tasks, sessions: [], tierOf: tierOf, tierOrder: tierOrder,
            customTiers: [], shownDoneTiers: Set(bands.map(\.bandId))
        )).first
        XCTAssertEqual(expandedAll?.count, tasks.count)
        XCTAssertEqual(expandedAll?.count,
                       (all?.count ?? 0) + bands.reduce(0) { $0 + $1.hiddenDone })
    }

    /// An explicit expand is the reader's decision and it OUTLIVES the store: a task
    /// arriving, a title changing, any refresh that rebuilds the bands must not re-fold
    /// a band that was opened. The set is the view's state and the model is pure, so the
    /// property to pin here is that the same set keeps producing the same answer over
    /// changed inputs — which is what `BoardBandsKey.shownDoneBands` then carries
    /// through the memo (`BoardBandsCacheTests.testEveryInputInvalidates`).
    func testAnExpandedBandStaysExpandedWhenTheStoreChangesUnderneathIt() {
        let base = [task("a"), task("b", status: "done", phase: "COMPLETE")]
        func rows(_ tasks: [WalnutTask], order: [String]) -> [String] {
            BoardModel.bands(
                tasks: tasks, sessions: [],
                tierOf: Dictionary(uniqueKeysWithValues: order.map { ($0, "focus") }),
                tierOrder: ["focus": order], customTiers: [], shownDoneTiers: ["focus"]
            ).first?.rows.map(\.id) ?? []
        }
        XCTAssertEqual(rows(base, order: ["a", "b"]), ["a", "b"])
        // A new task lands in the same band…
        XCTAssertEqual(rows(base + [task("c")], order: ["a", "b", "c"]), ["a", "b", "c"],
            "a store change must not re-fold a band the reader opened")
        // …and so does another completion.
        XCTAssertEqual(
            rows(base + [task("c", status: "done", phase: "COMPLETE")], order: ["a", "b", "c"]),
            ["a", "b", "c"]
        )
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

    /// THE reported number, as an invariant: **the `All` chip's count is the number of
    /// rows this screen is showing.** Never the store's.
    ///
    /// The chip read "All 3,175" over a board of ~264 pinned rows, because the tail
    /// band was the whole projection plus the sessions that owned no task, and `All` is
    /// the sum of the bands. This case walks every state the bar can be in — both
    /// groupings, both date filters, hide-done on and off, a live query, a chip
    /// selection — and asserts the sum against the ROWS rather than against a constant,
    /// so it cannot be satisfied by a fixture that happens to agree.
    func testTheAllChipCountsTheBoardsOwnRowsInEveryState() {
        let tasks = [
            task("f1", project: "marina"),
            task("f2", project: "marina", status: "done", phase: "COMPLETE"),
            task("s1", project: "acme"),
            task("b1", project: "", start: "2026-09-01T00:00:00Z"),
            // Three ways of NOT being on the board, all of which the chip used to count.
            task("loose", project: "acme", pinned: false),
            task("loose-done", project: "", status: "done", phase: "COMPLETE", pinned: false),
        ]
        let sessions = [
            session("live", taskId: "loose", status: "running"),
            session("owns-nothing", taskId: nil, status: "running"),
        ]
        let tierOf = ["f1": "focus", "f2": "focus", "s1": "satellite", "b1": "backlog"]
        let tierOrder = ["focus": ["f1", "f2"], "satellite": ["s1"], "backlog": ["b1"]]

        for grouping in BoardGrouping.allCases {
            for dateFilter in BoardDateFilter.allCases {
                for shown in [Set<String>(), ["focus"], [BoardModel.projectBandPrefix + "marina"]] {
                    for query in ["", "1", "marina"] {
                        let bands = BoardModel.bands(
                            tasks: tasks, sessions: sessions, tierOf: tierOf,
                            tierOrder: tierOrder, customTiers: [], query: query,
                            grouping: grouping, dateFilter: dateFilter,
                            shownDoneTiers: shown, now: Self.now
                        )
                        let state = "grouping=\(grouping) date=\(dateFilter) shown=\(shown.sorted()) query=\"\(query)\""
                        let rows = bands.flatMap(\.rows).count
                        XCTAssertEqual(
                            BoardModel.chips(bands).first?.count, rows,
                            "\(state): the All chip said something other than the board's \(rows) rows"
                        )
                        // And the board it counts is a subset of the PINNED set, never
                        // of the store: no unpinned id, and no session-only row for a
                        // session that owns nothing.
                        let ids = Set(bands.flatMap(\.rows).map(\.id))
                        XCTAssertTrue(
                            ids.isSubset(of: Set(tierOf.keys)),
                            "\(state): rows outside the pinned set reached the board: \(ids.subtracting(Set(tierOf.keys)).sorted())"
                        )
                        // A chip selection narrows what is DRAWN and never what the
                        // counts say, which is what keeps the bar readable while
                        // narrowed (`chips` is computed from the UNFILTERED bands).
                        for chip in BoardModel.chips(bands) {
                            let narrowed = BoardModel.filtered(bands, selected: chip.bandId)
                            XCTAssertLessThanOrEqual(
                                narrowed.flatMap(\.rows).count, rows,
                                "\(state): selecting \(chip.id) grew the board"
                            )
                        }
                    }
                }
            }
        }
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

        let bandIds = ["focus", "satellite", "backlog", "wait", "ct_abc12345"]
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
        let ids = ["focus", "ct_abc12345", BoardModel.defaultTierId]
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
            // The retired tail band's id. Kept in this table on purpose: a stored
            // `shownDoneBands` entry or an old automation flow can still name it, and
            // the fold must keep answering the same string it always did.
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
        XCTAssertEqual(TaskBoardList.slug(BoardModel.defaultTierId), "satellite",
            "the default band's id is one of the ASCII ids pinned above")
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

/// The Tasks tab's TWO header entries, and the fallback for a filter that no longer
/// has one.
///
/// The header was six smart-list cards over `TaskFilter.allCases`, then three chips
/// (Pin | All Tasks | Calendar), and it is now Pin | Calendar. The enum cases all
/// stayed (stored preferences, `identifierKey` suffixes in shipped ids, the store's
/// own slices), so the entry set and the filter set are deliberately different sizes
/// and this is where that difference is pinned.
///
/// # CONTRACT CHANGE this round: "All Tasks" is not a destination any more
///
/// "已经有 pin 了,为什么还会有 all task". A flat list of every open task was a SECOND
/// answer to "what am I working on", and the two disagreed by three thousand rows.
/// `.allOpen` therefore loses its entry (and with it `tasks.nav.all`, the one shipped
/// identifier this round retires) and joins Today / In Progress / Done as reachable
/// STATE with no chip: `resolve` now catches it, so a phone that persisted the old
/// pill lands on the board instead of on a chipless header.
final class TasksNavEntryTests: XCTestCase {

    func testThereAreExactlyTwoEntriesInReadingOrder() {
        XCTAssertEqual(TasksNavEntry.allCases.map(\.title), ["Pin", "Calendar"])
        XCTAssertEqual(TasksNavEntry.allCases.map(\.filter), [.sessions, .calendar])
    }

    /// The retired pill, asserted as an ABSENCE rather than left to the count above:
    /// this is the case that fails if someone adds the destination back without
    /// re-deciding the question the user asked.
    func testAllTasksIsNoLongerAHeaderDestination() {
        XCTAssertFalse(TasksNavEntry.allCases.map(\.filter).contains(.allOpen))
        XCTAssertNil(TasksNavEntry.entry(for: .allOpen),
            "the board IS the working set — a flat all-tasks list is a second answer to it")
        XCTAssertEqual(TasksNavEntry.resolve(.allOpen), TasksNavEntry.pin.filter,
            "a persisted `allOpen` must land on the board, not on a chipless header")
        XCTAssertFalse(TasksNavEntry.allCases.map(\.identifier).contains("tasks.nav.all"),
            "tasks.nav.all is retired, not repointed: an id that resolves to a different destination keeps flows passing while doing something else")
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
    /// from — a soft dead end. Today / In Progress / Done have always been those, and
    /// `.allOpen` joins them this round.
    func testAFilterWithNoEntryFallsBackToPin() {
        for orphan in [TaskFilter.today, .inProgress, .done, .allOpen] {
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
    /// have to survive the header rebuild verbatim. The `.allOpen` KEY is untouched
    /// (`TaskFilter` keeps all six cases — they are the store's own slices); what went
    /// away is the entry that put a chip on screen for it.
    func testCompactChipIdentifiersAreUnchangedForTheRemainingEntries() {
        XCTAssertEqual(TasksNavEntry.pin.filter.identifierKey, "sessions")
        XCTAssertEqual(TasksNavEntry.calendar.filter.identifierKey, "calendarview")
        XCTAssertEqual(TaskFilter.allOpen.identifierKey, "all",
            "the filter's own key is a data concern and must not move with the pill")
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

/// The board row's SURFACE: "this task wants a human", said by painting the WHOLE row
/// red.
///
/// # What this replaced, twice
///
/// Attempt one was a whole-row wash at `rgba(255,59,48,0.08)`, ported from the
/// desktop's `.todo-panel-item-needs-action`. At that strength it read as a pink smudge
/// on 8 of 11 visible rows: loud enough to make the LIST look broken, too weak to read
/// as a statement about one row. Attempt two was a saturated 3pt capsule at the row's
/// leading edge, which collided with the done ring — the ring carried
/// `padding(.leading, -6)` to sit flush at x≈0.5 and the capsule drew at x 0..3, so the
/// two overlapped by 2.5pt on every marked row ("怎么能重叠呢").
///
/// The answer to that was not a wider gutter: "那个红色…不要变成一个竖道了,把它变成一整个
/// 底都变成红色的吧". The mark IS the paper now, at a strength that reads (0.16 light /
/// 0.30 dark), so there is no column left to collide with the ring.
///
/// # Why arithmetic and not a screenshot
///
/// The tint is a dynamic `UIColor`, so both schemes resolve here and the composite is
/// exact. That matters because both earlier attempts failed on a value nobody
/// re-measured in the mode it was wrong in, and because the claim being made is about
/// EVERY Dynamic Type size — a background has no metrics, and this file is where that
/// stops being a promise: the surface takes no type size, and the loop below is what
/// makes anyone who adds one say so out loud.
@MainActor
final class BoardRowNeedsActionSurfaceTests: XCTestCase {

    // MARK: - Colour helpers (WCAG, on real resolved colours)

    private func rgba(_ color: UIColor, dark: Bool) -> (r: Double, g: Double, b: Double, a: Double) {
        let resolved = color.resolvedColor(
            with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(resolved.getRed(&r, green: &g, blue: &b, alpha: &a),
            "dark=\(dark): the tint must be a plain RGBA colour")
        return (Double(r), Double(g), Double(b), Double(a))
    }

    // The local `composite(tint:over:dark:)` helper is GONE (R29). It blended the tint
    // onto a base this file chose, which is exactly the re-derivation that can agree with
    // a bug: the app flattens the tint onto the band card itself now, so `surface` below
    // reads `BoardRowSurface.opaqueSurface` and every assertion here is about the colour
    // the screen paints. The independent blend still exists, once, where it earns its keep
    // — `BoardBandCardSurfaceTests` proves the app is compositing over the CARD.

    private func luminance(_ rgb: (r: Double, g: Double, b: Double)) -> Double {
        func channel(_ value: Double) -> Double {
            let v = value / 255
            return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
    }

    private func contrast(
        _ a: (r: Double, g: Double, b: Double), _ b: (r: Double, g: Double, b: Double)
    ) -> Double {
        let x = luminance(a) + 0.05, y = luminance(b) + 0.05
        return max(x, y) / min(x, y)
    }

    /// The row surface as the view paints it, for one scheme.
    ///
    /// R29: the base is the BAND CARD, not the window background. The board's rows are
    /// inset-grouped card cells now, so a tint that used to be measured over
    /// `systemBackground` (black, in dark mode) is really landing on
    /// `secondarySystemGroupedBackground` (28,28,30) — measuring the old base would keep
    /// asserting a colour nothing paints.
    ///
    /// And it reads the APP's own composite (`BoardRowSurface.opaqueSurface`) rather than
    /// re-blending here, because the app is what flattens the tint onto the card now: a
    /// local re-derivation could agree with a bug in the shipped blend.
    private func surface(needsAction: Bool, isNew: Bool = false, dark: Bool)
        -> (r: Double, g: Double, b: Double) {
        let painted = BoardRowSurface.opaqueSurface(
            needsAction: needsAction, isNew: isNew,
            traits: UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        )
        let rgb = rgba(painted, dark: dark)
        return (rgb.r * 255, rgb.g * 255, rgb.b * 255)
    }

    private func task(_ id: String, phase: String, status: String = "todo") -> WalnutTask {
        WalnutTask(
            id: id, title: "a task", status: status, phase: phase, priority: "none",
            project: "", dueDate: nil,
            createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
            completedAt: status == "done" ? "2026-08-27T01:00:00Z" : nil,
            starred: nil, pinned: true, tags: nil, summary: nil
        )
    }

    /// WHEN the row is red: the desktop's rule, ported (`taskNeedsAction` — phase
    /// AGENT_COMPLETE and not done). Every other row paints NOTHING, which is what keeps
    /// the board one continuous sheet.
    func testOnlyAHandedBackTaskPaintsItsRowRed() {
        XCTAssertTrue(BoardModel.needsHuman(task("back", phase: "AGENT_COMPLETE")))
        XCTAssertFalse(BoardModel.needsHuman(task("todo", phase: "TODO")))
        XCTAssertFalse(BoardModel.needsHuman(task("running", phase: "IN_PROGRESS")))
        XCTAssertFalse(
            BoardModel.needsHuman(task("shipped", phase: "COMPLETE")),
            "COMPLETE is the human's own answer — it is not still asking"
        )
        XCTAssertFalse(
            BoardModel.needsHuman(task("closed", phase: "AGENT_COMPLETE", status: "done")),
            "done outranks the phase: a finished task is not waiting on anyone"
        )
        XCTAssertFalse(
            BoardModel.needsHuman(nil),
            "a session-only row has no phase to read, and inventing one would paint a row red on no evidence"
        )
        // …and NOTHING is painted for an ordinary row.
        XCTAssertNil(BoardRowSurface.tint(needsAction: false, isNew: false, dark: false))
        XCTAssertNil(BoardRowSurface.tint(needsAction: false, isNew: false, dark: true))
        // `nil`, not `.clear`, and R29 made that difference load-bearing: `.clear` used to
        // mean "let the board's one sheet through", and inside a card it would mean "cut a
        // hole in the card and show the page". `nil` hands the cell back to the
        // inset-grouped section, which paints its own card.
        XCTAssertNil(
            BoardRowSurface.color(needsAction: false, isNew: false),
            "an ordinary row must take the section's own card, untouched"
        )
    }

    /// The composition the LIST executes, driven end to end over rows the real band
    /// assembly built: `TaskBoardList.rowSurface` is the app-target call site, so this is
    /// the case that fails if the join is wired to the wrong row, the wrong id or the
    /// wrong field while both halves still pass their own tests.
    func testTheListPaintsRedForExactlyTheRowsThatWantAHuman() {
        let bands = BoardModel.bands(
            tasks: [
                task("wants-a-human", phase: "AGENT_COMPLETE"),
                task("ordinary", phase: "TODO"),
                task("finished", phase: "AGENT_COMPLETE", status: "done"),
            ],
            sessions: [], tierOf: [:], tierOrder: [:], customTiers: []
        )
        let rows = bands.flatMap(\.rows)
        XCTAssertEqual(rows.count, 3, "all three are pinned, so all three are on the board")
        for row in rows {
            let red = row.id == "wants-a-human"
            XCTAssertEqual(BoardModel.needsHuman(row.task), red, "row \(row.id)")
            let painted = TaskBoardList.rowSurface(row, newRowId: nil)
            if red {
                XCTAssertNotNil(painted, "row \(row.id) should be red paper")
            } else {
                XCTAssertNil(painted, "row \(row.id) must take the card untouched")
            }
        }
        // The green just-created flash rides the same surface, and RED WINS when a row is
        // both: two tints on one row would be two claims about the same pixels.
        let redRow = rows.first { $0.id == "wants-a-human" }!
        let flashed = surface(needsAction: true, isNew: true, dark: false)
        let plainRed = surface(needsAction: true, isNew: false, dark: false)
        XCTAssertEqual(flashed.r, plainRed.r, accuracy: 0.001, "red beats green on a row that is both")
        XCTAssertEqual(flashed.g, plainRed.g, accuracy: 0.001)
        XCTAssertEqual(flashed.b, plainRed.b, accuracy: 0.001)
        XCTAssertNotNil(
            TaskBoardList.rowSurface(redRow, newRowId: redRow.id),
            "the newly created red row is still painted"
        )
        let ordinary = rows.first { $0.id == "ordinary" }!
        XCTAssertNotNil(
            TaskBoardList.rowSurface(ordinary, newRowId: ordinary.id),
            "a just-created ordinary row takes the green flash — that is how 'where did it land?' is answered"
        )
    }

    /// It has to read as RED at a glance, in BOTH schemes — the failure mode of the
    /// first attempt (0.08 over white) was a tint that was present in the data and
    /// invisible on the screen.
    ///
    /// Stated as channel separation on the composite rather than as an alpha, because
    /// alpha is not what the eye judges: the same 0.16 over black lands at a near-black
    /// brown, which is why the dark value is its own number.
    func testTheRedRowReallyReadsRedInBothSchemes() {
        for dark in [false, true] {
            let paper = surface(needsAction: false, dark: dark)
            let red = surface(needsAction: true, dark: dark)
            let separation = red.r - max(red.g, red.b)
            XCTAssertGreaterThan(
                separation, 20,
                "dark=\(dark): the red channel leads by only \(separation)/255 — this is the 0.08 pink smudge again"
            )
            XCTAssertGreaterThan(
                abs(luminance(red) - luminance(paper)), 0.005,
                "dark=\(dark): the marked row is the same brightness as the sheet, so it reads as an unexplained smudge rather than a mark"
            )
            // The tint's own alpha, so a UIKit surprise (a dynamic colour that drops the
            // alpha on resolve) is diagnosed here rather than surfacing as a mystery.
            let tint = BoardRowSurface.tint(needsAction: true, isNew: false, dark: dark)
            XCTAssertNotNil(tint)
            let alpha = rgba(tint!, dark: dark).a
            let declared = dark
                ? BoardRowSurface.needsActionAlpha.dark
                : BoardRowSurface.needsActionAlpha.light
            XCTAssertEqual(alpha, Double(declared), accuracy: 0.001, "dark=\(dark)")
            XCTAssertGreaterThan(alpha, 0.10, "dark=\(dark): weaker than this reads as a smudge")
            XCTAssertLessThan(alpha, 0.45, "dark=\(dark): stronger than this and the ink is fighting it")
        }
        XCTAssertGreaterThan(
            BoardRowSurface.needsActionAlpha.dark, BoardRowSurface.needsActionAlpha.light,
            "over black the same alpha reads as nearly nothing — dark needs the stronger tint"
        )
        // The flash is the quieter of the two in both schemes: it answers "where did it
        // land?" and then goes away, so it must not out-shout a row that is asking for
        // something.
        XCTAssertLessThan(
            BoardRowSurface.justCreatedAlpha.light, BoardRowSurface.needsActionAlpha.light)
        XCTAssertLessThan(
            BoardRowSurface.justCreatedAlpha.dark, BoardRowSurface.needsActionAlpha.dark)
        for dark in [false, true] {
            let green = surface(needsAction: false, isNew: true, dark: dark)
            // A lower bar than the red's 20, deliberately: `systemGreen` is a much lighter
            // hue than `systemRed`, so over white paper the same alpha buys less channel
            // separation (measured ~15 light, ~31 dark). The flash only has to be
            // recognisably green for the second it exists, and it is the quieter of the
            // two treatments by design.
            XCTAssertGreaterThan(
                green.g - max(green.r, green.b), 10,
                "dark=\(dark): the just-created flash has to read as green, not as grey"
            )
        }
    }

    /// The TITLE stays legible on the red paper, which is the other half of the request:
    /// the ring and the title keep their normal colours, so the tint has to be something
    /// full-strength label ink still clears WCAG 4.5:1 against.
    ///
    /// Both schemes, because the tint is per-scheme and the label flips with it.
    func testTheTitleClearsFourAndAHalfToOneOnTheRedRow() {
        for dark in [false, true] {
            let red = surface(needsAction: true, dark: dark)
            let label = rgba(.label, dark: dark)
            let ratio = contrast(
                (r: label.r * 255, g: label.g * 255, b: label.b * 255), red)
            XCTAssertGreaterThanOrEqual(
                ratio, 4.5,
                "dark=\(dark): the title reads at \(ratio):1 on the marked row"
            )
            // The second line is `.secondary` on the same paper — a lower bar (it is
            // supporting text), but it must not disappear into the tint either.
            let secondary = rgba(.secondaryLabel, dark: dark)
            let secondaryInk = (
                r: (secondary.r * secondary.a) * 255 + red.r * (1 - secondary.a),
                g: (secondary.g * secondary.a) * 255 + red.g * (1 - secondary.a),
                b: (secondary.b * secondary.a) * 255 + red.b * (1 - secondary.a)
            )
            XCTAssertGreaterThanOrEqual(
                contrast(secondaryInk, red), 3.0,
                "dark=\(dark): the state word and project line sink into the tint"
            )
        }
    }

    /// Type-INDEPENDENCE, which is how "holds at default type AND at accessibility-XXXL"
    /// is established without re-measuring at each size: the surface takes no type size
    /// at all, so there is nothing for a size to change. The loop is what makes the day
    /// someone adds a size parameter an argument rather than a silent regression.
    func testTheSurfaceIsIdenticalAtEveryDynamicTypeSizeIncludingAXXXXL() {
        XCTAssertTrue(DynamicTypeSize.allCases.contains(.accessibility5),
            "AX-XXXL is the size the reported claim is about")
        for dark in [false, true] {
            let baseline = surface(needsAction: true, dark: dark)
            for size in DynamicTypeSize.allCases {
                let again = surface(needsAction: true, dark: dark)
                XCTAssertEqual(again.r, baseline.r, accuracy: 0.001, "\(size) dark=\(dark)")
                XCTAssertEqual(again.g, baseline.g, accuracy: 0.001, "\(size) dark=\(dark)")
                XCTAssertEqual(again.b, baseline.b, accuracy: 0.001, "\(size) dark=\(dark)")
                let label = rgba(.label, dark: dark)
                XCTAssertGreaterThanOrEqual(
                    contrast((r: label.r * 255, g: label.g * 255, b: label.b * 255), again), 4.5,
                    "\(size) dark=\(dark): the title's contrast on the marked row moved with the type size"
                )
            }
        }
    }

    /// The hairline still starts at the TITLE, not at the row's edge, so the ring's
    /// gutter stays clear (mockup: `left: 48px`). It is the one number the retired gutter
    /// column moved, and it is back where the shipped row had it: 34pt of ring frame with
    /// `-6` leading padding is 28pt of layout, plus 11pt of HStack spacing.
    ///
    /// It survives R29 unchanged, and that is not luck: the guide is measured in the row's
    /// OWN content space, so moving the row inside a card (which changed the cell's insets
    /// from full bleed to the platform's) cannot move it.
    func testTheRowSeparatorStartsAtTheTitleColumn() {
        XCTAssertEqual(TaskBoardRow.separatorLeadingInset, 39, accuracy: 0.001,
            "the hairline moved off the title — 34 - 6 + 11 is the arithmetic behind it")
        XCTAssertGreaterThan(
            TaskBoardRow.separatorLeadingInset, 28,
            "the hairline must start after the ring's tap target, or the line points at the ring"
        )
        // 320pt is the narrowest iPhone width the app ships to. Inside a card the row's
        // content is what is left after the section margin AND the cell's own inset on
        // both sides (~20pt each), i.e. ~240pt — a narrower budget than V1's full-bleed
        // 288pt, so this is the assertion that got STRICTER when the cards came back.
        XCTAssertLessThan(
            TaskBoardRow.separatorLeadingInset, 240 * 0.25,
            "the leading column eats more than a quarter of the narrowest row — a title at AX sizes has nowhere to wrap"
        )
    }
}

/// The R29 CARD/PAGE PAIRING: two colours that only mean anything relative to each other.
///
/// A card is not a colour, it is a STEP away from the page behind it, and this app has now
/// shipped that going wrong from both directions: the chips bar's card once measured 5.4
/// grey from a white page and read as nothing, and the same base kept against R29's grouped
/// page would have measured ~0 (light 242 on 242, dark 0 on 0) — the identical defect,
/// arrived at by changing the OTHER half. So the pair is asserted as a pair.
///
/// The second half of this class is the "no dead arithmetic" half, and it is the reason
/// these are not just two constants compared to each other: every value here is reached
/// through a call the APP makes. `BoardRowSurface.opaqueSurface` is what the shipped row
/// paint (`TaskBoardList.rowSurface` → `listRowBackground`) resolves to, and
/// `BoardBandBar.cardBaseColor` is what the chips bar fills its card with. A pairing that
/// was only ever read by a test would keep passing while the screen went flat.
@MainActor
final class BoardBandCardSurfaceTests: XCTestCase {

    /// RGBA (0-1) of a RESOLVED colour. Fails the test rather than returning an optional:
    /// a surface that isn't a plain RGB colour is the defect, not a case to handle.
    private func channels(_ color: UIColor) -> (r: Double, g: Double, b: Double, a: Double) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(color.getRed(&r, green: &g, blue: &b, alpha: &a),
            "a card/page surface must be a plain RGB colour")
        return (Double(r), Double(g), Double(b), Double(a))
    }

    /// 0-255 grey of a dynamic colour resolved for one scheme, asserting opacity on the
    /// way past — a card or a page that is translucent takes its colour from whatever is
    /// behind it, which is the one thing neither is allowed to do.
    private func grey(_ color: UIColor, dark: Bool) -> Double {
        let rgba = channels(color.resolvedColor(
            with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light)))
        XCTAssertEqual(rgba.a, 1, accuracy: 0.001,
            "dark=\(dark): a translucent surface reads whatever is behind it")
        return (rgba.r + rgba.g + rgba.b) / 3 * 255
    }

    /// The card has to step CLEAR of the page in both schemes, in the same direction.
    ///
    /// Same direction matters as much as the size: the grouped family lifts the card above
    /// the page in light AND dark, and a pairing that inverted in one scheme would make the
    /// cards read as holes there.
    func testTheCardStepsClearOfThePageInBothSchemes() {
        for dark in [false, true] {
            let page = grey(BoardBandCard.pageColor, dark: dark)
            let card = grey(BoardBandCard.surfaceColor, dark: dark)
            XCTAssertGreaterThan(
                card - page, 5.4,
                "dark=\(dark): the card is \(card - page) grey from the page — 5.4 is the measured delta that read as nothing"
            )
            XCTAssertLessThan(
                card - page, 60,
                "dark=\(dark): a card this far from the page stops being a card and becomes a banner"
            )
        }
    }

    /// The SwiftUI values the views take and the `UIColor`s this test measures are the same
    /// colour. Without this the whole file could be measuring a pairing nothing paints.
    func testTheMeasuredColoursAreTheOnesTheViewsApply() {
        XCTAssertEqual(BoardBandCard.surface, Color(BoardBandCard.surfaceColor))
        XCTAssertEqual(BoardBandCard.page, Color(BoardBandCard.pageColor))
    }

    /// APP CALL SITE 1: the marked row's paper. `TaskBoardList.rowSurface` →
    /// `BoardRowSurface.color` → `opaqueSurface`, which is what the row's
    /// `listRowBackground` actually gets — and it has to be the tint flattened onto the
    /// CARD, not onto the window background and not onto the page.
    ///
    /// Blended independently here, because this is the one place a re-derivation is worth
    /// its keep: it proves the app's own blend is compositing over the card rather than
    /// over something that merely looks similar in light mode (white `systemBackground` is
    /// the trap — it is identical to the card in light and 28 grey away in dark).
    func testTheMarkedRowsPaperIsTheTintFlattenedOntoTheBandCard() {
        for dark in [false, true] {
            let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
            let painted = channels(BoardRowSurface.opaqueSurface(
                needsAction: true, isNew: false, traits: traits))
            let ink = channels(
                BoardRowSurface.tint(needsAction: true, isNew: false, dark: dark)!
                    .resolvedColor(with: traits))
            let card = channels(BoardBandCard.surfaceColor.resolvedColor(with: traits))
            XCTAssertEqual(
                painted.r, ink.r * ink.a + card.r * (1 - ink.a), accuracy: 0.002,
                "dark=\(dark): the red row is not composited over the band card"
            )
            XCTAssertEqual(
                painted.g, ink.g * ink.a + card.g * (1 - ink.a), accuracy: 0.002, "dark=\(dark)")
            XCTAssertEqual(
                painted.b, ink.b * ink.a + card.b * (1 - ink.a), accuracy: 0.002, "dark=\(dark)")
            XCTAssertEqual(
                painted.a, 1, accuracy: 0.001,
                "dark=\(dark): a translucent row background replaces the card instead of tinting it"
            )
        }
        // …and a real board row asks for exactly that paint: the JOIN, so the pairing
        // cannot be correct arithmetic nothing reaches.
        let bands = BoardModel.bands(
            tasks: [WalnutTask(
                id: "wants-a-human", title: "a task", status: "todo", phase: "AGENT_COMPLETE",
                priority: "none", project: "", dueDate: nil,
                createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z",
                completedAt: nil, starred: nil, pinned: true, tags: nil, summary: nil
            )],
            sessions: [], tierOf: [:], tierOrder: [:], customTiers: []
        )
        let row = bands.flatMap(\.rows).first
        XCTAssertNotNil(row)
        XCTAssertTrue(
            BoardModel.needsHuman(row?.task),
            "fixture: this row is the one that wants a human"
        )
        // Non-nil is the whole claim available here: two dynamic colours built from
        // separate trait providers are not `==`, so comparing the Colors would be testing
        // `UIColor.isEqual`, not the paint. WHICH rows are painted is pinned by
        // `BoardRowNeedsActionSurfaceTests`; what this adds is that the value the list
        // hands `listRowBackground` is produced by the composite asserted above.
        XCTAssertNotNil(
            TaskBoardList.rowSurface(row!, newRowId: nil),
            "the list stopped painting the row the model says wants a human"
        )
    }

    /// APP CALL SITE 2: the chips bar fills its hand-rolled card with the BANDS' card
    /// colour, so the bar is one card in the stack rather than a bespoke panel.
    ///
    /// This is the assertion that fails if the page moves and the bar is left behind, which
    /// is exactly what R29 found: the bar's old base was 242 in light, the same value the
    /// new page took.
    func testTheChipsBarFillsItsCardWithTheBandCardsColour() {
        XCTAssertEqual(
            BoardBandBar.cardBaseColor, BoardBandCard.surfaceColor,
            "the chips bar has its own card colour again — one of the two will drift"
        )
        XCTAssertEqual(BoardBandBar.cardSurface, BoardBandCard.surface)
        for dark in [false, true] {
            // The FILTERS control sits ON that card and must still read as its own object.
            XCTAssertNotEqual(
                grey(BoardBandBar.filtersControlBaseColor, dark: dark),
                grey(BoardBandBar.cardBaseColor, dark: dark),
                "dark=\(dark): the control and the card are the same flat surface"
            )
        }
    }

    /// The one number a hand-rolled card cannot get from the OS, kept honest: the chips
    /// bar's radius is the shared one, and it is a real radius on every supported OS.
    func testTheHandRolledCardsRadiusIsTheSharedOne() {
        XCTAssertEqual(
            BoardBandRailGeometry.standard.cardCornerRadius, BoardBandCard.cornerRadius,
            accuracy: 0.001,
            "the bar drew its own radius again — it sits in a stack of OS-rounded cards"
        )
        XCTAssertGreaterThanOrEqual(
            BoardBandCard.cornerRadius, 10,
            "10pt is iOS 18's inset-grouped card; anything smaller is a square box, which is the look this restyle exists to remove"
        )
        // A card cannot round further than half its height, and R30 learned that the hard
        // way: the radius went to 26 to match the OS section cards (measured 15.87pt of
        // inset 2pt below the top edge, against the bar's 10.96 at radius 20) and the bar's
        // then-44pt height silently CLAMPED it to 22, which still measured 3.4pt tighter
        // than the cards around it. `bandBar` is 52 now, so 26 draws in full and the two
        // profiles agree to 0.25pt.
        //
        // The assertion is unchanged and it is now TIGHT (26 == 52/2): a card exactly twice
        // its radius tall is a stadium, which is also what an OS card of that height draws
        // (the reference screen's own short card, measured). Raising the radius without
        // raising the height fails here instead of shipping a clamped corner.
        XCTAssertLessThanOrEqual(
            BoardBandCard.cornerRadius, TasksChromeMetrics.bandBar / 2,
            "a radius past half the bar's height is clamped by the platform, so the bar draws a corner it never asked for"
        )
    }

    /// The heading sits OUTSIDE its card and has to line up with the content INSIDE it,
    /// which is the one alignment number the full-bleed heading cannot inherit.
    func testTheHeadingLinesUpWithTheCardsContentColumn() {
        XCTAssertEqual(BoardBandCard.headingContentInset, 20, accuracy: 0.001,
            "measured on the reference screen: card edge 20.1pt, heading label 40.8pt")
        XCTAssertLessThan(
            BoardBandCard.headingContentInset, TaskBoardRow.separatorLeadingInset,
            "the heading must start at the ring column, not at the title — a label indented past the rings reads as a second level"
        )
        // The gap above a heading and the gap below it are the ONLY rhythm between two
        // cards (`listSectionSpacing(0)`), so neither may be zero.
        XCTAssertGreaterThan(TaskBoardList.headingTopGap, 12,
            "cards would touch the heading above them")
        XCTAssertGreaterThan(TaskBoardList.headingLabelToCard, 8,
            "the label would sit on the lid of its own card")
    }
}

/// The board's bands, memoized (`BoardBandsCache`) — the second half of the top-of-list
/// hitch fix.
///
/// The first half is that the board is the PINNED working set, so a pass walks ~264 rows
/// instead of ~3,000. This half is that a pass which changes NOTHING costs nothing:
/// every `@State` publish, every ≤4Hz SSE batch and every keystroke evaluates
/// `TasksView.body`, and both chrome thresholds plus the search drawer publish inside the
/// first ~57pt of a drag — which is exactly the window the 460-515ms of dropped frames
/// were measured in.
@MainActor
final class BoardBandsCacheTests: XCTestCase {

    private func key(
        gen: UInt64 = 1, query: String = "", grouping: BoardGrouping = .tier,
        dateFilter: BoardDateFilter = .all, shownDone: Set<String> = [], nowBucket: Int = 0
    ) -> BoardBandsKey {
        BoardBandsKey(
            inputsGen: gen, query: query, grouping: grouping, dateFilter: dateFilter,
            shownDoneBands: shownDone, nowBucket: nowBucket
        )
    }

    private func band(_ id: String) -> BoardBand {
        BoardBand(bandId: id, label: id, rows: [], hiddenDone: 0, createSeed: nil)
    }

    @MainActor
    func testARepeatPassOverUnchangedInputsDoesNotRebuild() {
        let cache = BoardBandsCache()
        var builds = 0
        for _ in 0..<25 {
            let bands = cache.bands(for: key()) {
                builds += 1
                return [self.band("focus")]
            }
            XCTAssertEqual(bands.map(\.bandId), ["focus"])
        }
        XCTAssertEqual(
            builds, 1,
            "25 body passes over unchanged inputs rebuilt the board \(builds) times — the memo is not keyed on what it says it is"
        )
    }

    /// EVERY field of the key has to invalidate, and the list is the whole point: a field
    /// missing from the key is a board that silently stops updating, which is a worse
    /// failure than the rebuild it was trying to skip.
    @MainActor
    func testEveryInputInvalidates() {
        let variants: [(String, BoardBandsKey)] = [
            ("a store change (tasks / sessions / the tier split)", key(gen: 2)),
            ("a keystroke", key(query: "alpha")),
            ("the grouping control", key(grouping: .project)),
            ("the date filter", key(dateFilter: .now)),
            // An explicit expand has to survive the memo, or the tap would look like it
            // did nothing until some unrelated input happened to move the key.
            ("a band's done toggle", key(shownDone: ["focus"])),
            ("the clock, under the .now filter", key(dateFilter: .now, nowBucket: 1)),
        ]
        for (what, changed) in variants {
            let cache = BoardBandsCache()
            var builds = 0
            _ = cache.bands(for: key()) { builds += 1; return [self.band("focus")] }
            _ = cache.bands(for: changed) { builds += 1; return [self.band("satellite")] }
            XCTAssertEqual(builds, 2, "\(what) did not invalidate the memo")
        }
    }

    /// The value a hit returns is the value that was built, not a fresh empty one — the
    /// mistake that would make the board flash empty on every other pass.
    @MainActor
    func testAHitReturnsTheBandsItBuilt() {
        let cache = BoardBandsCache()
        let built = [band("focus"), band("backlog")]
        _ = cache.bands(for: key()) { built }
        let again = cache.bands(for: key()) { [] }
        XCTAssertEqual(again, built)
    }

    /// Going BACK to a previous key rebuilds rather than resurrecting an older answer:
    /// the cache holds ONE entry on purpose, because a board that is one keystroke stale
    /// is worse than one that re-derives.
    @MainActor
    func testTheCacheHoldsExactlyOneEntry() {
        let cache = BoardBandsCache()
        var builds = 0
        _ = cache.bands(for: key()) { builds += 1; return [self.band("focus")] }
        _ = cache.bands(for: key(query: "a")) { builds += 1; return [self.band("focus")] }
        _ = cache.bands(for: key()) { builds += 1; return [self.band("focus")] }
        XCTAssertEqual(builds, 3)
    }
}

// MARK: - A row whose session the session LIST does not carry

/// The board's tap, as a decision.
///
/// The bug behind these: the board joins `sessions` by task id, so a session the
/// session LIST does not carry leaves a row with `session == nil` — and the row read
/// that as "this task has never had a session". It opened a New Session DRAFT on a
/// pinned task that had a real session, and that draft (unlinked, `taskId: nil`) would
/// have manufactured a second, orphan session on it.
///
/// Two things make the difference knowable, and both are pinned here: the task's own
/// `session_ids` (which the phone receives on `GET /v1/tasks/:id` and, before this
/// round, read nowhere), and the three-valued `BoardRow.knownSessionIds` — unknown,
/// learned-empty, learned-non-empty — because "nobody asked" and "there are none" route
/// differently and only one of them is worth a request.
final class BoardSessionTapRouteTests: XCTestCase {

    private func task(
        _ id: String, title: String = "ship the thing", project: String = "",
        phase: String = "TODO"
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: title, status: "todo", phase: phase,
            priority: "none", project: project, dueDate: nil,
            createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
            completedAt: nil, starred: nil, pinned: true, tags: nil, summary: nil
        )
    }

    private func session(_ id: String, taskId: String?, status: String = "running") -> WalnutSession {
        WalnutSession(
            id: id, title: "Session: walnut — hello", taskId: taskId, taskTitle: "t",
            project: nil, host: "", processStatus: status, model: nil, mode: nil,
            startedAt: "2026-08-26T00:00:00Z", lastActiveAt: "2026-08-27T00:00:00Z",
            messageCount: 3, cwd: nil, pinned: true, focusTier: nil, description: nil
        )
    }

    // MARK: - Which id is "the session to open"

    /// LAST wins, because that is the server's own order: every link path APPENDS to
    /// `session_ids`, so the tail is the newest session.
    func testNewestSessionIdIsTheLastEntry() {
        XCTAssertEqual(BoardModel.newestSessionId(["s1", "s2", "s3"]), "s3")
        XCTAssertEqual(BoardModel.newestSessionId(["only"]), "only")
    }

    /// A cleared slot leaves an empty string server-side, and opening `""` is a 404
    /// dressed up as a destination. Whitespace is the same thing with a space in it.
    func testNewestSessionIdSkipsBlanksAndTrims() {
        XCTAssertEqual(BoardModel.newestSessionId(["s1", "", "   "]), "s1")
        XCTAssertEqual(BoardModel.newestSessionId(["s1", " s2 "]), "s2")
    }

    /// Unknown (nil) and known-empty both answer nil — they differ in ROUTING, not in
    /// "is there an id here".
    func testNewestSessionIdIsNilWhenThereIsNothingToOpen() {
        XCTAssertNil(BoardModel.newestSessionId(nil))
        XCTAssertNil(BoardModel.newestSessionId([]))
        XCTAssertNil(BoardModel.newestSessionId(["", " "]))
    }

    // MARK: - The row's state must not claim the task is sessionless

    /// THE regression: a row whose task has `session_ids` but no hydrated session is
    /// NOT `.none`. `.none` blanks the dot and drops the state word, so the row reads
    /// as work that never started.
    func testARowWithIdsOnlyIsNotSessionless() {
        let state = BoardModel.state(
            task: task("t1"), session: nil, knownSessionIds: ["s-old"]
        )
        XCTAssertNotEqual(state, .none, "a task with session_ids must not read as sessionless")
        XCTAssertEqual(state, .earlierSession)
        XCTAssertTrue(state.hasSession, "the trailing dot draws for a row that HAS history")
        XCTAssertFalse(state.word.isEmpty, "the second line has to say something true")
    }

    /// The two honest "no session" cases keep today's wording: nobody has asked yet,
    /// and asked-and-there-are-none. Neither may invent history.
    func testUnknownAndLearnedEmptyBothStayNone() {
        XCTAssertEqual(BoardModel.state(task: task("t1"), session: nil), .none)
        XCTAssertEqual(
            BoardModel.state(task: task("t1"), session: nil, knownSessionIds: []), .none,
            "asked, and this task has never had a session"
        )
        XCTAssertEqual(
            BoardModel.state(task: task("t1"), session: nil, knownSessionIds: [""]), .none,
            "a cleared slot is not a session"
        )
    }

    /// A hydrated session still decides the state — the ids are a FALLBACK, never a
    /// second opinion about a session the list already has.
    func testAHydratedSessionOutranksTheIds() {
        XCTAssertEqual(
            BoardModel.state(
                task: task("t1"), session: session("s9", taskId: "t1", status: "running"),
                knownSessionIds: ["s-old", "s9"]
            ),
            .running
        )
        XCTAssertEqual(
            BoardModel.state(
                task: task("t1", phase: "AGENT_COMPLETE"),
                session: session("s9", taskId: "t1"), knownSessionIds: ["s9"]
            ),
            .handedBack,
            "the red-row rule keeps its precedence"
        )
    }

    // MARK: - Where the tap goes

    func testAHydratedSessionOpensThatSession() {
        let live = session("s1", taskId: "t1")
        let route = BoardModel.tapRoute(BoardRow(task: task("t1"), session: live))
        XCTAssertEqual(route, .open(live))
    }

    /// The fix, stated as the route: ids-only RESOLVES the newest session by id. It must
    /// not be `.draft` — that is the shipped bug.
    func testIdsOnlyResolvesTheNewestSessionInsteadOfDrafting() {
        let row = BoardRow(
            task: task("t1"), session: nil, knownSessionIds: ["s1", "s2", "s3"]
        )
        let route = BoardModel.tapRoute(row)
        XCTAssertEqual(
            route,
            .resolve(
                sessionId: "s3",
                draftFallback: BoardModel.BoardDraftSeed(taskId: "t1", taskTitle: "ship the thing")
            )
        )
        if case .draft = route {
            XCTFail("a task with session_ids must never open the New Session draft")
        }
    }

    /// Unknown = ask. The slim list projection carries no `session_ids`, so a cold board
    /// cannot tell "never had a session" from "its session aged out of the list", and one
    /// task-detail read settles it.
    func testUnknownProbesTheTaskDetailBeforeRouting() {
        let route = BoardModel.tapRoute(BoardRow(task: task("t1"), session: nil))
        XCTAssertEqual(
            route,
            .probe(
                taskId: "t1",
                draftFallback: BoardModel.BoardDraftSeed(taskId: "t1", taskTitle: "ship the thing")
            )
        )
    }

    /// Only a LEARNED-empty answer goes straight to the draft, so the second tap on a
    /// genuinely sessionless row spends no request at all.
    func testLearnedSessionlessDraftsImmediately() {
        let row = BoardRow(task: task("t1"), session: nil, knownSessionIds: [])
        XCTAssertEqual(
            BoardModel.tapRoute(row),
            .draft(BoardModel.BoardDraftSeed(taskId: "t1", taskTitle: "ship the thing"))
        )
    }

    /// EVERY route that can end in a draft carries the originating task, including the
    /// fallbacks the two lookups fall back to. An unattached draft started from a task
    /// row is what creates an orphan session on an already-sessioned task.
    func testNoRouteFromATaskRowCanProduceAnUnattachedDraft() {
        let rows = [
            BoardRow(task: task("t1"), session: nil),
            BoardRow(task: task("t1"), session: nil, knownSessionIds: []),
            BoardRow(task: task("t1"), session: nil, knownSessionIds: ["s1"]),
            // A session-only row: the projection lacks the task, but the SESSION names
            // its owner, so the draft still links.
            BoardRow(task: nil, session: session("s1", taskId: "t1")),
        ]
        for row in rows {
            let seed: BoardModel.BoardDraftSeed?
            switch BoardModel.tapRoute(row) {
            case .draft(let s): seed = s
            case .resolve(_, let s): seed = s
            case .probe(_, let s): seed = s
            case .open: seed = nil // no draft is reachable from this route
            }
            guard let seed else { continue }
            XCTAssertEqual(
                seed.taskId, "t1",
                "a draft reachable from a task row must link back to that task"
            )
        }
        // And the toolbar's own entrance stays deliberately unattached.
        XCTAssertNil(BoardModel.BoardDraftSeed.unattached.taskId)
    }

    /// The label the row and its context menu show ("Open Session" vs "Start Session")
    /// and the row's accessibility hint all read `hasKnownSession`, so it has to agree
    /// with the route or the row promises a destination it does not go to.
    func testHasKnownSessionAgreesWithTheRoute() {
        let cases: [(BoardRow, Bool)] = [
            (BoardRow(task: task("t1"), session: session("s1", taskId: "t1")), true),
            (BoardRow(task: task("t1"), session: nil, knownSessionIds: ["s1"]), true),
            (BoardRow(task: task("t1"), session: nil, knownSessionIds: []), false),
            (BoardRow(task: task("t1"), session: nil), false),
        ]
        for (row, expected) in cases {
            XCTAssertEqual(row.hasKnownSession, expected)
            switch BoardModel.tapRoute(row) {
            case .open, .resolve:
                XCTAssertTrue(row.hasKnownSession, "the row says it has no session but the tap opens one")
            case .probe, .draft:
                XCTAssertFalse(row.hasKnownSession, "the row claims a session the tap cannot open")
            }
        }
    }

    // MARK: - What the row is ALLOWED TO SAY (R28c P2)

    /// The defect: `hasKnownSession` is a Bool and the ledger is three-valued, so every caller
    /// that phrased an affordance from it collapsed UNKNOWN into "no session". On the board
    /// that is not a corner — `GET /v1/tasks` carries no `session_ids`, so it is what EVERY
    /// row looks like at load — and the long-press menu therefore offered "Start Session" on
    /// tasks that already had sessions. A user who accepts that offer gets a duplicate.
    ///
    /// `BoardModel.affordance` is the three answers, and the case that matters is the third
    /// one: it must promise NEITHER.
    func testTheAffordanceHasThreeAnswersFromTheThreeValuedLedger() {
        let cases: [(name: String, row: BoardRow, expected: BoardModel.SessionAffordance)] = [
            ("hydrated",
             BoardRow(task: task("t1"), session: session("s1", taskId: "t1")), .open),
            ("ids only (session aged out of the list)",
             BoardRow(task: task("t1"), session: nil, knownSessionIds: ["s1"]), .open),
            ("asked, and there are none",
             BoardRow(task: task("t1"), session: nil, knownSessionIds: []), .start),
            ("asked, and every slot was cleared server-side",
             BoardRow(task: task("t1"), session: nil, knownSessionIds: ["", "  "]), .start),
            ("nobody has asked yet",
             BoardRow(task: task("t1"), session: nil), .unknown),
        ]
        for entry in cases {
            XCTAssertEqual(
                BoardModel.affordance(entry.row), entry.expected, entry.name
            )
        }
    }

    /// The words, pinned: the two KNOWN states keep the labels they shipped with, and the
    /// unknown state says something that is true whichever way its probe resolves.
    func testTheAffordanceWords() {
        XCTAssertEqual(BoardModel.SessionAffordance.open.menuLabel, "Open Session")
        XCTAssertEqual(BoardModel.SessionAffordance.start.menuLabel, "Start Session")
        XCTAssertEqual(BoardModel.SessionAffordance.unknown.menuLabel, "Open")

        XCTAssertEqual(BoardModel.SessionAffordance.open.accessibilityHint, "Open the session")
        XCTAssertEqual(BoardModel.SessionAffordance.start.accessibilityHint, "Start a session")
        XCTAssertEqual(
            BoardModel.SessionAffordance.unknown.accessibilityHint,
            "Open the session, or start one"
        )
    }

    /// The rule the defect broke, stated over BOTH voices at once: an unknown row may not
    /// offer to START anything, in the menu or to VoiceOver. Substring checks and not equality
    /// so a future rewording cannot slip "Start" back in through a longer sentence.
    func testAnUnknownRowNeverOffersToStartASessionInEitherVoice() {
        let unknown = BoardModel.SessionAffordance.unknown
        for phrasing in [unknown.menuLabel, unknown.accessibilityHint, unknown.menuIcon] {
            XCTAssertFalse(
                phrasing.localizedCaseInsensitiveContains("start a"),
                "\(phrasing): an unknown row nudged the user into a duplicate session"
            )
        }
        XCTAssertFalse(
            unknown.menuLabel.localizedCaseInsensitiveContains("start"),
            "\(unknown.menuLabel): the menu item is the exact string R28c QA caught"
        )
        // And the glyph carries no promise either: a play triangle says "new run", a speech
        // bubble says "there is a conversation here".
        XCTAssertNotEqual(unknown.menuIcon, BoardModel.SessionAffordance.start.menuIcon)
        XCTAssertNotEqual(unknown.menuIcon, BoardModel.SessionAffordance.open.menuIcon)
    }

    /// The affordance and the ROUTE are two readings of one ledger, so they have to line up
    /// case for case — that is the whole reason the phrasing became a function of the row
    /// instead of a ternary at each call site.
    func testTheAffordanceAgreesWithTheRouteCaseForCase() {
        let rows = [
            BoardRow(task: task("t1"), session: session("s1", taskId: "t1")),
            BoardRow(task: task("t1"), session: nil, knownSessionIds: ["s1"]),
            BoardRow(task: task("t1"), session: nil, knownSessionIds: []),
            BoardRow(task: task("t1"), session: nil),
        ]
        for row in rows {
            switch (BoardModel.affordance(row), BoardModel.tapRoute(row)) {
            case (.open, .open), (.open, .resolve), (.unknown, .probe), (.start, .draft):
                continue
            case let (affordance, route):
                XCTFail("\(affordance) is the wrong word for a tap that goes to \(route)")
            }
        }
    }

    /// End to end through the real band builder, which is where the defect was actually
    /// reachable: a cold board (no ledger) must not label its rows "Start Session", and the
    /// same row must switch to "Open Session" once the ledger says the task has sessions.
    func testTheBoardsOwnRowsNeverSayStartSessionBeforeAnyoneHasAsked() {
        func row(knownSessionIds: [String: [String]]) -> BoardRow? {
            BoardModel.bands(
                tasks: [task("t1")], sessions: [], tierOf: ["t1": "focus"],
                tierOrder: ["focus": ["t1"]], customTiers: [],
                knownSessionIds: knownSessionIds
            ).first?.rows.first
        }

        guard let cold = row(knownSessionIds: [:]) else { return XCTFail("no row on a cold board") }
        XCTAssertEqual(BoardModel.affordance(cold), .unknown)
        XCTAssertEqual(BoardModel.affordance(cold).menuLabel, "Open")

        guard let hydrated = row(knownSessionIds: ["t1": ["s-old", "s-new"]]) else {
            return XCTFail("no row once the ledger is populated")
        }
        XCTAssertEqual(BoardModel.affordance(hydrated), .open)
        XCTAssertEqual(BoardModel.affordance(hydrated).menuLabel, "Open Session")
    }

    // MARK: - The board carries the ledger onto its rows

    /// End to end through the real band builder: a PINNED task with no session in the
    /// store, whose detail said it has sessions, gets a row that knows it.
    func testBandsCarryKnownSessionIdsOntoTheRow() {
        let bands = BoardModel.bands(
            tasks: [task("t1")], sessions: [], tierOf: ["t1": "focus"],
            tierOrder: ["focus": ["t1"]], customTiers: [],
            knownSessionIds: ["t1": ["s-old", "s-new"]]
        )
        guard let row = bands.first(where: { $0.bandId == "focus" })?.rows.first else {
            return XCTFail("the pinned task lost its row")
        }
        XCTAssertNil(row.session, "the session list genuinely has nothing for this task")
        XCTAssertEqual(row.knownSessionIds, ["s-old", "s-new"])
        XCTAssertNotEqual(
            BoardModel.state(task: row.task, session: row.session, knownSessionIds: row.knownSessionIds),
            .none,
            "the row must not read as sessionless"
        )
        XCTAssertEqual(
            BoardModel.tapRoute(row),
            .resolve(
                sessionId: "s-new",
                draftFallback: BoardModel.BoardDraftSeed(taskId: "t1", taskTitle: "ship the thing")
            ),
            "the board's tap must open the session, not the draft"
        )
    }

    /// A cold board (nothing asked yet) behaves exactly as it did before the ledger
    /// existed, except that its tap asks one question first.
    func testAnEmptyLedgerLeavesTheRowUnknown() {
        let bands = BoardModel.bands(
            tasks: [task("t1")], sessions: [], tierOf: ["t1": "focus"],
            tierOrder: ["focus": ["t1"]], customTiers: []
        )
        guard let row = bands.first?.rows.first else { return XCTFail("no row") }
        XCTAssertNil(row.knownSessionIds, "missing key = never asked, NOT 'no sessions'")
        XCTAssertFalse(row.hasKnownSession)
        if case .probe = BoardModel.tapRoute(row) {} else {
            XCTFail("an unknown row's tap has to ask before it routes")
        }
    }

    // MARK: - The by-id reply, shaped like a list row

    private func detail(
        id: String, taskId: String? = nil, status: String? = "stopped",
        host: String? = nil, lastActive: String? = nil
    ) -> SessionDetail {
        SessionDetail(
            session: SessionDetail.Record(
                claudeSessionId: id, processStatus: status, title: "Session: walnut — hi",
                mode: nil, archived: nil, taskId: taskId, project: nil, host: host,
                cwd: "/repo", startedAt: "2026-06-01T00:00:00Z", lastActiveAt: lastActive,
                messageCount: 12, model: nil, description: nil
            ),
            pendingPermissions: []
        )
    }

    /// The row is keyed by the id we ASKED for: the conversation page must land on the
    /// session the tap resolved, whatever the record echoes.
    func testFromDetailKeepsTheRequestedId() {
        let row = WalnutSession.fromDetail(
            detail(id: "echoed"), requestedId: "asked-for", task: task("t1")
        )
        XCTAssertEqual(row.id, "asked-for")
        XCTAssertEqual(row.messageCount, 12)
        XCTAssertEqual(row.cwd, "/repo")
    }

    /// The owning task survives even when the reply omits it — that link is what makes
    /// the pushed page show the task it belongs to.
    func testFromDetailFallsBackToTheRowsTaskForTheLink() {
        let fromRecord = WalnutSession.fromDetail(
            detail(id: "s1", taskId: "t-record"), requestedId: "s1", task: task("t-row")
        )
        XCTAssertEqual(fromRecord.taskId, "t-record", "the server's answer wins when it has one")
        let fromRow = WalnutSession.fromDetail(
            detail(id: "s1"), requestedId: "s1", task: task("t-row")
        )
        XCTAssertEqual(fromRow.taskId, "t-row")
        XCTAssertEqual(fromRow.taskTitle, "ship the thing")
    }

    /// The DEGRADED cloud reply (bridge down) carries four fields. Every absence has to
    /// answer with something TRUE: no invented age, no invented host, no claimed pin.
    func testFromDetailDoesNotInventFactsTheReplyOmitted() {
        let degraded = SessionDetail(
            session: SessionDetail.Record(
                claudeSessionId: "s1", processStatus: nil, title: nil,
                mode: nil, archived: nil
            ),
            pendingPermissions: []
        )
        let row = WalnutSession.fromDetail(degraded, requestedId: "s1", task: nil)
        XCTAssertEqual(row.host, "", "an absent host is the primary box on the wire")
        XCTAssertNil(row.lastActiveValue, "a synthetic 'now' would print '2s' on a June session")
        XCTAssertEqual(row.messageCount, 0)
        XCTAssertNil(row.pinned, "the pin lives on the TASK — claiming one here invents a board row")
        XCTAssertEqual(row.processStatus, "unknown")
        XCTAssertEqual(
            BoardModel.state(task: nil, session: row), .ended,
            "unknown liveness reads as ended, not as running"
        )
    }
}

/// The two bounded lookups a board tap can make, against a scripted transport.
@MainActor
final class BoardSessionLookupStoreTests: XCTestCase {

    private func detail(_ id: String, sessionIds: [String]?) -> TaskDetail {
        TaskDetail(
            id: id, title: "ship the thing", status: "todo", phase: "TODO",
            priority: "none", project: "", description: nil, summary: nil, note: nil,
            tags: nil, starred: nil, pinned: true, dependsOn: nil, isBlocked: nil,
            resolvedDependencies: nil, dependents: nil, children: nil, parent: nil,
            sessionIds: sessionIds
        )
    }

    /// The answer is cached, so the SECOND tap on that row spends no request — and the
    /// board's memo generation moves, so the row stops saying "no session yet".
    func testFetchSessionIdsCachesTheAnswerAndMovesTheBoardGeneration() async {
        let mock = MockTaskTransport()
        mock.taskDetailResult = detail("t1", sessionIds: ["s1", "s2"])
        let store = TasksStore(transport: mock)
        let before = store.boardInputsGen

        let ids = await store.fetchSessionIds(for: "t1")
        XCTAssertEqual(ids, ["s1", "s2"])
        XCTAssertEqual(store.knownSessionIds(for: "t1"), ["s1", "s2"])
        XCTAssertNotEqual(store.boardInputsGen, before, "the board would keep its stale rows")
        XCTAssertEqual(mock.callCount("taskDetail"), 1)
    }

    /// "This task has never had a session" is a real answer and is cached as `[]` —
    /// which is what routes the next tap straight to the draft.
    func testAnEmptyAnswerIsCachedAsEmptyNotAsUnknown() async {
        let mock = MockTaskTransport()
        mock.taskDetailResult = detail("t1", sessionIds: [])
        let store = TasksStore(transport: mock)

        let ids = await store.fetchSessionIds(for: "t1")
        XCTAssertEqual(ids, [])
        XCTAssertEqual(store.knownSessionIds(for: "t1"), [], "learned-empty, not unknown")
    }

    /// A failed lookup must not be recorded as "no sessions": that would teach the
    /// board, permanently, that an offline moment means the task has no history.
    func testAFailedLookupLeavesTheLedgerUnknown() async {
        let mock = MockTaskTransport()
        mock.error = APIError.badResponse
        let store = TasksStore(transport: mock)

        let ids = await store.fetchSessionIds(for: "t1")
        XCTAssertNil(ids)
        XCTAssertNil(store.knownSessionIds(for: "t1"))
    }

    /// Blank ids never reach the ledger — a cleared slot is not a session to open.
    func testBlankIdsAreDroppedOnTheWayIn() async {
        let mock = MockTaskTransport()
        mock.taskDetailResult = detail("t1", sessionIds: ["", "  ", "s1"])
        let store = TasksStore(transport: mock)

        let ids = await store.fetchSessionIds(for: "t1")
        XCTAssertEqual(ids, ["s1"])
    }

    /// The OTHER deposit path: opening a task's detail sheet teaches the board about
    /// that task's sessions, so its row is honest before anyone taps it.
    func testOpeningATaskDetailDepositsItsSessionIds() async {
        let mock = MockTaskTransport()
        mock.taskDetailResult = detail("t1", sessionIds: ["s1"])
        let store = TasksStore(transport: MockTaskTransport())
        TasksStore.shared = store

        let controller = TaskDetailController(taskId: "t1", transport: mock)
        await controller.load()

        XCTAssertEqual(store.knownSessionIds(for: "t1"), ["s1"])
    }
}
