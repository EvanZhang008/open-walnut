import SwiftUI
import UIKit

/// The words box of a card that asks the user something (an ask card under a task's row, a
/// thread's Follow up on its card), the phone's twin of the web's `ReplyComposer` (2026-11-20,
/// the user: "all the inbox like this should like input box ... the at works like the slash
/// works"). The letter reply's own field (`LetterReplyField`, which reads and clears the words
/// on screen), with the same `@` and `/` lists as every composer (`ComposerSuggestController`),
/// pictures from Photos, the camera or a paste (`ReplyPictureButton`), Walnut's mic when the
/// box names one (`voiceBox`), and a Send.
///
/// Each box keeps its own draft (`ComposerDrafts`, under `draftKey`), never a composer's, so
/// words typed here never show up in another box. A send that fails keeps its words and its
/// pictures: `onSend` answers true once they were taken. It never takes the keyboard by itself:
/// a page shows many of them.
struct ReplyBox: View {
    let placeholder: String
    /// This box's own draft.
    let draftKey: String
    /// Identifiers: `<idPrefix>.input`, `<idPrefix>.send`, `<idPrefix>.attach`, ...
    let idPrefix: String
    /// The task it answers for, and the session whose commands `/` lists.
    var scope = ComposerSuggestController.Scope()
    /// The answer takes pictures; when it does not, Paste with a picture pastes words only.
    var acceptsPictures = true
    /// What VoiceOver calls the field, when the placeholder alone does not say what it answers.
    var fieldLabel: String? = nil
    /// Walnut's mic beside the field: "voice-mic.<voiceBox>", "voice.<voiceBox>.*".
    var voiceBox: String? = nil
    /// A family of drafts kept by count (`ComposerDrafts.trimDrafts`): the newest `kept` stay.
    var draftFamily: (prefix: String, kept: Int)? = nil
    /// A send of this draft is on its way from another box (one closed and shown again).
    var busy = false
    /// The line under the box once a send failed (its words and pictures stay in it).
    var failureNote: String? = nil
    /// Words are the answer (an ask card): pictures go with them, never alone. A thread's
    /// Follow up takes a picture with no words, as the web's card does.
    var requiresWords = true
    /// Where the open `@` or `/` list shows. Above the field, floating over what is above it
    /// with no height of its own (a SwiftUI scroll, a thread card). A box in a `List` row (the
    /// board's ask card) opens it under the field in the row instead: a `List` row's cell takes
    /// no touch outside its own bounds, so a list floating above the row would pass its taps to
    /// the row above. Under the field the field and its caret still never move.
    var listOpensBelow = false
    let onSend: (String, [SelectedImage]) async -> Bool

    @Environment(TasksStore.self) private var store: TasksStore?
    @State private var field = LetterReplyFieldController()
    @State private var suggest = ComposerSuggestController()
    @State private var drafts = ComposerDrafts.shared
    @State private var gate = DictationSendGate()
    @State private var focused = false
    @State private var sending = false
    @State private var failed = false
    /// The words that went out while he kept writing: the box kept only what came after them.
    @State private var sentNote: String?
    @State private var pictureNotice: String?

    private func trim() {
        guard let draftFamily else { return }
        drafts.trimDrafts(prefix: draftFamily.prefix, keeping: draftKey, max: draftFamily.kept)
    }

    private var draft: Binding<String> {
        Binding(get: { drafts.draft(draftKey) }, set: { drafts.setDraft($0, key: draftKey); trim() })
    }

    private var pictures: Binding<[SelectedImage]> {
        Binding(get: { drafts.images(draftKey) }, set: { drafts.setImages($0, key: draftKey); trim() })
    }

    private var blocked: Bool { sending || busy }

    /// What a Send takes: words, or (`requiresWords` off) pictures alone.
    private func sendable(words: String, pictures: [SelectedImage]) -> Bool {
        !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (!requiresWords && !pictures.isEmpty)
    }

