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
    /// Wave-1 lifecycle control plane (permissions / restart / terminate /
    /// rename / archive) — separate from the conversation store on purpose:
    /// zero writes into the timeline rendering path.
    @State private var lifecycle: SessionLifecycleController
    @State private var showInfo = false
    @State private var showControls = false
    @State private var showRename = false
    @State private var renameDraft = ""
    /// Non-nil = terminate hit 409 cron_owner; confirm to force.
    @State private var forceTerminateMessage: String?
    /// Non-nil pushes the forked session's conversation onto the enclosing stack.
    @State private var forkedSession: WalnutSession?
    @State private var keyboardGeometryFrozen = false
    @State private var programmaticGeometryFrozen = false
    @State private var programmaticFreezeTask: Task<Void, Never>?
    /// Extra scroll-to-bottom pulses (keyboard repins) fed into the timeline
    /// engine alongside the store's own scrollToBottomSignal.
    @State private var repinSignal = 0

    init(session: WalnutSession) {
        self.session = session
        _store = State(initialValue: SessionConversationStore(session: session))
        _lifecycle = State(initialValue: SessionLifecycleController(sessionId: session.id))
    }

    /// WalnutTests seam: host the REAL page around a pre-seeded store (event-
    /// storm and first-paint freeze gates drive the store directly). Product
    /// code always uses init(session:).
    init(session: WalnutSession, store: SessionConversationStore) {
        self.session = session
        _store = State(initialValue: store)
        _lifecycle = State(initialValue: SessionLifecycleController(sessionId: session.id))
    }

    var body: some View {
        VStack(spacing: 0) {
            if store.offline {
                OfflineBanner(text: "\(store.hostLabel) unreachable — showing the last synced transcript")
            }
            if let error = store.errorMessage {
                ErrorBanner(text: error) { store.errorMessage = nil }
            }
            if let error = lifecycle.errorMessage {
                ErrorBanner(text: error) { lifecycle.errorMessage = nil }
            }
            if let confirmation = lifecycle.confirmation {
                ConfirmationBanner(text: confirmation) { lifecycle.confirmation = nil }
            }
            ForEach(lifecycle.pendingPermissions) { request in
                PermissionRequestCard(
                    request: request,
                    answering: lifecycle.answeringIds.contains(request.requestId)
                ) { allow in
                    Task { await lifecycle.respondPermission(request, allow: allow) }
                }
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
                // Model / effort / fork — the mobile mirror of the console's
                // session controls (additive /api/v1 endpoints).
                Button {
                    showControls = true
                } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                .accessibilityIdentifier("session.controls")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showInfo = true
                } label: {
                    Image(systemName: "info.circle")
                }
                .accessibilityIdentifier("session.info")
            }
            ToolbarItem(placement: .topBarTrailing) {
                lifecycleMenu
            }
        }
        .sheet(isPresented: $showInfo) {
            SessionInfoSheet(session: session, processStatus: store.processStatus)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showControls) {
            SessionControlsSheet(session: session) { forked in
                forkedSession = forked
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        // A successful fork pushes the new session's conversation on top of
        // this one (the enclosing stack already knows WalnutSession pages).
        .navigationDestination(item: $forkedSession) { forked in
            SessionConversationView(session: forked)
        }
        // Rename prompt (PATCH title) — a plain alert keeps this lightweight.
        .alert("Rename Session", isPresented: $showRename) {
            TextField("Title", text: $renameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty else { return }
                Task { await lifecycle.rename(title) }
            }
        }
        // 409 cron_owner ladder: confirm, then force-terminate.
        .alert("Session owns scheduled routines", isPresented: Binding(
            get: { forceTerminateMessage != nil },
            set: { if !$0 { forceTerminateMessage = nil } }
        )) {
            Button("Cancel", role: .cancel) { forceTerminateMessage = nil }
            Button("Force Terminate", role: .destructive) {
                forceTerminateMessage = nil
                Task { _ = await lifecycle.terminate(force: true) }
            }
        } message: {
            Text(forceTerminateMessage ?? "")
        }
        // Freeze reports name THIS session (8-char prefix of the uuid) so a
        // field freeze can be tied back to a specific giant transcript.
        .freezeScreen("session:\(session.id.prefix(8))")
        .task {
            // Route image fetches (/api/v1/media) to this session's exec host.
            MediaContext.currentSessionID = session.id
            lifecycle.start()
            await store.open()
        }
        .onDisappear {
            if MediaContext.currentSessionID == session.id { MediaContext.currentSessionID = nil }
            // Clear the flag too: cancelling the reset task alone would leave
            // a retained (nav-stacked) view permanently geometry-frozen.
            programmaticFreezeTask?.cancel()
            programmaticGeometryFrozen = false
            lifecycle.stop()
            store.close()
        }
    }

    /// Lifecycle actions menu — Restart / Retry / Rename / Archive / Terminate.
    /// Retry only shows for error/stopped sessions (the server 400s otherwise).
    private var lifecycleMenu: some View {
        Menu {
            Button {
                Task {
                    if await lifecycle.restart() {
                        // Fresh CLI: reattach the stream + reload the transcript.
                        await store.open()
                    }
                }
            } label: {
                Label("Restart", systemImage: "arrow.clockwise")
            }
            .accessibilityIdentifier("session.restart")
            if SessionStatus(store.processStatus) == .error || SessionStatus(store.processStatus) == .stopped {
                Button {
                    Task {
                        if await lifecycle.retry() { await store.open() }
                    }
                } label: {
                    Label("Retry", systemImage: "arrow.uturn.forward")
                }
                .accessibilityIdentifier("session.retry")
            }
            Button {
                renameDraft = session.title ?? session.rowTitle
                showRename = true
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            .accessibilityIdentifier("session.rename")
            Button {
                Task { await lifecycle.setArchived(true) }
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .accessibilityIdentifier("session.archive")
            Divider()
            Button(role: .destructive) {
                Task {
                    if case .needsForce(let message) = await lifecycle.terminate() {
                        forceTerminateMessage = message
                    }
                }
            } label: {
                Label("Terminate", systemImage: "stop.circle")
            }
            .accessibilityIdentifier("session.terminate")
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(lifecycle.acting)
        .accessibilityIdentifier("session.lifecycleMenu")
    }

    /// Nav-bar subtitle: live status + where it runs + the model when known
    /// ("Running · clouddev · Opus 4.8") — the model half doubles as the
    /// visible current-model indicator for the controls sheet.
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
        var parts = status.isEmpty ? [host] : [status, host]
        if let model = session.model, !model.isEmpty {
            parts.append(WalnutSession.shortModelName(model))
        }
        return parts.joined(separator: " · ")
    }

    /// UIKit timeline engine (Timeline/): all parsing/measurement happens on
    /// a background actor; the main thread only attaches pre-laid-out rows.
    /// This replaced the ScrollView+LazyVStack body — the structural fix for
    /// the 0x8BADF00D full-tree-diff watchdog kills (builds 34-36). The
    /// KeyboardRepinMachine stays: it is behavior, not rendering; its repin
    /// feeds the timeline's scroll signal instead of a ScrollPosition.
    private var messageList: some View {
        SessionTimelineBody(
            store: store,
            repinSignal: repinSignal,
            keyboardGeometryFrozen: { keyboardGeometryFrozen || programmaticGeometryFrozen },
            onRefresh: { await store.open() }
        )
        .modifier(KeyboardBottomRepin(
            keyboardGeometryFrozen: $keyboardGeometryFrozen,
            isPinned: { store.bottomPinned },
            programmaticFrozen: { programmaticGeometryFrozen },
            repin: { scrollToBottom() }
        ))
    }

    /// Freeze geometry briefly so this programmatic move cannot masquerade as
    /// a user drag and clear the sticky bottom intent. (The timeline engine
    /// also holds its own internal 250ms freeze around the scroll.)
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
