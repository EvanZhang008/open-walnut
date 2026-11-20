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

    /// The agent-ack line after the report still folds the turn away.
    func testTheAckLineAfterTheReportStillReads() {
        let text = "Nothing for you.\nFOR_USER_STATE: working\n\(TimelineTurnMarker.tag)"
        XCTAssertEqual(TimelineTurnMarker.strip(text), "Nothing for you.")
        XCTAssertEqual(TimelineTurnMarker.stripLive(text), "Nothing for you.")
    }
}
