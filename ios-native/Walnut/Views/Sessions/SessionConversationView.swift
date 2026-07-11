import SwiftUI

/// Full-screen conversation page for one Claude Code session — the mobile
/// mirror of the console's session view. Renders the transcript tail as chat
/// bubbles, a live streaming row while the agent works, and a composer that
/// sends text INTO the session (POST /sessions/:id/messages).
///
/// Cloned from ChatView's skeleton: bottom-anchored ScrollView + LazyVStack,
/// safeAreaInset composer. The info button opens SessionInfoSheet with the
/// session's Details / Task / About metadata.
struct SessionConversationView: View {
    let session: WalnutSession

    @State private var store: SessionConversationStore
    @State private var showInfo = false

    init(session: WalnutSession) {
        self.session = session
        _store = State(initialValue: SessionConversationStore(session: session))
    }

    var body: some View {
        VStack(spacing: 0) {
            if store.offline {
                OfflineBanner(text: "Mac offline — showing the last synced transcript")
            }
            if let error = store.errorMessage {
                ErrorBanner(text: error) { store.errorMessage = nil }
            }
            messageList
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerBar(
                placeholder: "Message this session",
                disabled: !store.canSend,
                disabledNotice: store.composerNotice,
                onSend: { text in await store.send(text) }
            )
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(session.displayTitle)
                    .font(.headline)
                    .lineLimit(1)
                    .frame(maxWidth: 240)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showInfo = true
                } label: {
                    Image(systemName: "info.circle")
                }
                .accessibilityIdentifier("session.info")
            }
        }
        .sheet(isPresented: $showInfo) {
            SessionInfoSheet(session: session, processStatus: store.processStatus)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .task { await store.open() }
        .onDisappear { store.close() }
    }

    private var messageList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                if store.transcriptMissing && store.messages.isEmpty {
                    emptyState
                }
                ForEach(store.messages) { message in
                    MessageRow(message: message)
                }
                if store.streaming {
                    liveRow
                }
            }
            .padding(.vertical, 12)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.open() }
    }

    /// Live turn: streamed text so far + the current tool/thinking activity.
    private var liveRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !store.liveText.isEmpty {
                MessageRow(message: ChatMessage(
                    id: "__live__", role: "assistant", text: store.liveText, createdAt: "", kind: nil
                ))
            }
            ThinkingRow(activity: store.activity)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "terminal")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("No transcript yet")
                .font(.headline)
            Text("Send a message to pick up where this session left off.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 100)
        .padding(.horizontal, 32)
    }
}
