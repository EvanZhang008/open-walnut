import XCTest
@testable import Walnut

/// 2026-08-23 dogfood R13: the server's entity-pill markup
/// (`<task-ref id="…" label="…"/>`) rendered as raw XML in chat bubbles.
final class MarkdownEntityRefTests: XCTestCase {
    func testTaskRefBecomesBoldLabel() {
        let input = #"已创建: <task-ref id="mt5zagj8-3621" label="Watch NVDA Q2 FY2027 earnings"/>(Stock Analyzer 项目)。"#
        let out = MarkdownParser.replaceEntityRefs(input)
        XCTAssertEqual(out, "已创建: **Watch NVDA Q2 FY2027 earnings**(Stock Analyzer 项目)。")
    }

    func testSessionRefAndMissingLabelFallsBackToId() {
        XCTAssertEqual(
            MarkdownParser.replaceEntityRefs(#"see <session-ref id="abc-123"/> for details"#),
            "see **abc-123** for details"
        )
    }

    func testMultipleRefsAndNoRefPassthrough() {
        let two = #"<task-ref id="a" label="First"/> then <task-ref id="b" label="Second"/>"#
        XCTAssertEqual(MarkdownParser.replaceEntityRefs(two), "**First** then **Second**")
        // No-ref text must come back untouched (same instance semantics).
        let plain = "ordinary **markdown** stays as-is <u>too</u>"
        XCTAssertEqual(MarkdownParser.replaceEntityRefs(plain), plain)
    }

    func testUnclosedOrEmptyRefIsLeftAlone() {
        // A ref with neither id nor label has no honest rendering — leave the
        // raw text rather than silently deleting content.
        let empty = #"<task-ref foo="bar"/>"#
        XCTAssertEqual(MarkdownParser.replaceEntityRefs(empty), empty)
    }
}
