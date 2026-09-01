import XCTest
import UIKit
@testable import Walnut

/// Gates for the LAYOUT side of rich HTML: what the live window does to a card
/// the model is still writing, and what a single height measurement is allowed
/// to cost. The row-level rich contract (segmentation, keys, cells) lives in
/// RichHTMLTimelineTests; everything here is about the streaming window and the
/// layout actor's memo, which is where the cheap-looking bugs hide.
@MainActor
final class RichHTMLLayoutTests: XCTestCase {
    private let pageWidth: CGFloat = 393
    private var contentWidth: CGFloat { TimelineMetrics.richContentWidth(393) }
    private var richMargins: CGFloat { TimelineMetrics.richVMargin * 2 }

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
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

    private func input(_ messages: [ChatMessage], streaming: Bool = false,
                       liveText: String = "") -> TimelineInput {
        TimelineInput(messages: messages, streaming: streaming, liveText: liveText,
                      liveTextTruncated: false, activity: nil, showLoadEarlier: false,
                      width: pageWidth, expandedRowIDs: [])
    }

    private let paragraph = "The check ran on every host and the result was identical.\n\n"

    /// A card tall enough to STRADDLE the live window's head boundary, with blank
    /// lines inside it: the boundary chooser only balances code fences, so a blank
    /// line at HTML depth 1 is a candidate cut as far as it is concerned.
    private var multiRowCard: String {
        var card = "<div style=\"padding:12px;border-radius:8px;background:#eee\">\n"
        for i in 1...12 {
            card += "<b>Row \(i)</b><br>step \(i) of the plan is done and verified\n\n"
        }
        return card + "</div>"
    }

    private func grown(to length: Int, from start: String) -> String {
        var text = start
        while text.utf16.count < length { text += paragraph }
        return text
    }

    /// Every web document of a snapshot, as (row id, markup).
    private func documents(_ snapshot: TimelineSnapshot) -> [(id: String, html: String)] {
        snapshot.rows.compactMap { row in
            switch row.content {
            case .richHTML(let html, _, _): return (row.id, html)
            case .richIsland(let html, _, _): return (row.id, html)
            default: return nil
            }
        }
    }

    private func richRow(_ snapshot: TimelineSnapshot) -> TimelineRow? {
        snapshot.rows.first { $0.content.reuseKind == "richHTML" }
    }

    private func richKey(_ row: TimelineRow?) -> String? {
        switch row?.content {
        case .richHTML(_, let key, _): return key
        case .richIsland(_, let key, _): return key
        default: return nil
        }
    }

    /// Attributed text per row id — the identity check for "was this row rebuilt".
    /// `pieces(from:)` builds a fresh NSMutableAttributedString every call, so
    /// reference equality is exactly "replayed from the memo".
    private func texts(_ snapshot: TimelineSnapshot) -> [String: NSAttributedString] {
        var out: [String: NSAttributedString] = [:]
        for row in snapshot.rows {
            if case .text(let attributed) = row.content { out[row.id] = attributed }
        }
        return out
    }

    private func occurrences(of needle: String, in text: String) -> Int {
        text.components(separatedBy: needle).count - 1
    }

    // MARK: - Live window: one card, one document

    /// A card the model is still writing must arrive as ONE document, whole. The
    /// live window's head/tail split is chosen by code-fence balance alone, so
    /// once the reply passes the tail threshold the cut lands on a blank line
    /// INSIDE an open element. Measured on this fixture before the fix: the head
    /// document ended mid-`<div>`, and the tail — segmented separately, so its own
    /// depth scan starts at zero — cut the rest at every blank line inside the
    /// card, eight documents in all, the last of them nothing but the orphaned
    /// `</div>`. The reader saw that until the turn settled.
    ///
    /// Reverting (splitting a rich window into head + tail again) brings it
    /// straight back — the precondition pins that this fixture's boundary really
    /// does fall at HTML depth 1.
    func testStreamingRichCardIsNeverSplitAcrossTwoDocuments() async {
        var live = grown(to: 7_500, from: "")
        live += multiRowCard + "\n\n"
        live = grown(to: 12_000, from: live)

        // Precondition: this fixture really does reproduce the bad cut, or the
        // assertions below would pass on any input at all.
        let window = LiveMarkdownWindow.segments(live)
        XCTAssertFalse(window.head.isEmpty,
                       "fixture must be long enough that the live window splits")
        XCTAssertTrue(window.head.contains("<div style"),
                      "fixture must put the card's opening tag in the head")
        XCTAssertFalse(window.head.contains("</div>"),
                       "the split must land INSIDE the card, or this test proves nothing")

        let actor = TimelineLayoutActor()
        let snapshot = await actor.buildSnapshot(input([], streaming: true, liveText: live))
        let docs = documents(snapshot)
        XCTAssertFalse(docs.isEmpty, "the live card produced no web document")
        for (id, html) in docs {
            XCTAssertEqual(occurrences(of: "<div", in: html),
                           occurrences(of: "</div>", in: html),
                           "document \(id) begins or ends mid-element")
        }
        let holdingFirstRow = docs.filter { $0.html.contains("Row 1<") }
        let holdingLastRow = docs.filter { $0.html.contains("Row 12<") }
        XCTAssertEqual(holdingFirstRow.count, 1, "the card's first row is in \(holdingFirstRow.count) documents")
        XCTAssertEqual(holdingLastRow.count, 1)
        XCTAssertEqual(holdingFirstRow.first?.id, holdingLastRow.first?.id,
                       "the card was cut in half: its rows landed in different documents")
    }

