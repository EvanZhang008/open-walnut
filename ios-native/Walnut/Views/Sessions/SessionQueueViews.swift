import SwiftUI

/// Which queued message the page is managing (a tap on a row of the strip or the list).
struct QueueRowRef: Identifiable, Equatable {
    let id: String
}

// MARK: - The strip above the composer

/// The messages sent to this session that have not reached its CLI: listed right above
/// the composer, where the person just typed them. A tap opens one to edit, send now or
/// withdraw; the cross withdraws it at once. Nothing is drawn while the queue is empty.
struct SessionQueueStrip: View {
    let queue: SessionQueueModel
    /// A turn runs: the rows wait for its end. Otherwise they are about to go out.
    let turnRunning: Bool
    let onOpen: (QueueRowRef) -> Void
    let onShowAll: () -> Void
    /// Put a message the person just withdrew back where it was.
    let onUndo: (WithdrawnQueuedMessage) -> Void
    /// The keyboard is up: the conversation above has little room, so the tray lists fewer rows.
    let keyboardUp: Bool

    /// Rows listed in the strip; the rest are one tap away in the list.
    static let visibleRows = 3

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// The tray shares the screen with the composer and the keyboard: at the accessibility
    /// sizes it lists one message and the rest are behind "Show all".
    private var shownRows: Int {
        if dynamicTypeSize.isAccessibilitySize { return keyboardUp ? 0 : 1 }
        // Large text and the keyboard leave the conversation almost nothing: the tray shrinks to its header.
        if keyboardUp { return dynamicTypeSize >= .xxLarge ? 0 : Self.visibleRowsWithKeyboard }
        return Self.visibleRows
    }

    static let visibleRowsWithKeyboard = 2

    /// At the accessibility sizes the keyboard leaves the conversation no room at all: the tray steps aside
    /// while the person types, and is back when the keyboard goes.
    private var trayShown: Bool {
        queue.hasRows && !(dynamicTypeSize.isAccessibilitySize && keyboardUp)
    }

