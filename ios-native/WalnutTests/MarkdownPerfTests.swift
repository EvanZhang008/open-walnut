import XCTest
import SwiftUI
@testable import Walnut

/// Long-session rendering perf regression gates — guards the class of bug
/// behind the 2026-08-07 0x8BADF00D watchdog kills (opening/streaming a long
/// session stalled the iOS main thread >5s and iOS killed the app).
///
/// Gate design (deliberate, do not "improve"):
///  - NO XCTest performance baselines: baselines are stored inside the
///    .xcodeproj, and this project regenerates Walnut.xcodeproj from
///    project.yml via xcodegen — every regenerate would silently wipe them.
///    Instead each scenario asserts an EXPLICIT in-code budget
///    (XCTAssertLessThan on the measured median of several runs).
///  - Absolute budgets carry ~2x headroom over measured values, because the
///    simulator slows down under concurrent machine load.
///  - The load-immune gate is the RATIO assertion: a windowed live-turn tick
///    must beat a full unwindowed re-parse of the same reply by >=10x.
///    Machine load scales both sides equally, so the ratio only collapses if
///    the windowing itself regresses to O(reply) — the exact bug signature.
final class MarkdownPerfTests: XCTestCase {

    /// Mirror of SessionConversationStore.hardMaxRenderedRows — the app never
    /// renders more rows than this, so perf scenarios must not either (bigger
    /// would overflow the parse cache in a way the real UI can't).
    private let renderCap = 400