    /// While Walnut's mic records, Send waits for its words (`DictationSendGate`).
    private var canSend: Bool {
        guard !blocked else { return false }
        return gate.isDictating || gate.isWaiting
            || sendable(words: drafts.draft(draftKey), pictures: acceptsPictures ? drafts.images(draftKey) : [])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if acceptsPictures {
                ReplyPictureStrip(images: pictures, notice: $pictureNotice, idPrefix: idPrefix, size: 44)
            }
            HStack(alignment: .bottom, spacing: 2) {
                if acceptsPictures {
                    ReplyPictureButton(
                        images: pictures, notice: $pictureNotice, idPrefix: idPrefix,
                        disabled: blocked, onWillPresent: { field.endEditing() }
                    )
                }
                fieldWithMic
                LetterSendButton(
                    enabled: canSend || sending, waiting: sending || gate.isWaiting,
                    identifier: "\(idPrefix).send", action: { gate.send { waited in send(waited: waited) } }
                )
            }
            // The open list floats over what is above the field (drawn after it, so on top) and
            // takes no height: the field and its caret stay put, and the rows around never jump.
            .overlay(alignment: .top) {
                if !listOpensBelow, suggest.isOpen {
                    ComposerSuggestList(controller: suggest, onPick: pick, maxHeight: 200)
                        .fixedSize(horizontal: false, vertical: true)
                        .alignmentGuide(.top) { d in d[.bottom] + 6 }
                }
            }
            if listOpensBelow {
                ComposerSuggestList(controller: suggest, onPick: pick, maxHeight: 200)
            }
            if failed, let failureNote {
                Text(failureNote)
                    .font(.footnote)
                    .foregroundStyle(Theme.needsText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("\(idPrefix).failed")
            } else if let returned = drafts.returnNote(draftKey) {
                // Words a held send gave back (`HeldSessionSends`), in the failure line's look.
                Text(returned)
                    .font(.footnote)
                    .foregroundStyle(Theme.needsText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("\(idPrefix).returned")
            } else if let sentNote {
                Text(sentNote)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("\(idPrefix).sentPart")
            }
        }
        .dictationSendGate(gate)
        .onAppear {
            suggest.store = store
            suggest.scope = scope
            suggest.attach(draftKey: draftKey)
        }
        .onChange(of: scope) { _, next in suggest.scope = next }
        .onChange(of: draftKey) { _, next in suggest.attach(draftKey: next) }
        // The `/` list is read once the box is used, never for every card on a board.
        .onChange(of: focused) { _, isFocused in if isFocused { suggest.prefetchCommands() } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(idPrefix)
    }

    @ViewBuilder
    private var fieldWithMic: some View {
        if let voiceBox {
            VoiceDictationField(
                text: draft, surface: draftKey, box: voiceBox, placement: .beside,
                blocked: blocked, refocus: { focused = true }
            ) { replyField }
        } else {
            replyField
        }
    }

    private var replyField: some View {
        LetterReplyField(
            text: draft, isFocused: $focused, controller: field, maxLines: 4,
            identifier: "\(idPrefix).input", accessibilityLabel: fieldLabel ?? placeholder,
            onPasteImages: acceptsPictures ? { (images: [UIImage]) in paste(images) } : nil,
            onCaretChange: { text, caret in suggest.update(text: text, caret: caret) }
        )
        .frame(maxWidth: .infinity)
        .overlay(alignment: .topLeading) {
            Text(placeholder)
                .lineLimit(1)
                .foregroundStyle(draft.wrappedValue.isEmpty ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Color.clear))
                .padding(.horizontal, 12)
                .padding(.vertical, LetterReplyField.verticalInset)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        // The one message box's corner (`MessageBox`), as every box he types in.
        .background(Color(.secondarySystemBackground), in: MessageBox.shape)
    }

    private func pick(_ suggestion: ComposerSuggestion) {
        let current = drafts.draft(draftKey)
        guard let result = suggest.pick(suggestion, currentText: current, caret: field.caret(in: current)) else { return }
        field.replace(with: result.text, caret: result.caret)
        if !focused { focused = true }
    }

    private func paste(_ images: [UIImage]) {
        Task { @MainActor in
            let outcome = ComposerBar.attach(await ReplyPictures.make(images), to: drafts.images(draftKey))
            drafts.setImages(outcome.images, key: draftKey)
            if let notice = outcome.notice { pictureNotice = notice }
            AppLog.info("composer", "reply box pictures pasted", ["box": idPrefix, "count": String(outcome.images.count)])
        }
    }

    /// Send what the field shows. `sending` holds from the tap (a dictation can make the read
    /// wait), so a second tap is the same send. The words stay in the box until the owner says
    /// they were taken; words typed while it sent stay too, and only what was sent leaves.
    /// `waited`: it ran after a wait for dictated words, whose field was redrawn meanwhile, so
    /// the stored draft (which the words were just added to) is what goes.
    private func send(waited: Bool) {
        guard !sending, !busy else { return }
        sending = true
        failed = false
        sentNote = nil
        Task { @MainActor in
            defer { sending = false }
            let shown = waited ? drafts.draft(draftKey) : await field.commitAndRead(fallback: drafts.draft(draftKey))
            let words = shown.trimmingCharacters(in: .whitespacesAndNewlines)
            let images = acceptsPictures ? drafts.images(draftKey) : []
            guard sendable(words: words, pictures: images) else { return }
            suggest.attach(draftKey: draftKey)
            let taken = await onSend(suggest.outgoing(words), images)
            AppLog.info("composer", "reply box sent", ["box": idPrefix, "taken": String(taken), "images": String(images.count)])
            guard taken else {
                failed = true
                return
            }
            drafts.setReturnNote(nil, key: draftKey)
            let after = Self.afterReceipt(
                sent: shown, sentPictures: images.map(\.id),
                draft: drafts.draft(draftKey), draftPictures: drafts.images(draftKey).map(\.id))
            if after.words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, after.pictures.isEmpty {
                field.clear(sent: words)
                drafts.clear(draftKey)
                suggest.reset()
                return
            }
            if after.words != drafts.draft(draftKey) {
                field.replace(with: after.words, caret: (after.words as NSString).length)
            }
            // The references only the sent words held go; the ones still in the box stay.
            suggest.forgetRefs(notIn: after.words)
            drafts.setImages(drafts.images(draftKey).filter { after.pictures.contains($0.id) }, key: draftKey)
            if after.remainder { sentNote = "Sent: \u{201C}\(Self.clip(words))\u{201D}. What you wrote after it is still here." }
        }
    }

    /// What the draft keeps once the owner took `sent`: what he wrote after it, never the part
    /// that went out (2026-11-08 review, round 3: "Approve" sent, " and ship it" added on the
    /// way, and the next Send sent "Approve" a second time). Words that do not start with the
    /// sent ones are newer words of his and stay whole; the pictures that went out leave the
    /// draft. `remainder`: the draft kept only what came after the sent words.
    nonisolated static func afterReceipt(sent: String, sentPictures: [UUID], draft: String, draftPictures: [UUID])
        -> (words: String, pictures: [UUID], remainder: Bool) {
        let pictures = draftPictures.filter { !sentPictures.contains($0) }
        guard !sent.isEmpty, draft.hasPrefix(sent) else { return (draft, pictures, false) }
        let rest = String(draft.dropFirst(sent.count))
        let trimmed = String(rest.drop { $0 == " " || $0 == "\n" || $0 == "\t" })
        return (trimmed, pictures, !trimmed.isEmpty)
    }

    private static func clip(_ words: String) -> String {
        let one = words.trimmingCharacters(in: .whitespacesAndNewlines)
        return one.count > 60 ? String(one.prefix(60)) + "\u{2026}" : one
    }
}
