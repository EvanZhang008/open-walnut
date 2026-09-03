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

    /// Share of the task list that is PINNED, i.e. that becomes a board row.
    ///
    /// 1-in-12, and it is chosen to match the shape of the real store rather than to be
    /// a round number: 3,064 tasks with 264 pinned is 1-in-11.6. It used to be
    /// `i % 9 == 0`, which was a fine ratio for a board that rendered the whole store
    /// (the tail band made the ratio irrelevant) and is the load-bearing number now that
    /// the board renders only the pins — a fixture with too many pins would understate
    /// how much of a pass is the WALK over unpinned rows, which is the cost that has to
    /// stay linear.
    static let pinnedEvery = 12

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
                starred: nil, pinned: i % Self.pinnedEvery == 0, tags: nil, summary: nil
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
        // ONE assemble() call: the view binds the result and hands the SAME value to the
        // band bar's rail, the rows and the sections builder. It is one call and not two
        // (rail + bands) precisely so a future "just build the rail separately" shows up as
        // a second population walk in this measurement rather than only as a rail whose
        // counts describe a board that is no longer on screen.
        let assembly = BoardModel.assemble(
            tasks: store.tasks, sessions: store.sessions,
            tierOf: store.taskTiers, tierOrder: store.taskTierOrder,
            customTiers: store.customTiers, query: query
        )
        sink += assembly.bands.count
        sink += assembly.rail.count
        let visible = assembly.bands
        sink += visible.count
        for f in TaskFilter.allCases { sink += store.count(for: f) }
        // A live query also appends the matching open tasks below the bands
        // (dogfood R17), minus the ids the VISIBLE bands already show.
        if !query.isEmpty {
            sink += TasksView.sections(
                from: store.tasks(for: .allOpen), query: query,
                excluding: BoardModel.rowIds(visible)
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
        // The board's project grouping sorts its bands by `lastActiveValue`, which is a
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
    ///
    /// # Budget history, which is the point of writing it down
    ///
    /// It was 5/8ms while the tail band was SESSION-GATED (a board pass built ~10 tail
    /// rows out of 2,000 tasks). The disappearing-task fix made that band the COMPLEMENT
    /// of the tier bands, so the same pass built ~1,780 rows and the gate was
    /// re-baselined to 12/18ms — with the reasoning that this was "not a regression, it
    /// is the feature".
    ///
    /// That reasoning was wrong, and the user's question is what showed it: "已经有 pin
    /// 了,为什么还会有 all task". The board IS the pinned working set, so the complement
    /// band was never a feature to pay for — it was the whole task store rendered as a
    /// tail, and 12ms was the price of an idle body pass that a scroll publishes. The
    /// band is gone; the gates stay at 12/18ms rather than being tightened back to 5/8,
    /// for one honest reason: this machine is contended enough that a tight absolute
    /// number turns red for load, and a gate people learn to raise is not a gate.
    ///
    /// So the SHAPE assertions below are the real gates — `…ScalesLinearlyWithTheTaskList`
    /// (the axis that actually grew) and `…WithTheSessionList` — and the number printed
    /// here is what a regression report quotes.
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
        XCTAssertLessThan(idle, 12.0,
            "an idle board body pass exceeded 12ms at 2,000 tasks + 500 sessions")
        XCTAssertLessThan(worstMs, 18.0,
            "a board search keystroke exceeded 18ms (n=\(query.count) keystrokes)")
    }

    /// The gate that actually holds the line: doubling the SESSION list must
    /// roughly double one board pass, not square it.
    ///
    /// Written after a real quadratic shipped into `unfiledRows` and no gate here
    /// named it. The session loop had grown a `tasks.contains(where:)` membership
    /// test; at this fixture's scale it took one board pass from ~1ms to ~33ms.
    /// Every absolute budget in this file failed at once, which sounds like
    /// detection but is the opposite: three red numbers with no shape information
    /// read exactly like "the machine is busy", and the machine WAS busy (load
    /// 85). The temptation was to raise the numbers and move on. A ratio cannot be
    /// argued with that way, and it needs no calibration against whatever else the
    /// Mac is doing, because load scales both halves of it.
    ///
    /// SESSIONS is the axis, and picking it took an experiment rather than a
    /// guess. The scan is nominally O(sessions x tasks), so scaling TASKS looks
    /// like the obvious probe, and it does not work: it was tried first, with the
    /// bug deliberately reintroduced, and measured 1.26x for a 2x task list, well
    /// inside any sane tolerance. The reason is the fixture: `contains(where:)`
    /// stops at the first match, every session's `t-<i>` sits at index `i`, and
    /// those indices are bounded by the SESSION count, not the task count. So
    /// doubling tasks adds rows nobody scans past, while doubling sessions doubles
    /// both the number of scans and the depth of each one.
    ///
    /// Threshold comes from measuring BOTH states, not from taste. Bug present:
    /// 2.00x (7.95 → 15.87ms). Bug fixed: 1.05x / 1.09x / 1.13x over three runs
    /// (session count barely moves a pass whose work is the 2,000-task walk).
    /// 1.5x sits in the gap with room on both sides. Note the first threshold
    /// tried here was 2.6x, chosen by "loose enough for n log n plus noise", and
    /// it would have watched this exact bug sail through at 2.00x. A tolerance has
    /// to be justified by the separation it achieves, not by how defensible it
    /// sounds.
    ///
    /// Two things this encodes beyond the one bug. A scaling gate is only as good
    /// as the axis it varies AND the threshold it picks, and both have to be
    /// confirmed against a real reintroduction of the defect rather than derived
    /// from the big-O on paper. And a perf gate that a busy machine can turn red
    /// teaches people to raise it; one built from a ratio of two measurements
    /// taken microseconds apart cannot be dismissed that way.
    func testTheBoardPassScalesLinearlyWithTheSessionList() {
        let small = seededStore(tasks: 2_000, sessions: 250)
        let large = seededStore(tasks: 2_000, sessions: 500)
        // Warm both: the date cache is shared and process-wide, so an unwarmed
        // second store would charge the formatter to the size difference.
        _ = boardDerivedPass(small, query: "")
        _ = boardDerivedPass(large, query: "")

        // Best-of, not worst-of. A scheduler hiccup can only inflate a sample, so
        // the minimum is the closest thing to the code's own cost, and taking it
        // on both sides keeps the ratio honest under contention.
        var bestSmall = Double.greatestFiniteMagnitude
        var bestLarge = Double.greatestFiniteMagnitude
        for _ in 0..<5 {
            bestSmall = min(bestSmall, ms { _ = boardDerivedPass(small, query: "") })
            bestLarge = min(bestLarge, ms { _ = boardDerivedPass(large, query: "") })
        }
        let ratio = bestLarge / bestSmall
        print(String(format: "[board-scaling] 250 sessions %.2fms | 500 sessions %.2fms | ratio %.2fx (gate 1.5x)",
                     bestSmall, bestLarge, ratio))
        XCTAssertLessThan(ratio, 1.5,
            "doubling the session list cost \(ratio)x (expected ~1.1x, and the known quadratic reads 2.0x): a per-session scan over the TASK list is back in the board pass")
    }

    /// The axis that ACTUALLY grew, and the gate the diagnosis found missing: doubling
    /// the TASK LIST must roughly double one board pass, not square it.
    ///
    /// # Why this test did not exist, and why its absence mattered
    ///
    /// The only scaling gate here was the session one, chosen because it was the axis
    /// that reproduced ONE quadratic (see above). Meanwhile the board's real cost was
    /// growing on the other axis: the trailing "Everything else" band was defined as the
    /// complement of every tier, so a body pass built a `BoardRow` per UNPINNED task,
    /// parsed an ISO date per row for the sort key, and decorate-sorted ~1,780 of them at
    /// this fixture (~2,800 on the real store). That is linear, so no ratio gate would
    /// have failed — but nothing here printed the number either, and `idle 7.55ms` sat in
    /// the log of a passing suite while the user felt 460ms of dropped frames.
    ///
    /// So this gate is not only about super-linearity. It also pins the SHARE: with the
    /// board as the pinned working set, a pass's cost is the walk over the store plus the
    /// rows it actually builds, and `pinnedEvery` is what keeps the fixture's pinned share
    /// (1-in-12) close to production's (264 of 3,064). A change that starts building rows
    /// for unpinned tasks again shows up as a ratio that stays ~2x but a BASE that jumps,
    /// which is why both numbers are printed.
    ///
    /// Threshold: linear is 2.0x (both the walk and the pinned set double). A per-task
    /// scan over the pinned set, or a sort of the whole store, reads 4x. 2.8x sits in the
    /// gap with room on both sides, and being a ratio of two measurements taken
    /// microseconds apart it cannot be dismissed as machine load — the rule the session
    /// gate above established.
    func testTheBoardPassScalesLinearlyWithTheTaskList() {
        let small = seededStore(tasks: 2_000, sessions: 500)
        let large = seededStore(tasks: 4_000, sessions: 500)
        // Warm both: the date cache is process-wide, so an unwarmed second store would
        // charge the formatter to the size difference.
        _ = boardDerivedPass(small, query: "")
        _ = boardDerivedPass(large, query: "")

        // Best-of on both sides, for the reason the session gate states: a hiccup can
        // only inflate a sample, so the minimum is the closest thing to the code's cost.
        var bestSmall = Double.greatestFiniteMagnitude
        var bestLarge = Double.greatestFiniteMagnitude
        for _ in 0..<5 {
            bestSmall = min(bestSmall, ms { _ = boardDerivedPass(small, query: "") })
            bestLarge = min(bestLarge, ms { _ = boardDerivedPass(large, query: "") })
        }
        let ratio = bestLarge / bestSmall
        print(String(format: "[board-scaling] 2,000 tasks %.2fms | 4,000 tasks %.2fms | ratio %.2fx (gate 2.8x)",
                     bestSmall, bestLarge, ratio))
        XCTAssertLessThan(ratio, 2.8,
            "doubling the task list cost \(ratio)x (linear is ~2.0x, a per-row scan or a full-store sort reads ~4x): the board is doing work per UNPINNED task again")
        // And the pinned set is what a band holds — stated here so the fixture cannot
        // drift into "almost everything is pinned", which would make the ratio above
        // meaningless (it would be measuring a full-store board either way).
        let pinned = small.tasks.filter { $0.pinned == true }.count
        XCTAssertLessThan(
            Double(pinned) / Double(small.tasks.count), 0.15,
            "the fixture pins \(pinned) of \(small.tasks.count) — production is 264 of 3,064, and a pin-heavy fixture hides the cost of the walk over the rest"
        )
    }

    // MARK: - Gate 2b: the board's search cost must not grow with rows a query discards

    /// A band's rows are sorted after they are collected. Filtering AFTER the sort means
    /// sorting rows the query is about to throw away, and it measured 3.79ms per pass at
    /// fixture scale versus 0.98ms filtering during collection (the same "bound the
    /// candidate set" rule the path resolver encodes).
    ///
    /// This gate is shaped to catch that specific regression rather than to
    /// restate the overall budget: a live query must not cost MUCH more than the
    /// same pass with no query. If someone reorders the phases, this fails long
    /// before the total budget does.
    ///
    /// The ratio assertion is the load-independent half and is unchanged. The absolute
    /// ceiling is 12ms for the reason spelled out on `testBoardSearchKeystrokeBudget` (a
    /// contended machine cannot hold a tight absolute number), and with the tail band gone
    /// the pass it bounds is the walk over the store plus the PINNED rows. The ratio is
    /// below 1 in practice — a live query is CHEAPER than none, because filtering during
    /// collection means fewer rows to sort — which is the direction this test wants and
    /// the clearest sign the phases are still in the right order.
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
        XCTAssertLessThan(worstQuery, 12.0,
            "one board pass with a live query exceeded 12ms at 2,000 tasks + 500 sessions")
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