    /// Each html run of a reply is its own document, so the message's `<style>`
    /// blocks have to be copied into every one of them (the harvest is
    /// message-scoped inside the segmenter — a second segmentation call cannot see
    /// the first call's CSS). Splitting the live window called it twice, so the
    /// tail's cards rendered with no stylesheet at all: a naked card, mid-stream,
    /// until the turn settled and the finalized message was segmented whole.
    ///
    /// Reverting the whole-window rendering strands the CSS again — the
    /// precondition pins that the split would separate the styles from the second
    /// card.
    func testEveryDocumentOfALiveRichReplyCarriesTheHarvestedStyle() async {
        let css = ".grid { display:grid; gap:8px }"
        var live = "<style>\n\(css)\n.cell { padding:10px; background:#eee }\n</style>\n\n"
        live += "<div class=\"grid\"><div class=\"cell\">Before</div>"
            + "<div class=\"cell\">After</div></div>\n\n"
        live = grown(to: 9_000, from: live)
        live += "<div class=\"grid\"><div class=\"cell\">Later</div></div>\n\n"
        live = grown(to: 12_000, from: live)

        let window = LiveMarkdownWindow.segments(live)
        XCTAssertTrue(window.head.contains("<style"),
                      "fixture must keep the styles in the head")
        XCTAssertFalse(window.tail.contains("<style"),
                       "fixture must leave the tail with no styles of its own")
        XCTAssertTrue(window.tail.contains("class=\"grid\""),
                      "fixture must put a card in the tail, or nothing could arrive unstyled")

        let actor = TimelineLayoutActor()
        let snapshot = await actor.buildSnapshot(input([], streaming: true, liveText: live))
        let docs = documents(snapshot)
        XCTAssertGreaterThanOrEqual(docs.count, 2,
                                    "expected at least the two card runs as documents, got \(docs.count)")
        for (id, html) in docs {
            XCTAssertTrue(html.contains(css), "document \(id) arrived without the message's CSS")
        }
    }

    /// A `<style>` block the model writes before its card gets NO row of its own.
    ///
    /// While streaming, one chunk is one segment (that is what keeps an emitted
    /// boundary from moving), and a `<style>` followed by a blank line is a chunk.
    /// Rendered as a card it is an empty box: 40pt of `richMinHeight` above the card
    /// the reader is watching being written, gone again when the turn settles and
    /// the runs coalesce. Would-fail-if-reverted: drop the `hasRenderableContent`
    /// guard in `richRows` and the snapshot gains a document with no content in it.
    func testAnAllCSSSegmentGetsNoRowWhileStreaming() async {
        let live = "<style>\n.card { padding:10px; background:#eee }\n</style>\n\n"
            + "<div class=\"card\">Step one is done.</div>\n\n"

        XCTAssertEqual(RichHTMLSegments.segments(live, streaming: true).count, 2,
                       "fixture must keep the styles and the card in SEPARATE segments")

        let actor = TimelineLayoutActor()
        let snapshot = await actor.buildSnapshot(input([], streaming: true, liveText: live))
        let docs = documents(snapshot)
        XCTAssertEqual(docs.count, 1, "expected the card alone, got \(docs.map(\.id))")
        for (id, html) in docs {
            XCTAssertTrue(html.contains("Step one is done."),
                          "document \(id) is not the card")
            XCTAssertTrue(html.contains("background:#eee"),
                          "document \(id) lost the styles the skipped segment carried")
        }
    }

    // MARK: - One measurement costs one row

