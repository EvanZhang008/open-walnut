import SwiftUI
import XCTest
@testable import Walnut

/// How a transcript joins a box's words: after what is typed with one space in
/// a plain box, and at the caret of the rich note editor.
@MainActor
final class VoiceDictationTests: XCTestCase {
    // MARK: - Plain boxes (append)

    func testAppendToEmptyBoxIsJustTheWords() {
        XCTAssertEqual(VoiceDictationText.appending("hello world", to: ""), "hello world")
    }

    func testAppendJoinsWithOneSpace() {
        XCTAssertEqual(VoiceDictationText.appending("second", to: "first"), "first second")
    }

    func testAppendAfterTrailingWhitespaceAddsNoSecondSpace() {
        XCTAssertEqual(VoiceDictationText.appending("b", to: "a "), "a b")
        XCTAssertEqual(VoiceDictationText.appending("b", to: "a\n"), "a\nb")
    }

    func testAppendTrimsTheTranscript() {
        XCTAssertEqual(VoiceDictationText.appending("  spoken words \n", to: "typed"), "typed spoken words")
    }

    func testEmptyTranscriptInsertsNothing() {
        XCTAssertNil(VoiceDictationText.appending("", to: "typed"))
        XCTAssertNil(VoiceDictationText.appending(" \n\t", to: "typed"))
    }

    func testAppendKeepsMixedLanguageText() {
        // Mixed Chinese and English, as the server engine returns it.
        let words = "\u{4ECA}\u{5929} deploy \u{4E00}\u{4E0B}"
        XCTAssertEqual(VoiceDictationText.appending(words, to: "note:"), "note: " + words)
    }

    // MARK: - Caret insertion (pure)

    func testInsertionBetweenWordsGetsSpacesBothSides() {
        XCTAssertEqual(VoiceDictationText.insertion("new", before: "a", after: "b"), " new ")
    }

    func testInsertionAtStartAndEnd() {
        XCTAssertEqual(VoiceDictationText.insertion("new", before: nil, after: nil), "new")
        XCTAssertEqual(VoiceDictationText.insertion("new", before: nil, after: "b"), "new ")
        XCTAssertEqual(VoiceDictationText.insertion("new", before: "a", after: nil), " new")
    }

    func testInsertionNextToSpacesAndPunctuation() {
        XCTAssertEqual(VoiceDictationText.insertion("new", before: " ", after: " "), "new")
        XCTAssertEqual(VoiceDictationText.insertion("new", before: "\n", after: "."), "new")
        XCTAssertNil(VoiceDictationText.insertion("  ", before: "a", after: "b"))
    }

    // MARK: - Rich note editor

    private func makeEditor(_ text: NSAttributedString) -> (WysiwygEditor.Coordinator, UITextView) {
        let editor = WysiwygEditor(
            attributedText: .constant(text), isEditable: true, notePath: "test.md",
            onChange: {}, onCheckboxToggle: {}
        )
        let coordinator = WysiwygEditor.Coordinator(editor)
        let textView = UITextView()
        textView.attributedText = text
        return (coordinator, textView)
    }

    func testEditorInsertsAtTheCaretWithSpaces() {
        let (coordinator, textView) = makeEditor(NSAttributedString(
            string: "hello world", attributes: MarkdownAttributed.typingAttributes(for: .body)
        ))
        let caret = coordinator.insertDictation("big", in: textView, at: NSRange(location: 5, length: 0))
        XCTAssertEqual(textView.textStorage.string, "hello big world")
        XCTAssertEqual(caret.location, 9)
        XCTAssertEqual(textView.selectedRange, caret)
    }

    func testEditorKeepsASelectionAndInsertsAfterIt() {
        let (coordinator, textView) = makeEditor(NSAttributedString(string: "keep this"))
        let caret = coordinator.insertDictation("too", in: textView, at: NSRange(location: 0, length: 4))
        XCTAssertEqual(textView.textStorage.string, "keep too this")
        XCTAssertEqual(caret.location, 8)
    }

    func testEditorAfterACheckboxAddsNoSpace() {
        let line = NSMutableAttributedString(attachment: CheckboxAttachment(source: "- [ ] ", checked: false))
        let (coordinator, textView) = makeEditor(line)
        coordinator.insertDictation("buy milk", in: textView, at: NSRange(location: 1, length: 0))
        XCTAssertEqual(textView.textStorage.string, "\u{FFFC}buy milk")
        // The words are text, not part of the attachment.
        XCTAssertNil(textView.textStorage.attribute(.attachment, at: 1, effectiveRange: nil))
    }

    func testEditorClampsAStaleCaretToTheEnd() {
        let (coordinator, textView) = makeEditor(NSAttributedString(string: "short"))
        let caret = coordinator.insertDictation("end", in: textView, at: NSRange(location: 99, length: 0))
        XCTAssertEqual(textView.textStorage.string, "short end")
        XCTAssertEqual(caret.location, 9)
    }

    func testEditorKeepsASurrogatePairWhole() {
        let (coordinator, textView) = makeEditor(NSAttributedString(string: "\u{1F600}"))
        coordinator.insertDictation("ok", in: textView, at: NSRange(location: 2, length: 0))
        XCTAssertEqual(textView.textStorage.string, "\u{1F600} ok")
    }

    func testEditorIgnoresAnEmptyTranscript() {
        let (coordinator, textView) = makeEditor(NSAttributedString(string: "same"))
        let caret = coordinator.insertDictation("  ", in: textView, at: NSRange(location: 2, length: 0))
        XCTAssertEqual(textView.textStorage.string, "same")
        XCTAssertEqual(caret.location, 2)
    }

    func testBridgeHoldsTextUntilTheEditorAttaches() async throws {
        let bridge = EditorDictationBridge()
        bridge.insert("early words")
        // Nothing to insert into yet: kept, not dropped.
        XCTAssertNil(bridge.textView)
        let textView = WalnutTextView()
        let editor = WysiwygEditor(
            attributedText: .constant(NSAttributedString(string: "body")), isEditable: false, notePath: "t.md",
            onChange: {}, onCheckboxToggle: {}
        )
        let coordinator = WysiwygEditor.Coordinator(editor)
        textView.coordinator = coordinator
        textView.attributedText = NSAttributedString(string: "body")
        bridge.attach(textView)
        // Not inside attach (it runs during a view update): on the next turn.
        XCTAssertEqual(textView.textStorage.string, "body")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(textView.textStorage.string, "body early words")
    }
}
