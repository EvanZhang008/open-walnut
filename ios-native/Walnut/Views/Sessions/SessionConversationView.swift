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
    @Environment(\.scenePhase) private var scenePhase

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
        .task { await store.open() }
        .onDisappear { store.close() }
        .onChange(of: scenePhase) { _, phase in
            // Kill the SSE stream + poll loop on background — live URLSession
            // tasks block graceful termination and get the app watchdog-killed
            // (0x8BADF00D). Revive and catch up on foreground.
            if phase == .background {
                store.suspend()
            } else if phase == .active {
                store.resume()
            }
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

    /// Bottom-pinned transcript. `defaultScrollAnchor(.bottom)` handles the
    /// initial position and streaming growth, but stops pinning after the
    /// user's first manual scroll — so turn-end reconciles (rows swapped for
    /// canonical ids/heights) yanked the viewport up and stranded the reader.
    /// A bottom sentinel tracks whether the user IS at the bottom; the store
    /// bumps `scrollToBottomSignal` after layout-shifting mutations and the
    /// view re-pins via ScrollViewReader — only when they were at the bottom.
    private var messageList: some View {
        ScrollViewReader { proxy in
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
                        liveRow
                    }
                    // Sentinel: its on-screen visibility IS the "user is at the
                    // bottom" state the store consults before re-pinning.
                    Color.clear
                        .frame(height: 1)
                        .id("bottom-sentinel")
                        .onAppear { store.viewIsAtBottom = true }
                        .onDisappear { store.viewIsAtBottom = false }
                }
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await store.open() }
            .onChange(of: store.scrollToBottomSignal) {
                // Next runloop tick so the mutated rows have laid out; animated
                // to read as "settling", not a teleport.
                Task { @MainActor in
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo("bottom-sentinel", anchor: .bottom)
                    }
                }
            }
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
