import SwiftUI
import UIKit

/// The letter reply box's text field: a `UITextView` this file owns, because
/// sending has to read and clear the words the human actually SEES, and SwiftUI's
/// `TextField` gives no handle on the input session behind them.
///
/// THE BUG THIS EXISTS FOR (TestFlight report, 2026-09-28). A reply dictated
/// into the letter box on the Pinyin keyboard was sent and landed in the thread,
/// yet the field still held the same words, drawn with the tan highlight of
/// MARKED text: an input session (an IME composition, or dictation still
/// publishing its hypothesis) was alive when Send was tapped. The reader cleared
/// its binding, and the live session then wrote its text straight back into the
/// field. Nothing on screen said the reply had gone.
///
/// So a send is three steps, owned here (`LetterReplyFieldController`):
///  1. `commitAndRead()` reads the words on screen. When nothing is marked and
///     dictation is not running, what is shown is final: it returns at once and
///     the keyboard stays up for the next reply. A composition (marked text, no
///     dictation) is committed exactly as displayed (`unmarkText`, synchronous);
///     the caller clears the field and then ends editing, in the same turn, so
///     nothing sent shows for a frame. Only dictation waits: it can publish its final words after
///     it stops, so the field is read once the text stops changing;
///  2. the caller sends exactly what that returned;
///  3. `clear(sent:)` empties the view itself, not just the binding, and for a
///     few seconds drops text that reappears while nobody is editing if it is
///     part of what was just sent (an input session echoing back). Words the
///     human did not send are never dropped.
///
/// Growth matches the `TextField(axis: .vertical).lineLimit(1...5)` it replaces:
/// one line tall when empty, up to five, then it scrolls.
struct LetterReplyField: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    let controller: LetterReplyFieldController
    var maxLines: Int = 5
    var identifier: String = "inbox.letter.replyField"
    var accessibilityLabel: String = "Reply to the agent"

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.isScrollEnabled = true
        view.alwaysBounceVertical = false
        view.showsVerticalScrollIndicator = true
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = .label
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(
            top: Self.verticalInset, left: 12, bottom: Self.verticalInset, right: 12
        )
        view.textContainer.lineFragmentPadding = 0
        view.autocorrectionType = .default
        view.autocapitalizationType = .sentences
        view.spellCheckingType = .default
        view.textAlignment = .natural
        view.accessibilityIdentifier = identifier
        view.accessibilityLabel = accessibilityLabel
        view.text = text
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        controller.attach(view, coordinator: context.coordinator)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        controller.attach(view, coordinator: context.coordinator)
        // Never write into a live composition: replacing the text under marked
        // text is the very write the input session undoes. Programmatic changes
        // (a voice transcript, an edited reply) arrive when nothing is marked,
        // because the voice row and the Edit button both end editing first.
        if view.markedTextRange == nil, view.text != text {
            view.text = text
            let end = (text as NSString).length
            view.selectedRange = NSRange(location: end, length: 0)
            view.scrollRangeToVisible(view.selectedRange)
        }
        if isFocused, !view.isFirstResponder, view.window != nil {
            view.becomeFirstResponder()
        } else if !isFocused, view.isFirstResponder {
            view.resignFirstResponder()
        }
    }

    /// Top and bottom inset: one line of body text at the default size makes a
    /// 44pt field, the height of the mic and send targets beside it.
    static let verticalInset: CGFloat = 11

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? max(uiView.bounds.width, 120)
        let font = uiView.font ?? UIFont.preferredFont(forTextStyle: .body)
        let inset = uiView.textContainerInset.top + uiView.textContainerInset.bottom
        let minHeight = font.lineHeight.rounded(.up) + inset
        let maxHeight = (font.lineHeight * CGFloat(maxLines)).rounded(.up) + inset
        let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: min(max(fitting, minHeight), maxHeight))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: LetterReplyField
        /// Set by `clear(sent:)`: text that reappears before this moment while
        /// the field is not being edited, and is part of `echoOf`, is dropped.
        var echoGuardUntil: Date?
        var echoOf = ""

        init(_ parent: LetterReplyField) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            if dropEcho(textView) { return }
            if parent.text != textView.text { parent.text = textView.text }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            // The human is typing again: nothing they enter from here is an echo.
            echoGuardUntil = nil
            if !parent.isFocused { parent.isFocused = true }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.isFocused { parent.isFocused = false }
        }

        /// The input session wrote words back after a send. Drop them only when
        /// every one of them was in the reply that just went out, so nothing the
        /// human has not sent can be lost here.
        private func dropEcho(_ textView: UITextView) -> Bool {
            guard let until = echoGuardUntil, Date() < until, !textView.isFirstResponder else { return false }
            let echoed = textView.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !echoed.isEmpty, LetterReplyFieldController.isEcho(echoed, of: echoOf) else { return false }
            if textView.markedTextRange != nil { textView.unmarkText() }
            textView.text = ""
            if !parent.text.isEmpty { parent.text = "" }
            AppLog.warn("inbox", "reply field echo dropped after send", ["chars": "\(echoed.count)"])
            return true
        }
    }
}

/// The handle the reader sends through: commit, read, clear.
@MainActor
final class LetterReplyFieldController {
    private weak var textView: UITextView?
    private weak var coordinator: LetterReplyField.Coordinator?

    /// How long `commitAndRead` waits for the text to stop changing (dictation
    /// can publish its final words after editing ends), and its ceiling.
    static let settleInterval: Duration = .milliseconds(200)
    static let settleCeiling: Duration = .milliseconds(1_500)
    /// How long after a send an echo of the sent words is dropped.
    static let echoWindow: TimeInterval = 3