    var body: some View {
        if trayShown || queue.withdrawn != nil {
            // The offer to take a withdrawn message back sits ABOVE the tray, in a card of its own:
            // when it goes the rows below do not move, so no tap meant for Undo can land on a cross.
            VStack(spacing: 6) {
                if let gone = queue.withdrawn {
                    undoLine(gone)
                        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ComposerCard.fill))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .strokeBorder(Color(uiColor: .separator).opacity(0.6), lineWidth: 0.5)
                        )
                }
                if trayShown {
                    trayCard
                }
            }
            .padding(.horizontal, ComposerCard.sideInset)
            .padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("session.queue.strip")

        }
    }

    private var trayCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ForEach(queue.rows.prefix(shownRows)) { row in
                rowView(row)
            }
            if queue.rows.count > shownRows {
                if shownRows == 0, let first = queue.rows.first {
                    // Squeezed to one line: the first message in words, and the way to the rest.
                    HStack(spacing: 8) {
                        Button { onOpen(QueueRowRef(id: first.id)) } label: {
                            Text(first.message)
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(first.message)
                        .accessibilityHint("Opens it to edit, send now or withdraw")
                        .accessibilityIdentifier("session.queue.row.\(first.id)")
                        showAllButton
                    }
                    .padding(.horizontal, 14)
                } else {
                    showAllButton
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                }
            }
            if let notice = queue.notice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("session.queue.notice")
            }
        }
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ComposerCard.fill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color(uiColor: .separator).opacity(0.6), lineWidth: 0.5)
        )
    }

    private var showAllButton: some View {
        Button {
            if queue.rows.count == 1, let only = queue.rows.first { onOpen(QueueRowRef(id: only.id)) } else { onShowAll() }
        } label: {
            // One message left behind the squeezed tray: "Show all 1" reads oddly, and what the button
            // opens for it is the edit sheet.
            Text(queue.rows.count == 1 ? "Edit" : "Show all \(queue.rows.count)")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.tint)
                .frame(minHeight: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("session.queue.showAll")
    }

    private var header: some View {
        // One line when it fits; the status drops under the title at large text sizes
        // instead of being cut short.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                titleGroup
                Spacer(minLength: 8)
                headline.lineLimit(1)
                sendAllButton
            }
            VStack(alignment: .leading, spacing: 2) {
                titleGroup
                HStack(spacing: 8) {
                    headline
                    Spacer(minLength: 8)
                    sendAllButton
                }
            }
        }
        .foregroundStyle(Theme.secondaryOnCard)
        .padding(.horizontal, 14)
        .padding(.top, 9)
        .padding(.bottom, 3)
    }

    /// The icon, the word and the count read as one; the status and the Send all button stay their own
    /// elements, so the button can be reached and activated by itself.
    private var titleGroup: some View {
        HStack(spacing: 6) { title }
            .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var title: some View {
        Image(systemName: "tray.full")
            .font(.caption.weight(.semibold))
        Text("Queued")
            .font(.subheadline.weight(.semibold))
        Text("\(queue.rows.count)")
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Theme.tintSoft, in: Capsule())
            .foregroundStyle(Theme.tint)
    }

    /// Two or more messages a Stop held back, with nothing running: one tap puts them all in line again.
    @ViewBuilder
    private var sendAllButton: some View {
        if !turnRunning, queue.heldCount >= 2 {
            Button {
                guard queue.takeRowTap() else { return }
                Task { await queue.sendAllHeld() }
            } label: {
                Text("Send all")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.tint)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 32)
                    .background(Theme.tintSoft, in: Capsule())
                    .padding(6)
                    .contentShape(Rectangle())
                    .padding(-6)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("session.queue.sendAll")
        }
    }

    private var headline: some View {
        Text(queue.rows.headline(turnRunning: turnRunning))
            .font(.footnote)
            .accessibilityIdentifier("session.queue.headline")
    }

    private func undoLine(_ gone: WithdrawnQueuedMessage) -> some View {
        QueueUndoLine(queue: queue, gone: gone, onUndo: onUndo, identifier: "session.queue.undo")
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("session.queue.withdrawn")
    }

    private func rowView(_ row: SessionQueuedMessage) -> some View {
        HStack(spacing: 0) {
            Button {
                onOpen(QueueRowRef(id: row.id))
            } label: {
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        // A Walnut notice or a task's note reads as who sent it and its title,
                        // never its envelope's markup.
                        Text(PeerMessagePresentation.previewLine(row.message))
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if let note = row.statusNote {
                            Text(note)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(row.status == "processing" ? Theme.doneText : Theme.needsText)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if row.canEdit {
                        Image(systemName: "pencil")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.secondaryOnCard)
                            .accessibilityHidden(true)
                    }
                }
                .padding(.leading, 14)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(PeerMessagePresentation.previewLine(row.message))
            .accessibilityHint("Opens it to edit, send now or withdraw")
            .accessibilityIdentifier("session.queue.row.\(row.id)")

            if row.status == "parked", !turnRunning, !queue.busyIds.contains(row.id) {
                // Nothing runs, so Send just puts it back in line: one tap, no sheet.
                Button {
                    guard queue.takeRowTap() else { return }
                    Task { _ = await queue.sendNow(row, interrupt: false) }
                } label: {
                    Text("Send")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.tint)
                        .padding(.horizontal, 10)
                        .frame(minWidth: 44, minHeight: 32)
                        .background(Theme.tintSoft, in: Capsule())
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                        .padding(.trailing, 4)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("session.queue.send.\(row.id)")
            }

            if queue.busyIds.contains(row.id) {
                ProgressView().controlSize(.small).frame(width: 44, height: 44)
            } else if row.canWithdraw {
                Button {
                    guard queue.takeRowTap() else { return }
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    Task { await queue.withdraw(row) }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Theme.secondaryOnCard)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Withdraw")
                .accessibilityIdentifier("session.queue.withdraw.\(row.id)")
            } else {
                Color.clear.frame(width: 14, height: 44)
            }
        }
    }
}

