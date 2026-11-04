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

    var body: some View {
        if queue.hasRows || queue.withdrawn != nil {
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
                if queue.hasRows {
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
                Button(action: onShowAll) {
                    Text("Show all \(queue.rows.count)")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.tint)
                        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                        .padding(.horizontal, 14)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("session.queue.showAll")
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

    private var header: some View {
        // One line when it fits; the status drops under the title at large text sizes
        // instead of being cut short.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                title
                Spacer(minLength: 8)
                headline.lineLimit(1)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) { title }
                headline
            }
        }
        .foregroundStyle(Theme.secondaryOnCard)
        .padding(.horizontal, 14)
        .padding(.top, 9)
        .padding(.bottom, 3)
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
                        Text(row.message)
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
            .accessibilityLabel(row.message)
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
                        .contentShape(Capsule())
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
            Text(gone.wasSetAside ? "Withdrawn \u{00B7} Undo returns it to the box" : "Message withdrawn")
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
                                Task { await sendNow(row) }
                            } label: {
                                Label(turnRunning ? "Interrupt & send now" : "Send now", systemImage: "bolt.fill")
                                    .font(.body.weight(.semibold))
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Theme.tint)
                            .foregroundStyle(Theme.onTint)
                            .disabled(saving || queue.busyIds.contains(row.id) || emptied)
                            .accessibilityIdentifier("session.queue.sendNow")
                        }
                        if row.canWithdraw {
                            Button(role: .destructive) {
                                Task {
                                    await queue.withdraw(row)
                                    dismiss()
                                }
                            } label: {
                                Label("Withdraw", systemImage: "trash")
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.bordered)
                            .tint(Theme.danger)
                            .disabled(saving || queue.busyIds.contains(row.id))
                            .accessibilityIdentifier("session.queue.withdrawSheet")
                        }
                    }
                    Spacer(minLength: 0)
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
                        if changed { askDiscard = true } else { dismiss() }
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
        .interactiveDismissDisabled(changed)
        .alert("Discard your changes?", isPresented: $askDiscard) {
            Button("Keep editing", role: .cancel) {}
            Button("Discard changes", role: .destructive) { dismiss() }
        } message: {
            Text("Your changes to this message have not been saved yet.")
        }
        .onAppear {
            if !seeded, let row {
                text = row.message
                seeded = true
                queue.notice = nil
            }
        }
        // The row left the queue while the sheet was open (it went out): say so, briefly.
        .onChange(of: row == nil) { _, gone in
            guard gone, seeded, !saving else { return }
            Task {
                try? await Task.sleep(for: .seconds(1.2))
                dismiss()
            }
        }
    }

    private func caption(for row: SessionQueuedMessage) -> String {
        if emptied && row.canEdit { return "There is nothing to save or send. Type the message again, or withdraw it." }
        switch row.status {
        case "pending":
            return turnRunning
                ? "Waiting to go in. You can edit it until it does."
                : "About to go out."
        case "processing": return "This message is with the agent now."
        case "parked": return "Not sent: a Stop set it aside. Edit it if you like, then send it."
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
        // Words edited but not saved go with it: what is on screen is what is sent.
        if changed, row.canEdit, !(await queue.edit(row, to: text)) { return }
        if await queue.sendNow(row, interrupt: turnRunning) { dismiss() }
    }
}
