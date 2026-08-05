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
    @State private var scrollPos = ScrollPosition(edge: .bottom)
    @State private var keyboardGeometryFrozen = false
    @State private var programmaticGeometryFrozen = false
    @State private var programmaticFreezeTask: Task<Void, Never>?

    init(session: WalnutSession) {
        self.session = session
        _store = State(initialValue: SessionConversationStore(session: session))
    }

    var body: some View {
        VStack(spacing: 0) {
            if store.offline {
                OfflineBanner(text: "\(store.hostLabel) unreachable — showing the last synced transcript")
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
                draftKey: "session:\(session.id)",
                onSend: { text, images in await store.send(text, images: images) }
            )
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(session.rowTitle)
                        .font(.headline)
                        .lineLimit(1)
                    Text(navSubtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
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
        .task {
            // Route image fetches (/api/v1/media) to this session's exec host.
            MediaContext.currentSessionID = session.id
            await store.open()
        }
        .onDisappear {
            if MediaContext.currentSessionID == session.id { MediaContext.currentSessionID = nil }
            // Clear the flag too: cancelling the reset task alone would leave
            // a retained (nav-stacked) view permanently geometry-frozen.
            programmaticFreezeTask?.cancel()
            programmaticGeometryFrozen = false
            store.close()
        }
    }

    /// Nav-bar subtitle: live status + where it runs ("Running · clouddev").
    private var navSubtitle: String {
        let status: String
        switch SessionStatus(store.processStatus) {
        case .running: status = "Running"
        case .idle: status = "Idle"
        case .error: status = "Error"
        case .stopped: status = "Ended"
        case .unknown: status = ""
        }
        let host = session.isLocal ? "Mac" : session.host
        return status.isEmpty ? host : "\(status) · \(host)"
    }

    /// ScrollPosition is the sole authority: its bottom edge association follows
    /// streaming growth while sticky user intent decides mutation re-pins.
    private var messageList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if store.messages.isEmpty && !store.streaming {
                    // Loading until the first transcript answer; empty state
                    // for BOTH "no tail exported" (404) and "tail exists but
                    // has zero renderable rows" — otherwise a 200-with-empty
                    // transcript painted a fully blank page.
                    if store.loadedOnce || store.transcriptMissing {
                        emptyState
                    } else {
                        loadingState
                    }
                }
                ForEach(store.messages) { message in
                    MessageRow(
                        message: message,
                        onRetry: { Task { await store.retry(message) } },
                        onDiscard: { store.discardFailed(message) }
                    )
                }
                if store.streaming {
                    // Leaf view so the 8Hz liveText/activity flush
                    // re-renders ONLY this row, never the sibling ForEach
                    // of stable history rows (see ChatView.LiveTurnRow).
                    SessionLiveTurnRow(store: store)
                }
            }
            .padding(.vertical, 12)
        }
        .scrollPosition($scrollPos, anchor: .bottom)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.open() }
        .modifier(ScrollBottomTracking(
            isPinned: { store.bottomPinned },
            setPinned: { store.bottomPinned = $0 },
            geometryFrozen: { keyboardGeometryFrozen || programmaticGeometryFrozen }
        ))
        .modifier(KeyboardBottomRepin(
            keyboardGeometryFrozen: $keyboardGeometryFrozen,
            isPinned: { store.bottomPinned },
            repin: { scrollToBottom() }
        ))
        .onChange(of: store.scrollToBottomSignal) {
            scrollToBottom()
        }
    }

    /// Freeze geometry briefly so this programmatic move cannot masquerade as
    /// a user drag and clear the sticky bottom intent.
    private func scrollToBottom() {
        programmaticGeometryFrozen = true
        scrollPos.scrollTo(edge: .bottom)
        programmaticFreezeTask?.cancel()
        programmaticFreezeTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            programmaticGeometryFrozen = false
        }
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading conversation…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 120)
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

/// Live turn for a session: streamed text so far + current tool/thinking
/// activity. Standalone leaf so the high-frequency liveText/activity updates
/// re-render only this row, never the sibling ForEach of history rows.
private struct SessionLiveTurnRow: View {
    let store: SessionConversationStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !store.liveText.isEmpty {
                MessageRow(message: ChatMessage(
                    id: "__live__", role: "assistant", text: store.liveText, createdAt: "", kind: nil
                ))
            }
            ThinkingRow(activity: store.activity)
        }
    }
}