    /// A measurement is one event about one row: it changes a HEIGHT, never
    /// markup. So it must not reach any other row — not another message's memo,
    /// and not the prose sitting next to the card that measured itself.
    ///
    /// Reverting to "a height moved, so drop every memo entry that holds a rich
    /// row" makes this fail on both counts, and that is the cost it was measured
    /// at: a reply that segments into 61 documents re-segmented and re-parsed the
    /// whole 121-row message once per card as the cards measured themselves one by
    /// one.
    func testMeasuringOneCardRebuildsNothingElse() async {
        let actor = TimelineLayoutActor()
        let card = """
        Here is the summary.

        <div style="padding:10px;background:#eee"><b>All green</b> · 12 checks.</div>

        Nothing else to report.
        """
        let messages = [message("m-card", card),
                        message("m-other", "## Other reply\n\nA separate message with its own prose.")]
        let first = await actor.buildSnapshot(input(messages))
        guard let before = richRow(first), let key = richKey(before) else {
            return XCTFail("no web document in \(first.rows.map(\.content.reuseKind))")
        }
        let textsBefore = texts(first)
        XCTAssertGreaterThanOrEqual(textsBefore.count, 3,
                                    "fixture must have prose rows either side of the card to protect")

        RichHTMLHeightCache.shared.recordMeasurement(key: key, width: contentWidth,
                                                     rowID: before.id, height: 640)
        let second = await actor.buildSnapshot(input(messages))
        guard let after = richRow(second) else { return XCTFail("the web document vanished") }
        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.height, 640 + richMargins,
                       "the measured height never reached the layout (\(after.height))")
        let textsAfter = texts(second)
        XCTAssertEqual(textsAfter.count, textsBefore.count)
        for (id, text) in textsAfter {
            XCTAssertTrue(textsBefore[id] === text,
                          "row \(id) was rebuilt by a measurement that cannot have changed it")
        }
    }

    /// The live head is memoized on its own byte-stable string, and re-parsing it
    /// is the exact cost LiveMarkdownWindow exists to bound. A card measuring
    /// itself somewhere else in the transcript has nothing to do with it, so a
    /// head that holds no rich row must survive the measurement untouched.
    ///
    /// Reverting to the unconditional `headCache = nil` means every card height
    /// change during a turn also throws away the head's TextKit measurement —
    /// several times a second on a card-heavy reply.
    func testMeasurementKeepsALiveHeadThatHoldsNoRichRow() async {
        let actor = TimelineLayoutActor()
        // Plain CJK prose: long enough to produce a head (the split needs
        // windowLen > tailReserve + tailQuantum), and with no markup in it.
        let live = String(repeating: TranscriptFixtures.cjk + "\n\n", count: 150)
        let messages = [message("m-card", "<div style=\"padding:10px\"><b>All green</b></div>")]
        let first = await actor.buildSnapshot(input(messages, streaming: true, liveText: live))
        let headBefore = first.rows.filter { $0.id.hasPrefix("live-head") }
        XCTAssertFalse(headBefore.isEmpty, "fixture must be long enough to produce a live head")
        XCTAssertFalse(headBefore.contains { $0.content.isRichDocument },
                       "this case is about a head with NO rich row")
        guard let before = richRow(first), let key = richKey(before) else {
            return XCTFail("no web document in the snapshot")
        }
        let textsBefore = texts(first)

        RichHTMLHeightCache.shared.recordMeasurement(key: key, width: contentWidth,
                                                     rowID: before.id, height: 480)
        let second = await actor.buildSnapshot(input(messages, streaming: true, liveText: live))
        let headAfter = second.rows.filter { $0.id.hasPrefix("live-head") }
        XCTAssertEqual(headAfter.count, headBefore.count)
        let textsAfter = texts(second)
        for row in headAfter {
            guard case .text = row.content else { continue }
            XCTAssertTrue(textsBefore[row.id] === textsAfter[row.id],
                          "live head row \(row.id) was re-parsed by a card's measurement")
        }
        XCTAssertEqual(richRow(second)?.height, 480 + richMargins,
                       "the measurement still has to land")
    }

    // MARK: - First-guess estimate

    /// The first guess counts what the READER sees, which means HTML's own
    /// whitespace rules: a run collapses to one character between two visible
    /// characters and to nothing when it touches a tag. Counting the source's
    /// newlines and indentation as prose made the guess depend on how the model
    /// happened to format its markup, and always in the OVER-estimating
    /// direction: the row opens a gap the measurement then closes, so the content
    /// visibly jumps up, where a short guess only grows into place.
    func testEstimateIgnoresPrettyPrintedIndentation() {
        let cells = (1...40).map { "<div class=\"row\"><b>Row \($0)</b> ok</div>" }
        let inline = "<div class=\"card\">" + cells.joined() + "</div>"
        let pretty = "<div class=\"card\">\n  " + cells.joined(separator: "\n  ") + "\n</div>"
        XCTAssertEqual(RichHTMLHeightCache.estimate(html: pretty, width: contentWidth),
                       RichHTMLHeightCache.estimate(html: inline, width: contentWidth),
                       "indentation between tags was read as prose, so a pretty-printed card guesses itself taller")
    }

    /// …and the fix is not "stop counting whitespace": a space BETWEEN WORDS is
    /// rendered, so it still occupies a character of the line it wraps on.
    func testEstimateStillCountsSpacesBetweenWords() {
        let words = Array(repeating: "word", count: 400)
        let spaced = "<p>" + words.joined(separator: " ") + "</p>"
        let glued = "<p>" + words.joined() + "</p>"
        XCTAssertGreaterThan(RichHTMLHeightCache.estimate(html: spaced, width: contentWidth),
                             RichHTMLHeightCache.estimate(html: glued, width: contentWidth),
                             "a rendered space is prose; dropping it under-guesses every wrapped paragraph")
    }
}