/// "Message withdrawn · Undo": shown over the strip and inside the full list, so the way back
/// is where the person's eyes are.
struct QueueUndoLine: View {
    let queue: SessionQueueModel
    let gone: WithdrawnQueuedMessage
    let onUndo: (WithdrawnQueuedMessage) -> Void
    let identifier: String

    var body: some View {
        HStack(spacing: 8) {
            Text(gone.earlier.isEmpty
                 ? (gone.wasSetAside ? "Withdrawn \u{00B7} Undo returns it to the box" : "Message withdrawn")
                 : "\(gone.earlier.count + 1) messages withdrawn")
                .font(.footnote)
                .foregroundStyle(Theme.secondaryOnCard)
            Spacer(minLength: 8)
            Button {
                queue.noteRowTap()
                queue.clearUndo()
                onUndo(gone)
            } label: {
                Text("Undo")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.tint)
                    .frame(minWidth: 44, minHeight: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(identifier)
        }
        .padding(.horizontal, 14)
    }
}

// MARK: - One queued message

/// Edit one queued message, send it now, or withdraw it. The row is read live from the
/// queue, so a message that started delivering (or was withdrawn elsewhere) closes the
/// sheet instead of offering a change the server would refuse.
struct SessionQueuedMessageSheet: View {
    let queue: SessionQueueModel
    let rowID: String
    /// A turn runs: Send now stops it first.
    let turnRunning: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var seeded = false
    @State private var saving = false
    @State private var askDiscard = false
    /// Sending it now while a turn runs stops that turn: asked first, because the sheet's other
    /// buttons sit right beside it and a stop cannot be taken back.
    @State private var askInterrupt = false
    /// The words as the sheet opened with them: what the person has changed is measured against these, also
    /// after the row has left the queue.
    @State private var original = ""
    /// The row went out while the person had unsaved changes: their words are kept on screen until they
    /// choose what to do with them.
    @State private var strandedWords: String?
    @FocusState private var focused: Bool

    private var row: SessionQueuedMessage? { queue.rows.first { $0.id == rowID } }

