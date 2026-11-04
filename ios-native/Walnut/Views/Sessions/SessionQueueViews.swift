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

    /// Rows listed in the strip; the rest are one tap away in the list.
    static let visibleRows = 3

    var body: some View {
        if queue.hasRows {
            VStack(alignment: .leading, spacing: 0) {
                header
                ForEach(queue.rows.prefix(Self.visibleRows)) { row in
                    rowView(row)
                }
                if queue.rows.count > Self.visibleRows {
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
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ComposerCard.fill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color(uiColor: .separator).opacity(0.6), lineWidth: 0.5)
            )
            .padding(.horizontal, ComposerCard.sideInset)
            .padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("session.queue.strip")
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "tray.full")
                .font(.caption.weight(.semibold))
            Text("Queued")
                .font(.footnote.weight(.semibold))
            Text("\(queue.rows.count)")
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Theme.tintSoft, in: Capsule())
                .foregroundStyle(Theme.tint)
            Spacer(minLength: 8)
            Text(turnRunning ? "Goes out when this turn ends" : "Going out now")
                .font(.caption)
                .lineLimit(1)
        }
        .foregroundStyle(Theme.secondaryOnCard)
        .padding(.horizontal, 14)
        .padding(.top, 9)
        .padding(.bottom, 3)
        .accessibilityElement(children: .combine)
    }

    private func rowView(_ row: SessionQueuedMessage) -> some View {
        HStack(spacing: 0) {
            Button {
                onOpen(QueueRowRef(id: row.id))
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.message)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if let note = row.statusNote {
                        Text(note)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(row.status == "processing" ? Theme.success : Theme.warning)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 14)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(row.message)
            .accessibilityHint("Opens it to edit, send now or withdraw")
            .accessibilityIdentifier("session.queue.row.\(row.id)")

            if queue.busyIds.contains(row.id) {
                ProgressView().controlSize(.small).frame(width: 44, height: 44)
            } else if row.canWithdraw {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    Task { await queue.withdraw(row) }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Theme.secondaryOnCard)
                        .frame(width: 44, height: 44)
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
    @FocusState private var focused: Bool

    private var row: SessionQueuedMessage? { queue.rows.first { $0.id == rowID } }

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
                            .disabled(saving || queue.busyIds.contains(row.id))
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
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
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
        switch row.status {
        case "pending":
            return turnRunning
                ? "Goes out when this turn ends. Edit it until then."
                : "About to go out."
        case "processing": return "This message is being delivered now."
        case "parked": return "Set aside, for example by a Stop. Send now puts it back in line."
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
