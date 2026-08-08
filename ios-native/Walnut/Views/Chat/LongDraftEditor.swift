import SwiftUI
import UIKit

/// Bounded-cost composer field for LONG drafts.
///
/// WHY THIS EXISTS (2026-08-07, build-35 0x8BADF00D freezes). The composer's
/// natural `TextField(text:axis:.vertical).lineLimit(1...6)` must decide how tall
/// the string *wants* to be before it can clamp it to six lines, and SwiftUI has
/// no viewport bound to stop at — so it lays out the WHOLE draft on every
/// re-measure. Measured on the real hosted view (`ComposerFreezeTests`):
///
///     draft chars     one relayout
///           148           1.65 ms
///         5,000          62.7  ms
///        10,000         160    ms
///        50,000       2,353    ms      ← breaches the watchdog-scaled budget alone
///
/// A relayout happens on every keystroke, focus edge, keyboard-geometry change
/// and safe-area inset change, and the draft has NO upper bound anywhere in the
/// app: one paste can put arbitrary text in it, and voice dictation appends
/// without limit (`appendToDraft` concatenates). Above a few thousand characters
/// the per-cycle cost becomes the multiplier that turns any repeated layout into
/// a multi-second stall.
///
/// THE FIX IS A BOUND, NOT A TRUNCATION. `UITextView` with scrolling enabled is a
/// TextKit client with a viewport: it lays out the visible fragments, not the
/// document, and its height here is a CONSTANT (the six-line ceiling the
/// `lineLimit` clamp would have produced anyway, since a draft this long always
/// overflows it). So cost stops scaling with draft length entirely, and the text
/// itself is never shortened — `ComposerDrafts` still holds every character.
///
/// SCOPE: used ONLY above `ComposerBar.longDraftThreshold`. Normal drafts keep
/// the plain SwiftUI `TextField` untouched, so the everyday typing path carries
/// zero behavioral risk from this file.
struct LongDraftEditor: UIViewRepresentable {
    @Binding var text: String
    /// Two-way focus, bridged manually. `.focused()` is not dependable on a
    /// representable, and `appendToDraft` raising the keyboard after a
    /// transcription depends on this working.
    @Binding var isFocused: Bool
    /// Six lines — the same ceiling `lineLimit(1...6)` imposes. Constant by
    /// design: no draft-length-dependent measurement anywhere in this view.
    var visibleLines: Int = 6

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        // The bound: a scrolling UITextView lays out its viewport, never the
        // whole document. Turning this off would reintroduce the exact
        // full-document measurement this view exists to avoid.
        view.isScrollEnabled = true
        view.alwaysBounceVertical = false
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = .label
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 9, left: 11, bottom: 9, right: 11)
        view.textContainer.lineFragmentPadding = 0
        view.keyboardDismissMode = .interactive
        // Match the plain TextField's editing affordances so crossing the
        // threshold mid-draft doesn't silently change how typing behaves.
        view.autocorrectionType = .default
        view.autocapitalizationType = .sentences
        view.spellCheckingType = .default
        view.textAlignment = .natural
        // Same identifier as the TextField it stands in for, so Maestro flows and
        // UI tests keep finding the composer at any draft length.
        view.accessibilityIdentifier = "chat.composer"
        view.text = text
        // The tail is what the user is composing — start there, not at the top of
        // a 50,000-character paste.
        view.setContentOffset(
            CGPoint(x: 0, y: max(0, view.contentSize.height - view.bounds.height)), animated: false
        )
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        // Only write when the store genuinely diverges: assigning `text`
        // unconditionally resets the selection on every pass, which eats the
        // caret mid-typing.
        if view.text != text {
            let atEnd = view.selectedRange.location >= (view.text as NSString).length
            view.text = text
            if atEnd {
                let end = (text as NSString).length
                view.selectedRange = NSRange(location: end, length: 0)
                view.scrollRangeToVisible(view.selectedRange)
            }
        }
        // Focus is driven from SwiftUI (`appendToDraft` sets it after a voice
        // transcription). Guarded both ways so we never fight the user.
        if isFocused, !view.isFirstResponder {
            view.becomeFirstResponder()
        } else if !isFocused, view.isFirstResponder {
            view.resignFirstResponder()
        }
    }

    /// CONSTANT height — the whole point. `visibleLines` × the font's line height
    /// plus the container inset, with no reference to `text`, so no draft length
    /// can make this view's sizing more expensive.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let lineHeight = uiView.font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
        let inset = uiView.textContainerInset.top + uiView.textContainerInset.bottom
        return CGSize(width: proposal.width ?? UIView.noIntrinsicMetric,
                      height: (lineHeight * CGFloat(visibleLines)).rounded(.up) + inset)
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        private let parent: LongDraftEditor

        init(_ parent: LongDraftEditor) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            // Straight through to the durable store — the same binding the plain
            // TextField writes. Draft ownership stays outside the view.
            parent.text = textView.text
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.isFocused { parent.isFocused = true }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.isFocused { parent.isFocused = false }
        }
    }
}
