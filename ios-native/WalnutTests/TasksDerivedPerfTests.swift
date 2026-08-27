import XCTest
@testable import Walnut

/// Perf gates for the Tasks tab's derived-collection cluster (main-thread
/// audit MAIN-5 / OBS-3 / TMR-9 / GEO-6, 2026-08-07): every TasksView body
/// evaluation recomputes `sections` / the board's `bands` /
/// 5x `count(for:)` from scratch, and the sort comparators used to parse
/// ISO-8601 strings through a FORMATTER on EVERY comparison (~26-59us each,
/// O(n log n) per sort). At the audited field scale (766 tasks / 351
/// sessions) one `sections` evaluation measured ~370ms, i.e. ~0.7s of main
/// thread per search keystroke — freeze territory, growing with data.
///
/// The fix is two-layer:
///  1. `WalnutTask.parseISO` memoizes parsed dates (keyed by the ISO string,
///     bounded cache) so a warm derived pass runs ZERO formatter parses.
///  2. Sorts are decorate-sort-undecorate (`openSorted` / `doneSorted` /
///     `recencySorted`): keys are computed O(n), compared O(n log n) cheap.
///
/// Budget convention: same as WatchdogRegressionTests — this M-series sim is
/// ~3-5x an A-series phone. Numbers printed with n so a regression report is
/// checkable.
@MainActor
final class TasksDerivedPerfTests: XCTestCase {

    private func ms(_ block: () -> Void) -> Double {
        let t0 = DispatchTime.now()
        block()
        return Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
    }

    // MARK: - Fixtures (field shape: 766 tasks / 351 sessions, gated at 2000/500)

    /// Varied ISO timestamps: distinct strings so the date cache is exercised
    /// honestly (one entry per row-field, not one shared constant).
    private static func iso(_ i: Int) -> String {
        String(format: "2026-%02d-%02dT%02d:%02d:%02dZ", (i % 12) + 1, (i % 28) + 1, i % 24, i % 60, (i * 7) % 60)
    }

    private func makeTasks(_ n: Int) -> [WalnutTask] {
        (0..<n).map { i in
            WalnutTask(
                id: "t-\(i)", title: "Task number \(i) with a realistic title 标题",
                status: ["todo", "in_progress", "done"][i % 3],
                phase: "TODO",
                priority: ["immediate", "important", "backlog", "none"][i % 4],
                project: ["", "marina", "acme", "walnut", "infra"][i % 5],
                dueDate: i % 4 == 0 ? Self.iso(i) : nil,
                createdAt: Self.iso(i), updatedAt: Self.iso(i + 1),
                completedAt: i % 3 == 2 ? Self.iso(i + 2) : nil,
                starred: nil, pinned: i % 9 == 0, tags: nil, summary: nil
            )
        }
    }

    private func makeSessions(_ n: Int) -> [WalnutSession] {
        (0..<n).map { i in
            WalnutSession(
                id: "s-\(i)", title: "Session: walnut — message \(i)",
                taskId: i % 2 == 0 ? "t-\(i)" : nil, taskTitle: "Task number \(i)",
                project: nil, host: i % 3 == 0 ? "" : "clouddev",
                processStatus: ["running", "idle", "stopped"][i % 3],
                model: nil, mode: nil,
                startedAt: Self.iso(i), lastActiveAt: Self.iso(i + 3),
                messageCount: i, cwd: "/tmp/work-\(i % 7)",
                pinned: i % 4 == 0, focusTier: ["focus", "backlog", "wait", "satellite"][i % 4],
                description: nil
            )
        }
    }

    private func seededStore(tasks: Int, sessions: Int) -> TasksStore {
        let store = TasksStore()
        store.tasks = makeTasks(tasks)
        store.sessions = makeSessions(sessions)
        // The board reads the tier map + order, so a store without them renders
        // no bands and the gate would measure nothing. Mirror what the split
        // gives: every pinned task in a tier, each band in pin order.
        var tierOf: [String: String] = [:]
        var order: [String: [String]] = [:]
        let tiers = ["focus", "satellite", "backlog", "wait"]
        for (i, task) in store.tasks.enumerated() where task.pinned == true {
            let tier = tiers[i % tiers.count]
            tierOf[task.id] = tier
            order[tier, default: []].append(task.id)
        }
        store.taskTiers = tierOf
        store.taskTierOrder = order
        return store
    }

    /// One full TasksView body-equivalent derived pass on a TASK LIST filter, via
    /// the SAME static helpers the view calls (kept pure precisely so this test
    /// can drive them).
    private func fullDerivedPass(_ store: TasksStore, query: String) -> Int {
        var sink = 0
        // sections is bound ONCE now, but it used to be read at every reference
        // and this is the shape that would regress — keep measuring two.
        sink += TasksView.sections(from: store.tasks(for: .allOpen), query: query).count
        sink += TasksView.sections(from: store.tasks(for: .allOpen), query: query).count
        // Smart-list cards: one count(for:) per filter.
        for f in TaskFilter.allCases { sink += store.count(for: f) }
        sink += store.activeSessions.count
        return sink
    }

