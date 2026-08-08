import XCTest
import UIKit
@testable import Walnut

/// Correctness gates for the timeline rendering engine (Timeline/):
/// diff minimality, measurement/render height parity, actor memoization,
/// and behavior-parity of the row builder against the product's row types.
@MainActor
final class TimelineEngineTests: XCTestCase {

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        MainWork.resetForTesting()
    }

    private func message(_ i: Int, text: String, role: String = "assistant",
                         kind: ChatMessage.Kind? = nil) -> ChatMessage {
        ChatMessage(id: "m-\(i)", role: role, text: text,
                    createdAt: "2026-08-08T06:00:\(String(format: "%02d", i % 60))Z", kind: kind)
    }

    private func input(_ messages: [ChatMessage], streaming: Bool = false,
                       liveText: String = "", width: CGFloat = 393) -> TimelineInput {
        TimelineInput(messages: messages, streaming: streaming, liveText: liveText,
                      liveTextTruncated: false, activity: nil, showLoadEarlier: false,
                      width: width, expandedRowIDs: [])
    }

    // MARK: - Diff

    func testDiffAppendOnlyTouchesTail() {
        let old = (0..<100).map { TimelineRow(id: "r\($0)", revision: 0, content: .truncationChip, height: 20) }
        let new = old + [TimelineRow(id: "r100", revision: 0, content: .truncationChip, height: 20)]
        let diff = TimelineDiff.compute(old: old, new: new)
        XCTAssertEqual(diff.deletes.count, 0)
        XCTAssertEqual(diff.inserts.map(\.0), [100])
        XCTAssertEqual(diff.reloads.count, 0)
    }

    func testDiffLiveTailRevisionReloadsOnlyThatRow() {
        var old = (0..<50).map { TimelineRow(id: "r\($0)", revision: 0, content: .truncationChip, height: 20) }
        old.append(TimelineRow(id: "live-tail#0", revision: 3, content: .truncationChip, height: 40))
        var new = old
        new[new.count - 1] = TimelineRow(id: "live-tail#0", revision: 4, content: .truncationChip, height: 55)
        let diff = TimelineDiff.compute(old: old, new: new)
        XCTAssertEqual(diff.deletes.count, 0)
        XCTAssertEqual(diff.inserts.count, 0)
        XCTAssertEqual(diff.reloads.map(\.0), [50])
    }

    func testDiffHeadTrimDeletesFromFront() {
        let old = (0..<150).map { TimelineRow(id: "r\($0)", revision: 0, content: .truncationChip, height: 20) }
        let new = Array(old.suffix(100))
        let diff = TimelineDiff.compute(old: old, new: new)
        XCTAssertEqual(diff.deletes, Array(0..<50))
        XCTAssertEqual(diff.inserts.count, 0)
        XCTAssertEqual(diff.reloads.count, 0)
    }

    func testDiffIdenticalArraysIsEmpty() {
        let rows = (0..<80).map { TimelineRow(id: "r\($0)", revision: 0, content: .truncationChip, height: 20) }
        XCTAssertTrue(TimelineDiff.compute(old: rows, new: rows).isEmpty)
    }

    // MARK: - Height parity (measurement == rendering)

    /// The engine's core contract: the actor's TextKit measurement must equal
    /// what the rendering text view produces at the same width. Checked
    /// across the fixture profiles (CJK, tables→text pieces, lists, links).
    func testMeasuredHeightMatchesRenderedHeight() {
        let measurer = TimelineTextMeasurer()
        let samples = [
            "收到,第 3 步完成。The check passed.",
            TranscriptFixtures.cjk,
            "## 结论\n\n" + TranscriptFixtures.cjk + "\n\n- 项目一:验证完成\n- 项目二:等待复核\n- 项目三:已回滚",
            "Bare url https://example.com/path and **bold** plus `code` inline.",
        ]
        var checked = 0
        for (i, text) in samples.enumerated() {
            let blocks = MarkdownParser.parse(text, cache: .skip)
            for (j, piece) in TimelineTextStyler.pieces(from: blocks).enumerated() {
                guard case .text(let attributed) = piece else { continue }
                let width: CGFloat = 320
                let measured = measurer.height(attributed, width: width)
                // Render through the SAME view class the cells use.
                let tv = TimelineTextView()
                tv.attributedText = attributed
                let rendered = tv.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
                XCTAssertEqual(measured, ceil(rendered), accuracy: 2.0,
                    "height parity broken for sample \(i) piece \(j): measured \(measured) vs rendered \(rendered)")
                checked += 1
            }
        }
        XCTAssertGreaterThanOrEqual(checked, 4, "parity gate must actually check pieces (n=\(checked))")
    }

    // MARK: - Row builder coverage (every product row type produces rows)

    func testBuilderCoversAllRowTypes() async {
        let actor = TimelineLayoutActor()
        var messages: [ChatMessage] = [
            message(0, text: "plain user text", role: "user"),
            message(1, text: "**assistant** markdown\n\n- list\n\n```swift\nlet x = 1\n```"),
            message(2, text: "Bash", kind: .tool),
            message(3, text: "thinking about it", kind: .thinking),
            message(4, text: "**Session Error** (Task X): it broke badly " + String(repeating: "detail ", count: 60), kind: .notification),
            message(5, text: "分析截图:`/tmp/perf-probe/latency-1.png` 供参考。"),
            message(6, text: "| a | b |\n|---|---|\n| 1 | 2 |"),
        ]
        var toolMsg = message(7, text: "Task", kind: .tool)
        toolMsg = ChatMessage(id: toolMsg.id, role: "assistant", text: "Task",
                              createdAt: toolMsg.createdAt, kind: .tool,
                              detail: "delegate work", resultPreview: "line1\nline2", agent: "explorer")
        messages.append(toolMsg)
        var failed = message(8, text: "failed send", role: "user")
        failed.failed = true
        messages.append(failed)

        let snapshot = await actor.buildSnapshot(input(messages, streaming: true, liveText: "live tail text"))
        let kinds = Set(snapshot.rows.map(\.content.reuseKind))
        for expected in ["text", "bubble", "toolChip", "chip", "notification", "image",
                         "table", "code", "failedNotice", "activity"] {
            XCTAssertTrue(kinds.contains(expected), "missing row kind \(expected); got \(kinds)")
        }
        // Every row must carry a positive height (layout never self-sizes).
        for row in snapshot.rows {
            XCTAssertGreaterThan(row.height, 0, "row \(row.id) has no height")
        }
    }

    /// The subagent badge (`agent` field, added 2026-08) must survive into the
    /// tool chip row.
    func testToolChipCarriesAgentBadge() async {
        let actor = TimelineLayoutActor()
        let msg = ChatMessage(id: "t-1", role: "assistant", text: "Task",
                              createdAt: "2026-08-08T06:00:00Z", kind: .tool,
                              detail: "explore", resultPreview: "out", agent: "researcher")
        let snapshot = await actor.buildSnapshot(input([msg]))
        guard case .toolChip(_, _, _, let agent, _) = snapshot.rows.first?.content else {
            return XCTFail("expected toolChip row")
        }
        XCTAssertEqual(agent, "researcher")
    }

    /// Historical image sends ("[Images attached …]") must split into image
    /// rows + the human's text bubble — the same parse MessageRow does.
    func testImageSendSplitsIntoImageAndBubbleRows() async {
        let actor = TimelineLayoutActor()
        let msg = message(0, text: "[Images attached — use the Read tool to view them]\n- /tmp/shots/shot-9.png\n\n看下这个截图哪里不对?", role: "user")
        let snapshot = await actor.buildSnapshot(input([msg]))
        let kinds = snapshot.rows.map(\.content.reuseKind)
        XCTAssertTrue(kinds.contains("image"), "image row missing: \(kinds)")
        XCTAssertTrue(kinds.contains("bubble"), "text bubble missing: \(kinds)")
        if case .userBubble(let text, _, _, _)? = snapshot.rows.first(where: { $0.content.reuseKind == "bubble" })?.content {
            XCTAssertEqual(text.string, "看下这个截图哪里不对?")
        }
    }

    // MARK: - Live window semantics in the actor pipeline

    /// Live head must be memoized: two builds with the same (quantized) head
    /// re-parse only the tail. Asserted via the head rows being identical
    /// object arrays (reference-equal NSAttributedStrings).
    func testLiveHeadMemoizedAcrossTicks() async {
        let actor = TimelineLayoutActor()
        // Long enough for LiveMarkdownWindow to produce a non-empty head:
        // the split needs windowLen > tailReserve + tailQuantum (10K UTF-16).
        let base = String(repeating: TranscriptFixtures.cjk + "\n\n", count: 150) // ~17K UTF-16
        let snap1 = await actor.buildSnapshot(input([], streaming: true, liveText: base))
        let snap2 = await actor.buildSnapshot(input([], streaming: true, liveText: base + "追加的一小段。"))
        func headTexts(_ s: TimelineSnapshot) -> [NSAttributedString] {
            s.rows.filter { $0.id.hasPrefix("live-head") }.compactMap {
                if case .text(let t) = $0.content { return t } else { return nil }
            }
        }
        let heads1 = headTexts(snap1)
        let heads2 = headTexts(snap2)
        XCTAssertFalse(heads1.isEmpty, "fixture must be long enough to produce a head")
        XCTAssertEqual(heads1.count, heads2.count)
        for (a, b) in zip(heads1, heads2) {
            XCTAssertTrue(a === b, "head rows must be memoized (reference-equal), not rebuilt per tick")
        }
    }

    /// Truncation chip must appear when the store reports a trimmed liveText.
    func testTruncationChipOnStoreTruncation() async {
        let actor = TimelineLayoutActor()
        var inp = input([], streaming: true, liveText: "short")
        inp.liveTextTruncated = true
        let snapshot = await actor.buildSnapshot(inp)
        XCTAssertTrue(snapshot.rows.contains { $0.id == "live-truncated" })
    }

    // MARK: - Actor memoization

    /// Unchanged messages must replay from the row cache: same input twice →
    /// reference-equal text content (no re-parse, no re-measure).
    func testUnchangedMessagesReplayFromCache() async {
        let actor = TimelineLayoutActor()
        let messages = (0..<50).map { message($0, text: "## 第 \($0) 轮\n\n" + TranscriptFixtures.cjk) }
        let snap1 = await actor.buildSnapshot(input(messages))
        let snap2 = await actor.buildSnapshot(input(messages))
        XCTAssertEqual(snap1.rows.count, snap2.rows.count)
        var compared = 0
        for (a, b) in zip(snap1.rows, snap2.rows) {
            if case .text(let ta) = a.content, case .text(let tb) = b.content {
                XCTAssertTrue(ta === tb, "row \(a.id) was rebuilt despite identical input")
                compared += 1
            }
        }
        XCTAssertGreaterThan(compared, 0)
    }

    // MARK: - Budgeter

    /// A giant snapshot must be split into multiple budgeted batches, each
    /// visible in the MainWork ledger; a small one applies in a single batch.
    func testBudgeterSplitsLargeApplyAndLedgersEveryBatch() {
        let budgeter = TimelineApplyBudgeter()
        let rows = (0..<1_000).map {
            TimelineRow(id: "r\($0)", revision: 0, content: .truncationChip, height: 20)
        }
        let snapshot = TimelineSnapshot(rows: rows, width: 393, generation: 1)
        var applied = 0
        var sawFinal = false
        let exp = expectation(description: "final slice")
        budgeter.apply(snapshot: snapshot) { slice, isFinal in
            applied += slice.count
            if isFinal { sawFinal = true; exp.fulfill() }
        }
        wait(for: [exp], timeout: 5)
        XCTAssertEqual(applied, 1_000, "every row must be applied exactly once (n=\(applied))")
        XCTAssertTrue(sawFinal)
        let batches = MainWork.recent(64).filter { $0.label == "timeline.apply" }
        XCTAssertGreaterThanOrEqual(batches.count, 2,
            "1000 rows must split into multiple ledgered batches (n=\(batches.count))")
        XCTAssertEqual(batches.reduce(0) { $0 + $1.count }, 1_000,
            "ledger must account for all rows")
    }

    /// A newer snapshot arriving mid-split abandons the stale one's remaining
    /// slices (latest wins — stale rows must never land after fresh ones).
    func testBudgeterLatestWinsAcrossGenerations() {
        let budgeter = TimelineApplyBudgeter()
        let bigRows = (0..<5_000).map {
            TimelineRow(id: "a\($0)", revision: 0, content: .truncationChip, height: 20)
        }
        let smallRows = (0..<10).map {
            TimelineRow(id: "b\($0)", revision: 0, content: .truncationChip, height: 20)
        }
        var staleAfterFresh = false
        var freshApplied = false
        budgeter.apply(snapshot: TimelineSnapshot(rows: bigRows, width: 393, generation: 1)) { slice, _ in
            if freshApplied, slice.first?.id.hasPrefix("a") == true { staleAfterFresh = true }
        }
        let exp = expectation(description: "fresh final")
        budgeter.apply(snapshot: TimelineSnapshot(rows: smallRows, width: 393, generation: 2)) { _, isFinal in
            freshApplied = true
            if isFinal { exp.fulfill() }
        }
        wait(for: [exp], timeout: 5)
        // Drain any lingering continuation tasks of the stale generation.
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        XCTAssertFalse(staleAfterFresh, "stale generation slices applied after the fresh snapshot")
    }
}
