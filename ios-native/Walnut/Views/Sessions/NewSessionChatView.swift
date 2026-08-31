import SwiftUI

/// Start a session by CHATTING: a chat page whose composer is already there, with
/// the folder/host and model pickable above it, and whose first message launches
/// the session and then continues in it.
///
/// This is the phone's version of the web console's draft column
/// (`DraftLaunchBar.tsx` + the composer beneath it), and it keeps that layout's
/// two decisions:
///  - **The launch config sits directly ABOVE the composer**, closest to the verb
///    it configures, with the cwd/host pill and the project pill LEFT-ALIGNED on
///    the last row so "where does this run" stays glued to the message that
///    answers it.
///  - **The model lives IN the composer's controls row**, exactly where a live
///    session's model pill sits, rather than being asked again up here.
///
/// It replaces the old form-shaped `NewSessionSheet` as the DEFAULT entry (that
/// sheet is still the right shape when launching FROM a task, where the folder is
/// usually inherited and the point is the link). The difference the user asked
/// for: you land in a chat page and pick the path there, instead of filling in a
/// form and then arriving somewhere else.
///
/// Launch contract, unchanged and deliberately: ONE `POST /api/v1/sessions` with
/// `{ cwd, host, message, model, mode }`, exactly what the sheet sent. `201` means
/// ACCEPTED, not spawned, so the first message is stashed through
/// `SessionLaunchContext` (the same handoff the sheet uses) and the conversation
/// page paints it immediately while the CLI comes up.
struct NewSessionChatView: View {
    /// The task this draft is FOR, when it was opened from one (nil = the toolbar's
    /// task-less New Session).
    ///
    /// It rides the create call, and that is a correctness fix rather than a
    /// convenience: this page used to send `taskId: nil` unconditionally, so a draft
    /// reached from a TASK ROW created a session no task points at. On a task that
    /// already had a session — which is exactly what a mis-routed board tap produced
    /// when the server's session list dropped older rows — that is a silent second,
    /// orphan session.
    var taskId: String? = nil
    /// Its title, for the one line that states the link. Display only.
    var taskTitle: String? = nil

    /// Called with the pre-seeded session once the launch is accepted; the
    /// presenter swaps this page for the session's conversation page.
    let onCreated: (WalnutSession) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(TasksStore.self) private var tasks: TasksStore?
    @Environment(ConnectionStore.self) private var connection: ConnectionStore?

    private let api = WalnutAPI()

    @State private var options: SessionLaunchOptions?
    @State private var loadFailed: String?
    @State private var cwd = ""
    @State private var host = ""
    @State private var mode: NewSessionSheet.PermissionMode = .bypass
    @State private var model: String?
    @State private var showPathPicker = false
    @State private var creating = false
    @State private var createError: String?
    @State private var didPreselect = false

    /// Same key the sheet uses, so a cached launch-options payload is shared
    /// rather than fetched twice.
    private static let optionsCacheKey = "session-launch-options"