    /// One body-equivalent pass on THE BOARD, which is the default filter and so
    /// the one that runs most.
    ///
    /// Deliberately NOT `fullDerivedPass` + bands. The board renders tier bands,
    /// not project sections, so it does not compute `sections` at all unless a
    /// query is typed — measured, that skip is 5.17ms of an 8ms budget. Folding
    /// both into one number would hide which surface a regression is in.
    private func boardDerivedPass(_ store: TasksStore, query: String) -> Int {
        var sink = 0
        // ONE bands() call: the view binds the result and hands the same array to
        // the rail overlay and the sections builder.
        let bands = BoardModel.bands(
            tasks: store.tasks, sessions: store.sessions,
            tierOf: store.taskTiers, tierOrder: store.taskTierOrder,
            customTiers: store.customTiers, query: query
        )
        sink += bands.count
        for f in TaskFilter.allCases { sink += store.count(for: f) }
        // A live query also appends the matching open tasks below the bands
        // (dogfood R17), minus the ids the bands already show.
        if !query.isEmpty {
            sink += TasksView.sections(
                from: store.tasks(for: .allOpen), query: query,
                excluding: BoardModel.rowIds(bands)
            ).count
        }
        return sink
    }

    // MARK: - Gate 1: warm derived pass runs ZERO formatter parses

    /// The killer was parseISO-in-comparator: formatter parses at O(n log n)
    /// per sort per body eval. With the memoized date cache, a WARM pass (the
    /// steady state — the same rows re-derived every keystroke) must not
    /// invoke the formatter at all.
    func testWarmDerivedPassDoesZeroFormatterParses() {
        let store = seededStore(tasks: 2_000, sessions: 500)
        _ = fullDerivedPass(store, query: "") // warm the cache
        _ = boardDerivedPass(store, query: "")

        WalnutTask.isoFormatterParses.withLock { $0 = 0 }
        _ = fullDerivedPass(store, query: "")
        _ = fullDerivedPass(store, query: "task 17")
        // The board sorts its unpinned-live tail by `lastActiveValue`, which is a
        // parseISO call per row — so it belongs in this gate, not outside it.
        _ = boardDerivedPass(store, query: "")
        _ = boardDerivedPass(store, query: "task 17")
        let parses = WalnutTask.isoFormatterParses.withLock { $0 }
        XCTAssertEqual(parses, 0,
            "\(parses) formatter parses in a warm derived pass (n=2 passes, 2,000 tasks + 500 sessions) — the parseISO memo cache regressed; comparators are re-parsing dates per comparison again")
    }

    // MARK: - Gate 2: budget at above-field scale

    /// Full body-equivalent derived pass at 2.6x the audited field scale.
    /// Audit red measurement (pre-fix, this sim): one `sections` eval alone
    /// ~370ms at 766/351. Post-fix the whole pass must fit well inside a
    /// frame even at 2,000/500.
    func testDerivedPassBudgetAtScale() {
        let store = seededStore(tasks: 2_000, sessions: 500)
        _ = fullDerivedPass(store, query: "") // warm (decode-time state, caches)

        var worstMs = 0.0
        let passes = 5
        for pass in 0..<passes {
            let t = ms { _ = fullDerivedPass(store, query: "") }
            worstMs = max(worstMs, t)
            print(String(format: "[tasks-derived] pass %d: full derived pass (2,000 tasks + 500 sessions): %7.2fms", pass, t))
        }
        XCTAssertLessThan(worstMs, 8.0,
            "worst of \(passes) warm derived passes exceeded the 8ms budget — the Tasks tab recompute cluster is back (audit MAIN-5: 370ms/eval at field scale)")
    }

    /// Search keystrokes re-derive everything with a query. 10 keystrokes,
    /// per-keystroke budget — pre-fix this was ~0.7s per keystroke.
    func testSearchKeystrokeBudget() {
        let store = seededStore(tasks: 2_000, sessions: 500)
        _ = fullDerivedPass(store, query: "")

        var worstMs = 0.0
        let query = "task 1234"
        for i in 1...query.count {
            let q = String(query.prefix(i))
            let t = ms { _ = fullDerivedPass(store, query: q) }
            worstMs = max(worstMs, t)
        }
        print(String(format: "[tasks-derived] worst of %d search keystrokes: %7.2fms", query.count, worstMs))
        XCTAssertLessThan(worstMs, 8.0,
            "a search keystroke's derived recompute exceeded 8ms (n=\(query.count) keystrokes) — typing in Tasks search saturates the main thread again")
    }

