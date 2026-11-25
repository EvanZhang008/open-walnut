import XCTest
import UIKit
@testable import Walnut

/// Walnut's own lines (the status report a session wrote at the end of its reply, an
/// old version tag in front of a line) never show on the phone (`InternalLines`,
/// 2026-11-20: "FOR_USER_STATE: working" flashed in a reply while it streamed in).
///
/// The rules are the server's: both run the cases in
/// `tests/fixtures/internal-lines/cases.json`, so a change on one side that the other
/// lacks fails here or in `tests/lib/internal-lines.test.ts`. Every place that draws a
/// reply goes through `TimelineTurnMarker.strip` / `stripLive`
/// (`MessageAboutTagTests.testEveryPlaceThatDrawsAReplyStripsTheLine` is that guard),
/// and both run `InternalLines`.
final class InternalLinesTests: XCTestCase {
    private struct Case: Decodable {
        let label: String
        let text: String
        let streaming: Bool?
        let shown: String
        let mustShow: Bool?
    }

    private func cases() throws -> [Case] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("tests/fixtures/internal-lines/cases.json")
        return try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
    }

    func testTheSharedCases() throws {
        let all = try cases()
        XCTAssertGreaterThan(all.count, 20)
        for c in all {
            XCTAssertEqual(InternalLines.strip(c.text, streaming: c.streaming ?? false), c.shown, c.label)
        }
    }

    /// Precision first (review 2026-11-25): the shapes the file marks `mustShow` are the session's own
    /// words, and every place that draws a finished reply shows them whole. The server's test keeps the
    /// list of them, so a widening that drops one fails on both sides.
    func testTheMustShowShapesShowWhole() throws {
        let marked = try cases().filter { $0.mustShow == true }
        XCTAssertGreaterThanOrEqual(marked.count, 32)
        for c in marked {
            XCTAssertEqual(c.shown, c.text, c.label)
            XCTAssertEqual(InternalLines.strip(c.text), c.text, c.label)
            XCTAssertEqual(TimelineTurnMarker.strip(c.text), c.text, c.label)
        }
    }

    private let builder = TimelineRowBuilder()
    private let report = "Two subagents still run.\n\nFOR_USER_STATE: working\nFOR_USER_NOW: phase one\nFOR_USER_NEXT: review"

    private func shown(_ rows: [TimelineRow]) -> String {
        rows.map { row -> String in
            if case .text(let text) = row.content { return text.string }
            return String(describing: row.content)
        }.joined(separator: "\n")
    }

    /// The reply as it streams in, chunk by chunk: no step of it shows a field name
    /// or its start, and the words before it stay.
    func testAStreamingReplyNeverShowsTheReport() {
        let ns = report as NSString
        for end in stride(from: 1, through: ns.length, by: 1) {
            let text = ns.substring(to: end)
            let live = TimelineTurnMarker.stripLive(text)
            // Once the report started, not even the next field's first letter shows.
            XCTAssertFalse(live.contains("FOR_") || (end > 27 && live.hasSuffix("F")), "stripLive at \(end): \(text)")
            if end > 24 { XCTAssertTrue(live.hasPrefix("Two subagents still run."), "stripLive at \(end)") }
            let rows = builder.liveRows(liveText: text, storeTruncated: false, activity: nil, width: 390,
                                        tailRevision: 0, cachedHead: nil)
            XCTAssertFalse(shown(rows.rows).contains("FOR_U"), "liveRows at \(end): \(text)")
        }
        XCTAssertEqual(TimelineTurnMarker.stripLive("[v16908844] Done."), "Done.")
    }

    @MainActor
    func testASavedReplyAndTheProvisionalRowShowNoReport() {
        XCTAssertEqual(TimelineTurnMarker.strip(report), "Two subagents still run.")
        let reply = ChatMessage(id: "r1", role: "assistant", text: report, createdAt: "2026-11-20T01:00:05Z", kind: nil)
        let drawn = shown(builder.rows(for: reply, width: 390, expandedRowIDs: []))
        XCTAssertTrue(drawn.contains("Two subagents still run."))
        XCTAssertFalse(drawn.contains("FOR_USER_"))
        // The finished turn's row before the refetch: like the server's history row, so it swaps in place.
        let (text, about) = SessionConversationStore.provisionalReply(
            report + "\n<walnut-about tasks=\"mt-a-1\"/>", truncated: false)
        XCTAssertEqual(text, "Two subagents still run.")
        XCTAssertEqual(about, ["mt-a-1"])
    }

    /// A tasks line before the report (review, 2026-11-20): the report goes first, so the
    /// tasks line is read and never prints, while it streams in too.
    func testATasksLineBeforeTheReportNeverPrints() {
        let text = "Answer\n<walnut-about tasks=\"mt-a-1\"/>\nFOR_USER_STATE: a\nFOR_USER_NOW: b\nFOR_USER_NEXT: c"
        XCTAssertEqual(TimelineTurnMarker.strip(text), "Answer")
        XCTAssertEqual(TimelineTurnMarker.stripLive(text), "Answer")
        let ns = text as NSString
        for end in 1...ns.length {
            let live = TimelineTurnMarker.stripLive(ns.substring(to: end))
            XCTAssertFalse(live.contains("<w") || live.contains("FOR_"), "stripLive at \(end): \(live)")
        }
    }

    /// Thread lines after the words (2026-11-24) never flash up while they stream in, whatever their
    /// shape: after two lines, after two sentences on one line, in a tag the session made up after one
    /// sentence, as items whose state is said in free words under a heading (2026-11-25, the 834 real
    /// replies). A list that is the answer (one lead-in line, a heading, the list) shows at every step.
    func testAThreadBlockNeverFlashesUpAndTheListThatIsTheAnswerShows() {
        let words = "Done: the report is on the board.\nIt names both delays, with their logs."
        let oneLine = "Done: the report is on the board. It names both delays."
        let block = "th-0a1b2c3d4e5f: answered \u{00B7} posted\nth-1b2c3d4e5f60: waiting \u{00B7} in review"
        // "Thread status:", items whose state is said in free words, then one with a known state.
        let items = "\u{7EBF}\u{7A0B}\u{72B6}\u{6001}\u{FF1A}\n- th-0a1b2c3d4e5f\u{FF08}Fence review\u{FF09}\u{FF1A}\u{7B49}\u{4F60}\u{5BA1}\n"
            + "- th-1b2c3d4e5f60 (Seed list): waits for one approval\n- th-2c3d4e5f6071: answered \u{00B7} posted"
        let shapes: [(String, String)] = [
            (words, words + "\n\n" + block),
            (oneLine, oneLine + "\n\n" + block),
            ("Done.", "Done.\n\n<walnut-turn-status>\n" + block + "\n</walnut-turn-status>"),
            (oneLine, oneLine + "\n\n" + items),
        ]
        for (said, full) in shapes {
            let hidden = full as NSString
            for end in (said as NSString).length...hidden.length {
                let live = TimelineTurnMarker.stripLive(hidden.substring(to: end))
                XCTAssertEqual(live.trimmingCharacters(in: .whitespacesAndNewlines), said, "at \(end): \(hidden.substring(to: end))")
            }
            XCTAssertEqual(TimelineTurnMarker.strip(full), said)
        }
        // A tag start the turn marker's own hold takes is left to it.
        XCTAssertEqual(TimelineTurnMarker.stripLive(oneLine + "\n<walnut-turn st"), oneLine)
        XCTAssertEqual(TimelineTurnMarker.stripLive(oneLine + "\n" + TimelineTurnMarker.tag), oneLine)
        let answer = ("Here is where they stand:\n\n**Thread status:**\n- th-0a1b2c3d4e5f: answered \u{00B7} posted\n"
            + "- th-1b2c3d4e5f60: waiting \u{00B7} in review") as NSString
        for end in 1...answer.length {
            let text = answer.substring(to: end)
            XCTAssertEqual(InternalLines.strip(text, streaming: true), text, "at \(end)")
        }
    }

    /// Sentences, not lines: a version, a file and line, a time or a URL never end one.
    func testSentenceCount() {
        XCTAssertEqual(InternalLines.sentenceCount([]), 0)
        XCTAssertEqual(InternalLines.sentenceCount(["Here is where they stand:"]), 1)
        XCTAssertEqual(InternalLines.sentenceCount(["Done."]), 1)
        XCTAssertEqual(InternalLines.sentenceCount(["Done. Shipped."]), 2)
        XCTAssertEqual(InternalLines.sentenceCount(["Shipped 1.0.267.0; x.test.ts:242 passed at 19:14Z (https://example.com/run?id=7)."]), 1)
        XCTAssertEqual(InternalLines.sentenceCount(["one", "two"]), 2)
    }

    /// The agent-ack line after the report still folds the turn away.
    func testTheAckLineAfterTheReportStillReads() {
        let text = "Nothing for you.\nFOR_USER_STATE: working\n\(TimelineTurnMarker.tag)"
        XCTAssertEqual(TimelineTurnMarker.strip(text), "Nothing for you.")
        XCTAssertEqual(TimelineTurnMarker.stripLive(text), "Nothing for you.")
    }
}
