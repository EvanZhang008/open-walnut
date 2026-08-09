import SwiftUI

/// Conversation switcher sheet — recent conversations plus "New conversation".
/// Long-press a row for management: rename / pin / delete (Wave-1 endpoints).
struct ConversationListView: View {
    @Environment(ChatStore.self) private var chat
    @Environment(\.dismiss) private var dismiss

    @State private var renameTarget: ConversationSummary?
    @State private var renameDraft = ""
    @State private var deleteTarget: ConversationSummary?
    @State private var actionError: String?

    var body: some View {
        NavigationStack {
            List {
                Button {
                    chat.startNewConversation()
                    dismiss()
                } label: {
                    Label {
                        Text("New conversation")
                            .fontWeight(.medium)
                            .foregroundStyle(Theme.tint)
                    } icon: {
                        Image(systemName: "plus.circle.fill")
                            .foregroundStyle(Theme.tint)
                    }
                }

                ForEach(chat.conversations) { conversation in
                    Button {
                        chat.select(conversation.id)
                        dismiss()
                    } label: {
                        row(conversation)
                    }
                    .foregroundStyle(.primary)
                    .contextMenu { rowMenu(conversation) }
                    .accessibilityIdentifier("chat.conversation.\(conversation.id)")
                }
            }
            .listStyle(.plain)
            .navigationTitle("Conversations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .refreshable {
                await chat.refreshConversations()
            }
            .overlay {
                if chat.conversations.isEmpty && !chat.loadingList {
                    ContentUnavailableView(
                        "No conversations yet",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Start one and it will appear here.")
                    )
                }
            }
            .alert("Rename Conversation", isPresented: Binding(
                get: { renameTarget != nil },
                set: { if !$0 { renameTarget = nil } }
            )) {
                TextField("Title", text: $renameDraft)
                Button("Cancel", role: .cancel) { renameTarget = nil }
                Button("Rename") {
                    let target = renameTarget
                    let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    renameTarget = nil
                    guard let target, !title.isEmpty else { return }
                    Task { actionError = await chat.renameConversation(target.id, title: title) }
                }
            }
            .alert("Delete Conversation?", isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            )) {
                Button("Cancel", role: .cancel) { deleteTarget = nil }
                Button("Delete", role: .destructive) {
                    let target = deleteTarget
                    deleteTarget = nil
                    guard let target else { return }
                    Task { actionError = await chat.deleteConversation(target.id) }
                }
            } message: {
                Text("This permanently deletes \"\(deleteTarget?.title ?? "this conversation")\" and its history.")
            }
            .alert("Couldn't update conversation", isPresented: Binding(
                get: { actionError != nil },
                set: { if !$0 { actionError = nil } }
            )) {
                Button("OK", role: .cancel) { actionError = nil }
            } message: {
                Text(actionError ?? "")
            }
        }
    }

    /// Long-press actions: rename / pin / delete. The v1 list has no pinned
    /// flag, so both pin directions are offered (idempotent server-side).
    @ViewBuilder
    private func rowMenu(_ conversation: ConversationSummary) -> some View {
        Button {
            renameDraft = conversation.title ?? ""
            renameTarget = conversation
        } label: {
            Label("Rename", systemImage: "pencil")
        }
        Button {
            Task { actionError = await chat.setConversationPinned(conversation.id, pinned: true) }
        } label: {
            Label("Pin", systemImage: "pin")
        }
        Button {
            Task { actionError = await chat.setConversationPinned(conversation.id, pinned: false) }
        } label: {
            Label("Unpin", systemImage: "pin.slash")
        }
        Divider()
        Button(role: .destructive) {
            deleteTarget = conversation
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    private func row(_ conversation: ConversationSummary) -> some View {
        let isActive = conversation.id == chat.activeID
        return HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title ?? "New conversation")
                    .fontWeight(isActive ? .semibold : .regular)
                    .foregroundStyle(isActive ? Theme.tint : .primary)
                    .lineLimit(1)
                Text("\(conversation.messageCount) messages")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Text(Self.relativeTime(conversation.updatedAt))
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    /// Shared formatter (audit IO-7): this runs per ROW per render, and an
    /// ISO8601DateFormatter allocation alone is ~133µs — the parse itself
    /// rides WalnutTask.parseISO's memo cache (Models.swift).
    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    static func relativeTime(_ iso: String) -> String {
        guard let date = WalnutTask.parseISO(iso) else { return "" }
        // The active conversation's timestamp can be ~now or slightly ahead
        // (server clock skew) — RelativeDateTimeFormatter renders that as the
        // future tense "in 0s". Clamp anything under a minute to "now".
        if abs(date.timeIntervalSinceNow) < 60 { return "now" }
        return Self.relative.localizedString(for: date, relativeTo: .now)
    }
}
