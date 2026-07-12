import SwiftUI

/// Chat tab — drops straight into the most recent conversation. Toolbar:
/// history (conversation switcher sheet) on the left, agent picker in the
/// title (tap the agent name, like the console's agents dropdown), mode badge
/// on the right.
struct ChatView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ChatStore.self) private var chat

    @State private var showConversations = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !connection.online {
                    OfflineBanner(text: "Offline — showing cached data")
                }
                if let error = chat.errorMessage {
                    ErrorBanner(text: error) { chat.errorMessage = nil }
                }
                MessageListView()
            }
            // safeAreaInset (not a VStack sibling) so the bar rides the
            // keyboard: the keyboard grows the bottom safe area and the inset
            // content stays above it. A plain VStack child does NOT get that
            // treatment when the scroll view is bottom-anchored.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ComposerView()
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    agentTitleMenu
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showConversations = true
                    } label: {
                        Image(systemName: "clock")
                    }
                    .accessibilityIdentifier("chat.history")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    StatusBadge()
                }
            }
            .sheet(isPresented: $showConversations) {
                ConversationListView()
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    /// Title = agent name (+ chevron when more agents exist). Tapping shows
    /// the agent menu — the mobile mirror of the console's agents dropdown.
    private var agentTitleMenu: some View {
        Menu {
            ForEach(chat.agents) { agent in
                Button {
                    chat.switchAgent(agent.id)
                } label: {
                    if agent.id == chat.activeAgentID {
                        Label(agent.name, systemImage: "checkmark")
                    } else {
                        Text(agent.name)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                VStack(spacing: 0) {
                    Text(chat.activeAgentName)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let title = conversationSubtitle {
                        Text(title)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                // Cap the label — a long conversation title must not overflow
                // the principal toolbar slot into the side buttons.
                .frame(maxWidth: 210)
                if chat.agents.count > 1 {
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(chat.agents.count <= 1)
        .accessibilityIdentifier("chat.agentMenu")
    }

    /// The conversation's own title, when it differs from the agent name.
    private var conversationSubtitle: String? {
        guard let id = chat.activeID,
              let title = chat.conversations.first(where: { $0.id == id })?.title,
              !title.isEmpty
        else { return nil }
        return title
    }
}

/// Scrollable message list, newest pinned at the visual bottom.
///
/// Relies on iOS 17's `defaultScrollAnchor(.bottom)`: content starts anchored
/// at the bottom and stays pinned while streaming grows it. No manual
/// `scrollTo` — with a LazyVStack of variable-height rows a programmatic jump
/// lands on estimated (wrong) offsets and fights the anchor.
private struct MessageListView: View {
    @Environment(ChatStore.self) private var chat

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if chat.hasOlder {
                    Button("Load earlier messages") {
                        Task { await chat.loadOlder() }
                    }
                    .font(.footnote)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                if chat.messages.isEmpty && !chat.loadingMessages && !chat.streaming {
                    emptyState
                }
                ForEach(chat.messages) { message in
                    MessageRow(
                        message: message,
                        onRetry: { Task { await chat.retry(message) } },
                        onDiscard: { chat.discardFailed(message) }
                    )
                }
                if chat.streaming {
                    liveRow
                }
            }
            .padding(.vertical, 12)
        }
        .defaultScrollAnchor(.bottom)
        .redacted(reason: chat.loadingMessages && chat.messages.isEmpty ? .placeholder : [])
        .scrollDismissesKeyboard(.interactively)
        .refreshable {
            if let id = chat.activeID {
                await chat.loadMessages(id)
            }
            await chat.refreshConversations()
        }
    }

    /// Live turn: streamed text so far + the current tool/thinking activity.
    private var liveRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !chat.streamText.isEmpty {
                MessageRow(message: ChatMessage(
                    id: "__live__", role: "assistant", text: chat.streamText, createdAt: "", kind: nil
                ))
            }
            ThinkingRow(activity: chat.activity)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("Your butler is listening")
                .font(.headline)
            Text("Ask anything — tasks, notes, or what happened today.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 120)
    }
}

/// Shimmering ellipsis row shown while the agent thinks / runs tools.
struct ThinkingRow: View {
    let activity: String?
    @State private var phase = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: activity == nil || activity == "Thinking" ? "sparkles" : "wrench.and.screwdriver")
                .font(.caption)
            Text(activity.map { $0 == "Thinking" ? "Thinking…" : "\($0)…" } ?? "Thinking…")
                .font(.footnote)
        }
        .foregroundStyle(.secondary)
        .opacity(phase ? 0.35 : 1)
        .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: phase)
        .onAppear { phase = true }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }
}
