import SwiftUI

/// What the person says to the CEO about one piece of content, before anything is sent: Talk to
/// CEO opens this first (2026-11-03, the user: "you at least give me an input box ... you can't
/// just send it straight to the CEO"). The content rides along as an attachment; only Send sends.
/// The words and pictures are kept per item in the composer draft store, so closing and
/// reopening keeps them, and a send that fails leaves both for the next try (the pictures in
/// memory only, as the chat's are).
struct CeoNoteSheet: View {
    let item: ContentItem
    /// Prefix of every accessibility identifier, e.g. `inbox.item.<id>`.
    let identifier: String
    /// Called with the trimmed words and the pictures put with them when the person taps Send;
    /// the sheet closes itself.
    let onSend: (String, [SelectedImage]) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var drafts = ComposerDrafts.shared
    @FocusState private var focused: Bool
    /// The box's height; the sheet scrolls, so at the large text sizes the keyboard never
    /// squeezes the attachment line or the box away.
    @ScaledMetric(relativeTo: .body) private var boxHeight: CGFloat = 150
    @State private var pictureNotice: String?

    /// The server's cap on the note (`content-v1.ts`); longer words are refused, not cut.
    nonisolated static let noteLimit = 8_000
    /// Notes kept for emails the person left unsent (Cancel keeps the words).
    nonisolated static let keptNotes = 10
    nonisolated static let draftPrefix = "ceo-note:"

    /// The draft store key for this item's note: one per email, so two cards never share words.
    /// Without an open link, the sender and time keep two emails with one subject apart.
    nonisolated static func draftKey(_ item: ContentItem) -> String {
        draftPrefix + (item.open ?? [item.source, item.title, item.from ?? "", item.at ?? ""].joined(separator: "|"))
    }

    /// Send is offered only for words that are not blank and fit the server's cap.
    nonisolated static func canSend(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= noteLimit
    }

    private var key: String { Self.draftKey(item) }
    private var note: Binding<String> {
        Binding(get: { drafts.draft(key) }, set: {
            drafts.setDraft($0, key: key)
            drafts.trimDrafts(prefix: Self.draftPrefix, keeping: key, max: Self.keptNotes - 1)
        })
    }
    /// Pictures for the CEO, like the chat composer's (the route takes up to 5). In the draft
    /// store with the words: gone only once the send reached the CEO (ContentActionButtons).
    private var pictures: Binding<[SelectedImage]> {
        Binding(get: { drafts.images(key) }, set: {
            drafts.setImages($0, key: key)
            drafts.trimDrafts(prefix: Self.draftPrefix, keeping: key, max: Self.keptNotes - 1)
        })
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    attachment
                    ZStack(alignment: .topLeading) {
                        TextEditor(text: note)
                            .font(.body)
                            .focused($focused)
                            .scrollContentBackground(.hidden)
                            .padding(8)
                            .background(Theme.tintSoft.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                            .accessibilityLabel("Message to the CEO")
                            .accessibilityIdentifier("\(identifier).ceoNote")
                        if note.wrappedValue.isEmpty {
                            Text("What should the CEO do with this?")
                                .font(.body)
                                .foregroundStyle(Theme.secondaryOnCard)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, 13)
                                .padding(.vertical, 16)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(height: boxHeight)
                    HStack(spacing: 4) {
                        ReplyPictureButton(
                            images: pictures, notice: $pictureNotice, idPrefix: "\(identifier).ceoNote",
                            onWillPresent: { focused = false }
                        )
                        Text(pictures.wrappedValue.isEmpty ? "Add a picture" : "Pictures go with your message")
                            .font(.caption)
                            .foregroundStyle(Theme.secondaryOnCard)
                    }
                    ReplyPictureStrip(images: pictures, notice: $pictureNotice, idPrefix: "\(identifier).ceoNote")
                    if let over = overLimit {
                        Text(over)
                            .font(.caption)
                            .foregroundStyle(Theme.needsText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Talk to CEO")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("\(identifier).ceoNoteCancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        let words = note.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
                        dismiss()
                        onSend(words, pictures.wrappedValue)
                    }
                    .fontWeight(.semibold)
                    .disabled(!Self.canSend(note.wrappedValue))
                    .accessibilityHint("Sends your message to the CEO with this email attached.")
                    .accessibilityIdentifier("\(identifier).ceoNoteSend")
                }
            }
        }
        .onAppear {
            // At the accessibility sizes the keyboard leaves room for the box alone and the
            // attachment line scrolls away, so there the person taps the box to start.
            guard !dynamicTypeSize.isAccessibilitySize else { return }
            // After the sheet's own appear, or the keyboard does not come up with it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { focused = true }
        }
    }

    /// The content that goes with the words: where it came from and its title.
    private var attachment: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "paperclip")
                .foregroundStyle(Theme.secondaryOnCard)
                .accessibilityHidden(true)
            Text("\(item.source) · \(item.title)")
                .font(.subheadline)
                .foregroundStyle(Theme.secondaryOnCard)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 6 : 2)
                // The box below gives way, never this: it says which email goes along.
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.tintSoft, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Attached: \(item.source), \(item.title)")
        .accessibilityIdentifier("\(identifier).ceoNoteAttachment")
    }

    private var overLimit: String? {
        let count = note.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).count
        guard count > Self.noteLimit else { return nil }
        return "\(count - Self.noteLimit) characters over the \(Self.noteLimit) limit."
    }
}
