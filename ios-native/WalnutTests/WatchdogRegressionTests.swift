import XCTest
import SwiftUI
@testable import Walnut

/// Reproduction tests for the build-34 field crashes (0x8BADF00D watchdog
/// kills that SURVIVED the LiveMarkdownWindow fix). Field evidence 2026-08-07:
/// attaching a session whose live stream JSONL was 206MB froze the main
/// thread ~6s within 11-40s of "stream attached", thread 0 in SwiftUICore/
/// AttributeGraph. The transcript was tiny (36 msgs / 25KB); the giant part
/// was the IN-FLIGHT live region — the window fix bounded per-tick RENDER
/// cost but not the attach/decode/append paths.
///
/// These tests drive the REAL SessionConversationStore through scripted SSE
/// events and measure single continuous main-thread occupancy. Budget: any
/// one synchronous main-thread step must stay under 1s — this simulator is
/// an M-series Mac, roughly 3-5x faster than the A-series phones that
/// crashed, so 1s here ≈ 3-5s on device ≈ the 5s watchdog line.
///
/// STATUS: FIXED (2026-08-07) — these are now PERMANENT HARD GATES. The
/// original reproduction ran red (attach 200MB = 1413ms; delta tick
/// 32/64/200MB = 168/306/881ms vs the 120ms flush cadence) under strict
/// `XCTExpectFailure` wrappers; the fix landed (store-side liveText retention
/// cap via LiveMarkdownWindow.boundedTail + off-main snapshot decode for
/// large payloads) and the wrappers were removed. Do NOT loosen the budgets;
/// a red run here means the 0x8BADF00D bug class is back.
@MainActor
final class WatchdogRegressionTests: XCTestCase {

    private let mainThreadBudgetMs = 1_000.0

    private func measureMainThreadMs(_ block: () -> Void) -> Double {
        let t0 = DispatchTime.now()
        block()
        return Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
    }

    /// One live-row render pass, as LiveMarkdownBody's body performs it —
    /// same cache routing as production: stable head through the shared
    /// cache, unique tail skips it, neither clips (the window bounds them).
    private func evaluateLiveRow(_ text: String, tick: Int) -> Double {
        measureMainThreadMs {
            let seg = LiveMarkdownWindow.segments(text)
            if !seg.head.isEmpty { _ = MarkdownParser.parse(seg.head, cache: .shared, clipOversized: false) }
            if !seg.tail.isEmpty { _ = MarkdownParser.parse(seg.tail + "\u{0}wr\(tick)", cache: .skip, clipOversized: false) }
        }
    }

    // MARK: - Suspect 1+4: snapshot attach (JSON decode + joined() on MainActor)

    /// Attaching to a session with a huge in-flight live region delivers ONE
    /// snapshot SSE event. Pre-fix, JSON decode + block join + liveText
    /// publish all ran synchronously on the MainActor; now large payloads
    /// decode off-main and the seeded liveText is capped, so only handle()'s
    /// dispatch + applySeed + the first (bounded) live render touch the main
    /// thread. The await between measurements lets the off-main decode finish
    /// so the "first render" measures the REAL seeded text, not an empty one.
    /// Ladder: 8/32/64MB to find where the 5s watchdog line falls on device.
    func testAttachSnapshotMainThreadCost() async {
        var over: [String] = []
        // 200MB ≈ the field session (206MB live stream JSONL behind the attach).
        for mb in [8, 32, 64, 200] {
            let store = SessionConversationStore(session: ScriptedSSE.session())
            let event = ScriptedSSE.snapshotEvent(megabytes: mb) // setup, untimed
            let decodeAndSeedMs = measureMainThreadMs { store.handle(event) }
            await store.snapshotDecodeTask?.value // off-main decode is not main-thread cost
            XCTAssertFalse(store.liveText.isEmpty, "seed must land after the decode settles (\(mb)MB)")
            // The attach is immediately followed by the first live-row render
            // of the seeded liveText — same main-thread queue.
            let firstRenderMs = evaluateLiveRow(store.liveText, tick: mb)
            let totalMs = decodeAndSeedMs + firstRenderMs
            print(String(format: "[watchdog] attach %2dMB snapshot: decode+seed %7.1fms + first live render %7.1fms = %7.1fms (budget %.0f; ~3-5x slower on A-series)",
                         mb, decodeAndSeedMs, firstRenderMs, totalMs, mainThreadBudgetMs))
            if totalMs >= mainThreadBudgetMs { over.append("\(mb)MB=\(Int(totalMs))ms") }
        }
        // HARD GATE (was XCTExpectFailure until the 2026-08-07 fix): large
        // snapshots decode off-main + the seeded liveText is capped, so the
        // synchronous main-thread cost is bounded regardless of payload size.
        XCTAssertTrue(over.isEmpty,
            "snapshot attach blocks the main thread past the watchdog-scaled budget: \(over.joined(separator: ", "))")
    }

    // MARK: - Suspect 3+5: delta flush on a giant accumulated liveText