    var body: some View {
        VStack(spacing: 0) {
            if let createError {
                ErrorBanner(text: createError) { self.createError = nil }
            }
            introOrStatus
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                launchBar
                ComposerBar(
                    placeholder: canLaunch ? "Describe the first task…" : "Pick a folder to start",
                    busy: creating,
                    disabled: !canLaunch,
                    disabledNotice: canLaunch ? nil : "Choose the folder this session runs in.",
                    // Draft is keyed to the DRAFT, not to a session id that
                    // doesn't exist yet, so text typed before launching survives
                    // a path change and a backgrounding.
                    draftKey: "draft:new-session",
                    // No model pill here: a draft has no session yet, so there is
                    // nothing to switch live. The model is chosen in the launch
                    // bar above and RIDES the create call.
                    hostProvenance: connection.map {
                        .chat(status: $0.status, online: $0.online)
                    },
                    onSend: { text, _ in await launch(message: text) }
                )
            }
        }
        .navigationTitle("New Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") { dismiss() }.disabled(creating)
            }
        }
        .sheet(isPresented: $showPathPicker) {
            SessionPathPicker(
                options: options,
                initialPath: cwd,
                initialHost: host
            ) { pickedCwd, pickedHost in
                cwd = pickedCwd
                host = pickedHost
                didPreselect = true
            }
        }
        .task { await loadOptions() }
    }

    // MARK: - Body content

    /// The page above the composer. Not a transcript (there is none yet): it
    /// states what starting will DO, which is the honest content for a draft.
    private var introOrStatus: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let loadFailed {
                    Label(loadFailed, systemImage: "icloud.slash")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button("Retry") { Task { await loadOptions() } }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("newSessionChat.retry")
                    Text("You can still type an absolute path in the folder picker and start.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if creating {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Starting the session…").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                // States the LINK when this draft came from a task. It is not
                // decoration: the same fact is what stops the launch creating an
                // orphan session, so showing it is how the user can see that the
                // draft is about the row they tapped and not a stray new task.
                if let taskId, !taskId.isEmpty {
                    Label(
                        taskTitle.map { "This session will be linked to “\($0)”" }
                            ?? "This session will be linked to the task you started from",
                        systemImage: "link"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("newSessionChat.linkedTask")
                }
                if !cwd.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Your first message starts a session in")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(cwd)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                        Text(hostSentence)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("newSessionChat.summary")
                }
                // Quick folders: the top-ranked recents, one tap each. Same idea as
                // the web's quick-folder chip row (label = the folder BASENAME),
                // which is the row that makes the common case zero-navigation.
                if !quickDirs.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Quick folders")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(quickDirs) { dir in
                                    Button {
                                        cwd = dir.cwd
                                        host = dir.host
                                        didPreselect = true
                                    } label: {
                                        Text(PathRanking.pathBasename(dir.cwd))
                                            .font(.caption.weight(.medium))
                                            .lineLimit(1)
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 6)
                                            .background(
                                                isCurrent(dir) ? Theme.tintSoft : Color(.tertiarySystemFill),
                                                in: Capsule()
                                            )
                                            .foregroundStyle(isCurrent(dir) ? Theme.tint : .primary)
                                    }
                                    .accessibilityIdentifier("newSessionChat.quickDir")
                                }
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
    }

    /// The launch bar: folder/host pill, model pill, mode pill. Directly above the
    /// composer and LEFT-ALIGNED, matching the web draft's fixed last row.
    private var launchBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Button {
                    showPathPicker = true
                } label: {
                    pill(
                        PathRanking.pathLabel(cwd: cwd, host: host.isEmpty ? nil : host, hostLabel: hostLabel),
                        icon: "folder",
                        active: !cwd.isEmpty
                    )
                }
                .accessibilityIdentifier("newSessionChat.pathPill")

                Menu {
                    Section("Model") {
                        Button {
                            model = nil
                        } label: {
                            if model == nil { Label("Default", systemImage: "checkmark") } else { Text("Default") }
                        }
                        // The launch route validates against the shared model-id
                        // set, so a draft (which has no session and therefore no
                        // live catalog) offers the stable aliases rather than
                        // inventing ids the server would 400.
                        ForEach(Self.launchModels, id: \.0) { id, label in
                            Button {
                                model = id
                            } label: {
                                if model == id { Label(label, systemImage: "checkmark") } else { Text(label) }
                            }
                        }
                    }
                } label: {
                    pill(model.flatMap { id in
                        Self.launchModels.first { $0.0 == id }?.1
                    } ?? "Default model", icon: "cpu", active: model != nil)
                }
                .accessibilityIdentifier("newSessionChat.modelPill")

                Menu {
                    ForEach(NewSessionSheet.PermissionMode.allCases) { m in
                        Button {
                            mode = m
                        } label: {
                            if m == mode { Label(m.label, systemImage: "checkmark") } else { Text(m.label) }
                        }
                    }
                } label: {
                    pill(mode.label, icon: "lock.shield", active: mode != .bypass)
                }
                .accessibilityIdentifier("newSessionChat.modePill")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .background(.bar)
    }

    /// Aliases the launch route accepts (`resolveModelSwitchValue`). A draft has
    /// no session, so there is no live per-host catalog to read: these are the
    /// stable ids, and the live catalog takes over in the session's own pill.
    static let launchModels: [(String, String)] = [
        ("opus", "Opus"),
        ("sonnet", "Sonnet"),
        ("haiku", "Haiku"),
    ]

    private func pill(_ text: String, icon: String, active: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 10, weight: .semibold))
            Text(text).font(.caption.weight(.medium)).lineLimit(1)
        }
        .foregroundStyle(active ? Theme.tint : .secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(active ? Theme.tintSoft : Color(.tertiarySystemFill), in: Capsule())
        .contentShape(Capsule())
    }

    // MARK: - Derived

    private var canLaunch: Bool { !creating && cwd.hasPrefix("/") }

    private var hostLabel: String? {
        guard !host.isEmpty else { return nil }
        return options?.hosts.first { $0.alias == host }?.label
    }

    private var hostSentence: String {
        host.isEmpty ? "on this Mac" : "on \(hostLabel ?? host)"
    }

    /// Top recents, best-first (the server already scores them). Six fits one
    /// horizontal row's worth of taps without becoming a second list.
    private var quickDirs: [SessionLaunchOptions.Dir] {
        Array((options?.dirs ?? []).prefix(6))
    }

    private func isCurrent(_ dir: SessionLaunchOptions.Dir) -> Bool {
        PathRanking.pathChipKey(dir: dir) == PathRanking.pathChipKey(cwd: cwd, host: host.isEmpty ? nil : host)
    }

    // MARK: - Load

    private func loadOptions() async {
        loadFailed = nil
        if options == nil,
           let cached = await DiskCache.loadAsync(SessionLaunchOptions.self, key: Self.optionsCacheKey) {
            apply(cached)
        }
        do {
            let opts = try await api.sessionLaunchOptions()
            DiskCache.save(opts, key: Self.optionsCacheKey)
            apply(opts)
        } catch let APIError.server(_, code, msg, _, _)
            where code == "session_launch_needs_upgrade" || code == "bridge_offline" {
            // Self-healing relay states: keep the cached form usable, say the
            // honest thing only when nothing is on screen.
            if options == nil { loadFailed = msg }
        } catch let APIError.server(_, code, _, _, _) where code == "not_supported_cloud" {
            options = nil
            DiskCache.remove(key: Self.optionsCacheKey)
            loadFailed = "This cloud companion is too old to create sessions — update it, or connect to your primary box directly."
        } catch {
            // Degrade, don't block: the picker still accepts a typed path.
            if options == nil {
                loadFailed = "Couldn't load recent folders: \(error.localizedDescription)"
            }
        }
    }

    private func apply(_ opts: SessionLaunchOptions) {
        options = opts
        // A refresh must never yank a host the user already chose.
        if !host.isEmpty, !opts.hosts.contains(where: { $0.alias == host }) {
            host = ""
            cwd = ""
            didPreselect = false
        }
        // Preselect the top-ranked recent exactly once, and never over a choice
        // the user already made (the empty-cache apply doesn't latch, so the live
        // fetch behind it can still seed a real suggestion).
        guard !didPreselect, cwd.isEmpty, let top = opts.dirs.first else { return }
        cwd = top.cwd
        host = top.host
        didPreselect = true
    }

    // MARK: - Launch

    /// One create call carrying everything picked here, then hand the pre-seeded
    /// session to the presenter. Returns false on failure so the composer keeps
    /// the text (its no-loss contract) instead of clearing it into the void.
    private func launch(message: String) async -> Bool {
        guard !creating, canLaunch else { return false }
        creating = true
        createError = nil
        defer { creating = false }
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let created = try await api.createSession(
                cwd: cwd,
                host: host,
                message: text,
                // The originating task, when this draft came from one. `nil` (the
                // toolbar entrance) keeps the server's own behaviour: it creates the
                // task that owns the new session.
                taskId: taskId,
                // bypass is the server default; send nil so an older server
                // behaves identically.
                mode: mode == .bypass ? nil : mode.rawValue,
                model: model
            )
            // ORDER MATTERS (same as NewSessionSheet): stash BEFORE onCreated,
            // because the presenter's push mounts the conversation view whose
            // store consumes the stash in open().
            SessionLaunchContext.stash(sessionId: created.sessionId, message: text)
            AppLog.info("session", "created session from chat draft", [
                "sessionId": created.sessionId, "host": host, "mode": mode.rawValue,
                "model": model ?? "default",
                // Logged because "which task owns this session" is the thing that used
                // to be silently nothing on every draft.
                "taskId": created.taskId, "linkedTaskId": taskId ?? "-",
            ])
            let now = ISO8601DateFormatter().string(from: Date())
            let session = WalnutSession(
                id: created.sessionId,
                title: created.title,
                taskId: created.taskId,
                // The task's real title when this draft was about one; the server's
                // echo (which for a task-less draft IS the new task's title) otherwise.
                taskTitle: taskTitle ?? created.title,
                project: nil,
                host: host,
                // 'idle' matches the server's pre-seeded record: 'running' would
                // paint a working badge on a CLI that hasn't spawned.
                processStatus: "idle",
                model: model,
                mode: mode == .bypass ? nil : mode.rawValue,
                startedAt: now,
                lastActiveAt: now,
                messageCount: 0,
                cwd: cwd,
                pinned: nil,
                focusTier: nil,
                description: nil
            )
            if let tasks { Task { await tasks.loadSessions() } }
            onCreated(session)
            return true
        } catch let APIError.server(_, code, msg, _, _) {
            switch code {
            case "not_supported_cloud":
                createError = "This cloud companion is too old to create sessions — update it, or connect directly to your primary box."
            case "session_launch_needs_upgrade":
                createError = "Your primary box's daemon needs an update for mobile session launch — it updates on its next reconnect. Try again in a minute."
            case "bridge_offline":
                createError = "The primary box isn't reachable from the cloud right now — try again when it reconnects."
            default:
                createError = msg
            }
            return false
        } catch {
            createError = error.localizedDescription
            return false
        }
    }
}
