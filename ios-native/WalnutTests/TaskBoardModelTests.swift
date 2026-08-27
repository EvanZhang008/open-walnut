import XCTest
@testable import Walnut

/// Every pure rule the board is built on. The layout is the simulator's job;
/// what is pinned here is the arithmetic and the semantics: which band a row is
/// in, in what order, what its second line says, what a tapped tier token does,
/// what expanding does to the other rows' state, and where a new task lands.
final class TaskBoardModelTests: XCTestCase {

    // MARK: - Fixtures

    private func task(
        _ id: String, title: String = "a task", project: String = "",
        status: String = "todo", phase: String = "TODO", pinned: Bool? = true
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: title, status: status, phase: phase,
            priority: "none", project: project, dueDate: nil,
            createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
            completedAt: status == "done" ? "2026-08-27T01:00:00Z" : nil,
            starred: nil, pinned: pinned, tags: nil, summary: nil
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
        XCTAssertEqual(bands.map(\.tierId), ["focus", "satellite", "backlog", "wait", "ct_abc12345"])
        XCTAssertEqual(bands.last?.label, "Deep Work", "a custom tier shows its label, never its ct_ id")
    }

    func testEmptyBandsAreDropped() {
        let bands = BoardModel.bands(
            tasks: [task("f")], sessions: [],
            tierOf: ["f": "focus"], tierOrder: ["focus": ["f"]], customTiers: []
        )
        XCTAssertEqual(bands.map(\.tierId), ["focus"], "an empty tier is not a heading")
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
        XCTAssertEqual(bands.first(where: { $0.tierId == "focus" })?.rows.map(\.id), ["f1"])
        XCTAssertEqual(bands.first(where: { $0.tierId == "satellite" })?.rows.map(\.id), ["s1", "s2"])
    }

    /// A band that is ALL done and hiding must still render its heading, or the
    /// `show done` toggle that would bring the rows back would be gone too.
    func testABandHidingEveryRowKeepsItsHeading() {
        let bands = BoardModel.bands(
            tasks: [task("d", status: "done", phase: "COMPLETE")], sessions: [],
            tierOf: ["d": "focus"], tierOrder: ["focus": ["d"]],
            customTiers: [], hiddenDoneTiers: ["focus"]
        )
        XCTAssertEqual(bands.map(\.tierId), ["focus"])
        XCTAssertEqual(bands.first?.rows.count, 0)
        XCTAssertEqual(bands.first?.hiddenDone, 1, "the heading can say what to un-hide")
    }

    // MARK: - The unpinned-but-alive tail

