import XCTest
import UIKit
import WebKit
@testable import Walnut

/// Gates for rich-HTML rows in the timeline: the row builder's split of a reply
/// into markdown runs + web documents, the height cache that stands in for a
/// measurement the layout actor cannot take, and the two invariants that make
/// the feature safe to add — an ordinary reply's rows are exactly what they were,
/// and a streaming card keeps its row identity while its content changes.
@MainActor
final class RichHTMLTimelineTests: XCTestCase {
    private let pageWidth: CGFloat = 393
    private var contentWidth: CGFloat { TimelineMetrics.richContentWidth(393) }

    /// A styled card with no script — the shape a rich-output reply writes.
    private let cardHTML = """
    <div style="padding:10px;border-radius:8px;background:#eee">
      <strong>All green</strong> · 12 checks, 0 failures.
    </div>
    """

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        // A height banked by an earlier case would silently satisfy the next
        // case's "nothing is measured yet" branch.
        RichHTMLHeightCache.shared.resetForTesting()
    }

    override func tearDown() {
        RichHTMLHeightCache.shared.resetForTesting()
        super.tearDown()
    }

    // MARK: - Fixtures

    private func message(_ id: String, _ text: String) -> ChatMessage {
        ChatMessage(id: id, role: "assistant", text: text,
                    createdAt: "2026-08-31T06:00:00Z", kind: nil)
    }

    private func rows(_ text: String, id: String = "m-1",
                      cache: MarkdownParser.CacheMode = .shared,
                      idPrefix: String? = nil) -> [TimelineRow] {
        TimelineRowBuilder().assistantRows(message(id, text), width: pageWidth,
                                           idPrefix: idPrefix, cache: cache)
    }

    private func kinds(_ rows: [TimelineRow]) -> [String] {
        rows.map(\.content.reuseKind)
    }

    private func richKey(_ row: TimelineRow?) -> String? {
        switch row?.content {
        case .richHTML(_, let key, _): return key
        case .richIsland(_, let key, _): return key
        default: return nil
        }
    }

    /// The single web-document row of a reply (nil when there isn't one).
    private func cardRow(_ text: String, cache: MarkdownParser.CacheMode = .shared,
                         idPrefix: String? = nil) -> TimelineRow? {
        rows(text, cache: cache, idPrefix: idPrefix).first { $0.content.reuseKind == "richHTML" }
    }

    // MARK: - The common path must not move

    /// The overwhelming majority of replies carry no HTML at all, and their rows
    /// must be exactly what they were before rich rendering existed: heading and
    /// paragraph merge into one prose run, the fence splits out, the trailing
    /// paragraph is its own run.
    func testPlainMarkdownReplyRowsUnchanged() {
        let text = """
        ## Result

        The check passed on every host.

        ```swift
        let x = 1
        ```

        Nothing else to report.
        """
        XCTAssertFalse(RichHTMLSegments.isRich(text),
                       "plain markdown classified as rich would reroute ordinary replies through a web view")
        let built = rows(text)
        XCTAssertEqual(kinds(built), ["text", "code", "text"], "got \(kinds(built))")
        XCTAssertEqual(built.map(\.id), ["m-1#0", "m-1#1", "m-1#2"])
        for row in built {
            XCTAssertGreaterThan(row.height, 0, "row \(row.id) has no height")
        }
    }

    /// Prose that only LOOKS like markup (a generic parameter, an autolink) is
    /// the classic false positive. If it ever routes through the rich path,
    /// ordinary engineering chat starts rendering inside web views.
    func testTagLikeProseStaysOnThePlainPath() {
        for text in ["Use Array<T> for that.", "See <https://example.com/docs> for the rest."] {
            XCTAssertEqual(kinds(rows(text)), ["text"], "\(text) → \(kinds(rows(text)))")
        }
    }

    // MARK: - Rich rows

    func testHTMLCardProducesOneRichRow() {
        let built = rows(cardHTML)
        XCTAssertEqual(kinds(built).filter { $0 == "richHTML" }.count, 1,
                       "expected exactly one web document, got \(kinds(built))")
        guard let row = cardRow(cardHTML), let key = richKey(row) else {
            return XCTFail("no rich row in \(kinds(built))")
        }
        XCTAssertFalse(key.isEmpty, "a rich row needs a content key to bank its height under")
        XCTAssertGreaterThan(row.height, TimelineMetrics.richVMargin * 2,
                             "the row must reserve more than its own padding")
        XCTAssertLessThanOrEqual(row.height,
                                 TimelineMetrics.richMaxHeight + TimelineMetrics.richVMargin * 2)
        // The key is a content digest: same text → same key (so a re-attach is a
        // cache hit and the cell skips the reload), different text → different
        // key (so changed markup actually reaches the cell).
        XCTAssertEqual(richKey(cardRow(cardHTML)), key)
        let edited = cardHTML.replacingOccurrences(of: "All green", with: "All red")
        XCTAssertNotEqual(richKey(cardRow(edited)), key)
    }

    /// A card between two paragraphs: the prose keeps its native TextKit rows,
    /// the card becomes ONE web document, and the order the model wrote them in
    /// survives. Ids stay unique across the mixed run (one counter for the whole
    /// reply), or the diff would treat two different rows as the same row.
    func testProseCardProseOrderAndStableIDs() {
        let text = """
        Here is the summary.

        \(cardHTML)

        Nothing else to report.
        """
        let built = rows(text)
        let shape = kinds(built)
        XCTAssertEqual(shape.filter { $0 == "richHTML" }.count, 1, "shape \(shape)")
        guard let cardIndex = shape.firstIndex(of: "richHTML") else {
            return XCTFail("no card row in \(shape)")
        }
        XCTAssertTrue(shape[..<cardIndex].contains("text"), "prose before the card is missing: \(shape)")
        XCTAssertTrue(shape[(cardIndex + 1)...].contains("text"), "prose after the card is missing: \(shape)")
        XCTAssertEqual(Set(built.map(\.id)).count, built.count, "duplicate row ids: \(built.map(\.id))")
        for row in built {
            XCTAssertTrue(row.id.hasPrefix("m-1#"), "row id outside the message's namespace: \(row.id)")
            XCTAssertGreaterThan(row.height, 0, "row \(row.id) has no height")
        }
        // Rebuilding the same text must produce the same ids in the same order —
        // that is what lets the diff leave an unchanged card's cell alone.
        XCTAssertEqual(rows(text).map(\.id), built.map(\.id))
    }

    // MARK: - Islands

    /// A ```html-app fence is a script-bearing island. While the fence is open it
    /// renders the fixed-height placeholder (mounting it would run half a
    /// script); once closed it becomes a real document on the normal height path.
    func testIslandFencePlaceholderUntilComplete() {
        let openText = """
        ```html-app
        <div id="out"></div>
        <script>document.getElementById('out').textContent = 'ready'</script>
        """
        let openRows = rows(openText).filter { $0.content.reuseKind == "richIsland" }
        XCTAssertEqual(openRows.count, 1, "an open html-app fence must still be one island row")
        guard case .richIsland(_, _, let openComplete)? = openRows.first?.content,
              let openRow = openRows.first else {
            return XCTFail("expected an island row, got \(kinds(rows(openText)))")
        }
        XCTAssertFalse(openComplete, "an unclosed fence is not mountable")
        XCTAssertEqual(openRow.height,
                       TimelineMetrics.richIslandBuildingHeight + TimelineMetrics.richVMargin * 2,
                       "a building island must use the placeholder height")

        let closedRows = rows(openText + "\n```").filter { $0.content.reuseKind == "richIsland" }
        XCTAssertEqual(closedRows.count, 1)
        guard case .richIsland(_, _, let closedComplete)? = closedRows.first?.content,
              let closedRow = closedRows.first else {
            return XCTFail("expected an island row once the fence closed")
        }
        XCTAssertTrue(closedComplete, "a closed fence must mount")
        XCTAssertNotEqual(openRow.revision, closedRow.revision,
                          "completion must be visible to the diff, or the placeholder never swaps for the island")
    }

    // MARK: - Height cache

    func testRecordedHeightIsUsedByTheNextBuild() {
        guard let key = richKey(cardRow(cardHTML)) else { return XCTFail("no rich row") }
        RichHTMLHeightCache.shared.record(key: key, width: contentWidth, height: 512)
        guard let measured = cardRow(cardHTML) else { return XCTFail("rich row vanished") }
        XCTAssertEqual(measured.height, 512 + TimelineMetrics.richVMargin * 2,
                       "a measured height must beat the estimate")
    }

    func testDifferentWidthMissesTheCache() {
        let cache = RichHTMLHeightCache.shared
        cache.record(key: "doc", width: 320, height: 400)
        XCTAssertEqual(cache.height(key: "doc", width: 320), 400)
        // Sub-pixel jitter must still HIT (widths are keyed at whole points)…
        XCTAssertEqual(cache.height(key: "doc", width: 320.2), 400)
        // …but a real width change is a different layout and must miss.
        XCTAssertNil(cache.height(key: "doc", width: 361))
    }

    /// A streaming card gets a brand-new document key every tick, so the exact
    /// table always misses mid-stream. The per-ROW height is the fallback that
    /// keeps a growing card from snapping back to the estimate on every tick.
    func testLastRowHeightIsTheStreamingFallback() {
        let cache = RichHTMLHeightCache.shared
        guard let first = cardRow(cardHTML, cache: .skip, idPrefix: "live-tail") else {
            return XCTFail("no rich row")
        }
        cache.recordRow(rowID: first.id, height: 333)
        let grown = cardHTML.replacingOccurrences(of: "0 failures", with: "0 failures so far")
        guard let next = cardRow(grown, cache: .skip, idPrefix: "live-tail"),
              let nextKey = richKey(next) else { return XCTFail("no rich row after growth") }
        XCTAssertEqual(next.id, first.id, "a growing card must keep its row id")
        XCTAssertNil(cache.height(key: nextKey, width: contentWidth),
                     "the fixture must exercise the fallback: this document is unmeasured")
        XCTAssertEqual(next.height, 333 + TimelineMetrics.richVMargin * 2,
                       "the row's last height must carry over to the next tick")
    }

    func testHeightCacheIsBounded() {
        let cache = RichHTMLHeightCache.shared
        let total = RichHTMLHeightCache.capacity * 2
        for i in 0..<total { cache.record(key: "k-\(i)", width: 300, height: 100 + CGFloat(i)) }
        XCTAssertNil(cache.height(key: "k-0", width: 300), "the oldest entry must be evicted")
        XCTAssertEqual(cache.height(key: "k-\(total - 1)", width: 300), 100 + CGFloat(total - 1),
                       "the newest entry must survive")
        let survivors = (0..<total).filter { cache.height(key: "k-\($0)", width: 300) != nil }.count
        // Trimming fires one entry past the cap and then drops a batch, so the
        // table sits at most `capacity + 1`.
        XCTAssertLessThanOrEqual(survivors, RichHTMLHeightCache.capacity + 1,
                                 "cache grew past its cap (\(survivors) entries)")
    }

    /// The estimate is only a first guess, but it must be a SANE one: inside the
    /// row's own clamps, and bigger for more content.
    func testEstimateStaysInsideTheRowClamps() {
        let small = RichHTMLHeightCache.estimate(html: "<p>hi</p>", width: contentWidth)
        let large = RichHTMLHeightCache.estimate(
            html: "<p>" + String(repeating: "content ", count: 4_000) + "</p>",
            width: contentWidth)
        XCTAssertGreaterThanOrEqual(small, TimelineMetrics.richMinHeight)
        XCTAssertLessThanOrEqual(large, TimelineMetrics.richMaxHeight)
        XCTAssertGreaterThan(large, small)
    }

    /// A `<style>` block is CSS, not prose, and every html run of a rich reply
    /// carries the whole message's harvested styles. Counting that text as
    /// visible characters is what made a 60pt comparison card guess itself into a
    /// 466pt row on a real transcript.
    func testEstimateDoesNotReadCSSAsProse() {
        let css = String(repeating: ".row { display:flex; gap:10px; padding:4px 8px }\n", count: 12)
        let card = "<div class=\"row\"><b>Before</b><span>3 round trips</span></div>"
        let bare = RichHTMLHeightCache.estimate(html: card, width: contentWidth)
        let styled = RichHTMLHeightCache.estimate(html: "<style>\(css)</style>\(card)",
                                                  width: contentWidth)
        XCTAssertEqual(styled, bare + RichHTMLHeightCache.estimateLineHeightForTesting,
                       "the CSS text was counted as prose (\(styled) vs \(bare)) — only the two style tags may add rhythm")
        // Same for a script a card is not going to run anyway.
        let scripted = RichHTMLHeightCache.estimate(
            html: "<script>\(String(repeating: "let n = 0; n += 1;\n", count: 20))</script>\(card)",
            width: contentWidth)
        XCTAssertEqual(scripted, bare + RichHTMLHeightCache.estimateLineHeightForTesting)
    }

    /// The style harvest COPIES rather than moves, so the segment that owns the
    /// blocks carries each one TWICE (the original where the model wrote it,
    /// plus the prepended copy). Measured payload: four `<style` opens in ~119
    /// bytes for ~5 characters of visible prose. A first-match exclusion would
    /// still read three of those bodies as text and estimate that segment at
    /// roughly 24x its real content, so the suppression has to be a running
    /// count over EVERY rawtext run.
    func testEstimateExcludesEveryRawtextRunNotJustTheFirst() {
        let card = "<div class=\"row\"><b>Before</b><span>3 round trips</span></div>"
        let css = ".row { display:flex; gap:10px }"
        let more = ".row b { font-weight:600; letter-spacing:0.2px }"
        let harvested = "<style>\(css)</style><style>\(more)</style>"
        let bare = RichHTMLHeightCache.estimate(html: card, width: contentWidth)
        let doubled = RichHTMLHeightCache.estimate(html: harvested + harvested + card,
                                                   width: contentWidth)
        // Four style elements = eight tags = four structural lines of rhythm, and
        // not one character of their bodies.
        XCTAssertEqual(doubled, bare + 4 * RichHTMLHeightCache.estimateLineHeightForTesting,
                       "a later rawtext run was counted as prose (\(doubled) vs \(bare))")
    }

    /// `extractAppHtml` hands the fence body over verbatim, script included, so
    /// an island's payload is mostly rawtext by construction. It must go through
    /// the SAME rawtext-aware estimator as a card — a second estimate path for
    /// islands would over-guess every scripted block on first layout.
    func testCompleteIslandRowUsesTheSharedRawtextAwareEstimate() {
        let script = String(repeating: "for (var i = 0; i !== 20; i++) { total += i; }\n",
                            count: 12) // ~550 characters of code, ~2 of prose
        let text = """
        ```html-app
        <div id="out">ok</div>
        <script>
        \(script)
        </script>
        ```
        """
        let islandRows = rows(text).filter { $0.content.reuseKind == "richIsland" }
        guard case .richIsland(let html, _, let complete)? = islandRows.first?.content,
              let row = islandRows.first else {
            return XCTFail("expected one island row, got \(kinds(rows(text)))")
        }
        XCTAssertTrue(complete, "the fence is closed")
        let shared = min(TimelineMetrics.richMaxHeight,
                         max(TimelineMetrics.richMinHeight,
                             RichHTMLHeightCache.estimate(html: html, width: contentWidth)))
        XCTAssertEqual(row.height, shared + TimelineMetrics.richVMargin * 2,
                       "the island row does not use the shared estimator")
        // And the exclusion is actually engaged on this payload: ~550 characters
        // of code read as prose would be a dozen text lines on its own.
        XCTAssertLessThan(row.height, 200,
                          "the script body was counted as visible text (\(row.height)pt)")
    }

    // MARK: - Measurement must not be floored by the row

    /// The bug this pins is the whole reason a card can be trusted to size
    /// itself: `scrollView.contentSize` is never SHORTER than the web view's
    /// frame, so a document laid out at the row's height re-reports that height
    /// and every over-estimate becomes permanent. The cell therefore lays the
    /// document out at a small probe height until it has measured itself.
    func testDocumentIsLaidOutAtItsOwnHeightNotTheRowsGuess() {
        let cell = TimelineRichHTMLCell(frame: .zero)
        cell.frame = CGRect(x: 0, y: 0, width: pageWidth, height: 900)
        cell.configureContent(html: cardHTML, key: "rh-probe-1", streaming: false,
                              rowID: "m-1#0", contentWidth: contentWidth, delegate: nil)
        cell.layoutIfNeeded()
        guard let web = cell.webViewForTesting else { return XCTFail("no web view") }
        XCTAssertEqual(web.frame.width, contentWidth, accuracy: 0.5)
        XCTAssertLessThanOrEqual(web.frame.height, TimelineMetrics.richMinHeight,
                                 "a 900pt row floored the measurement at 900pt — the card can never shrink to its content")

        // Once a measurement exists the document owns exactly that height.
        cell.applyMeasuredHeightForTesting(220)
        cell.layoutIfNeeded()
        XCTAssertEqual(web.frame.height, 220, accuracy: 0.5)
    }

    /// A card scrolled off screen and back re-loads its document. Starting THAT
    /// from the probe height would show a 40pt sliver inside a correctly sized
    /// row for a frame or two, so a height already banked for this document at
    /// this width is used from the first layout.
    func testAReattachedCardStartsFromItsBankedHeight() {
        let key = "rh-reattach-1"
        RichHTMLHeightCache.shared.record(key: key, width: contentWidth, height: 260)
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 268))
        cell.configureContent(html: cardHTML, key: key, streaming: false,
                              rowID: "m-4#0", contentWidth: contentWidth, delegate: nil)
        cell.layoutIfNeeded()
        guard let web = cell.webViewForTesting else { return XCTFail("no web view") }
        XCTAssertEqual(web.frame.height, 260, accuracy: 0.5,
                       "a re-attached card starts as a sliver and grows a frame later")
    }

    /// A streaming card gets a new document key on every tick, so the exact table
    /// always misses mid-stream. Starting each tick from the probe would collapse
    /// the card and grow it back several times a second — exactly the strobe the
    /// load throttle exists to prevent. The row's own last height is the start.
    func testAStreamingCardStartsFromItsPreviousHeightNotTheProbe() {
        let rowID = "live-tail#0"
        RichHTMLHeightCache.shared.recordRow(rowID: rowID, height: 310)
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 318))
        cell.configureContent(html: cardHTML, key: "rh-live-tick-2", streaming: true,
                              rowID: rowID, contentWidth: contentWidth, delegate: nil)
        cell.layoutIfNeeded()
        guard let web = cell.webViewForTesting else { return XCTFail("no web view") }
        XCTAssertEqual(web.frame.height, 310, accuracy: 0.5,
                       "a live card collapses to the probe on every tick")
    }

    /// A `contentSize` change that lands BEFORE the document finished loading is
    /// measuring either the previous card (a reused cell keeps showing it until
    /// the new load paints) or a half-laid-out document. On a real transcript five
    /// different cards each reported the same impossible first height that way,
    /// which set wrong row heights AND spent the revision budget the honest late
    /// measurements need.
    func testMeasurementsBeforeTheDocumentIsReadyAreDiscarded() {
        let spy = RichHeightSpy()
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 900))
        cell.configureContent(html: cardHTML, key: "rh-ready-1", streaming: false,
                              rowID: "m-3#0", contentWidth: contentWidth, delegate: spy)

        cell.observeContentHeightForTesting(742)
        XCTAssertEqual(spy.heights, [], "a measurement taken mid-load reached the layout")

        cell.markDocumentReadyForTesting()
        cell.observeContentHeightForTesting(180)
        XCTAssertEqual(spy.heights, [180], "the first honest measurement did not reach the layout")
        // The 1pt dead band: assigning the height resizes the web view, which
        // fires `contentSize` again. Without it this is a render loop.
        cell.observeContentHeightForTesting(180.4)
        XCTAssertEqual(spy.heights, [180])
    }

    /// The shrink case the whole measurement design exists for. A `<details>` the
    /// reader collapses changes no document key, so nothing reloads and nothing
    /// re-probes: if a SMALLER number cannot lower the row, the card keeps its dead
    /// space for the rest of the session (83pt of it, on the transcript that found
    /// this). Both halves matter — the report has to reach the coordinator, and the
    /// document has to be re-laid-out at the smaller height straight away.
    func testASmallerMeasurementLowersTheRow() {
        let spy = RichHeightSpy()
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 900))
        cell.configureContent(html: cardHTML, key: "rh-shrink-1", streaming: false,
                              rowID: "m-6#0", contentWidth: contentWidth, delegate: spy)
        cell.markDocumentReadyForTesting()
        cell.observeContentHeightForTesting(300)
        cell.layoutIfNeeded()
        guard let web = cell.webViewForTesting else { return XCTFail("no web view") }
        XCTAssertEqual(web.frame.height, 300, accuracy: 0.5)

        cell.observeContentHeightForTesting(120)
        cell.layoutIfNeeded()
        XCTAssertEqual(spy.heights, [300, 120], "the shrink never reached the layout")
        XCTAssertEqual(web.frame.height, 120, accuracy: 0.5,
                       "the document kept the taller frame, which is also the height it would then re-measure")
    }

    // MARK: - Revision ceiling

    /// A document sized in viewport units measures whatever we just resized it to,
    /// so measure → resize → measure alternates between two honest answers for ever.
    /// The per-load ceiling is the only thing that ends it, and it has to be
    /// UN-RESETTABLE: the budget it replaced was cleared by the observer path, which
    /// is the one producer that can loop, so nothing was bounded at all. Reverting
    /// that gives `<div style="height:100vh"></div><div style="height:50px"></div>`
    /// an ~80-step staircase to the 4000pt clamp, and `calc(600px - 100vh)` a
    /// permanent ~30Hz relayout — one actor rebuild per step, for ever.
    func testADocumentCannotReviseItsHeightPastThePerLoadCeiling() {
        let spy = RichHeightSpy()
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 900))
        cell.configureContent(html: cardHTML, key: "rh-ceiling-1", streaming: false,
                              rowID: "m-5#0", contentWidth: contentWidth, delegate: spy)
        cell.markDocumentReadyForTesting()
        // Driven through the DOCUMENT'S OWN path — the one the old reset sat on — so
        // a fix that only bounds the other producers cannot pass this.
        for step in 0..<80 {
            cell.observeContentHeightForTesting(100 + CGFloat(step) * 7)
        }
        XCTAssertEqual(spy.heights.count, TimelineRichHTMLCell.maxHeightRevisionsPerLoad,
                       "the staircase ran to \(spy.heights.count) rebuilds")

        // Per LOAD, not per cell: a long-lived streaming card reloads every ~300ms
        // and would otherwise freeze at the first document's 32 revisions.
        cell.configureContent(html: cardHTML + "<p>and more</p>", key: "rh-ceiling-2",
                              streaming: false, rowID: "m-5#0", contentWidth: contentWidth,
                              delegate: spy)
        cell.markDocumentReadyForTesting()
        cell.observeContentHeightForTesting(250)
        XCTAssertEqual(spy.heights.count, TimelineRichHTMLCell.maxHeightRevisionsPerLoad + 1,
                       "a new document did not get its own budget")
    }

    /// The behaviour that motivated the resettable budget in the first place, kept:
    /// a reader working a disclosure gets a height per tap, not two and then silence.
    /// This is why the ceiling is high rather than tight, and why it is not a
    /// "this height repeated → stop" rule: a toggle alternates between exactly two
    /// heights, so that rule would have capped the reader at the second tap.
    func testAReaderTogglingADisclosureGetsEveryHeight() {
        let spy = RichHeightSpy()
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 400))
        cell.configureContent(html: cardHTML, key: "rh-toggle-1", streaming: false,
                              rowID: "m-5#1", contentWidth: contentWidth, delegate: spy)
        cell.markDocumentReadyForTesting()
        for _ in 0..<4 {
            cell.observeContentHeightForTesting(300) // opened
            cell.observeContentHeightForTesting(120) // closed again
        }
        XCTAssertEqual(spy.heights, [300, 120, 300, 120, 300, 120, 300, 120],
                       "the card stopped answering the reader partway through")
    }

    // MARK: - Reuse

    /// A recycled cell must show nothing of the row it came FROM. The still frame is
    /// the trap: it was only ever removed in `didFinish`, and the row a cell lands on
    /// may never produce one — an island that is still arriving never does. So a
    /// snapshot of another message's card sat on top of "Building interactive block…"
    /// for the rest of the cell's life. Reverting either half (the drop on reuse, or
    /// the placeholder's own) puts one reply's card inside another reply's row,
    /// permanently.
    func testReuseLeavesNothingOfThePreviousRowVisible() {
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 300))
        cell.configureContent(html: cardHTML, key: "rh-reuse-1", streaming: true,
                              rowID: "m-7#0", contentWidth: contentWidth, delegate: nil)
        cell.markDocumentReadyForTesting()
        // Stand in for the still frame a mid-reload card holds (a real snapshot needs
        // a rendered view; what matters here is that something of the old row is up).
        cell.coverForTesting = UIView()
        XCTAssertNotNil(cell.coverForTesting)

        cell.prepareForReuse()
        XCTAssertNil(cell.coverForTesting, "the previous row's still frame survived reuse")

        // …and the row it lands on is an island that is still building, which is the
        // case that used to return before any blanking ran at all.
        cell.configureIsland(html: "<div>half a widget", key: "rh-reuse-2", complete: false,
                             rowID: "m-8#0", contentWidth: contentWidth, delegate: nil)
        XCTAssertNil(cell.coverForTesting,
                     "another message's card is painted over the building placeholder")
        guard let web = cell.webViewForTesting else { return XCTFail("no web view") }
        XCTAssertTrue(web.isHidden,
                      "the previous row's document is still on screen behind the placeholder")

        // The other channel for the same symptom: nothing cancels an in-flight WebKit
        // load, so the load this cell issued for the row it came FROM can finish right
        // here. Revealing it paints one message's card under another's placeholder.
        cell.webView(web, didFinish: nil)
        XCTAssertTrue(web.isHidden,
                      "a finish for the previous row's load revealed its card in this row")
    }

    /// Same rule for a complete card: blank until the new document paints, because a
    /// reader saw one reply's "Conclusion" card painted into another reply's
    /// streaming tail.
    func testARecycledCellBlanksUntilItsOwnDocumentPaints() {
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 300))
        cell.configureContent(html: cardHTML, key: "rh-recycle-1", streaming: false,
                              rowID: "m-7#1", contentWidth: contentWidth, delegate: nil)
        cell.markDocumentReadyForTesting()
        XCTAssertEqual(cell.webViewForTesting?.isHidden, false)

        cell.prepareForReuse()
        cell.configureContent(html: "<p>a different reply's card</p>", key: "rh-recycle-2",
                              streaming: false, rowID: "m-8#1", contentWidth: contentWidth,
                              delegate: nil)
        XCTAssertEqual(cell.webViewForTesting?.isHidden, true,
                       "the card of the row this cell came from is visible in this row")
    }

    /// Two rows of a streaming reply routinely carry a byte-identical card, so the
    /// idempotence guard fires on a RECYCLE too — and it used to return before the
    /// load stamp moved. Every later height report was then banked under the row the
    /// cell came from: the wrong row got resized, this one kept its guess, and
    /// `performLoad`'s cover check (same field) missed, so the next reload flashed
    /// blank instead of holding a still frame.
    func testTheLoadStampFollowsTheRowThroughTheIdentityEarlyReturn() {
        let spy = RichHeightSpy()
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 300))
        cell.configureContent(html: cardHTML, key: "rh-dup-1", streaming: false,
                              rowID: "m-1#0", contentWidth: contentWidth, delegate: spy)
        cell.markDocumentReadyForTesting()

        cell.prepareForReuse()
        // Same bytes, same width, same style — so this configure issues no load at
        // all, and must not: re-loading would restart the document under a reader
        // who is looking at it.
        cell.configureContent(html: cardHTML, key: "rh-dup-1", streaming: false,
                              rowID: "m-2#0", contentWidth: contentWidth, delegate: spy)
        XCTAssertEqual(cell.webViewForTesting?.isHidden, false,
                       "an identical document IS this row's document — blanking it flashes for nothing")

        cell.observeContentHeightForTesting(210)
        XCTAssertEqual(spy.reports.map(\.rowID), ["m-2#0"],
                       "the measurement was banked under the row the cell came from")
        XCTAssertEqual(spy.reports.first?.key, "rh-dup-1")
        XCTAssertEqual(spy.reports.first?.width ?? 0, contentWidth, accuracy: 0.5)
    }

    // MARK: - Failure paths

    /// A load that fails produces no `didFinish`, so no observer installs, no
    /// measurement is ever taken, and the row keeps the estimate it was built with: a
    /// tall empty box the reader cannot explain and the app never corrects. The
    /// minimum height is the honest answer. The other half of this case is just as
    /// load-bearing: a load the cell SUPERSEDED itself (every streaming tick cancels
    /// the one in flight, and so does every navigation the lockdown blocks) arrives
    /// through the same callback, and sizing a row from that would collapse a live
    /// card several times a second.
    func testAFailedLoadSizesTheRowAndASupersededOneDoesNot() {
        let spy = RichHeightSpy()
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 900))
        cell.configureContent(html: cardHTML, key: "rh-fail-1", streaming: true,
                              rowID: "m-9#0", contentWidth: contentWidth, delegate: spy)
        cell.markDocumentReadyForTesting()
        guard let web = cell.webViewForTesting else { return XCTFail("no web view") }

        // Recycled onto another row, so the cell has blanked itself and issued that
        // row's load: a `didFinish` is the only thing that can bring pixels back.
        cell.prepareForReuse()
        cell.configureContent(html: "<p>the next reply's card</p>", key: "rh-fail-2",
                              streaming: false, rowID: "m-10#0", contentWidth: contentWidth,
                              delegate: spy)
        XCTAssertTrue(web.isHidden)

        // A load THIS cell superseded is not a failure — a streaming tick cancels the
        // one in flight, and 102 ("frame load interrupted") is what the navigation
        // lockdown's own `.cancel` looks like from here.
        cell.webView(web, didFailProvisionalNavigation: nil,
                     withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
        cell.webView(web, didFailProvisionalNavigation: nil,
                     withError: NSError(domain: "WebKitErrorDomain", code: 102))
        XCTAssertEqual(spy.heights, [], "a load this cell superseded collapsed the card")
        XCTAssertTrue(web.isHidden, "a superseded load revealed an empty web view")

        cell.webView(web, didFail: nil,
                     withError: NSError(domain: "WebKitErrorDomain", code: 100))
        XCTAssertEqual(spy.heights, [TimelineMetrics.richMinHeight],
                       "a failed load left the row sitting at its estimate with nothing in it")
        XCTAssertEqual(spy.reports.first?.rowID, "m-10#0",
                       "the fallback height was banked under the wrong row")
        XCTAssertFalse(web.isHidden, "the web view stayed hidden: the row is a permanent blank")
    }

    // MARK: - Dark mode

    /// The palette is baked THROUGH the document, so a light/dark flip can only be
    /// honoured by re-loading it — and the cell has to do that itself. A trait
    /// change reconfigures nothing (the rows did not change), so the version that
    /// merely dropped its identity kept serving light-palette markup into a black
    /// transcript: dark-grey SVG labels and prose on black.
    func testInterfaceStyleFlipReloadsWithTheOtherPalette() {
        // A REAL window, because that is the only place UIKit propagates a style
        // change: an override on a detached view leaves `traitCollection` alone,
        // so a test written that way would assert nothing about the flip.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 400))
        window.overrideUserInterfaceStyle = .light
        let cell = TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 200))
        window.addSubview(cell)
        window.layoutIfNeeded()
        cell.configureContent(html: cardHTML, key: "rh-dark-1", streaming: false,
                              rowID: "m-2#0", contentWidth: contentWidth, delegate: nil)
        guard let light = cell.loadedDocumentForTesting else { return XCTFail("nothing loaded") }
        XCTAssertTrue(light.contains(RichHTMLPalette.light.fg),
                      "light document lacks the light fg; style=\(cell.traitCollection.userInterfaceStyle.rawValue)")
        XCTAssertTrue(light.contains("color-scheme: light"))

        window.overrideUserInterfaceStyle = .dark
        window.layoutIfNeeded()
        guard let dark = cell.loadedDocumentForTesting else { return XCTFail("nothing loaded") }
        XCTAssertTrue(dark.contains(RichHTMLPalette.dark.fg),
                      "the flip did not re-load: the card keeps its light palette on black")
        // `color-scheme` drives what WebKit styles itself — a bare `<button>` in an
        // island came out light-on-black while this said "light dark".
        XCTAssertTrue(dark.contains("color-scheme: dark"))
        XCTAssertFalse(dark.contains("color-scheme: light dark"))
    }

    // MARK: - Streaming identity

    /// The cell is only reconfigured when a row's revision (or height) changes.
    /// A streaming card keeps its id — that is what stops the web view being
    /// torn down and losing its DOM state — so the revision is the ONLY signal
    /// that new markup arrived.
    func testStreamingCardKeepsIDAndChangesRevision() {
        guard let first = cardRow(cardHTML, cache: .skip, idPrefix: "live-tail") else {
            return XCTFail("no rich row")
        }
        let grown = cardHTML.replacingOccurrences(
            of: "<strong>All green</strong>", with: "<strong>All green</strong><em>+1</em>")
        guard let next = cardRow(grown, cache: .skip, idPrefix: "live-tail") else {
            return XCTFail("no rich row after growth")
        }
        XCTAssertEqual(next.id, first.id)
        XCTAssertNotEqual(next.revision, first.revision,
                          "changed markup with an unchanged revision never reaches the cell")
        // The streaming flag must reach the cell too, or a live card reloads at
        // the full ~8Hz tick rate instead of the throttled cadence.
        guard case .richHTML(_, _, let streaming) = next.content else {
            return XCTFail("not a card row")
        }
        XCTAssertTrue(streaming)
    }

    /// Only the LAST segment of a live reply can still grow; the segmenter
    /// freezes every earlier one byte-for-byte. A card the model has already
    /// finished and moved past must therefore NOT be flagged streaming, or its
    /// cell throttles reloads it will never receive.
    func testSettledCardInALiveReplyIsNotFlaggedStreaming() {
        let text = """
        \(cardHTML)

        Still writing the next part
        """
        guard let settled = cardRow(text, cache: .skip, idPrefix: "live-tail") else {
            return XCTFail("no rich row in \(kinds(rows(text, cache: .skip, idPrefix: "live-tail")))")
        }
        guard case .richHTML(_, _, let streaming) = settled.content else {
            return XCTFail("not a card row")
        }
        XCTAssertFalse(streaming,
                       "a card followed by more output is finished — flagging it live throttles a cell with nothing to reload")
    }

    // MARK: - Actor pipeline (a measurement must survive the row memo)

    /// The layout actor memoizes a message's rows. A rich row's height arrives
    /// AFTER the build (the cell measures it), so the memo has to be invalidated
    /// when a height lands — otherwise the card keeps its rough estimate for the
    /// rest of the session and the measurement is dead weight.
    func testBankedHeightSurvivesTheActorRowMemo() async {
        let actor = TimelineLayoutActor()
        let input = TimelineInput(messages: [message("m-9", cardHTML)], streaming: false,
                                  liveText: "", liveTextTruncated: false, activity: nil,
                                  showLoadEarlier: false, width: pageWidth, expandedRowIDs: [])
        let first = await actor.buildSnapshot(input)
        guard let before = first.rows.first(where: { $0.content.reuseKind == "richHTML" }),
              let key = richKey(before) else {
            return XCTFail("no rich row in the snapshot: \(kinds(first.rows))")
        }

        RichHTMLHeightCache.shared.record(key: key, width: contentWidth, height: 640)
        RichHTMLHeightCache.shared.recordRow(rowID: before.id, height: 640)
        let second = await actor.buildSnapshot(input)
        guard let after = second.rows.first(where: { $0.content.reuseKind == "richHTML" }) else {
            return XCTFail("the rich row vanished")
        }
        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.height, 640 + TimelineMetrics.richVMargin * 2,
                       "the memo replayed a stale height (\(after.height)) — the measurement never reached the layout")
    }
}

/// Stands in for the coordinator, recording the whole `richHeight` request rather
/// than only the number: which ROW a measurement is banked under is the thing
/// several of these cases are about, and a spy that dropped it could not see a
/// height land on the wrong row.
private final class RichHeightSpy: TimelineCellActionDelegate {
    var reports: [(rowID: String, key: String, width: CGFloat, height: CGFloat)] = []
    var heights: [CGFloat] { reports.map(\.height) }

    func timelineCell(didRequest action: TimelineRowAction) {
        if case .richHeight(let rowID, let key, let width, let height) = action {
            reports.append((rowID: rowID, key: key, width: width, height: height))
        }
    }
}
