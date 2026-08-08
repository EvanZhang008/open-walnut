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
    private func applyFully(_ controller: TimelineCollectionController,
                            _ snapshot: TimelineSnapshot) -> Double {
        let before = MainWork.recent(64).count
        controller.apply(snapshot)
        // Drain budgeter frame-split continuations.
        for _ in 0..<100 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
            if controller.rows.count == snapshot.rows.count { break }
        }
        let entries = MainWork.recent(64)
        return entries.dropFirst(before).map(\.ms).max() ?? 0
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
            applied += 1
            if i % 100 == 0 { RunLoop.current.run(until: Date().addingTimeInterval(0.001)) }
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        let batches = MainWork.recent(64).filter { $0.label.hasPrefix("timeline") }
        let worst = batches.map(\.ms).max() ?? 0
        let p50 = batches.map(\.ms).sorted()[max(0, batches.count / 2 - 1)]
        print(String(format: "[timeline-gate] storm: events=%d applies=%d ledgeredBatches=%d p50=%.2fms worst=%.1fms (gate 50)",
                     1_155, applied, batches.count, p50, worst))
        XCTAssertFalse(batches.isEmpty)
        XCTAssertLessThan(worst, 50.0,
            "storm produced a main-thread batch over 50ms (n=\(batches.count) ledgered batches)")
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

        var liveText = ""
        for i in 0..<500 {
            liveText += "第\(i)段。"
            let snapshot = await build(actor, input(history, streaming: true,
                                                    liveText: liveText,
                                                    activity: i % 2 == 0 ? "Thinking" : "Bash"))
            controller.apply(snapshot)
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        let batches = MainWork.recent(64).filter { $0.label.hasPrefix("timeline") }
        let worst = batches.map(\.ms).max() ?? 0
        // Diff-batch change counts must be live-row sized, never page sized.
        let worstCount = batches.filter { $0.label == "timeline.diff" }.map(\.count).max() ?? 0
        print(String(format: "[timeline-gate] microburst: 500 events worstBatch=%.1fms worstDiffCount=%d (historyRows=%d)",
                     worst, worstCount, historyRowCount))
        XCTAssertLessThan(worst, 50.0, "microburst batch over 50ms")
        XCTAssertLessThan(worstCount, 20,
            "a streaming diff touched \(worstCount) rows — history invalidation is back (page=\(historyRowCount))")
    }

    // MARK: - Gate 3: scroll

    /// 400-row round-trip scroll: drive contentOffset top↔bottom in
    /// frame-sized steps; every step's visible-cell materialization must stay
    /// under 16ms (one 60fps frame).
    func testScrollRoundTripFrameBudget() async {
        let controller = hostController()
        let actor = TimelineLayoutActor()
        _ = applyFully(controller, await build(actor, input(heavyRows400())))
        let cv = controller.collectionView!
        cv.layoutIfNeeded()
        let contentHeight = cv.contentSize.height
        XCTAssertGreaterThan(contentHeight, cv.bounds.height * 3, "fixture must be scrollable")

        // 800pt jumps ≈ fast flick; down then back up. Noise discipline: a
        // hosted test shares the sim with the host app's own hydration, so a
        // single pass's worst step can absorb a scheduler hiccup (measured
        // 15.2ms solo vs 16.0ms under full-suite load — same code). A REAL
        // regression (O(n) materialization) slows EVERY pass, so the gate is
        // the BEST pass's worst step over 3 passes: min over passes of
        // (max over steps), still a hard per-frame bound.
        let stride800 = stride(from: 0, to: contentHeight - cv.bounds.height, by: 800)
        let offsets = Array(stride800) + Array(stride800).reversed()
        var bestPassWorstMs = Double.greatestFiniteMagnitude
        var steps = 0
        for pass in 0..<3 {
            var worstStepMs = 0.0
            for y in offsets {
                let stepMs = ms {
                    cv.setContentOffset(CGPoint(x: 0, y: y), animated: false)
                    cv.layoutIfNeeded()
                }
                worstStepMs = max(worstStepMs, stepMs)
                if pass == 0 { steps += 1 }
            }
            bestPassWorstMs = min(bestPassWorstMs, worstStepMs)
        }
        print(String(format: "[timeline-gate] scroll round-trip: steps=%d x3 passes, bestPassWorstStep=%.1fms (gate 16)",
                     steps, bestPassWorstMs))
        XCTAssertLessThan(bestPassWorstMs, 16.0,
            "every pass had a scroll step over one 60fps frame (n=\(steps) steps x 3 passes)")
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
        let total = ms { _ = applyFully(controller, snapshot) }
        let batches = MainWork.recent(64).filter { $0.label.hasPrefix("timeline") }
        let worst = batches.map(\.ms).max() ?? 0
        let accounted = batches.reduce(0) { $0 + $1.count }
        print(String(format: "[timeline-gate] 1000-row reconcile: rows=%d batches=%d worstBatch=%.1fms total=%.1fms accountedRows=%d",
                     snapshot.rows.count, batches.count, worst, total, accounted))
        XCTAssertGreaterThanOrEqual(batches.count, 2,
            "giant apply must frame-split into multiple batches (n=\(batches.count))")
        XCTAssertLessThan(worst, 50.0,
            "a giant-reconcile batch exceeded 50ms (n=\(batches.count) batches)")
        XCTAssertEqual(controller.rows.count, snapshot.rows.count, "all rows must land")
    }
}
