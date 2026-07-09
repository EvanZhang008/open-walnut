import SwiftUI

/// Conversation switcher sheet — recent conversations plus "New conversation".
struct ConversationListView: View {
    @Environment(ChatStore.self) private var chat
    @Environment(\.dismiss) private var dismiss

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

    static func relativeTime(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso)
            ?? ISO8601DateFormatter().date(from: iso)
        else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: .now)
    }
}