    /// Steady-state streaming with tens of MB already accumulated: every 120ms
    /// flush appends to liveText (copy-on-write on a giant string) and every
    /// render tick re-runs LiveMarkdownWindow.segments on the WHOLE string
    /// (NSString bridge + length are O(n) on a fresh string instance each
    /// tick, even though the window itself is bounded).
    func testDeltaFlushTickOnGiantLiveText() {
        var overBudget: [String] = []
        var saturated: [String] = []
        // 200MB ≈ the field session (206MB live stream JSONL behind the attach).
        for mb in [8, 32, 64, 200] {
            let store = SessionConversationStore(session: ScriptedSSE.session())
            store.streaming = true
            store.liveText = ScriptedSSE.liveText(megabytes: mb) // setup, untimed
            var worstTickMs = 0.0
            for tick in 0..<5 {
                let event = ScriptedSSE.deltaEvent(bytes: 2_000)
                let tickMs = measureMainThreadMs {
                    store.handle(event)       // appendDelta (buffer)
                    store.flushPendingDelta() // liveText += delta (the 120ms flush)
                } + evaluateLiveRow(store.liveText, tick: mb * 100 + tick)
                worstTickMs = max(worstTickMs, tickMs)
            }
            print(String(format: "[watchdog] delta tick @ %3dMB liveText: worst %7.1fms (single-stall budget %.0f; flush cadence 120)",
                         mb, worstTickMs, mainThreadBudgetMs))
            if worstTickMs >= mainThreadBudgetMs { overBudget.append("\(mb)MB=\(Int(worstTickMs))ms") }
            if worstTickMs >= 120 { saturated.append("\(mb)MB=\(Int(worstTickMs))ms") }
        }
        XCTAssertTrue(overBudget.isEmpty,
            "one tick on a giant liveText breaches the watchdog-scaled budget: \(overBudget.joined(separator: ", "))")
        // SATURATION gate — the actual field kill mechanism: when one tick
        // costs more than the 120ms flush cadence, the main thread can never
        // drain; occupancy accumulates into the continuous multi-second stall
        // the watchdog measures (field crashes hit 11-40s after attach, i.e.
        // after the backlog built up — not on the first tick).
        // HARD GATE (was XCTExpectFailure until the 2026-08-07 fix): the
        // store now retains only a capped liveText tail, so append +
        // segments() is O(cap) per tick regardless of reply size.
        XCTAssertTrue(saturated.isEmpty,
            "tick cost exceeds the 120ms flush cadence — main-thread saturation, the 0x8BADF00D accumulation mechanism: \(saturated.joined(separator: ", "))")
    }

    // MARK: - Composite: attach + immediate scroll (field scenario)

    /// The user attaches the giant session and starts scrolling right away:
    /// seedFromSnapshot, the first live render, AND the first burst of
    /// history-row materializations all queue on the same main thread. The
    /// watchdog sees one continuous stall.
    func testAttachThenImmediateScrollComposite() async {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        let event = ScriptedSSE.snapshotEvent(megabytes: 32)
        let rows = TranscriptFixtures.transcript(count: 40, profile: .heavyMarkdown)
            .filter { $0.kind == nil }
            .prefix(10)
        var totalMs = measureMainThreadMs { store.handle(event) }
        // Large snapshots decode off-main now; await so the live render below
        // measures the REAL seeded text (off-main time is not main-thread cost).
        await store.snapshotDecodeTask?.value
        totalMs += evaluateLiveRow(store.liveText, tick: 999_001)
        // One frame's worth of scroll materialization right behind the attach.
        totalMs += measureMainThreadMs {
            for (i, m) in rows.enumerated() {
                if ChatMarkdownBody.isBlockMarkdown(m.text) || ChatMarkdownBody.containsImageRef(m.text) {
                    _ = MarkdownParser.parse(m.text + "\u{0}attach-scroll\(i)")
                }
            }
        }
        print(String(format: "[watchdog] attach 32MB + first scroll burst: %7.1fms total main-thread (budget %.0f)",
                     totalMs, mainThreadBudgetMs))
        XCTAssertLessThan(totalMs, mainThreadBudgetMs,
            "attach+scroll composite stalls the main thread past the watchdog-scaled budget")
    }

    // MARK: - Suspect 3b: streaming while scrolled UP (bottomPinned = false)

    /// "Sometimes even scrolling freezes" in giant sessions: while streaming,
    /// the user scrolls up — every flush still mutates liveText (Observation
    /// invalidates the mounted live row even off-viewport) while scroll
    /// materialization competes for the same thread. Measures a flush tick +
    /// live-row re-eval + a 5-row materialization burst in one frame.
    func testDeltaFlushWhileScrolledUpComposite() {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        store.streaming = true
        store.bottomPinned = false
        store.liveText = ScriptedSSE.liveText(megabytes: 32)
        let rows = TranscriptFixtures.transcript(count: 20, profile: .heavyMarkdown)
            .filter { $0.kind == nil }
            .prefix(5)
        var worstFrameMs = 0.0
        for tick in 0..<5 {
            var frameMs = measureMainThreadMs {
                store.handle(ScriptedSSE.deltaEvent(bytes: 2_000))
                store.flushPendingDelta()
            }
            frameMs += evaluateLiveRow(store.liveText, tick: 888_000 + tick)
            frameMs += measureMainThreadMs {
                for (i, m) in rows.enumerated() {
                    _ = MarkdownParser.parse(m.text + "\u{0}scrollup\(tick)-\(i)")
                }
            }
            worstFrameMs = max(worstFrameMs, frameMs)
        }
        print(String(format: "[watchdog] flush+scroll-up frame @ 32MB liveText: worst %7.1fms (budget %.0f)",
                     worstFrameMs, mainThreadBudgetMs))
        XCTAssertLessThan(worstFrameMs, mainThreadBudgetMs,
            "streaming flush + scroll materialization frame breaches the budget")
    }
}
