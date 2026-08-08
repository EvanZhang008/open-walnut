import XCTest
@testable import Walnut

/// Invariants of the bounded streaming render window (the 0x8BADF00D
/// watchdog-kill fix). If any of these break, the live turn either renders
/// garbage (a fence split in half) or silently drops/duplicates text.
final class LiveMarkdownWindowTests: XCTestCase {

    private func headFenceCount(_ head: String) -> Int {
        head.components(separatedBy: "\n").filter { $0.hasPrefix("```") }.count
    }

    func testShortTextPassesThroughUnchanged() {
        let short = "hello **world**\n\nnext para"
        let seg = LiveMarkdownWindow.segments(short)
        XCTAssertTrue(seg.head.isEmpty, "no head split below tailReserve+tailQuantum")
        XCTAssertEqual(seg.tail, short)
        XCTAssertFalse(seg.omittedPrefix)
    }

    /// head+tail must always reconstruct a SUFFIX of the original text — the
    /// window may drop an old prefix but must never reorder, drop mid-text, or
    /// duplicate. Checked across a growing reply like a real streaming turn.
    func testWindowIsAlwaysASuffixOfTheText() {
        let unit = "段落内容,含**加粗**与表格标记。\n\n```swift\nlet x = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n"
        var text = ""
        for i in 0..<3000 {
            text += unit
            guard i % 250 == 0 else { continue }
            let seg = LiveMarkdownWindow.segments(text)
            let window = seg.head + seg.tail
            XCTAssertTrue(text.hasSuffix(window),
                          "window must be a suffix at len \(text.utf16.count)")
            XCTAssertEqual(
                headFenceCount(seg.head) % 2, 0,
                "even fence count in head at len \(text.utf16.count)"
            )
        }
    }

    func testOmittedPrefixSetOnlyPastWindowMax() {
        let para = "一段普通的分析文字,用来填充窗口。\n\n"
        var text = ""
        while text.utf16.count <= LiveMarkdownWindow.windowMax {
            let seg = LiveMarkdownWindow.segments(text)
            XCTAssertFalse(seg.omittedPrefix, "no omission below windowMax (len \(text.utf16.count))")
            text += para
        }
        // Now past windowMax: prefix must be dropped and flagged.
        let seg = LiveMarkdownWindow.segments(text)
        XCTAssertTrue(seg.omittedPrefix, "omitted flag set past windowMax")
        XCTAssertLessThan((seg.head + seg.tail).utf16.count, text.utf16.count)
    }

    /// Pathological input: one giant code fence larger than the whole window.
    /// The quantized split must NOT land inside it — half a fence renders as
    /// garbage. safeBoundary is expected to give up and put it all in tail.
    func testGiantSingleFenceIsNeverSplit() {
        let giant = "```\n" + String(repeating: "line of code\n", count: 8000) + "```\n\n tail para"
        let seg = LiveMarkdownWindow.segments(giant)
        XCTAssertEqual(headFenceCount(seg.head) % 2, 0,
                       "giant fence must not be split (head fences \(headFenceCount(seg.head)))")
    }

    /// The whole point of the quantized boundary: while the reply grows within
    /// one tailQuantum, head must stay byte-identical so EquatableView + the
    /// parse cache skip it. A head that churns every tick reintroduces the
    /// O(reply)-per-tick bug with extra steps.
    func testHeadIsStableWithinAQuantum() {
        let para = "增量输出的一段文字,模拟流式回复。\n\n"
        var text = ""
        while text.utf16.count < 100_000 { text += para }
        let base = LiveMarkdownWindow.segments(text)
        // Grow by much less than tailQuantum: head must not move.
        let grown = LiveMarkdownWindow.segments(text + "追加")
        XCTAssertEqual(base.head, grown.head, "head must be stable within a tailQuantum of growth")
    }
}
