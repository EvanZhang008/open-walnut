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

    // MARK: - A table cell's mic (EditorDictationBridge.micTapped(in:))

    /// Counts the event the table editor reads its cells on, as it does for typing.
    private final class EditingChangedCounter: NSObject {
        var count = 0
        @objc func changed() { count += 1 }
    }

    private struct TableScene {
        let window: UIWindow
        let textView: WalnutTextView
        /// Held here: the text view keeps its coordinator weakly.
        let coordinator: WysiwygEditor.Coordinator
        let editor: TableInlineEditor
        let bridge: EditorDictationBridge
        let cell: UITextField
    }

    /// A note holding one real table, in a window, with its in-place editor open and the note's
    /// bridge attached; `cell` is the first body cell (row 1, column 0), seeded with "a1".
    private func makeTableScene(onCommit: @escaping (EditableTable?) -> Void = { _ in }) throws -> TableScene {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let textView = WalnutTextView(frame: window.bounds, textContainer: nil)
        window.addSubview(textView)
        window.isHidden = false
        let editorModel = WysiwygEditor(
            attributedText: .constant(NSAttributedString()), isEditable: true, notePath: "t.md",
            onChange: {}, onCheckboxToggle: {}
        )
        let coordinator = WysiwygEditor.Coordinator(editorModel)
        textView.coordinator = coordinator
        let table = EditableTable(header: ["Name", "Note"], rows: [["a1", "b1"], ["a2", "b2"]])
        let attachment = TableAttachment(table: table, maxWidth: 340)
        let text = NSMutableAttributedString(attachment: attachment)
        text.append(NSAttributedString(string: "\nnote end", attributes: MarkdownAttributed.typingAttributes(for: .body)))
        textView.attributedText = text
        let bridge = EditorDictationBridge()
        bridge.attach(textView)
        let editor = TableInlineEditor(
            attachment: attachment, charIndex: 0, in: textView, dictation: bridge,
            onLiveResize: { _ in }, onCommit: onCommit
        )
        textView.addSubview(editor)
        let cell = try XCTUnwrap(Self.field("table.cell.1.0", in: editor), "the editor has its body cells")
        XCTAssertEqual(cell.text, "a1")
        return TableScene(
            window: window, textView: textView, coordinator: coordinator, editor: editor, bridge: bridge, cell: cell
        )
    }

    private static func field(_ identifier: String, in view: UIView) -> UITextField? {
        if let match = view as? UITextField, match.accessibilityIdentifier == identifier { return match }
        for sub in view.subviews { if let found = field(identifier, in: sub) { return found } }
        return nil
    }

    func testEveryCellOffersTheNotesMicOnItsKeyboardBar() throws {
        let scene = try makeTableScene()
        let bar = try XCTUnwrap(scene.cell.inputAccessoryView as? UIToolbar, "a cell's keyboard carries the mic bar")
        XCTAssertTrue(bar.items?.contains { $0.accessibilityIdentifier == "voice-mic.table-cell" } == true)
        let other = try XCTUnwrap(Self.field("table.cell.2.1", in: scene.editor))
        XCTAssertTrue(other.inputAccessoryView === bar, "one bar for every cell")
    }

    func testACellsTakeLandsAtTheEndOfThatCellAndUpdatesTheTable() throws {
        var committed: EditableTable?
        let scene = try makeTableScene(onCommit: { committed = $0 })
        let counter = EditingChangedCounter()
        scene.cell.addTarget(counter, action: #selector(EditingChangedCounter.changed), for: .editingChanged)
        var starts = 0
        scene.bridge.onMicTap = { starts += 1 }

        scene.bridge.micTapped(in: scene.cell)
        XCTAssertEqual(starts, 1, "the cell's mic starts the note's own take")
        scene.bridge.insert("  spoken words ")

        XCTAssertEqual(scene.cell.text, "a1 spoken words", "after what is in the cell, one space, trimmed")
        XCTAssertEqual(counter.count, 1, "the cell sends the event the table editor reads, as typing does")
        XCTAssertEqual(scene.textView.textStorage.string, "\u{FFFC}\nnote end", "the note's own text is untouched")
        // The take was spoken into the cell: never into a neighbour.
        XCTAssertEqual(Self.field("table.cell.1.1", in: scene.editor)?.text, "b1")

        scene.editor.commit()
        XCTAssertEqual(committed?.rows.first, ["a1 spoken words", "b1"], "the finished table keeps the words")
        XCTAssertEqual(committed?.header, ["Name", "Note"])
    }

    func testACellClosedBeforeItsWordsCameSendsThemToTheEndOfTheNote() async throws {
        let scene = try makeTableScene()
        scene.bridge.micTapped(in: scene.cell)
        // The table is finished (its editor and cells leave) while the take is transcribed.
        scene.editor.commit()
        scene.editor.removeFromSuperview()
        XCTAssertNil(scene.cell.window)

        scene.bridge.insert("late words")

        XCTAssertEqual(scene.cell.text, "a1", "a cell no longer on screen is not written")
        XCTAssertEqual(scene.textView.textStorage.string, "\u{FFFC}\nnote end late words", "the words are kept, at the note's end")
    }

    func testTheNotesMicAfterACellTakeNeverWritesTheOldCell() throws {
        let scene = try makeTableScene()
        scene.bridge.micTapped(in: scene.cell)
        scene.bridge.insert("first")
        XCTAssertEqual(scene.cell.text, "a1 first")

        // The rich editor's own mic next, caret at the end of the note: its words are the note's.
        scene.textView.selectedRange = NSRange(location: scene.textView.textStorage.length, length: 0)
        scene.bridge.micTapped()
        scene.bridge.insert("second")
        XCTAssertEqual(scene.cell.text, "a1 first", "a later take never goes to the earlier cell")
        XCTAssertEqual(scene.textView.textStorage.string, "\u{FFFC}\nnote end second")
    }

    func testASecondCellMicTapWhileATakeRunsKeepsTheFirstCell() throws {
        let scene = try makeTableScene()
        var busy = false
        var starts = 0
        scene.bridge.canStart = { !busy }
        scene.bridge.onMicTap = { starts += 1; busy = true }
        scene.bridge.micTapped(in: scene.cell)
        XCTAssertEqual(starts, 1)

        // Recording or transcribing: a tap in another cell, or on the note's own mic, is refused
        // and moves nothing.
        let other = try XCTUnwrap(Self.field("table.cell.2.1", in: scene.editor))
        scene.bridge.micTapped(in: other)
        scene.textView.selectedRange = NSRange(location: 0, length: 0)
        scene.bridge.micTapped()
        XCTAssertEqual(starts, 1, "no second take starts")

        scene.bridge.insert("still here")
        XCTAssertEqual(scene.cell.text, "a1 still here", "the words go where the running take was asked for")
        XCTAssertEqual(other.text, "b2")
        XCTAssertEqual(scene.textView.textStorage.string, "\u{FFFC}\nnote end")
    }

    func testANoteMicTapWhileATakeRunsKeepsTheFirstCaret() throws {
        let scene = try makeTableScene()
        var busy = false
        scene.bridge.canStart = { !busy }
        scene.bridge.onMicTap = { busy = true }
        scene.textView.selectedRange = NSRange(location: scene.textView.textStorage.length, length: 0)
        scene.bridge.micTapped()
        // A second tap with the caret moved to the start, and one in a cell, while it runs.
        scene.textView.selectedRange = NSRange(location: 0, length: 0)
        scene.bridge.micTapped()
        scene.bridge.micTapped(in: scene.cell)
        scene.bridge.insert("tail")
        XCTAssertEqual(scene.textView.textStorage.string, "\u{FFFC}\nnote end tail", "at the caret of the take that runs")
        XCTAssertEqual(scene.cell.text, "a1")
    }

    func testTheNotesMicTappedBeforeACellsWordsCameTakesThemForTheNote() throws {
        let scene = try makeTableScene()
        // The cell's take never brought words (its start was refused, or it was cancelled), and
        // the cell is still on screen; then the note's own mic was tapped.
        scene.bridge.onMicTap = {}
        scene.bridge.micTapped(in: scene.cell)
        XCTAssertNotNil(scene.cell.window, "the old cell is still in the window")
        scene.textView.selectedRange = NSRange(location: scene.textView.textStorage.length, length: 0)
        scene.bridge.micTapped()
        scene.bridge.insert("for the note")
        XCTAssertEqual(scene.cell.text, "a1", "the cell the first take was for is not written")
        XCTAssertEqual(scene.textView.textStorage.string, "\u{FFFC}\nnote end for the note")
    }
}
