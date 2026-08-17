import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// List indent / outdent — the format drawer's arrows, the swipe gesture, and
/// the markdown round trip they must produce.
///
/// The whole point of the feature is that an indent SURVIVES a save: the marker
/// source gains two leading spaces, the serializer re-emits them, and a re-parse
/// of that markdown recreates the same visual indent. Each test below pins one
/// link of that chain, because the original implementation broke several at once
/// (indent applied to the storage but the paragraph style / serialized source
/// disagreed, so the arrows looked like no-ops).
@MainActor
final class ListIndentTests: XCTestCase {
    private func makeEditor() -> (WysiwygEditor.Coordinator, WalnutTextView) {
        var text = NSAttributedString()
        let editor = WysiwygEditor(
            attributedText: Binding(get: { text }, set: { text = $0 }),
            isEditable: true, notePath: "indent-test.md",
            onChange: {}, onCheckboxToggle: {}
        )
        let coordinator = editor.makeCoordinator()
        let textView = WalnutTextView()
        textView.coordinator = coordinator
        return (coordinator, textView)
    }

    private func load(_ markdown: String) -> (WysiwygEditor.Coordinator, WalnutTextView) {
        let (coordinator, textView) = makeEditor()
        let parsed = MarkdownAttributed.parse(markdown, maxImageWidth: 300)
        textView.attributedText = parsed.attributed
        return (coordinator, textView)
    }

    private func serialize(_ textView: UITextView) -> String {
        MarkdownSerializer.serialize(frontmatter: nil, attributed: textView.attributedText)
    }

    /// Caret index of the first character on line `line` (0-based).
    private func caret(_ textView: UITextView, line: Int) -> Int {
        let ns = textView.textStorage.string as NSString
        var index = 0
        var seen = 0
        while seen < line, index < ns.length {
            if ns.character(at: index) == 10 { seen += 1 }
            index += 1
        }
        return index
    }

    // MARK: - Bullets

