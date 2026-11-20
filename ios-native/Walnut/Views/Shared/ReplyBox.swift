import SwiftUI
import UIKit

/// The words box of a card that asks the user something (an ask card under a task's row),
/// the phone's twin of the web's `ReplyComposer` (2026-11-20, the user: "all the inbox like
/// this should like input box ... the at works like the slash works"). The letter reply's own
/// field (`LetterReplyField`, which reads and clears the words on screen), with the same `@`
/// and `/` lists as every composer (`ComposerSuggestController`), pictures from Photos, the
/// camera or a paste (`ReplyPictureButton`), and a Send.
///
/// Each box keeps its own draft (`ComposerDrafts`, under `draftKey`), never a composer's, so
/// words typed here never show up in another box. A send that fails keeps its words and its
/// pictures: `onSend` answers true once they were taken.
struct ReplyBox: View {
    let placeholder: String
    /// This box's own draft.
    let draftKey: String
    /// Identifiers: `<idPrefix>.field`, `<idPrefix>.send`, `<idPrefix>.attach`, ...
    let idPrefix: String
    /// The task it answers for, and the session whose commands `/` lists.
    var scope = ComposerSuggestController.Scope()
    /// The answer takes pictures; when it does not, Paste with a picture pastes words only.
    var acceptsPictures = true
    let onSend: (String, [SelectedImage]) async -> Bool

    @Environment(TasksStore.self) private var store: TasksStore?
    @State private var field = LetterReplyFieldController()
    @State private var suggest = ComposerSuggestController()
    @State private var drafts = ComposerDrafts.shared
    @State private var focused = false
    @State private var sending = false
    @State private var pictureNotice: String?

    private var draft: Binding<String> {
        Binding(get: { drafts.draft(draftKey) }, set: { drafts.setDraft($0, key: draftKey) })
    }

    private var pictures: Binding<[SelectedImage]> {
        Binding(get: { drafts.images(draftKey) }, set: { drafts.setImages($0, key: draftKey) })
    }

    /// Words are the answer: pictures go with them, never alone (the web's ask card).
    private var canSend: Bool {
        !sending && !drafts.draft(draftKey).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ComposerSuggestList(controller: suggest, onPick: pick, maxHeight: 200)
            if acceptsPictures {
                ReplyPictureStrip(images: pictures, notice: $pictureNotice, idPrefix: idPrefix, size: 44)
            }
            HStack(alignment: .bottom, spacing: 2) {
                if acceptsPictures {
                    ReplyPictureButton(
                        images: pictures, notice: $pictureNotice, idPrefix: idPrefix,
                        disabled: sending, onWillPresent: { field.endEditing() }
                    )
                }
                LetterReplyField(
                    text: draft, isFocused: $focused, controller: field, maxLines: 4,
                    identifier: "\(idPrefix).field", accessibilityLabel: placeholder,
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
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                LetterSendButton(enabled: canSend || sending, waiting: sending, identifier: "\(idPrefix).send", action: send)
            }
        }
        .onAppear {
            suggest.store = store
            suggest.scope = scope
        }
        .onChange(of: scope) { _, next in suggest.scope = next }
        // The `/` list is read once the box is used, never for every card on a board.
        .onChange(of: focused) { _, isFocused in if isFocused { suggest.prefetchCommands() } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(idPrefix)
    }

    private func pick(_ suggestion: ComposerSuggestion) {
        guard let result = suggest.pick(suggestion) else { return }
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
    private func send() {
        guard !sending else { return }
        sending = true
        Task { @MainActor in
            defer { sending = false }
            let shown = await field.commitAndRead(fallback: drafts.draft(draftKey))
            let words = shown.trimmingCharacters(in: .whitespacesAndNewlines)
            let images = acceptsPictures ? drafts.images(draftKey) : []
            guard !words.isEmpty else { return }
            let taken = await onSend(suggest.outgoing(words), images)
            AppLog.info("composer", "reply box sent", ["box": idPrefix, "taken": String(taken), "images": String(images.count)])
            guard taken else { return }
            let now = drafts.draft(draftKey)
            if now == shown || now.trimmingCharacters(in: .whitespacesAndNewlines) == words {
                field.clear(sent: words)
                drafts.clear(draftKey)
                suggest.reset()
            } else {
                // More was typed while it went: keep that, drop the sent part and the sent pictures.
                let rest = now.hasPrefix(shown) ? String(now.dropFirst(shown.count)).trimmingCharacters(in: .whitespacesAndNewlines) : now
                field.replace(with: rest, caret: (rest as NSString).length)
                let sentIDs = Set(images.map(\.id))
                drafts.setImages(drafts.images(draftKey).filter { !sentIDs.contains($0.id) }, key: draftKey)
            }
        }
    }
}
