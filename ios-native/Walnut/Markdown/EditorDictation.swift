import UIKit

/// Walnut's mic for the rich note editor. The mic sits in the keyboard's
/// accessory bar; the recording row and the voice notices are SwiftUI, under the
/// editor (NoteDetailView). This object is the link between the two: the bar
/// asks it to start, and the transcript comes back through it to the caret the
/// person left when they tapped the mic.
///
/// Text that arrives before the editor exists (a take recovered on open) waits
/// here and goes in as soon as the editor attaches.
@MainActor
final class EditorDictationBridge {
    private(set) weak var textView: WalnutTextView?
    /// Starts a take. Set by the screen that owns the recorder.
    var onMicTap: (() -> Void)?
    /// Where the words go: the selection when the mic was tapped. nil = the
    /// end of the note.
    private var anchor: NSRange?
    private var waiting: [String] = []

    func attach(_ textView: WalnutTextView) {
        self.textView = textView
        // Called from makeUIView: an insert there would write the note's state
        // in the middle of a view update, so it waits for the next turn.
        guard !waiting.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in self?.flush() }
    }

    /// The bar's mic: remember the caret, put the keyboard away while the
    /// person speaks, start the take.
    func micTapped() {
        guard let textView else { return }
        anchor = textView.selectedRange
        _ = textView.resignFirstResponder()
        onMicTap?()
    }

    /// A transcript to insert. Never saved or sent by itself beyond the note's
    /// own autosave, the same as typed words.
    func insert(_ words: String) {
        waiting.append(words)
        flush()
    }

    private func flush() {
        guard let textView, let coordinator = textView.coordinator, !waiting.isEmpty else { return }
        let pieces = waiting
        waiting = []
        var at = anchor ?? NSRange(location: textView.textStorage.length, length: 0)
        for words in pieces {
            at = coordinator.insertDictation(words, in: textView, at: at)
        }
        anchor = nil
        // The keyboard comes back with the caret after the new words.
        textView.beginEditingSession(at: at)
    }
}

extension WysiwygEditor.Coordinator {
    /// Insert dictated words after `range` (a selection is kept, never
    /// replaced), with a space where they would touch another word, styled as
    /// typing there would be. Returns the caret after them.
    @discardableResult
    func insertDictation(_ words: String, in textView: UITextView, at range: NSRange) -> NSRange {
        let storage = textView.textStorage
        let ns = storage.string as NSString
        let loc = max(0, min(range.location + range.length, storage.length))
        let before = loc > 0 ? Self.character(in: ns, endingAt: loc) : nil
        let after = loc < ns.length ? Self.character(in: ns, startingAt: loc) : nil
        guard let piece = VoiceDictationText.insertion(words, before: before, after: after) else {
            return NSRange(location: loc, length: 0)
        }
        isInternalUpdate = true
        storage.insert(
            NSAttributedString(string: piece, attributes: Self.typingAttributes(at: loc, in: storage)),
            at: loc
        )
        let caret = NSRange(location: loc + (piece as NSString).length, length: 0)
        textView.selectedRange = caret
        isInternalUpdate = false
        pushBinding(from: textView)
        parent.onChange()
        return caret
    }

    /// The character just before `loc`, whole (a surrogate pair stays one). An
    /// attachment (a checkbox, an image) reads as a space: its markdown already
    /// ends in one, or stands on its own.
    private static func character(in ns: NSString, endingAt loc: Int) -> Character? {
        let range = ns.rangeOfComposedCharacterSequence(at: loc - 1)
        return visible(ns.substring(with: range))
    }

    private static func character(in ns: NSString, startingAt loc: Int) -> Character? {
        let range = ns.rangeOfComposedCharacterSequence(at: loc)
        return visible(ns.substring(with: range))
    }

    private static func visible(_ text: String) -> Character? {
        guard let first = text.first else { return nil }
        return first == "\u{FFFC}" ? " " : first
    }
}