    /// The words were deleted: there is nothing to send (the saved ones would go out instead).
    private var emptied: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var changed: Bool {
        guard let row else { return false }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !words.isEmpty && words != row.message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                if let row {
                    TextEditor(text: $text)
                        .focused($focused)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .padding(10)
                        .frame(minHeight: 120, maxHeight: 220)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .disabled(!row.canEdit || saving)
                        .accessibilityIdentifier("session.queue.edit.text")

                    Text(caption(for: row))
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    if let notice = queue.notice {
                        Text(notice).font(.footnote).foregroundStyle(Theme.danger)
                    }

                    VStack(spacing: 10) {
                        if row.canSendNow {
                            Button {
                                if turnRunning { askInterrupt = true } else { Task { await sendNow(row) } }
                            } label: {
                                Label(turnRunning ? "Interrupt & send now" : "Send now", systemImage: "bolt.fill")
                                    .font(.body.weight(.semibold))
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.bordered)
                            .tint(Theme.tint)
                            .foregroundStyle(Theme.tint)
                            .disabled(saving || queue.busyIds.contains(row.id) || emptied)
                            .accessibilityIdentifier("session.queue.sendNow")
                        }
                        if row.canWithdraw {
                            Button(role: .destructive) {
                                Task {
                                    saving = true
                                    await queue.withdraw(row)
                                    dismiss()
                                }
                            } label: {
                                Label("Withdraw", systemImage: "trash")
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.bordered)
                            .tint(Theme.danger)
                            .foregroundStyle(Theme.dangerText)
                            .disabled(saving || queue.busyIds.contains(row.id))
                            .accessibilityIdentifier("session.queue.withdrawSheet")
                        }
                    }
                    Spacer(minLength: 0)
                } else if let words = strandedWords {
                    strandedView(words)
                } else {
                    ContentUnavailableView(
                        "No longer queued", systemImage: "checkmark.circle",
                        description: Text("This message went out or was withdrawn.")
                    )
                }
            }
            .padding(16)
            .navigationTitle("Queued message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        if changed || strandedWords != nil { askDiscard = true } else { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let row else { return }
                        Task { await save(row) }
                    }
                    .disabled(!changed || saving || !(row?.canEdit ?? false))
                    .accessibilityIdentifier("session.queue.save")
                }
            }
        }
        .presentationBackground(Color(.systemBackground))
        .interactiveDismissDisabled(changed || strandedWords != nil)
        .alert("Interrupt the agent?", isPresented: $askInterrupt) {
            Button("Keep waiting", role: .cancel) {}
            Button("Interrupt & send", role: .destructive) {
                if let row { Task { await sendNow(row) } }
            }
        } message: {
            Text("It stops what it is doing right now, and this message goes in as its next turn.")
        }
        .alert("Discard your changes?", isPresented: $askDiscard) {
            Button(strandedWords == nil ? "Keep editing" : "Keep my words", role: .cancel) {}
            Button(strandedWords == nil ? "Discard changes" : "Discard them", role: .destructive) { dismiss() }
        } message: {
            Text(strandedWords == nil ? "Your changes to this message have not been saved yet."
                                      : "The message already went out; these words would be lost.")
        }
        .onAppear {
            if !seeded, let row {
                text = row.message
                original = row.message
                seeded = true
                queue.notice = nil
            }
        }
        // The row left the queue while the sheet was open (it went out): say so, briefly. Words the person
        // changed and had not saved stay on screen: the message went out as it was, and these are theirs.
        .onChange(of: row == nil) { _, gone in
            guard gone, seeded, !saving else { return }
            if let words = Self.strandedWords(text: text, original: original) {
                strandedWords = words
                return
            }
            Task {
                try? await Task.sleep(for: .seconds(1.2))
                dismiss()
            }
        }
    }

    /// The person's words when the message left the line with changes in the box that were never saved;
    /// nil when there is nothing of theirs to keep (nothing typed, or the box still holds the sent words).
    static func strandedWords(text: String, original: String) -> String? {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty, words != original.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return words
    }

    /// The message left before the change was saved: offer the new words back in the message box.
    private func strandedView(_ words: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Already sent", systemImage: "paperplane.fill")
                .font(.headline)
            Text("This message went out before you saved your change, so the agent got the old words. Your new words were not sent.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(words)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityIdentifier("session.queue.stranded.words")
            Button {
                let key = "session:\(queue.sessionId)"
                let now = ComposerDrafts.shared.draft(key)
                ComposerDrafts.shared.setDraft(now.isEmpty ? words : now + "\n" + words, key: key)
                dismiss()
            } label: {
                Label("Put my words in the message box", systemImage: "square.and.pencil")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.tint)
            .accessibilityIdentifier("session.queue.stranded.keep")
            Button(role: .destructive) {
                dismiss()
            } label: {
                Text("Discard them")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("session.queue.stranded.discard")
            Spacer(minLength: 0)
        }
    }

    private func caption(for row: SessionQueuedMessage) -> String {
        if emptied && row.canEdit { return "There is nothing to save or send. Type the message again, or withdraw it." }
        switch row.status {
        case "pending":
            return turnRunning
                ? "It sends by itself when the agent finishes this turn. Tap the words to change them until then."
                : "About to go out."
        case "processing": return "This message is with the agent now."
        case "parked": return "Not sent: you stopped the agent first. Edit it if you like, then send it."
        case "held": return "Waiting for your Mac to come back online."
        default: return ""
        }
    }

    private func save(_ row: SessionQueuedMessage) async {
        saving = true
        defer { saving = false }
        if await queue.edit(row, to: text) { dismiss() }
    }

    private func sendNow(_ row: SessionQueuedMessage) async {
        saving = true
        defer { saving = false }
        // Words edited but not saved go with it: what is on screen is what is sent.
        if changed, row.canEdit, !(await queue.edit(row, to: text)) { return }
        if await queue.sendNow(row, interrupt: turnRunning) { dismiss() }
    }
}