    /// The BOARD is the default filter, so its keystroke cost is the one most
    /// users pay. It gets its own gate rather than sharing the task-list one
    /// because the two do different work: the board skips `sections` entirely
    /// until a query exists, and then only asks it for the ids the bands don't
    /// already show.
    func testBoardSearchKeystrokeBudget() {
        let store = seededStore(tasks: 2_000, sessions: 500)
        _ = boardDerivedPass(store, query: "")

        let idle = ms { _ = boardDerivedPass(store, query: "") }
        var worstMs = 0.0
        let query = "task 1234"
        for i in 1...query.count {
            let t = ms { _ = boardDerivedPass(store, query: String(query.prefix(i))) }
            worstMs = max(worstMs, t)
        }
        print(String(format: "[tasks-derived] board: idle %5.2fms | worst of %d keystrokes %7.2fms",
                     idle, query.count, worstMs))
        XCTAssertLessThan(idle, 5.0,
            "an idle board body pass exceeded 5ms at 2,000 tasks + 500 sessions")
        XCTAssertLessThan(worstMs, 8.0,
            "a board search keystroke exceeded 8ms (n=\(query.count) keystrokes)")
    }

    // MARK: - Gate 2b: the board's search cost must not grow with rows a query discards

    /// The board's unpinned-live tail sorts by activity. Filtering AFTER that
    /// sort means sorting rows the query is about to throw away, and it measured
    /// 3.79ms per pass at fixture scale versus 0.98ms filtering during collection
    /// (the same "bound the candidate set" rule the path resolver encodes).
    ///
    /// This gate is shaped to catch that specific regression rather than to
    /// restate the overall budget: a live query must not cost MUCH more than the
    /// same pass with no query. If someone reorders the phases, this fails long
    /// before the total budget does.
    func testABoardSearchDoesNotPayToSortRowsItDiscards() {
        let store = seededStore(tasks: 2_000, sessions: 500)
        let board = { (query: String) in
            _ = BoardModel.bands(
                tasks: store.tasks, sessions: store.sessions,
                tierOf: store.taskTiers, tierOrder: store.taskTierOrder,
                customTiers: store.customTiers, query: query
            )
        }
        board("")            // warm the date cache
        board("task 1234")

        var worstEmpty = 0.0, worstQuery = 0.0
        for _ in 0..<5 {
            worstEmpty = max(worstEmpty, ms { board("") })
            worstQuery = max(worstQuery, ms { board("task 1234") })
        }
        print(String(format: "[board-search] no query %.2fms | live query %.2fms", worstEmpty, worstQuery))
        XCTAssertLessThan(
            worstQuery, worstEmpty * 1.6 + 0.5,
            "a live query costs \(worstQuery)ms vs \(worstEmpty)ms unfiltered — the filter moved back AFTER the sort"
        )
        XCTAssertLessThan(worstQuery, 4.0,
            "one board pass with a live query exceeded 4ms at 2,000 tasks + 500 sessions")
    }

    // MARK: - Gate 3: sort semantics preserved by the decorated sorts

    /// The decorate-sort-undecorate rewrite must be ORDER-IDENTICAL to the
    /// original comparators (pinned > priority > recency for open; completed
    /// recency for done; lastActive for sessions).
    func testDecoratedSortsMatchComparatorSemantics() {
        let tasks = makeTasks(500)
        let open = tasks.filter { !$0.isDone }
        XCTAssertEqual(
            WalnutTask.openSorted(open).map(\.id),
            open.sorted(by: WalnutTask.openSort).map(\.id),
            "openSorted must be order-identical to the openSort comparator"
        )
        let done = tasks.filter(\.isDone)
        XCTAssertEqual(
            WalnutTask.doneSorted(done).map(\.id),
            done.sorted(by: WalnutTask.doneSort).map(\.id),
            "doneSorted must be order-identical to the doneSort comparator"
        )
        let sessions = makeSessions(500)
        XCTAssertEqual(
            WalnutSession.recencySorted(sessions).map(\.id),
            sessions.sorted(by: WalnutSession.recencySort).map(\.id),
            "recencySorted must be order-identical to the recencySort comparator"
        )
    }

    /// parseISO must still parse every wire shape (fractional, plain, day-only)
    /// through the cache, and cache hits must return identical values.
    func testParseISOCacheCorrectness() {
        let fractional = "2026-08-08T01:02:03.456Z"
        let plain = "2026-08-08T01:02:03Z"
        let dayOnly = "2026-08-08"
        for iso in [fractional, plain, dayOnly] {
            let first = WalnutTask.parseISO(iso)
            XCTAssertNotNil(first, "parseISO must parse \(iso)")
            XCTAssertEqual(first, WalnutTask.parseISO(iso), "cache hit must equal the parsed value")
        }
        XCTAssertNil(WalnutTask.parseISO(nil))
        XCTAssertNil(WalnutTask.parseISO("not a date"))
        XCTAssertNil(WalnutTask.parseISO("not a date"), "negative results must be cached consistently too")
    }
}