    /// Live work on an unpinned task must not be invisible on the one screen that
    /// shows work. It lands in a trailing band, most recent first.
    func testUnpinnedLiveWorkAppearsInATrailingBandNewestFirst() {
        let tasks = [
            task("pinned"),
            task("loose1", pinned: false),
            task("loose2", pinned: false),
            task("quiet", pinned: false),
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
        XCTAssertEqual(bands.map(\.tierId), ["focus", BoardModel.activeTierId])
        XCTAssertEqual(bands.last?.rows.map(\.id), ["loose2", "loose1"],
            "newest activity first; a stopped session is not live work")
    }

    /// A session whose owning task never reached the projection still gets a row
    /// rather than disappearing — but only while it is alive.
    func testATasklessLiveSessionStillGetsARow() {
        let bands = BoardModel.bands(
            tasks: [], sessions: [
                session("orphan", taskId: nil, status: "running"),
                session("dead", taskId: nil, status: "stopped"),
            ],
            tierOf: [:], tierOrder: [:], customTiers: []
        )
        XCTAssertEqual(bands.map(\.tierId), [BoardModel.activeTierId])
        XCTAssertEqual(bands.first?.rows.map(\.id), ["orphan"])
        XCTAssertEqual(bands.first?.rows.first?.canRetier, false,
            "a session with no task has nothing to pin, so it shows no tier picker")
    }

    func testAPinnedTaskIsNeverAlsoInTheUnpinnedTail() {
        let bands = BoardModel.bands(
            tasks: [task("t")], sessions: [session("s", taskId: "t", status: "running")],
            tierOf: ["t": "focus"], tierOrder: ["focus": ["t"]], customTiers: []
        )
        XCTAssertEqual(bands.map(\.tierId), ["focus"], "one row, one band — never two")
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
        XCTAssertEqual(bands.map(\.tierId), ["focus"])
        XCTAssertEqual(bands.first?.rows.map(\.id), ["a"])
    }

    // MARK: - One task, one row (the search-on-the-board dedup)

    /// A search on the board shows the matching bands AND the matching open tasks
    /// below them. A PINNED task that matched belongs to both sets, so without the
    /// exclusion it appeared twice on one screen — which is the exact confusion
    /// ("task and session feel too separate") this redesign exists to remove.
    func testASearchOnTheBoardNeverShowsOneTaskTwice() {
        let pinned = task("pinned", title: "alpha work", project: "marina")
        let loose = task("loose", title: "alpha elsewhere", project: "marina", pinned: false)
        let bands = BoardModel.bands(
            tasks: [pinned, loose], sessions: [],
            tierOf: ["pinned": "focus"], tierOrder: ["focus": ["pinned"]],
            customTiers: [], query: "alpha"
        )
        XCTAssertEqual(bands.first?.rows.map(\.id), ["pinned"])

        let alreadyShown = BoardModel.rowIds(bands)
        XCTAssertEqual(alreadyShown, ["pinned"])

        let hits = TasksView.sections(
            from: [pinned, loose], query: "alpha", excluding: alreadyShown
        )
        let hitIds = hits.flatMap(\.tasks).map(\.id)
        XCTAssertEqual(hitIds, ["loose"], "the pinned row is already on screen in its band")
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

    /// The default (no exclusion) must be byte-for-byte the old behaviour — every
    /// other filter calls this and none of them wants a dedup.
    func testSectionsWithoutAnExclusionIsUnchanged() {
        let rows = [task("a", title: "alpha", project: "marina"), task("b", title: "alpha", project: "")]
        let sections = TasksView.sections(from: rows, query: "alpha")
        XCTAssertEqual(sections.map(\.project), ["Inbox", "marina"], "headers A→Z, Inbox for \"\"")
        XCTAssertEqual(sections.flatMap(\.tasks).count, 2)
    }

    // MARK: - The letter rail

    func testRailLettersAreUniqueAcrossBands() {
        // "Focus" and "Fast lane" both start with F — the second must not repeat it.
        let bands = BoardModel.bands(
            tasks: ["a", "b", "c", "d", "e"].map { task($0) }, sessions: [],
            tierOf: ["a": "focus", "b": "satellite", "c": "backlog", "d": "wait", "e": "ct_abc12345"],
            tierOrder: [
                "focus": ["a"], "satellite": ["b"], "backlog": ["c"],
                "wait": ["d"], "ct_abc12345": ["e"],
            ],
            customTiers: [FocusTierInfo(id: "ct_abc12345", label: "Fast lane")]
        )
        let letters = bands.map(\.letter)
        XCTAssertEqual(Set(letters).count, letters.count, "two identical rail buttons is a bug: \(letters)")
        XCTAssertEqual(Array(letters.prefix(4)), ["F", "S", "B", "W"])
    }

    /// A rail glyph rides an accessibility identifier, and automation matches
    /// those as REGEXES — so it stays alphanumeric and can never carry a `|`.
    func testRailLettersAreAutomationSafe() {
        var taken = Set<String>()
        for label in ["Focus", "a|b", "(paren)", "…", "Wait", "Wait", "工作"] {
            let letter = BoardModel.railLetter(for: label, taken: &taken)
            XCTAssertEqual(letter.count, 1, "\(label) → \(letter)")
            XCTAssertFalse(letter.contains("|"), "a pipe reads as a regex alternation")
        }
    }

    func testRailLetterFallsBackToDigitsWhenEveryLetterIsTaken() {
        var taken = Set(["W", "A", "I", "T"])
        XCTAssertEqual(BoardModel.railLetter(for: "Wait", taken: &taken), "0")
        XCTAssertEqual(BoardModel.railLetter(for: "Wait", taken: &taken), "1")
    }

    // MARK: - Expand / collapse

    func testExpandThenCollapseTheSameRow() {
        var open = BoardModel.toggleExpanded([], "t1")
        XCTAssertEqual(open, ["t1"])
        open = BoardModel.toggleExpanded(open, "t1")
        XCTAssertTrue(open.isEmpty)
    }

    /// Expanding a second row must NOT collapse the first. Force-collapsing a row
    /// that sits above the viewport shrinks content ABOVE the visible area, which
    /// is precisely how a list yanks its scroll position.
    func testExpandingASecondRowLeavesTheFirstOpen() {
        var open = BoardModel.toggleExpanded([], "above")
        open = BoardModel.toggleExpanded(open, "tapped")
        XCTAssertEqual(open, ["above", "tapped"],
            "one-at-a-time would resize a row above the viewport and move every visible row")
    }

    func testCollapsingAnUnknownRowIsANoop() {
        XCTAssertEqual(BoardModel.toggleExpanded(["a"], "b"), ["a", "b"])
        XCTAssertEqual(BoardModel.toggleExpanded([], "x"), ["x"])
    }

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
                inlineAddActive: false, openAddGroup: nil, openCreateTier: "backlog"
            ),
            "the row is at the foot of the band the user is looking at — stay there"
        )
    }

    func testEveryOpenAddRowSuppressesTheRelocation() {
        XCTAssertFalse(TasksView.shouldRelocateToNewTask(
            inlineAddActive: true, openAddGroup: nil, openCreateTier: nil))
        XCTAssertFalse(TasksView.shouldRelocateToNewTask(
            inlineAddActive: false, openAddGroup: .tier("focus"), openCreateTier: nil))
        XCTAssertFalse(TasksView.shouldRelocateToNewTask(
            inlineAddActive: false, openAddGroup: nil, openCreateTier: "focus"))
    }

    /// With nothing open the help is still wanted: a task created from the toolbar
    /// `+` has no on-screen home, so the list should go find it.
    func testWithNoAddRowOpenTheRelocationStillHappens() {
        XCTAssertTrue(TasksView.shouldRelocateToNewTask(
            inlineAddActive: false, openAddGroup: nil, openCreateTier: nil))
    }

    // MARK: - Automation-safe band ids

    func testBandIdentifierSlugsAreRegexSafe() {
        for tierId in ["focus", "ct_abc12345", BoardModel.activeTierId] {
            let slug = TaskBoardList.slug(tierId)
            XCTAssertFalse(slug.contains("|"))
            XCTAssertTrue(slug.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" }, slug)
        }
    }

    func testBandAnchorIdsAreDistinctPerTier() {
        let ids = ["focus", "satellite", "ct_abc12345"].map(TaskBoardList.anchorId)
        XCTAssertEqual(Set(ids).count, 3)
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
        XCTAssertEqual(bands.first(where: { $0.tierId == "focus" })?.rows.last?.id, created.id)
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