    /// Internal, not private, so a unit test can drive a bare `UITextView`.
    func attach(_ view: UITextView, coordinator: LetterReplyField.Coordinator) {
        if textView !== view { textView = view }
        if self.coordinator !== coordinator { self.coordinator = coordinator }
    }

    /// Whether the field is on screen right now.
    var isAttached: Bool { textView != nil }

    /// Words in the field, a composition still marked included.
    var holdsWords: Bool { !(textView?.text ?? "").isEmpty }

    /// The last `readNow` committed a composition, so editing has to end.
    private(set) var committedComposition = false

    /// The words on screen when they are final right now, or nil while dictation
    /// runs (then `commitAndRead` waits for them). Never suspends, so the caller
    /// clears the field in the same run-loop turn as the tap. Returns `fallback`
    /// (the binding's value) when the field is not on screen.
    ///
    /// Nothing marked: nothing can still change what is shown, and the keyboard
    /// stays up. A composition (marked text, no dictation): `unmarkText` commits
    /// it as shown, right now, and `committedComposition` tells the caller to end
    /// editing so the input session cannot write it back (the echo guard in
    /// `clear` drops anything that still does). The settle wait this used to
    /// share with dictation held the committed words in the field for 240ms
    /// after Send (2026-09-29 gate, P2-1).
    ///
    /// The caller ends editing AFTER it has cleared the field, in the same turn:
    /// putting the keyboard away here, before the field and the send button
    /// changed, made the send glyph trail the reply box by about 150ms as the
    /// box slid down (2026-09-29 film, round 4), which the other order does not.
    func readNow(fallback: String) -> String? {
        committedComposition = false
        guard let view = textView else { return fallback }
        if Self.isDictating(view) { return nil }
        if view.markedTextRange != nil {
            view.unmarkText()
            committedComposition = true
        }
        let shown = view.text ?? ""
        if let coordinator, coordinator.parent.text != shown { coordinator.parent.text = shown }
        return shown
    }

    /// Return exactly the words on screen, ending the input session first when
    /// one is still composing. See `readNow`; only dictation makes this wait.
    func commitAndRead(fallback: String) async -> String {
        if let now = readNow(fallback: fallback) { return now }
        guard let view = textView else { return fallback }
        if view.markedTextRange != nil { view.unmarkText() }
        Self.dismissKeyboard(view)
        let clock = ContinuousClock()
        let started = clock.now
        var last = view.text ?? ""
        var stableSince = clock.now
        while clock.now - started < Self.settleCeiling {
            try? await Task.sleep(for: .milliseconds(50))
            // The human tapped back in: what they type now is the next reply, so
            // send what was there when editing ended.
            if view.isFirstResponder { break }
            if view.markedTextRange != nil { view.unmarkText() }
            let current = view.text ?? ""
            if current != last {
                last = current
                stableSince = clock.now
            } else if clock.now - stableSince >= Self.settleInterval {
                break
            }
        }
        // Make sure the binding holds what is sent, even if the last change came
        // from a path that did not reach the delegate.
        if let coordinator, coordinator.parent.text != last { coordinator.parent.text = last }
        return last
    }

    /// Empty the field (the view itself, not just the binding) and guard it for
    /// `echoWindow` against the sent words being written back.
    func clear(sent: String) {
        coordinator?.echoOf = sent
        coordinator?.echoGuardUntil = Date().addingTimeInterval(Self.echoWindow)
        guard let view = textView else { return }
        if view.markedTextRange != nil { view.unmarkText() }
        view.text = ""
        if let coordinator, !coordinator.parent.text.isEmpty { coordinator.parent.text = "" }
    }

    /// End editing without sending (the voice row, the Edit button): commits
    /// marked text so a programmatic change can land.
    func endEditing() {
        guard let view = textView else { return }
        if view.markedTextRange != nil { view.unmarkText() }
        Self.dismissKeyboard(view)
    }

    /// Put the keyboard away inside the keyboard's own animation (its duration
    /// and curve 7), so it slides down together with the reply box above it
    /// (2026-09-29 gate, P2-1).
    ///
    /// Note for anyone filming this on the iOS 26 simulator: a programmatic
    /// dismissal there removes the keyboard in ONE frame in every app, the
    /// system's own too (Settings' search, dismissed with its Search key, films
    /// the same way), while showing it slides normally. The reply box then
    /// slides down in the keyboard's 0.25s. That one-frame keyboard is the
    /// simulator's, not this code's.
    static func dismissKeyboard(_ view: UITextView) {
        guard view.isFirstResponder else { return }
        UIView.animate(
            withDuration: 0.25, delay: 0,
            options: [UIView.AnimationOptions(rawValue: 7 << 16), .beginFromCurrentState, .allowUserInteraction]
        ) {
            view.resignFirstResponder()
        }
    }

    /// Whether dictation owns the field right now. UIKit reports the dictation
    /// input mode's language as "dictation"; there is no other public signal.
    static func isDictating(_ view: UITextView) -> Bool {
        view.textInputMode?.primaryLanguage == "dictation"
    }

    /// Is `echoed` made only of words from `sent`? Compared without whitespace,
    /// because an IME re-commit can drop or add the spaces between syllables.
    nonisolated static func isEcho(_ echoed: String, of sent: String) -> Bool {
        let squash: (String) -> String = { $0.filter { !$0.isWhitespace } }
        let e = squash(echoed)
        let s = squash(sent)
        guard !e.isEmpty, !s.isEmpty else { return false }
        return s.contains(e)
    }
}
