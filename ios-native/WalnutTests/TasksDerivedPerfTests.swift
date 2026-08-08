import XCTest
@testable import Walnut

/// Perf gates for the Tasks tab's derived-collection cluster (main-thread
/// audit MAIN-5 / OBS-3 / TMR-9 / GEO-6, 2026-08-07): every TasksView body
/// evaluation recomputes `sections` / `scopedSessions` / `pinnedTierGroups` /
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
        return store
    }

    /// One full TasksView body-equivalent derived pass, via the SAME static
    /// helpers the view calls (kept pure precisely so this test can drive them).
    private func fullDerivedPass(_ store: TasksStore, query: String) -> Int {
        var sink = 0
        // sections is referenced twice per body pass (isEmpty check + ForEach).
        sink += TasksView.sections(from: store.tasks(for: .allOpen), query: query).count
        sink += TasksView.sections(from: store.tasks(for: .allOpen), query: query).count
        // Smart-list cards: 5x count(for:).
        for f in TaskFilter.allCases { sink += store.count(for: f) }
        // Sessions tab derived slices.
        let pinned = TasksView.pinnedScopeSessions(tasks: store.tasks, sessions: store.sessions)
        sink += pinned.count
        sink += TasksView.pinnedTierGroups(pinned: pinned, query: query).count
        sink += store.activeSessions.count
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

        WalnutTask.isoFormatterParses.withLock { $0 = 0 }
        _ = fullDerivedPass(store, query: "")
        _ = fullDerivedPass(store, query: "task 17")
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
