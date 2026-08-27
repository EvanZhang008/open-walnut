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

    /// Optional on purpose: WalnutTests host this page without the app
    /// environment; task affordances just hide there (fixture has no taskId).
    @Environment(TasksStore.self) private var tasksStore: TasksStore?

    @State private var store: SessionConversationStore
    /// Wave-1 lifecycle control plane (permissions / restart / terminate /
    /// rename / archive) — separate from the conversation store on purpose:
    /// zero writes into the timeline rendering path.
    @State private var lifecycle: SessionLifecycleController
    @State private var showInfo = false
    @State private var showControls = false
    /// Full task detail for the linked task — every task capability in place.
    @State private var showTask = false
    // Wave-2 extras — presented from the session menu.
    @State private var showQueue = false
    @State private var showPlan = false
    @State private var showSideQuestions = false
    @State private var showFiles = false
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
                    answering: lifecycle.answeringIds.contains(request.requestId),
                    onRespond: { allow in
                        Task { await lifecycle.respondPermission(request, allow: allow) }
                    },
                    // AskUserQuestion: the ALLOW response carries the answers.
                    onAnswer: { answers in
                        Task { await lifecycle.respondPermission(request, allow: true, answers: answers) }
                    },
                    // Refusing the ask is a deny with the reason the model reads.
                    onDismissQuestions: {
                        Task {
                            await lifecycle.respondPermission(
                                request, allow: false, message: "User dismissed the questions"
                            )
                        }
                    }
                )
            }
            messageList
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerBar(
                placeholder: "Message this session",
                disabled: !store.canSend,
                disabledNotice: store.composerNotice,
                draftKey: "session:\(session.id)",
                // The model pill switches THIS session's model/effort live.
                modelSource: .session(id: session.id),
                fallbackModel: session.model,
                // A live session's exec host is a fact, not a choice (the CLI is
                // already running there), so it shows as provenance in the `+`.
                // Picking a host happens at CREATION (NewSessionChatView).
                hostProvenance: .session(hostAlias: session.host, cwd: session.cwd),
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
                sessionMenu
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
        // Every task capability in place — a session IS a task. The sheet's
        // own controller fetches the full record, so a placeholder row (task
        // filtered out of the list projection) still opens fully functional.
        .sheet(isPresented: $showTask) {
            if let taskId = session.taskId, tasksStore != nil {
                TaskDetailSheet(task: linkedTask ?? SessionTaskRow.placeholder(id: taskId, title: session.taskTitle))
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
        // Wave-2 extras: queue / plan / side questions / files.
        .sheet(isPresented: $showQueue) {
            SessionQueueSheet(sessionId: session.id)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showPlan) {
            SessionPlanSheet(sessionId: session.id)
        }
        .sheet(isPresented: $showSideQuestions) {
            SideQuestionsSheet(sessionId: session.id)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showFiles) {
            SessionFilesSheet(session: session)
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

    /// THE toolbar entry — one ellipsis menu unifying what used to be three
    /// buttons (controls sliders / info / lifecycle menu). Sections top→down:
    /// frequent (Controls incl. fork, Info, linked Task), lifecycle
    /// (Restart/Retry/Rename/Archive), tools (Queue/Plan/Side Questions/
    /// Files), destructive (Terminate). Retry only shows for error/stopped
    /// sessions (the server 400s otherwise).
    private var sessionMenu: some View {
        Menu {
            // Frequent: the controls sheet (model / effort / mode / fork).
            Button {
                showControls = true
            } label: {
                Label("Session Controls", systemImage: "slider.horizontal.3")
            }
            .accessibilityIdentifier("session.controls")
            Button {
                showInfo = true
            } label: {
                Label("Session Info", systemImage: "info.circle")
            }
            .accessibilityIdentifier("session.info")
            if session.taskId != nil {
                Button {
                    showTask = true
                } label: {
                    Label("Task Details", systemImage: "checklist")
                }
                .accessibilityIdentifier("session.taskDetails")
            }
            Divider()
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
            // Wave-2 extras — read/withdraw the send queue, view the plan,
            // ask side questions, browse the working directory.
            Button {
                showQueue = true
            } label: {
                Label("Queued Messages", systemImage: "tray.full")
            }
            .accessibilityIdentifier("session.queue")
            Button {
                showPlan = true
            } label: {
                Label("View Plan", systemImage: "list.bullet.clipboard")
            }
            .accessibilityIdentifier("session.plan")
            Button {
                showSideQuestions = true
            } label: {
                Label("Side Questions", systemImage: "questionmark.bubble")
            }
            .accessibilityIdentifier("session.sideQuestions")
            Button {
                showFiles = true
            } label: {
                Label("Browse Files", systemImage: "folder")
            }
            .accessibilityIdentifier("session.files")
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
        .accessibilityIdentifier("session.menu")
    }

    /// The linked task's LIVE row from the store (events feed keeps it fresh);
    /// nil when the session has no task, the store is absent (tests), or the
    /// row fell out of the list projection (TaskDetailSheet still opens off a
    /// placeholder — its controller fetches the full record by id).
    private var linkedTask: WalnutTask? {
        guard let taskId = session.taskId else { return nil }
        return tasksStore?.tasks.first { $0.id == taskId }
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
            previewHost: session.host,
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
