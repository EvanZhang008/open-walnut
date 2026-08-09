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
                if chat.pendingQuestion {
                    questionBanner
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
                // Stop rides the toolbar only while a turn is running — aborts
                // the agent's active turn(s) via POST /conversations/:id/stop.
                if chat.streaming || chat.sending {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            Task { await chat.stopTurn() }
                        } label: {
                            Image(systemName: "stop.circle.fill")
                                .foregroundStyle(Theme.danger)
                        }
                        .accessibilityIdentifier("chat.stop")
                    }
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

    /// Banner shown while the agent is blocked on a user_ask question. The
    /// composer doubles as the answer field (send routes to POST /answer);
    /// this banner explains the state and offers a one-tap skip.
    private var questionBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "questionmark.bubble.fill")
                .font(.subheadline)
                .foregroundStyle(Theme.tint)
            Text("\(chat.activeAgentName) has a question — reply below to answer.")
                .font(.footnote)
                .lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Theme.tint.opacity(0.10))
        .accessibilityIdentifier("chat.questionBanner")
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

/// Butler chat message list on the UIKit timeline engine (Timeline/):
/// parsing/measurement on a background actor, O(visible) main-thread attach.
/// Replaced the ScrollView+LazyVStack body — same structural fix as
/// SessionConversationView (0x8BADF00D full-tree-diff class). The
/// KeyboardRepinMachine stays as the behavior layer; its repin pulses the
/// timeline's scroll signal.
private struct MessageListView: View {
    @Environment(ChatStore.self) private var chat
    @State private var keyboardGeometryFrozen = false
    @State private var programmaticGeometryFrozen = false
    @State private var programmaticFreezeTask: Task<Void, Never>?
    @State private var repinSignal = 0

    var body: some View {
        ChatTimelineBody(
            chat: chat,
            repinSignal: repinSignal,
            keyboardGeometryFrozen: { keyboardGeometryFrozen || programmaticGeometryFrozen },
            onRefresh: {
                if let id = chat.activeID {
                    await chat.loadMessages(id)
                }
                await chat.refreshConversations()
            }
        )
        .modifier(KeyboardBottomRepin(
            keyboardGeometryFrozen: $keyboardGeometryFrozen,
            isPinned: { chat.bottomPinned },
            programmaticFrozen: { programmaticGeometryFrozen },
            repin: { scrollToBottom() }
        ))
        .onDisappear {
            // Clear the flag too: cancelling the reset task alone would leave
            // a retained (tab-switched) view permanently geometry-frozen.
            programmaticFreezeTask?.cancel()
            programmaticGeometryFrozen = false
        }
    }

    private func scrollToBottom() {
        programmaticGeometryFrozen = true
        repinSignal += 1
        programmaticFreezeTask?.cancel()
        programmaticFreezeTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            programmaticGeometryFrozen = false
        }
    }
}

/// Shimmering ellipsis row shown while the agent thinks / runs tools.
struct ThinkingRow: View {
    let activity: String?
    @Environment(\.scenePhase) private var scenePhase
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
        .animation(
            scenePhase == .active ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : nil,
            value: phase
        )
        .onAppear { phase = scenePhase == .active }
        .onChange(of: scenePhase) { _, phaseState in
            phase = phaseState == .active
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }
}
