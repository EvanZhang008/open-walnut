import XCTest
import SwiftUI
@testable import Walnut

/// Scroll-driven freeze scenarios ("sometimes even scrolling freezes" in
/// giant sessions). LazyVStack materializes rows as they scroll on-screen:
/// each new row runs MessageRow's classification + a first (cold) parse on
/// the main thread. 60fps frame budget = 16.7ms; >100ms per frame is felt
/// jank; a sustained >5s stall is the watchdog kill.
@MainActor
final class ScrollPerfTests: XCTestCase {

    override func setUp() {
        super.setUp()
        // Cache-behavior gates need a KNOWN population: without this, entries
        // left by earlier suites make NSCache's (undefined-order) count
        // eviction nondeterministic and the hit-rate assertions flaky.
        MarkdownParser.resetCacheForTesting()
    }

    private func ms(_ block: () -> Void) -> Double {
        let t0 = DispatchTime.now()
        block()
        return Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
    }

    /// Cold materialization of one row, as the LazyVStack does when it enters
    /// the viewport: classify, then (block rows) parse.
    private func materializeRow(_ text: String, cacheBuster: String) {
        _ = MessageRow.imageSendParts(text)
        if ChatMarkdownBody.isBlockMarkdown(text) || ChatMarkdownBody.containsImageRef(text) {
            _ = MarkdownParser.parse(text + cacheBuster)
        } else {
            _ = Text(inline: text)
        }
    }

    /// Full 400-row page of worst-case rows (~4KB each — the transcript clip
    /// limit — heavy markdown + CJK + tables). Fast-scrolling materializes a
    /// burst of fresh rows per frame; measure a 10-row burst.
    func testFastScrollMaterializationBurst() {
        // ~4KB heavy rows: transcript-clipped worst case.
        var row = ""
        while row.utf8.count < 4_000 {
            row += "## 结论\n\n" + TranscriptFixtures.cjk + "\n\n" + TranscriptFixtures.table(1, rows: 4) + "\n\n"
        }
        let rows = (0..<400).map { i in row + "\n\nrow-\(i)" }
        var worstBurstMs = 0.0
        var bursts: [Double] = []
        for frame in 0..<40 { // 40 frames x 10 rows = the whole page
            let slice = rows[(frame * 10)..<(frame * 10 + 10)]
            let burstMs = ms {
                for (i, text) in slice.enumerated() { materializeRow(text, cacheBuster: "\u{0}scroll\(frame)-\(i)") }
            }
            bursts.append(burstMs)
            worstBurstMs = max(worstBurstMs, burstMs)
        }
        let median = bursts.sorted()[bursts.count / 2]
        print(String(format: "[scroll] 10-row cold burst (4KB heavy rows): median %6.1fms worst %6.1fms (frame=16.7ms, felt-jank=100ms)", median, worstBurstMs))
        // Cold parse of 10 heavy rows will exceed one frame — that is known
        // (parse is main-thread by design). The gate is FELT-FREEZE territory:
        // a single burst must stay well under 1s on this sim (~3-5x device).
        XCTAssertLessThan(worstBurstMs, 1_000.0, "one scroll frame's materialization approaches watchdog territory")
    }

    /// Cache thrash lock: a round trip (scroll up 200 rows, back down 200)
    /// must be parse-cache hits, not re-parses. Two escalations:
    ///  a) STREAMING POLLUTION — every live tick parses a fresh (unique) tail
    ///     string into the SAME NSCache. countLimit=512 barely covers a
    ///     400-row page, so a few hundred tick entries evict history rows;
    ///     the next scroll re-parses them (and re-inserting evicts more —
    ///     sustained thrash). This is a prime "scrolling a giant streaming
    ///     session freezes" mechanism.
    ///  b) OVERSIZED legacy rows — 400 x 64KB blows totalCostLimit (4M
    ///     UTF-16 units), so even count-wise-covered pages evict on cost.
    func testScrollRoundTripCacheBehavior() {
        // Normal page: 400 x 4KB rows — populate = the first scroll down.
        var small = ""
        while small.utf8.count < 4_000 { small += TranscriptFixtures.cjk + "\n\n" + TranscriptFixtures.table(1, rows: 3) + "\n\n" }
        let smallRows = (0..<400).map { "\(small)\n\nsmall-\($0)" }
        for r in smallRows { _ = MarkdownParser.parse(r) }
        // Streaming pollution: 300 live ticks, each a UNIQUE tail string —
        // exactly what LiveMarkdownBody parses during a long turn. Production
        // now routes the tail with cache: .skip (the fix): one-shot strings
        // must never enter the shared cache and evict the visible page.
        let tailUnit = TranscriptFixtures.cjk + "\n\n"
        for t in 0..<300 { _ = MarkdownParser.parse(tailUnit + "\u{0}tick\(t)", cache: .skip, clipOversized: false) }
        let smallRoundTripMs = ms {
            for r in smallRows.reversed() { _ = MarkdownParser.parse(r) } // up
            for r in smallRows { _ = MarkdownParser.parse(r) }            // down
        }
        print(String(format: "[scroll] round trip 400x4KB rows after 300 live ticks: %6.1fms (hits expected; misses = tick entries evicted history)", smallRoundTripMs))
        // HARD GATE (was XCTExpectFailure until the 2026-08-07 fix — 916ms
        // red): live ticks now route through cache: .skip, so they can no
        // longer evict the visible page from the shared cache.
        XCTAssertLessThan(smallRoundTripMs, 100.0,
            "round-trip scroll re-parses after streaming — live tick entries evict history rows from the parse cache (countLimit too small for page+stream)")

        // Oversized legacy rows: 400 x 64KB blows the cost cap → evictions.
        var big = ""
        while big.utf8.count < 64_000 { big += TranscriptFixtures.cjk + "\n\n" + TranscriptFixtures.table(2, rows: 8) + "\n\n" }
        let bigRows = (0..<400).map { "\(big)\n\nbig-\($0)" }
        for r in bigRows { _ = MarkdownParser.parse(r) }
        let bigRoundTripMs = ms {
            for r in bigRows.reversed() { _ = MarkdownParser.parse(r) }
            for r in bigRows { _ = MarkdownParser.parse(r) }
        }
        print(String(format: "[scroll] round trip 400x64KB rows: %7.1fms (cost-cap eviction scenario; ~3-5x on device)", bigRoundTripMs))
        // HARD GATE (was XCTExpectFailure until the 2026-08-07 fix — 25,027ms
        // red): parse() now clips oversized rows to 16K chars before keying,
        // so a worst-case 400-row page fits the (raised) cost cap and the
        // round trip is cache hits.
        XCTAssertLessThan(bigRoundTripMs, 1_000.0,
            "oversized-row round trip thrashes the parse cache into re-parse storms")
    }
}
