import XCTest
@testable import Walnut

/// A `<br>` in model text renders as a line break on the phone, as it does in the
/// web console. 2026-10-09: a weekend plan table in the main chat showed its raw
/// pipe source, because one `<br>` in a cell routed the table into a web view
/// (`RichHTMLSegmentsTests.testLineBreakTagsStayOnTheNativePath`), and the native
/// parser, which now keeps it, showed the tag as text.
final class MarkdownLineBreakTests: XCTestCase {
    private let sep = MarkdownParser.lineSeparator

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
    }

    private func plain(_ text: AttributedString) -> String { String(text.characters) }
    private func inline(_ text: String) -> String { plain(MarkdownParser.inline(text)) }

    func testTableCellBreaksBecomeLines() {
        let blocks = MarkdownParser.parse("""
        | Time | Saturday |
        |---|---|
        | Morning | 10:00 call<br>10:30 **proxy** |
        | Evening | free |
        """)
        guard case .table(let header, let rows)? = blocks.first?.kind else {
            return XCTFail("expected a table, got \(blocks.map(\.kind))")
        }
        XCTAssertEqual(header.map(plain), ["Time", "Saturday"])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(plain(rows[0][1]), "10:00 call\(sep)10:30 proxy")
        XCTAssertEqual(rows.map { $0.map(MarkdownParser.explicitLineCount) }, [[1, 2], [1, 1]])
        // Emphasis after the break is still emphasis.
        let bold = rows[0][1].runs
            .filter { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
            .map { String(rows[0][1][$0.range].characters) }
        XCTAssertEqual(bold, ["proxy"])
    }

    func testEverySpellingAnHTMLParserReadsAsABreak() {
        for tag in ["<br>", "<br/>", "<br />", "<BR>", #"<br class="x">"#, "</br>", #"<br title="a>b">"#] {
            XCTAssertEqual(inline("a\(tag)b"), "a\(sep)b", tag)
        }
        XCTAssertEqual(inline("no tags at all"), "no tags at all")
    }

    /// What a browser shows as TEXT stays text: another element whose name starts
    /// with "br", a backslash-escaped tag, an entity, a `<br` that never closes.
    func testTextThatOnlyLooksLikeABreakStaysText() {
        XCTAssertEqual(inline("a <brx> b"), "a <brx> b")
        XCTAssertEqual(inline("a <br-note> b"), "a <br-note> b")
        XCTAssertEqual(inline(#"write \<br> for that"#), "write <br> for that")
        XCTAssertEqual(inline("write &lt;br&gt; for that"), "write <br> for that")
        XCTAssertEqual(inline("the <br tag isn't closed"), "the <br tag isn't closed")
    }

    /// A browser drops the spaces around a break, and a break that ends the block
    /// draws no empty line.
    func testSpacesAroundABreakAndATrailingBreakDrawNothing() {
        XCTAssertEqual(inline("one <br> two"), "one\(sep)two")
        XCTAssertEqual(inline("done<br>"), "done")
        XCTAssertEqual(inline("one<br><br>two"), "one\(sep)\(sep)two")
    }

    func testCodeSpansKeepTheTagAsWritten() {
        XCTAssertEqual(inline("write `<br/>` here<br>next"), "write <br/> here\(sep)next")
        XCTAssertEqual(inline("`a <br> b`"), "a <br> b")
        // A fence never reaches the inline pass at all.
        let blocks = MarkdownParser.parse("```html\na<br>b\n```")
        guard case .code(_, let code)? = blocks.first?.kind else {
            return XCTFail("expected a code block, got \(blocks.map(\.kind))")
        }
        XCTAssertEqual(code, "a<br>b")
    }

    /// A short reply skips the block parser, so the reply fast path breaks too. A
    /// user's own bubble does not: a `<br>` they typed is what they meant to show.
    func testParagraphsAndTheReplyFastPathBreakButUserTextDoesNot() {
        guard case .paragraph(let paragraph)? = MarkdownParser.parse("one<br>two").first?.kind else {
            return XCTFail("expected a paragraph")
        }
        XCTAssertEqual(plain(paragraph), "one\(sep)two")
        XCTAssertEqual(TimelineTextStyler.inlineText("one<br>two", lineBreakTags: true).string,
                       "one\(sep)two")
        XCTAssertEqual(TimelineTextStyler.inlineText("why does <br> fail?").string,
                       "why does <br> fail?")
    }
}