    /// Median wall-clock ms of `iterations` runs of `block`. Median (not mean)
    /// so one GC pause / scheduler hiccup can't fail the gate.
    private func medianMs(iterations: Int = 5, _ block: () -> Void) -> Double {
        var samples: [Double] = []
        for _ in 0..<iterations {
            let t0 = DispatchTime.now()
            block()
            let t1 = DispatchTime.now()
            samples.append(Double(t1.uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000)
        }
        return samples.sorted()[samples.count / 2]
    }

    /// Block-markdown rows of a fixture, capped like the real render path.
    private func blockRows(_ msgs: [TranscriptFixtures.Msg]) -> [(Int, String)] {
        Array(msgs.suffix(renderCap)).enumerated().compactMap { i, m in
            guard m.kind == nil,
                  ChatMarkdownBody.isBlockMarkdown(m.text) || ChatMarkdownBody.containsImageRef(m.text)
            else { return nil }
            return (i, m.text)
        }
    }

    // MARK: - classify (runs per row per render)

    func testClassifyBudget() {
        for profile in TranscriptFixtures.Profile.allCases {
            let msgs = Array(TranscriptFixtures.transcript(count: 1000, profile: profile).suffix(renderCap))
            let median = medianMs {
                for m in msgs {
                    if m.role == "user" { _ = MessageRow.imageSendParts(m.text) }
                    if m.kind == nil {
                        _ = ChatMarkdownBody.isBlockMarkdown(m.text) || ChatMarkdownBody.containsImageRef(m.text)
                    }
                }
            }
            // Harness-measured ~3ms/400 rows on this sim; 0.15ms/msg = ~20x.
            let budgetMs = 0.15 * Double(msgs.count)
            print("[perf] classify \(profile.rawValue) x\(msgs.count): \(String(format: "%.2f", median))ms (budget \(budgetMs))")
            XCTAssertLessThan(median, budgetMs, "classify(\(profile.rawValue)) blew its budget")
        }
    }

    // MARK: - cold parse (first open of a session page)

    func testColdParseBudget() {
        var run = 0
        for profile in [TranscriptFixtures.Profile.mixed, .heavyMarkdown, .codeBlocks] {
            let rows = blockRows(TranscriptFixtures.transcript(count: 1000, profile: profile))
            let kb = Double(rows.reduce(0) { $0 + $1.1.utf16.count }) / 1024.0
            let median = medianMs(iterations: 3) {
                run += 1
                // Unique suffix defeats the parse cache -> every row parses cold.
                for (i, text) in rows { _ = MarkdownParser.parse(text + "\u{0}cold\(run)-\(i)") }
            }
            // ~2x measured (mixed 99ms/115KB, heavy 368ms/423KB on this sim)
            // with a floor for small pages — headroom for machine load.
            let budgetMs = max(200.0, 1.8 * kb)
            print("[perf] coldParse \(profile.rawValue) \(rows.count) rows/\(Int(kb))KB: \(String(format: "%.1f", median))ms (budget \(String(format: "%.0f", budgetMs)))")
            XCTAssertLessThan(median, budgetMs, "coldParse(\(profile.rawValue)) blew its budget")
        }
    }

    // MARK: - warm parse (steady-state re-render of a FULL render-cap page)

    /// Uses a full 400-row page on purpose: the parse cache's countLimit must
    /// cover hardMaxRenderedRows or a steady-state re-render thrashes it
    /// (measured 760ms/pass when the cache was 256 entries — a silent
    /// re-introduction of the freeze). This gate catches that regression.
    func testWarmParseFullPageBudget() {
        let rows = blockRows(TranscriptFixtures.transcript(count: 1000, profile: .mixed))
        for (i, text) in rows { _ = MarkdownParser.parse(text + "\u{0}warm\(i)") } // fill cache
        let median = medianMs {
            for (i, text) in rows { _ = MarkdownParser.parse(text + "\u{0}warm\(i)") } // hits
        }
        let budgetMs = 0.1 * Double(renderCap) + 5
        print("[perf] warmParse x\(rows.count): \(String(format: "%.2f", median))ms (budget \(budgetMs))")
        XCTAssertLessThan(median, budgetMs, "warm re-render must be cache hits, not re-parses")
    }

    // MARK: - inline fast path (non-block rows)

    func testInlineFastPathBudget() {
        let msgs = Array(TranscriptFixtures.transcript(count: 1000, profile: .plain).suffix(renderCap))
        let inlineRows = msgs.filter { $0.kind == nil && !ChatMarkdownBody.isBlockMarkdown($0.text) && !ChatMarkdownBody.containsImageRef($0.text) }
        let median = medianMs {
            for m in inlineRows { _ = Text(inline: m.text) }
        }
        let budgetMs = 0.3 * Double(max(inlineRows.count, 1))
        print("[perf] inline x\(inlineRows.count): \(String(format: "%.2f", median))ms (budget \(budgetMs))")
        XCTAssertLessThan(median, budgetMs, "inline fast path blew its budget")
    }

    // MARK: - live turn (the watchdog-kill scenario itself)

    /// Grows a streamed reply to ~2MB and measures the per-tick parse cost
    /// through LiveMarkdownWindow, exactly like LiveMarkdownBody renders it:
    /// head is quantized-stable (cache hit in steady state), tail is fresh
    /// every tick. Two gates:
    ///  1. absolute: worst windowed tick under budget (covers the bounded
    ///     once-per-tailQuantum head re-parse spike);
    ///  2. ratio (load-immune): windowed worst tick >=10x faster than one
    ///     unwindowed full re-parse at 2MB — the pre-fix per-tick behavior.
    func testLiveTurnWindowedTickBudgetAndRatio() {
        let chunk = TranscriptFixtures.cjk + "\n\n" + TranscriptFixtures.table(1, rows: 2) + "\n\n"
        var live = ""
        var worstWindowedMs = 0.0
        var tick = 0
        // Track the length instead of re-deriving it. `while live.utf16.count <
        // 2_000_000` was O(n²) IN THE LOOP CONDITION: `utf16.count` walks the whole
        // string, and it ran on all 12,122 appends even though only every 200th tick
        // (60 of them) is ever measured. Cost of the condition alone, measured in
        // isolation with identical appends: 35.24s vs 0.00s with a counter — ~29,000x,
        // and it was the ENTIRE runtime of this test: 19.8s → 2.4s after the fix, an 8x
        // speedup of the whole suite's slowest test. The chunk is an invariant string,
        // so the counter is exactly equivalent, and this fixed the HARNESS only — both
        // gates below are untouched and keep their headroom (worst tick 42.0-44.5ms vs
        // the 150ms budget; ratio 39-40x vs the >=10x gate), so the 2MB ceiling and the
        // bug-class coverage are fully preserved. Don't "fix" a future slowdown here by
        // shrinking the ceiling or relaxing a gate before checking for accidental O(n²)
        // in the scaffolding.
        //
        // ⚠️ THIS DID *NOT* FIX THE SIGKILL FLAKE, and I first said it would — recording
        // the wrong diagnosis so nobody re-derives it. This test was SIGKILLed twice
        // ("Test crashed with signal kill"), and because it was also the longest-running
        // test I concluded its 19.8s duration was the mechanism and that host load
        // decided the outcome. Both halves were wrong. After the 8x speedup the kills
        // continued and moved to OTHER tests: `testClassifyBudget` (0.18s!) and
        // `WatchdogRegressionTests/testAttachSnapshotMainThreadCost`. Across 7 suite
        // runs: 3 kills with 3 DIFFERENT victims, at loads 16 and 40, while GREEN runs
        // happened at loads 25/31/42/54 — so load does not predict it and duration is
        // irrelevant (a 0.18s test died). The real discriminator: these are HOSTED unit
        // tests, so each launch boots the whole app inside the test host, and the app's
        // own store hydration runs ~13s and peaks at 554-562MB CONCURRENTLY with the
        // tests. Whichever test is executing when the host is reaped is the victim —
        // environmental roulette, not a property of any test. Fixing that means changing
        // how the tests are hosted (project.yml intentionally uses a hosted target for
        // `@testable import Walnut`), which is a product-config decision, so it is
        // deliberately NOT done here. Treat a lone `signal kill` on a passing test as
        // this flake and re-run; only investigate if the SAME test dies repeatedly.
        var liveUTF16 = 0
        while liveUTF16 < 2_000_000 {
            live += chunk
            liveUTF16 += chunk.utf16.count
            tick += 1
            guard tick % 200 == 0 else { continue } // sample every ~30KB of growth
            let seg = LiveMarkdownWindow.segments(live)
            let t0 = DispatchTime.now()
            // Production cache routing (LiveMarkdownBody): stable head via the
            // shared cache, unique tail skips it, neither clips (the window
            // already bounds them).
            if !seg.head.isEmpty { _ = MarkdownParser.parse(seg.head, cache: .shared, clipOversized: false) }
            if !seg.tail.isEmpty { _ = MarkdownParser.parse(seg.tail + "\u{0}t\(tick)", cache: .skip, clipOversized: false) }
            let cost = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
            worstWindowedMs = max(worstWindowedMs, cost)
        }

        // Reference: ONE unwindowed tick at 2MB (what every tick cost pre-fix).
        // clipOversized: false — the 16K defensive clip would shrink this to a
        // constant-cost parse and collapse the ratio the gate depends on.
        let t0 = DispatchTime.now()
        _ = MarkdownParser.parse(live + "\u{0}unwindowed", cache: .skip, clipOversized: false)
        let unwindowedMs = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000

        let ratio = unwindowedMs / max(worstWindowedMs, 0.001)
        print("[perf] live windowed worst tick: \(String(format: "%.1f", worstWindowedMs))ms (budget 150); unwindowed 2MB tick: \(String(format: "%.0f", unwindowedMs))ms; ratio \(String(format: "%.0f", ratio))x (gate >=10x)")

        // Steady-state ticks are 3-10ms; once per tailQuantum the head
        // re-parses (~50ms, bounded). 150ms ~= 2-3x that spike.
        XCTAssertLessThan(worstWindowedMs, 150.0, "windowed live tick blew its budget")
        XCTAssertGreaterThanOrEqual(ratio, 10.0,
            "windowing no longer bounds per-tick cost — the 0x8BADF00D bug class is back")
    }
}