    func testIndentBulletWritesTwoSpacesToMarkdown() {
        let (coordinator, textView) = load("- alpha\n- beta")
        textView.selectedRange = NSRange(location: caret(textView, line: 1) + 1, length: 0)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "- alpha\n  - beta",
                       "indent must add two leading spaces to the bullet's own marker source")
    }

    func testIndentBulletFromLineStartCaret() {
        // Caret sitting exactly ON the bullet attachment (index 0 of the line)
        // is the common case right after tapping the row — it must still work.
        let (coordinator, textView) = load("- alpha")
        textView.selectedRange = NSRange(location: 0, length: 0)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "  - alpha")
    }

    func testOutdentBulletRemovesTwoSpaces() {
        let (coordinator, textView) = load("- alpha\n    - deep")
        textView.selectedRange = NSRange(location: caret(textView, line: 1) + 2, length: 0)
        coordinator.adjustIndent(-1, in: textView)
        XCTAssertEqual(serialize(textView), "- alpha\n  - deep")
    }

    func testOutdentAtZeroIndentIsNoOp() {
        let (coordinator, textView) = load("- alpha")
        textView.selectedRange = NSRange(location: 1, length: 0)
        coordinator.adjustIndent(-1, in: textView)
        XCTAssertEqual(serialize(textView), "- alpha", "already flush left — nothing to remove")
    }

    /// The indent must be visible, not just serialized: the paragraph style's
    /// head indents move by one level per two source spaces.
    func testIndentBulletMovesParagraphStyle() {
        let (coordinator, textView) = load("- alpha")
        textView.selectedRange = NSRange(location: 1, length: 0)
        let before = (textView.textStorage.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.firstLineHeadIndent ?? -1
        coordinator.adjustIndent(1, in: textView)
        let after = (textView.textStorage.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.firstLineHeadIndent ?? -1
        XCTAssertEqual(before, 0, accuracy: 0.01)
        XCTAssertEqual(after, 16, accuracy: 0.01, "one indent level = 16pt firstLineHeadIndent")
    }

    /// Round trip: indent → serialize → re-parse must reproduce the same
    /// paragraph style. A marker source that the parser can't read back turns
    /// the arrows into a save-and-lose-it operation.
    func testIndentRoundTripsThroughParser() {
        let (coordinator, textView) = load("- alpha")
        textView.selectedRange = NSRange(location: 1, length: 0)
        coordinator.adjustIndent(2, in: textView)
        let markdown = serialize(textView)
        XCTAssertEqual(markdown, "    - alpha")
        let reparsed = MarkdownAttributed.parse(markdown, maxImageWidth: 300).attributed
        let style = reparsed.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertEqual(style?.firstLineHeadIndent ?? -1, 32, accuracy: 0.01,
                       "two indent levels must survive the markdown round trip")
    }

    // MARK: - Numbered

    func testIndentNumberedLine() {
        let (coordinator, textView) = load("1. first\n2. second")
        textView.selectedRange = NSRange(location: caret(textView, line: 1) + 3, length: 0)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "1. first\n  2. second")
    }

    func testOutdentNumberedLine() {
        let (coordinator, textView) = load("  1. nested")
        textView.selectedRange = NSRange(location: 5, length: 0)
        coordinator.adjustIndent(-1, in: textView)
        XCTAssertEqual(serialize(textView), "1. nested")
    }

    /// A numbered line's leading spaces are REAL characters in the storage, so
    /// the caret has to move with them or the next keystroke lands inside the
    /// marker.
    func testNumberedIndentKeepsCaretOnItsCharacter() {
        let (coordinator, textView) = load("1. first")
        textView.selectedRange = NSRange(location: 3, length: 0) // just before "first"
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(textView.selectedRange.location, 5,
                       "caret must shift by the two inserted spaces")
    }

    // MARK: - Tasks

    func testIndentTaskLine() {
        let (coordinator, textView) = load("- [ ] todo")
        textView.selectedRange = NSRange(location: 1, length: 0)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "  - [ ] todo")
    }

    func testIndentTaskPreservesCheckedState() {
        let (coordinator, textView) = load("- [x] done")
        textView.selectedRange = NSRange(location: 1, length: 0)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "  - [x] done", "indent must not uncheck the box")
    }

    // MARK: - Non-list lines

    func testIndentIsNoOpOnBodyLine() {
        let (coordinator, textView) = load("just a paragraph")
        textView.selectedRange = NSRange(location: 4, length: 0)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "just a paragraph")
    }

    func testIndentIsNoOpOnHeading() {
        let (coordinator, textView) = load("## Heading")
        textView.selectedRange = NSRange(location: 2, length: 0)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "## Heading")
    }

    // MARK: - Multi-line selection

    /// A selection spanning several list rows indents EVERY row it touches —
    /// Apple Notes behavior, and what "select the list, press indent" means.
    func testIndentAppliesToEveryLineInSelection() {
        let (coordinator, textView) = load("- one\n- two\n- three")
        let start = caret(textView, line: 0)
        let end = caret(textView, line: 2) + 3
        textView.selectedRange = NSRange(location: start, length: end - start)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "  - one\n  - two\n  - three")
    }

    func testOutdentSelectionSkipsAlreadyFlushLines() {
        let (coordinator, textView) = load("- one\n  - two")
        textView.selectedRange = NSRange(location: 0, length: textView.textStorage.length)
        coordinator.adjustIndent(-1, in: textView)
        XCTAssertEqual(serialize(textView), "- one\n- two",
                       "a flush-left row stays put while its nested sibling comes out one level")
    }

    /// Mixed selections must indent the list rows and leave prose alone.
    func testSelectionIndentIgnoresNonListLines() {
        let (coordinator, textView) = load("- one\nprose\n- two")
        textView.selectedRange = NSRange(location: 0, length: textView.textStorage.length)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "  - one\nprose\n  - two")
    }

    // MARK: - Odd / tab / runaway indents

    /// A 3-space indent (Obsidian and hand editing both produce these) is one
    /// level plus a stray space. Indenting must snap to whole levels, or the row
    /// drifts a half-step further out of alignment on every press.
    func testOddIndentSnapsToWholeLevels() {
        let (coordinator, textView) = load("   - odd")
        textView.selectedRange = NSRange(location: 1, length: 0)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "    - odd", "3 spaces = level 1 → indent to level 2")
    }

    func testOddIndentOutdentsToFlushLeft() {
        let (coordinator, textView) = load("   - odd")
        textView.selectedRange = NSRange(location: 1, length: 0)
        coordinator.adjustIndent(-1, in: textView)
        XCTAssertEqual(serialize(textView), "- odd")
    }

    /// A tab-indented list (Apple Notes and some Obsidian setups write tabs) is
    /// one level per tab, normalized to spaces on the way out.
    func testTabIndentCountsAsOneLevel() {
        let (coordinator, textView) = load("\t- tabbed")
        textView.selectedRange = NSRange(location: 1, length: 0)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "    - tabbed", "tab = level 1 → level 2 as spaces")
    }

    func testTabIndentedNumberedLineNormalizes() {
        let (coordinator, textView) = load("\t1. tabbed")
        textView.selectedRange = NSRange(location: 4, length: 0)
        coordinator.adjustIndent(1, in: textView)
        XCTAssertEqual(serialize(textView), "    1. tabbed")
    }

    /// A held swipe must not walk the marker off the screen.
    func testIndentStopsAtMaxLevel() {
        let (coordinator, textView) = load("- deep")
        textView.selectedRange = NSRange(location: 1, length: 0)
        for _ in 0..<(WysiwygEditor.Coordinator.maxIndentLevel + 5) {
            coordinator.adjustIndent(1, in: textView)
        }
        let expected = String(repeating: " ", count: WysiwygEditor.Coordinator.maxIndentLevel * 2) + "- deep"
        XCTAssertEqual(serialize(textView), expected)
    }

    // MARK: - Swipe gesture eligibility (pure decision function)

    func testSwipeEligibleOnlyOnListLines() {
        let (coordinator, textView) = load("- bullet\nprose\n1. numbered\n- [ ] task\n## head")
        for (line, expected) in [(0, true), (1, false), (2, true), (3, true), (4, false)] {
            textView.selectedRange = NSRange(location: caret(textView, line: line), length: 0)
            XCTAssertEqual(coordinator.canAdjustIndent(in: textView), expected,
                           "line \(line) swipe-eligibility")
        }
    }

    func testSwipeEligibleWhenSelectionTouchesAnyListLine() {
        let (coordinator, textView) = load("prose\n- bullet")
        textView.selectedRange = NSRange(location: 0, length: textView.textStorage.length)
        XCTAssertTrue(coordinator.canAdjustIndent(in: textView),
                      "a multi-line selection containing one list row is swipe-eligible")
    }

    func testSwipeIneligibleOnEmptyDocument() {
        let (coordinator, textView) = makeEditor()
        XCTAssertFalse(coordinator.canAdjustIndent(in: textView))
    }
}
