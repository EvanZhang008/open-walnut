import XCTest
import SwiftUI
@testable import Walnut

/// Performance gates for the timeline rendering engine — the numbers the
/// architecture exists to guarantee. All gates run against the REAL engine
/// (actor build + budgeted apply into a hosted UIKit collection view), not a
/// replica. Budget convention matches WatchdogRegressionTests: this M-series
/// sim ≈ 3-5x an A-series phone, so 1s here ≈ the 5s watchdog line; the
/// engine's own gates are far tighter (50ms/batch = design bound).
///
/// Numbers carry n: every printed line states the sample count.
@MainActor
final class TimelinePerfGateTests: XCTestCase {

    private var hostWindow: UIWindow?

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        MainWork.resetForTesting()
        FreezeContext.shared.resetForTesting()
    }

    override func tearDown() {
        if let w = hostWindow {
            w.isHidden = true
            w.rootViewController = nil
            hostWindow = nil
        }
        super.tearDown()
    }

    private func ms(_ block: () -> Void) -> Double {
        let t0 = DispatchTime.now()
        block()
        return Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
    }

    /// CPU actually burned by THIS thread, not wall clock. The difference is the
    /// entire reason the scroll gate below stopped being a coin flip: on a shared
    /// machine, wall clock charges a frame for every millisecond the scheduler
    /// gave to somebody else, and vitest/Xcode/simulators next door then read as
    /// a rendering regression.
    private func cpuMs(_ block: () -> Void) -> Double {
        let t0 = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        block()
        return Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - t0) / 1_000_000
    }

    // MARK: - Fixtures

    private func chatMessages(_ msgs: [TranscriptFixtures.Msg]) -> [ChatMessage] {
        msgs.enumerated().map { i, m in
            ChatMessage(
                id: "fx-\(i)", role: m.role, text: m.text,
                createdAt: String(format: "2026-08-08T06:%02d:%02dZ", (i / 60) % 60, i % 60),
                kind: m.kind == "tool" ? .tool : nil,
                detail: m.kind == "tool" ? "cmd \(i)" : nil,
                resultPreview: m.kind == "tool" ? String(repeating: "line \(i)\n", count: 10) : nil
            )
        }
    }

    /// Field transcript shape (crash-1's 105-ish rows, mostly tool chips,
    /// small text) at 109 rows.
    private func fieldRows109() -> [ChatMessage] {
        chatMessages(TranscriptFixtures.transcript(count: 109, profile: .mixed))
    }

    private func heavyRows400() -> [ChatMessage] {
        chatMessages(TranscriptFixtures.transcript(count: 400, profile: .heavyMarkdown))
    }

    private func input(_ messages: [ChatMessage], streaming: Bool = false,
                       liveText: String = "", activity: String? = nil,
                       width: CGFloat = 393) -> TimelineInput {
        TimelineInput(messages: messages, streaming: streaming, liveText: liveText,
                      liveTextTruncated: false, activity: activity,
                      showLoadEarlier: false, width: width, expandedRowIDs: [])
    }

    /// Host a REAL TimelineCollectionController in a window.
    private func hostController() -> TimelineCollectionController {
        let controller = TimelineCollectionController()
        let window = hostWindow ?? UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        hostWindow = window
        window.rootViewController = controller
        window.isHidden = false
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        return controller
    }

    /// Build a snapshot on the actor (background cost, untimed for main-thread
    /// gates) and return it.
    private func build(_ actor: TimelineLayoutActor, _ input: TimelineInput) async -> TimelineSnapshot {
        await actor.buildSnapshot(input)
    }

    /// Apply a snapshot fully (drains budgeter continuations) and return the
    /// WORST single main-thread batch from the MainWork ledger.
    @discardableResult
    private func applyFully(_ controller: TimelineCollectionController,
                            _ snapshot: TimelineSnapshot) -> Double {
        applyFullyMeasured(controller, snapshot).worstMs
    }

    /// Same apply, plus how many ledger entries the window actually saw.
    ///
    /// Windowed by TIMESTAMP and sampled on EVERY drain turn, which the previous
    /// version was not: it read `MainWork.recent(64)` once and returned
    /// `dropFirst(before)`, correct only while the ledger's 64-entry RING has not
    /// rotated. An apply that emits more than `64 - before` entries pushes the
    /// oldest out, `before` then indexes past the batches it meant to skip, and
    /// the "worst batch" reported is some other apply's — a silently wrong number
    /// in a helper four gates share. Per-turn sampling means an entry can only be
    /// missed if a SINGLE run-loop turn emits 64 of them, and the returned count
    /// is what makes "how close is this fixture to the ring" an observed number
    /// instead of an assumption (`testGiantReconcileFrameSplits` prints it for
    /// the largest fixture in the file).
    private func applyFullyMeasured(_ controller: TimelineCollectionController,
                                    _ snapshot: TimelineSnapshot) -> (worstMs: Double, batches: Int) {
        let sink = LedgerSink()
        controller.apply(snapshot)
        sink.drain()
        // Drain budgeter frame-split continuations.
        for _ in 0..<100 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
            sink.drain()
            if controller.rows.count == snapshot.rows.count { break }
        }
        sink.drain()
        return (sink.worstMs, sink.count)
    }

    // MARK: - Gate 1: first frame

    /// 109-row field shape AND 400-row heavy markdown: open → first visible
    /// frame. Gate: worst single main-thread batch ≤50ms (sim), total
    /// main-thread work ≤500ms.
    func testFirstFrameBudget() async {
        for (name, messages) in [("109-field", fieldRows109()), ("400-heavy", heavyRows400())] {
            MainWork.resetForTesting()
            let controller = hostController()
            let actor = TimelineLayoutActor()
            let snapshot = await build(actor, input(messages))
            XCTAssertGreaterThan(snapshot.rows.count, messages.count / 2, "fixture must produce rows")
            let totalMs = ms {
                _ = applyFully(controller, snapshot)
            }
            let batches = MainWork.recent(64).filter { $0.label.hasPrefix("timeline") }
            let worst = batches.map(\.ms).max() ?? 0
            print(String(format: "[timeline-gate] first-frame %@: rows=%d batches=%d worstBatch=%.1fms total=%.1fms (gates: 50/500)",
                         name, snapshot.rows.count, batches.count, worst, totalMs))
            XCTAssertFalse(batches.isEmpty, "apply must be ledgered")
            XCTAssertLessThan(worst, 50.0,
                "\(name): a single first-frame batch exceeded 50ms (n=\(batches.count) batches)")
            XCTAssertLessThan(totalMs, 500.0,
                "\(name): total first-frame main-thread work exceeded 500ms")
            XCTAssertGreaterThan(controller.collectionView.visibleCells.count, 0,
                "\(name): first frame must actually show cells")
        }
    }

    // MARK: - Gate 2: event storm

    /// Field-rate (21 ev/s over 55s = 1155 events) and microburst (500 ev/s)
    /// storms through the REAL pipeline: store-shaped input mutations →
    /// actor rebuild → apply. Gate: no main-thread batch >50ms across the
    /// whole storm. (The 60s wall run is compressed: same event COUNT
    /// delivered back-to-back — strictly harder than paced delivery.)
    func testEventStormNoBatchOverBudget() async {
        let controller = hostController()
        let actor = TimelineLayoutActor()
        let history = fieldRows109()
        let base = await build(actor, input(history))
        _ = applyFully(controller, base)
        MainWork.resetForTesting()

        // 1155 thinking-rate events + a text delta every 10th (field mix).
        //
        // The ledger is read AS THE STORM RUNS (see LedgerSink). Reading it once
        // at the end only ever saw the last 64 applies of 1155 — the ring's whole
        // capacity, confirmed saturated in a real run — so "no batch over 50ms
        // across the whole storm" was a claim about the final 5% of it.
        let sink = LedgerSink()
        var liveText = ""
        var applied = 0
        for i in 0..<1_155 {
            let activity = i % 7 < 4 ? "Thinking" : "Bash · cmd"
            if i % 10 == 0 { liveText += TranscriptFixtures.cjk + "\n\n" }
            // The store coalesces deltas at 8Hz; activity flips pass through.
            // Rebuild + apply for every event = the WORST case the engine can
            // be asked to absorb.
            let snapshot = await build(actor, input(history, streaming: true,
                                                    liveText: liveText, activity: activity))
            controller.apply(snapshot)
            sink.drain(labelPrefix: "timeline")
            applied += 1
            if i % 100 == 0 { RunLoop.current.run(until: Date().addingTimeInterval(0.001)) }
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        sink.drain(labelPrefix: "timeline")
        let worst = sink.worstMs
        print(String(format: "[timeline-gate] storm: events=%d applies=%d ledgeredBatches=%d p50=%.2fms worst=%.1fms (gate 50)",
                     1_155, applied, sink.count, sink.p50Ms, worst))
        XCTAssertGreaterThan(sink.count, 64,
            "the storm ledgered only \(sink.count) batches — fewer than the ring holds, so this accumulating read is measuring less than the old single read did")
        XCTAssertLessThan(worst, 50.0,
            "storm produced a main-thread batch over 50ms (n=\(sink.count) ledgered batches across all \(applied) applies)")
    }

    /// 500 ev/s microburst shape: 500 activity flips + live growth delivered
    /// with zero pacing, history untouched. The diff must touch only live
    /// rows — worst batch stays under the same 50ms gate.
    func testMicroburstDiffTouchesOnlyLiveRows() async {
        let controller = hostController()
        let actor = TimelineLayoutActor()
        let history = fieldRows109()
        _ = applyFully(controller, await build(actor, input(history)))
        let historyRowCount = controller.rows.count
        MainWork.resetForTesting()

        // Accumulated as the burst runs, for the same reason as the storm above:
        // 500 applies against a 64-entry ring meant the diff-count assertion —
        // the one that actually guards against history invalidation — only ever
        // examined the last ~13% of the burst.
        let sink = LedgerSink()
        var liveText = ""
        for i in 0..<500 {
            liveText += "第\(i)段。"
            let snapshot = await build(actor, input(history, streaming: true,
                                                    liveText: liveText,
                                                    activity: i % 2 == 0 ? "Thinking" : "Bash"))
            controller.apply(snapshot)
            sink.drain(labelPrefix: "timeline")
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        sink.drain(labelPrefix: "timeline")
        let worst = sink.worstMs
        // Diff-batch change counts must be live-row sized, never page sized.
        let worstCount = sink.worstCount(label: "timeline.diff")
        print(String(format: "[timeline-gate] microburst: 500 events ledgeredBatches=%d worstBatch=%.1fms worstDiffCount=%d (historyRows=%d)",
                     sink.count, worst, worstCount, historyRowCount))
        XCTAssertLessThan(worst, 50.0, "microburst batch over 50ms")
        XCTAssertLessThan(worstCount, 20,
            "a streaming diff touched \(worstCount) rows — history invalidation is back (page=\(historyRowCount), n=\(sink.count) ledgered batches across 500 applies)")
    }

    // MARK: - Gate 3: scroll — bounded materialization, not elapsed time

    /// 400-row round-trip scroll: drive contentOffset top↔bottom in frame-sized
    /// steps. The gate is BOUNDED WORK — how many cells a step has to
    /// materialize — not how long the step took.
    ///
    /// Why the time gate was replaced rather than loosened. It wall-clock-timed
    /// `layoutIfNeeded()` on a shared machine, so every millisecond the main
    /// thread spent DESCHEDULED counted as frame cost, and its per-pass statistic
    /// was a max over ~2N steps: the noisiest estimator available. The budget was
    /// then set equal to the measured cost of passing code (the old comment
    /// recorded the straddle at birth — "15.2ms solo vs 16.0ms under full-suite
    /// load, same code"), and unchanged code was observed at 14.9 / 15.2 / 16.0 /
    /// 16.0 / 17.2ms against `< 16.0`. `min` over 3 passes defends against a
    /// transient hiccup, never against sustained load, so the gate was a coin
    /// flip — which trains everyone to ignore it.
    ///
    /// What the gate is actually claiming: materialization is bounded per frame
    /// and NOT O(page). That is a COUNT. An O(n) regression multiplies it by an
    /// order of magnitude; scheduler noise does not move it at all. The
    /// microburst gate above (`worstDiffCount < 20`) already works this way and
    /// has held up, so this follows its shape.
    ///
    /// Counted through a forwarding data-source proxy: `cellForItemAt` IS the
    /// materialization event, so proxying the data source measures it exactly,
    /// with no instrumentation added to the engine and nothing to keep in sync.
    func testScrollRoundTripMaterializesBoundedWork() async {
        let controller = hostController()
        let actor = TimelineLayoutActor()
        applyFully(controller, await build(actor, input(heavyRows400())))
        let cv = controller.collectionView!
        cv.layoutIfNeeded()
        let contentHeight = cv.contentSize.height
        XCTAssertGreaterThan(contentHeight, cv.bounds.height * 3, "fixture must be scrollable")
        let pageRows = controller.rows.count

        // Count every cell the collection view asks for, without touching the
        // engine. `dataSource` is a WEAK reference, so the proxy has to be held
        // here for the whole run; the real data source (the controller) is kept
        // alive by the host window. Installed AFTER the initial apply and removed
        // before anything applies again, so nothing but the scroll is measured.
        guard let realSource = cv.dataSource else {
            return XCTFail("the controller must be its own data source for this gate to count")
        }
        let counter = CountingDataSource(realSource)
        cv.dataSource = counter
        cv.reloadData()
        cv.setContentOffset(.zero, animated: false)
        cv.layoutIfNeeded()

        // THE BUDGET, and where the number comes from.
        //
        // A step advances 800pt of an 852pt viewport, so the most a correct engine
        // can need is the screen it leaves plus the screen it enters: two screens'
        // worth of cells. `rowsPerScreen` below is printed for every run so the
        // headroom is never a guess, but the ASSERTION is against a literal, on
        // purpose — a budget computed from the same fixture it is judging moves
        // when the fixture does, and a bound that follows the thing it measures is
        // how the millisecond gate ended up equal to its own measurement.
        //
        // `maxCellsPerStep` is a constant in CELLS, so it is independent of page
        // size by construction. That is the property being asserted: an O(page)
        // regression on this 400-row fixture costs ~`pageRows` cells per step, an
        // order of magnitude past this, and it gets worse as the page grows, while
        // machine load cannot move a count at all.
        let maxCellsPerStep = 40
        let rowsPerScreen = max(1, cv.indexPathsForVisibleItems.count)
        XCTAssertGreaterThan(pageRows, maxCellsPerStep * 4,
            "the fixture must be many screens deep or an O(page) regression would fit inside the budget (rows=\(pageRows), budget=\(maxCellsPerStep))")

        let stride800 = stride(from: 0, to: contentHeight - cv.bounds.height, by: 800)
        let offsets = Array(stride800) + Array(stride800).reversed()
        var worstStepCells = 0
        var worstLiveCells = 0
        var steps = 0
        var ledgeredRowsDuringScroll = 0
        var ledgerWatermark = FreezeContext.uptimeNow()
        // Kept ONLY as a catastrophe smoke bound (see the assertion). THREAD CPU
        // time, because wall clock is precisely what the old gate got wrong.
        var bestPassWorstCPUms = Double.greatestFiniteMagnitude

        // The RETIRED statistic, kept as a printed diagnostic only: the exact
        // number the old gate compared against 16.0. Printing it is what makes
        // "the old gate was a coin flip" checkable from any run's log instead of
        // something you have to take on trust from an incident write-up.
        var bestPassWorstWallMs = Double.greatestFiniteMagnitude

        for pass in 0..<3 {
            var worstPassCPUms = 0.0
            var worstPassWallMs = 0.0
            for y in offsets {
                counter.reset()
                var stepWall = 0.0
                let stepCPU = cpuMs {
                    stepWall = ms {
                        cv.setContentOffset(CGPoint(x: 0, y: y), animated: false)
                        cv.layoutIfNeeded()
                    }
                }
                worstPassWallMs = max(worstPassWallMs, stepWall)
                worstStepCells = max(worstStepCells, counter.configured)
                worstLiveCells = max(worstLiveCells, cv.visibleCells.count)
                worstPassCPUms = max(worstPassCPUms, stepCPU)
                for entry in MainWork.recent(64)
                where entry.at > ledgerWatermark && entry.label.hasPrefix("timeline") {
                    ledgeredRowsDuringScroll += entry.count
                    ledgerWatermark = entry.at
                }
                if pass == 0 { steps += 1 }
            }
            bestPassWorstCPUms = min(bestPassWorstCPUms, worstPassCPUms)
            bestPassWorstWallMs = min(bestPassWorstWallMs, worstPassWallMs)
        }
        cv.dataSource = realSource

        print(String(format: "[timeline-gate] scroll round-trip: steps=%d x3 passes, pageRows=%d rowsPerScreen=%d | worstStepCells=%d liveCells=%d ledgeredRows=%d (budget %d cells/step) | bestPassWorstStepCPU=%.1fms (smoke 50) | RETIRED wall statistic=%.1fms (old gate: <16.0 — %@)",
                     steps, pageRows, rowsPerScreen, worstStepCells, worstLiveCells,
                     ledgeredRowsDuringScroll, maxCellsPerStep, bestPassWorstCPUms,
                     bestPassWorstWallMs,
                     bestPassWorstWallMs < 16.0 ? "would have passed" : "WOULD HAVE FAILED"))
        XCTAssertGreaterThan(worstStepCells, 0,
            "no cell was configured by any scroll step — the proxy is not being asked, so this gate is measuring nothing")

        // THE GATE. Per step, so it is a per-frame bound; a count, so load cannot
        // move it; a constant, so an O(page) materialization cannot hide in it.
        XCTAssertLessThanOrEqual(worstStepCells, maxCellsPerStep,
            "a scroll step materialized \(worstStepCells) cells against a budget of \(maxCellsPerStep) (~2 screens; this fixture shows \(rowsPerScreen) rows per screen). On a \(pageRows)-row page that is O(page), not O(frame) — the engine is re-materializing rows it already has (n=\(steps) steps x 3 passes)")
        // …and never more than that many alive at once, which is the same claim
        // seen from the other side: a page-sized cell population is the shape a
        // lost reuse identifier or a lost estimated size produces.
        XCTAssertLessThanOrEqual(worstLiveCells, maxCellsPerStep,
            "\(worstLiveCells) cells were live at once on a \(pageRows)-row page — cells are not being recycled")
        // Scrolling must not re-enter the apply path at all. Expected value: 0.
        XCTAssertLessThanOrEqual(ledgeredRowsDuringScroll, maxCellsPerStep,
            "scrolling ledgered \(ledgeredRowsDuringScroll) rows of timeline.* main-thread work — a scroll is triggering snapshot applies")

        // Catastrophe smoke bound, and labelled as one: it exists to catch "a
        // step now takes a visible fraction of a second", not to police frames.
        // The COUNTS above are the gate.
        //
        // Where 50 comes from: a step on this fixture measured 14.1ms of thread
        // CPU on an idle machine, so ~1.5 frames (25ms) would leave 1.8x, and
        // CPU time is NOT load-immune the way a count is — CLOCK_THREAD_CPUTIME_ID
        // measures on-CPU nanoseconds, so an E-core or a thermally downclocked
        // P-core inflates it roughly 2x for the same work. 50ms ≈ 3 frames at
        // 60fps (a frame is 16.67ms, not the 16.0 the old gate called "one
        // frame") is 3.5x the measurement, which is the whole difference from a
        // budget set equal to what passing code measured. Thread CPU rather than
        // wall clock so a DESCHEDULED main thread cannot inflate it at all, and
        // best-of-3 because the first pass pays cold caches.
        XCTAssertLessThan(bestPassWorstCPUms, 50.0,
            "every pass had a scroll step burning over 50ms of main-thread CPU (~3 frames at 60fps, 3.5x the 14.1ms this fixture measures idle; n=\(steps) steps x 3 passes)")
    }

    // MARK: - Gate 4: background-restore reopen

    /// Scene-active reopen with caches invalidated (the r4b scenario): a COLD
    /// actor (no row cache) + cold parse cache building the same page again.
    /// Same first-frame gates.
    func testColdReopenAfterCacheInvalidation() async {
        let controller = hostController()
        let warmActor = TimelineLayoutActor()
        _ = applyFully(controller, await build(warmActor, input(fieldRows109())))

        // Invalidate everything the way a jetsam-adjacent resume would find it.
        MarkdownParser.resetCacheForTesting()
        MainWork.resetForTesting()
        let coldActor = TimelineLayoutActor()
        let totalMs = ms {}
        _ = totalMs
        let snapshot = await build(coldActor, input(fieldRows109()))
        let total = ms { _ = applyFully(controller, snapshot) }
        let batches = MainWork.recent(64).filter { $0.label.hasPrefix("timeline") }
        let worst = batches.map(\.ms).max() ?? 0
        print(String(format: "[timeline-gate] cold reopen: rows=%d worstBatch=%.1fms total=%.1fms (gates 50/500, n=%d batches)",
                     snapshot.rows.count, worst, total, batches.count))
        XCTAssertLessThan(worst, 50.0, "cold-reopen batch over 50ms")
        XCTAssertLessThan(total, 500.0, "cold-reopen total over 500ms")
    }

    // MARK: - Gate 5: giant diff through the budgeter (1000 rows)

    /// A 1000-message reconcile must frame-split: no single batch over the
    /// 50ms gate, ledger shows every batch with its row count.
    func testGiantReconcileFrameSplits() async {
        let controller = hostController()
        let actor = TimelineLayoutActor()
        _ = applyFully(controller, await build(actor, input(fieldRows109())))
        MainWork.resetForTesting()

        let giant = chatMessages(TranscriptFixtures.transcript(count: 1_000, profile: .mixed))
        let snapshot = await build(actor, input(giant))
        XCTAssertGreaterThan(snapshot.rows.count, 900)
        var windowBatches = 0
        let total = ms { windowBatches = applyFullyMeasured(controller, snapshot).batches }
        let batches = MainWork.recent(64).filter { $0.label.hasPrefix("timeline") }
        let worst = batches.map(\.ms).max() ?? 0
        let accounted = batches.reduce(0) { $0 + $1.count }
        print(String(format: "[timeline-gate] 1000-row reconcile: rows=%d batches=%d worstBatch=%.1fms total=%.1fms accountedRows=%d ledgerWindow=%d/64",
                     snapshot.rows.count, batches.count, worst, total, accounted, windowBatches))
        // The ring question, answered by measurement rather than by assumption:
        // `MainWork` keeps 64 entries, and every gate in this file reads a WINDOW
        // of it. If the largest fixture here can fill the ring, those windows are
        // silently truncated and their worst-batch numbers belong to some other
        // apply. This is the biggest apply in the suite, so its entry count is the
        // headroom for all of them.
        XCTAssertLessThan(windowBatches, 64,
            "the biggest apply in this file emitted \(windowBatches) ledger entries and the ring holds 64 — every windowed read in this file is now truncated, and their worst-batch numbers cannot be trusted")
        XCTAssertGreaterThanOrEqual(batches.count, 2,
            "giant apply must frame-split into multiple batches (n=\(batches.count))")
        XCTAssertLessThan(worst, 50.0,
            "a giant-reconcile batch exceeded 50ms (n=\(batches.count) batches)")
        XCTAssertEqual(controller.rows.count, snapshot.rows.count, "all rows must land")
    }
}

/// Forwarding `UICollectionViewDataSource` that counts `cellForItemAt` calls.
///
/// The scroll gate needs "how many cells did this step have to materialize", and
/// `cellForItemAt` is that event exactly — it is the only way a cell comes into
/// existence or gets handed back out of the reuse pool. Counting it from the TEST
/// side keeps the engine free of a counter that exists only for one assertion (and
/// that a future refactor could stop incrementing while the gate stayed green).
///
/// Forwards only what `TimelineCollectionController` implements: one section, no
/// supplementary views. `numberOfSections` is optional in the protocol and the
/// controller does not define it, so the default of 1 is forwarded honestly.
/// Accumulating reader for the `MainWork` ledger, which is a 64-entry RING.
///
/// Every gate in this file wants "the batches MY code caused", and the obvious
/// way to get that — read `MainWork.recent(64)` at the end — is only correct
/// while fewer than 64 entries have been recorded since the start of the window.
/// Measured on this fixture set: one apply emits at most 14 entries (safe), but
/// the two STORM gates apply 1155 and 500 times, and the ring is verifiably
/// saturated (`ledgeredBatches=64` in a real run). Read once at the end, those
/// gates were inspecting the last 64 applies of a 1155-apply storm — about 5% —
/// while their messages claimed "across the whole storm".
///
/// So the window is accumulated instead: `drain()` is called as the storm runs
/// and keeps a timestamp watermark, which makes an entry unobservable only if a
/// single stretch between two drains emits 64 of them. Cost per drain is one
/// lock plus a 64-element copy, and it happens strictly OUTSIDE the tracked
/// batches, so it cannot inflate the numbers it is collecting.
private final class LedgerSink {
    private var watermark = FreezeContext.uptimeNow()
    private(set) var samples: [Double] = []
    private(set) var worstMs = 0.0
    /// Change counts for one label, e.g. the diff-size series.
    private(set) var counts: [String: [Int]] = [:]

    var count: Int { samples.count }

    /// Take everything recorded since the last call. Labels are not filtered
    /// here: the watermark must advance past EVERY entry, or an untracked label
    /// would be re-read forever and pin the window open.
    func drain(labelPrefix: String = "") {
        for entry in MainWork.recent(64) where entry.at > watermark {
            watermark = entry.at
            guard entry.label.hasPrefix(labelPrefix) else { continue }
            samples.append(entry.ms)
            worstMs = max(worstMs, entry.ms)
            counts[entry.label, default: []].append(entry.count)
        }
    }

    /// Median of the collected batch costs (same statistic the storm gate printed
    /// before, just over the whole storm rather than over its last 64 applies).
    var p50Ms: Double {
        guard !samples.isEmpty else { return 0 }
        return samples.sorted()[max(0, samples.count / 2 - 1)]
    }

    func worstCount(label: String) -> Int { counts[label]?.max() ?? 0 }
}

private final class CountingDataSource: NSObject, UICollectionViewDataSource {
    private let wrapped: UICollectionViewDataSource
    private(set) var configured = 0

    init(_ wrapped: UICollectionViewDataSource) {
        self.wrapped = wrapped
        super.init()
    }

    func reset() { configured = 0 }

    func numberOfSections(in collectionView: UICollectionView) -> Int {
        wrapped.numberOfSections?(in: collectionView) ?? 1
    }

    func collectionView(_ collectionView: UICollectionView,
                        numberOfItemsInSection section: Int) -> Int {
        wrapped.collectionView(collectionView, numberOfItemsInSection: section)
    }

    func collectionView(_ collectionView: UICollectionView,
                        cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        configured += 1
        return wrapped.collectionView(collectionView, cellForItemAt: indexPath)
    }
}
