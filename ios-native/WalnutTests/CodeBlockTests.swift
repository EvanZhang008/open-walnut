import XCTest
import UIKit
@testable import Walnut

/// Chat code blocks: language label, syntax colors, each block's own Wrap,
/// and heights that match what the cell draws (CodeHighlighter,
/// TimelineRowBuilder.codeRow, TimelineCodeCell).
@MainActor
final class CodeBlockTests: XCTestCase {

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        MainWork.resetForTesting()
    }

    /// `codeWrap`: wrap every block of `text` (by its key, as the Wrap button does).
    private func input(_ text: String, width: CGFloat = 393, codeWrap: Bool = false,
                       wrapped: Set<String> = [],
                       streaming: Bool = false, liveText: String = "") -> TimelineInput {
        var input = TimelineInput(
            messages: [ChatMessage(id: "m-1", role: "assistant", text: text, createdAt: "2026-08-08T06:00:00Z", kind: nil)],
            streaming: streaming, liveText: liveText, liveTextTruncated: false, activity: nil,
            showLoadEarlier: false, width: width, expandedRowIDs: [])
        input.wrappedCodeKeys = wrapped
        if codeWrap {
            // Keys of every fenced block in `text`, as the builder makes them.
            let blocks = MarkdownParser.parse(text, cache: .skip, clipOversized: false)
            for case .code(let code, let language) in TimelineTextStyler.pieces(from: blocks) {
                var trimmed = Substring(code)
                while trimmed.last == "\n" { trimmed = trimmed.dropLast() }
                input.wrappedCodeKeys.insert(CodeHighlighter.blockKey(code: String(trimmed), language: language))
            }
        }
        return input
    }

    private func codeBlocks(_ snapshot: TimelineSnapshot) -> [(TimelineRow, TimelineCodeBlock)] {
        snapshot.rows.compactMap { row in
            if case .code(let block) = row.content { return (row, block) }
            return nil
        }
    }

    // MARK: - Fence

    func testFenceLabels() {
        let cases: [(String?, String, Bool)] = [
            ("ts", "TypeScript", true), ("TypeScript", "TypeScript", true), ("swift", "Swift", true),
            ("zsh", "Shell", true), ("py", "Python", true), ("json", "JSON", true), ("yml", "YAML", true),
            ("src/app.py", "src/app.py", true), ("text", "Text", false), (nil, "Text", false), ("", "Text", false),
            ("mermaid", "mermaid", false), ("{.python}", "Python", true), ("ts:src/a.ts", "TypeScript", true),
        ]
        for (info, label, colored) in cases {
            let fence = CodeHighlighter.fence(info)
            XCTAssertEqual(fence.label, label, "label for \(info ?? "nil")")
            XCTAssertEqual(fence.grammar != nil, colored, "grammar for \(info ?? "nil")")
        }
    }

    // MARK: - Colors

    private func color(of word: String, in s: NSAttributedString) -> UIColor? {
        let r = (s.string as NSString).range(of: word)
        guard r.location != NSNotFound else { return nil }
        return s.attribute(.foregroundColor, at: r.location, effectiveRange: nil) as? UIColor
    }

    func testColorsKeywordsStringsCommentsAndKeepsText() {
        let code = "import Foundation\n// note: \"not a string\"\nlet name = \"walnut\" // trailing\nfunc greet(_ n: Int) -> String { return \"hi\" }"
        let font = TimelineTextStyler.codeFont
        let out = CodeHighlighter.attributed(code, grammar: CodeHighlighter.fence("swift").grammar, font: font)
        XCTAssertEqual(out.string, code, "coloring never changes the text")
        XCTAssertEqual(color(of: "import", in: out), CodeHighlighter.keywordColor)
        XCTAssertEqual(color(of: "\"walnut\"", in: out), CodeHighlighter.stringColor)
        XCTAssertEqual(color(of: "// note", in: out), CodeHighlighter.commentColor)
        // A quote inside a comment is the comment's, not a string's.
        XCTAssertEqual(color(of: "\"not a string\"", in: out), CodeHighlighter.commentColor)
        XCTAssertEqual(color(of: "greet", in: out), CodeHighlighter.functionColor)
        XCTAssertEqual(color(of: "name", in: out), UIColor.label)
    }

    func testShellPythonJsonDiff() {
        let font = TimelineTextStyler.codeFont
        let sh = CodeHighlighter.attributed("export PATH=$HOME/bin # add\necho \"done\"", grammar: CodeHighlighter.fence("bash").grammar, font: font)
        XCTAssertEqual(color(of: "export", in: sh), CodeHighlighter.keywordColor)
        XCTAssertEqual(color(of: "$HOME", in: sh), CodeHighlighter.variableColor)
        XCTAssertEqual(color(of: "# add", in: sh), CodeHighlighter.commentColor)
        let py = CodeHighlighter.attributed("def f(x):\n    return x  # same\ns = 'a#b'", grammar: CodeHighlighter.fence("python").grammar, font: font)
        XCTAssertEqual(color(of: "def", in: py), CodeHighlighter.keywordColor)
        XCTAssertEqual(color(of: "'a#b'", in: py), CodeHighlighter.stringColor, "a # inside a string is not a comment")
        let json = CodeHighlighter.attributed("{\"k\": \"v\", \"n\": 3, \"ok\": true}", grammar: CodeHighlighter.fence("json").grammar, font: font)
        XCTAssertEqual(color(of: "\"k\"", in: json), CodeHighlighter.tagColor)
        XCTAssertEqual(color(of: "\"v\"", in: json), CodeHighlighter.stringColor)
        XCTAssertEqual(color(of: "true", in: json), CodeHighlighter.numberColor)
        let diff = CodeHighlighter.attributed("@@ -1 +1 @@\n-old\n+new\n same", grammar: CodeHighlighter.fence("diff").grammar, font: font)
        XCTAssertEqual(color(of: "-old", in: diff), CodeHighlighter.keywordColor)
        XCTAssertEqual(color(of: "+new", in: diff), CodeHighlighter.tagColor)
    }

    func testOverLongBlockStaysPlain() {
        let code = String(repeating: "let a = 1\n", count: CodeHighlighter.maxHighlightLength / 10 + 10)
        let out = CodeHighlighter.attributed(code, grammar: CodeHighlighter.fence("swift").grammar, font: TimelineTextStyler.codeFont)
        XCTAssertEqual(color(of: "let", in: out), UIColor.label)
    }

    // MARK: - Rows

    func testCodeRowCarriesLabelTextAndHeaderHeight() async {
        let actor = TimelineLayoutActor()
        let snapshot = await actor.buildSnapshot(input("Run:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone."))
        let blocks = codeBlocks(snapshot)
        XCTAssertEqual(blocks.count, 1)
        let (row, block) = blocks[0]
        XCTAssertEqual(block.label, "TypeScript")
        XCTAssertEqual(block.text, "const a = 1;\nconst b = 2;")
        XCTAssertFalse(block.wrapped)
        XCTAssertEqual(row.height, TimelineMetrics.codeHeaderHeight + block.contentSize.height
                       + TimelineMetrics.codePadding * 2 + TimelineMetrics.codeVMargin * 2, accuracy: 0.5)
    }

    func testWrapMakesAWideBlockTallerAndFitsTheCard() async {
        let wide = "curl -sS -X POST \"https://api.example.com/v1/projects/marina/deployments?wait=true&timeout=600\" -H \"Content-Type: application/json\""
        let text = "```bash\n\(wide)\n```"
        let actor = TimelineLayoutActor()
        let plain = codeBlocks(await actor.buildSnapshot(input(text)))[0]
        // The memo must drop on the preference: same message, other shape.
        let wrapped = codeBlocks(await actor.buildSnapshot(input(text, codeWrap: true)))[0]
        XCTAssertFalse(plain.1.wrapped)
        XCTAssertTrue(wrapped.1.wrapped)
        XCTAssertGreaterThan(plain.1.contentSize.width, TimelineMetrics.codeTextWidth(393))
        XCTAssertLessThanOrEqual(wrapped.1.contentSize.width, TimelineMetrics.codeTextWidth(393))
        XCTAssertGreaterThan(wrapped.0.height, plain.0.height)
        // Back off: the unwrapped shape again.
        let again = codeBlocks(await actor.buildSnapshot(input(text)))[0]
        XCTAssertEqual(again.0.height, plain.0.height, accuracy: 0.5)
    }

    /// Height parity for wrapped code: the builder's TextKit measurement equals
    /// what the cell's text view lays out at the same width.
    func testWrappedHeightMatchesRenderedHeight() async {
        let code = (0..<12).map { "let value\($0) = compute(input: \"\(String(repeating: "x", count: $0 * 9))\")" }.joined(separator: "\n")
        let actor = TimelineLayoutActor()
        let (_, block) = codeBlocks(await actor.buildSnapshot(input("```swift\n\(code)\n```", codeWrap: true)))[0]
        let tv = TimelineTextView()
        tv.attributedText = block.attributed
        let rendered = tv.sizeThatFits(CGSize(width: block.contentSize.width, height: .greatestFiniteMagnitude)).height
        XCTAssertEqual(block.contentSize.height, ceil(rendered), accuracy: 2.0)
    }

    /// The same parity unwrapped: every line drawn, none clipped or wrapped.
    func testUnwrappedHeightMatchesRenderedHeight() async {
        let code = (0..<9).map { "let item\($0) = [\(String(repeating: "\"v\", ", count: $0 * 3))]" }.joined(separator: "\n")
        let actor = TimelineLayoutActor()
        let (_, block) = codeBlocks(await actor.buildSnapshot(input("```swift\n\(code)\n```")))[0]
        let tv = TimelineTextView()
        tv.attributedText = block.attributed
        let fit = tv.sizeThatFits(CGSize(width: block.contentSize.width + TimelineMetrics.codeUnwrappedSlack,
                                         height: .greatestFiniteMagnitude))
        XCTAssertEqual(block.contentSize.height, ceil(fit.height), accuracy: 2.0)
        let lines = tv.sizeThatFits(CGSize(width: CGFloat(10_000), height: CGFloat.greatestFiniteMagnitude)).height
        XCTAssertEqual(fit.height, lines, accuracy: 1.0, "no line wraps at the measured width")
    }

    func testStreamingBlockIsFramedAndColoredAsItGrows() async {
        let actor = TimelineLayoutActor()
        var live = "Writing:\n\n```swift\n"
        for i in 0..<40 {
            live += "let step\(i) = \(i)\n"
            let snapshot = await actor.buildSnapshot(input("Earlier reply.", streaming: true, liveText: live))
            guard let (_, block) = codeBlocks(snapshot).last else { return XCTFail("no code row at tick \(i)") }
            XCTAssertEqual(block.label, "Swift")
            XCTAssertTrue(block.text.hasSuffix("let step\(i) = \(i)"))
            XCTAssertEqual(color(of: "let", in: block.attributed), CodeHighlighter.keywordColor)
        }
    }

    /// A long block's header follows the visible top down the card (Copy stays
    /// in reach mid-block) and stops at the card's end, leaving with the block.
    func testHeaderPinsToTheVisibleTopWithinTheCard() async {
        let code = (0..<80).map { "let row\($0) = \($0)" }.joined(separator: "\n")
        let actor = TimelineLayoutActor()
        let (row, block) = codeBlocks(await actor.buildSnapshot(input("```swift\n\(code)\n```")))[0]
        let cell = TimelineCodeCell(frame: CGRect(x: 0, y: 0, width: 393, height: row.height))
        cell.configure(block, delegate: nil)
        cell.layoutIfNeeded()
        XCTAssertEqual(cell.headerOffset, 0)
        cell.pinHeader(visibleTop: 300)
        XCTAssertEqual(cell.headerOffset, 300 - TimelineMetrics.codeVMargin, accuracy: 0.5)
        let cardHeight = row.height - TimelineMetrics.codeVMargin * 2
        cell.pinHeader(visibleTop: row.height + 500)
        XCTAssertEqual(cell.headerOffset, cardHeight - TimelineMetrics.codeHeaderHeight, accuracy: 0.5)
        cell.pinHeader(visibleTop: -40)
        XCTAssertEqual(cell.headerOffset, 0)
        // A relayout keeps the pin; reuse drops it.
        cell.pinHeader(visibleTop: 200)
        cell.setNeedsLayout()
        cell.layoutIfNeeded()
        XCTAssertEqual(cell.headerOffset, 200 - TimelineMetrics.codeVMargin, accuracy: 0.5)
        cell.prepareForReuse()
        cell.setNeedsLayout()
        cell.layoutIfNeeded()
        XCTAssertEqual(cell.headerOffset, 0)
    }

    /// Wrapped, each line's continuation is indented past the line's own indent.
    func testWrappedLinesHangDeeperThanTheirIndent() async {
        let code = "func f() {\n    let value = \(String(repeating: "compute(x) + ", count: 12))1\n}"
        let actor = TimelineLayoutActor()
        let plain = codeBlocks(await actor.buildSnapshot(input("```swift\n\(code)\n```")))[0].1
        let (_, block) = codeBlocks(await actor.buildSnapshot(input("```swift\n\(code)\n```", codeWrap: true)))[0]
        XCTAssertEqual(block.attributed.string, plain.attributed.string, "the text is unchanged")
        XCTAssertNil(plain.attributed.attribute(.paragraphStyle, at: 0, effectiveRange: nil), "unwrapped: no indents")
        let ns = block.attributed.string as NSString
        let column = (" " as NSString).size(withAttributes: [.font: TimelineTextStyler.codeFont]).width
        let first = block.attributed.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        let second = block.attributed.attribute(.paragraphStyle, at: ns.range(of: "let value").location, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertEqual(first?.headIndent ?? 0, 2 * column, accuracy: 0.5)
        XCTAssertEqual(second?.headIndent ?? 0, 6 * column, accuracy: 0.5)
        XCTAssertEqual(second?.firstLineHeadIndent ?? -1, 0)
    }

    /// A block whose lines all fit has nothing to wrap: its cell shows no Wrap.
    func testABlockWithNoLongLineHasNothingToWrap() async {
        let actor = TimelineLayoutActor()
        let text = "```sh\nmake test\n```\n\n```sh\n\(String(repeating: "make test ", count: 30))\n```"
        let blocks = codeBlocks(await actor.buildSnapshot(input(text)))
        XCTAssertTrue(blocks[0].1.fits)
        XCTAssertFalse(blocks[1].1.fits)
        let cell = TimelineCodeCell(frame: CGRect(x: 0, y: 0, width: 393, height: blocks[0].0.height))
        cell.configure(blocks[0].1, delegate: nil)
        XCTAssertNil(cell.contentView.firstVisible(identifier: "timeline.code.wrap"))
        cell.configure(blocks[1].1, delegate: nil)
        XCTAssertNotNil(cell.contentView.firstVisible(identifier: "timeline.code.wrap"))
    }

    /// Wrap is per block: wrapping one leaves the others, rebuilds only what
    /// drew it, and the key holds while the block streams in.
    func testWrapIsPerBlockAndHoldsWhileStreaming() async {
        let wide = String(repeating: "export PATH=$HOME/bin:$PATH ", count: 8)
        let text = "```bash\n\(wide)\n```\n\nand\n\n```python\nprint('\(String(repeating: "x", count: 200))')\n```"
        let actor = TimelineLayoutActor()
        let plain = codeBlocks(await actor.buildSnapshot(input(text)))
        XCTAssertEqual(plain.count, 2)
        XCTAssertNotEqual(plain[0].1.key, plain[1].1.key)
        let one = codeBlocks(await actor.buildSnapshot(input(text, wrapped: [plain[0].1.key])))
        XCTAssertTrue(one[0].1.wrapped)
        XCTAssertFalse(one[1].1.wrapped, "the other block keeps its own state")
        XCTAssertNotEqual(one[0].0.revision, plain[0].0.revision, "a flip reloads its cell")
        XCTAssertEqual(one[1].0.height, plain[1].0.height, accuracy: 0.5)
        // A block still streaming keeps its key, so a wrap set mid-stream holds.
        var live = "Writing:\n\n```swift\nlet first = 0\n"
        let key = codeBlocks(await actor.buildSnapshot(input("Earlier.", streaming: true, liveText: live))).last!.1.key
        for i in 0..<10 {
            live += "let step\(i) = \(String(repeating: "value", count: 30))\n"
            let block = codeBlocks(await actor.buildSnapshot(input("Earlier.", wrapped: [key], streaming: true, liveText: live))).last!.1
            XCTAssertEqual(block.key, key)
            XCTAssertTrue(block.wrapped, "tick \(i)")
        }
    }
}

private extension UIView {
    /// The first view with that accessibility identifier that is not hidden.
    func firstVisible(identifier: String) -> UIView? {
        if accessibilityIdentifier == identifier && !isHidden { return self }
        for sub in subviews { if let hit = sub.firstVisible(identifier: identifier) { return hit } }
        return nil
    }
}
