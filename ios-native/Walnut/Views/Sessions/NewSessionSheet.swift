import SwiftUI

/// Create a Claude Code session: pick where it runs (this Mac / any configured
/// remote host, including a cloud box), pick or type the working path, and
/// optionally give it a first message. Launching from a task links the new
/// session to it. On success the sheet dismisses and hands the pre-seeded
/// session back to the presenter, which pushes the conversation view.
struct NewSessionSheet: View {
    /// Present from a task to link the session to it; nil = standalone launch.
    var task: WalnutTask? = nil
    /// Called after a successful create, right before dismissal.
    let onCreated: (WalnutSession) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(TasksStore.self) private var tasks

    private let api = WalnutAPI()

    /// Permission modes the CLI accepts, in safest→loosest order. Raw values
    /// are the wire contract (POST /api/v1/sessions `mode`); `bypass` is the
    /// server default and matches the web launcher's behavior.
    enum PermissionMode: String, CaseIterable, Identifiable {
        // Full CLI set. `dontAsk` and `auto` are camelCase on the wire — they are
        // the CLI's own spellings, so the raw values must not be lowercased.
        case plan, `default`, dontAsk, accept, auto, bypass
        var id: String { rawValue }
        var label: String {
            switch self {
            case .plan: return "Plan"
            case .default: return "Default"
            case .dontAsk: return "Don't Ask"
            case .accept: return "Accept Edits"
            case .auto: return "Auto"
            case .bypass: return "Bypass"
            }
        }
        var blurb: String {
            switch self {
            case .plan: return "Read-only: the agent proposes a plan first."
            case .default: return "Asks before anything sensitive."
            case .dontAsk: return "Never prompts — denies whatever isn't pre-approved."
            case .accept: return "File edits are auto-accepted; commands still ask."
            case .auto: return "Classifies each action and auto-allows the safe ones."
            case .bypass: return "Full autonomy — no permission prompts."
            }
        }
    }

    @State private var options: SessionLaunchOptions?
    @State private var loadFailed: String?
    /// Non-nil = the form works but Start does not (see `LaunchOptionsFailure`).
    /// Separate from `loadFailed` because it is NOT an either/or with the form:
    /// this one rides above it and changes nothing else about the sheet.
    @State private var startBlockedReason: String?
    @State private var selectedHost: String = ""   // "" = the primary box
    @State private var path: String = ""
    @State private var message: String = ""
    @State private var mode: PermissionMode = .bypass
    @State private var creating = false
    @State private var createError: String?

    /// Path suggestions for the selected host, best first (server pre-sorts).
    private var suggestions: [SessionLaunchOptions.Dir] {
        (options?.dirs ?? []).filter { $0.host == selectedHost }
    }

    /// Icon distinguishing where the session will run: the Mac itself, a
    /// cloud box, or any other SSH remote. Cloud detection is a label/alias
    /// heuristic — good enough for a picker glyph, never load-bearing.
    static func hostIcon(alias: String, label: String) -> String {
        if alias.isEmpty { return "laptopcomputer" }
        let hay = (alias + " " + label).lowercased()
        return hay.contains("cloud") || hay.contains("ec2") ? "cloud" : "server.rack"
    }

    // hasPrefix("/") mirrors the server's absolute-path gate: a relative path
    // would be accepted as 201 (spawn is async) and die later as an opaque
    // session error, so both ends reject it up front.
    private var canCreate: Bool {
        !creating && path.trimmingCharacters(in: .whitespaces).hasPrefix("/")
    }

    var body: some View {
        NavigationStack {
            Form {
                if let error = loadFailed {
                    unavailableSection(error)
                } else {
                    if let startBlockedReason {
                        startBlockedSection(startBlockedReason)
                    }
                    hostSection
                    pathSection
                    modeSection
                    messageSection
                    if let createError {
                        Section {
                            Label(createError, systemImage: "exclamationmark.triangle.fill")
                                .font(.subheadline)
                                .foregroundStyle(Theme.danger)
                        }
                    }
                }
            }
            .navigationTitle(task == nil ? "New Session" : "New Session for Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.disabled(creating)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if creating {
                        ProgressView()
                    } else {
                        Button("Start") { Task { await create() } }
                            .fontWeight(.semibold)
                            .disabled(!canCreate)
                            .accessibilityIdentifier("newSession.start")
                    }
                }
            }
            .task { await loadOptions() }
            // Mid-create dismissal would orphan the launch stash and skip the
            // conversation push (the created session would look "lost" until
            // the list refreshes) — hold the sheet for the ~1s the POST takes.
            .interactiveDismissDisabled(creating)
        }
    }

    // MARK: - Sections

    private var hostSection: some View {
        Section("Run on") {
            if let options {
                Picker("Host", selection: $selectedHost) {
                    ForEach(options.hosts) { host in
                        Label(host.label, systemImage: Self.hostIcon(alias: host.alias, label: host.label))
                            .tag(host.alias)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("newSession.host")
            } else {
                HStack {
                    ProgressView()
                    Text("Loading hosts…").foregroundStyle(.secondary)
                }
            }
        }
    }

    private var modeSection: some View {
        Section {
            Picker("Permissions", selection: $mode) {
                ForEach(PermissionMode.allCases) { m in
                    Text(m.label).tag(m)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("newSession.mode")
        } header: {
            Text("Permission Mode")
        } footer: {
            Text(mode.blurb)
        }
    }

    private var pathSection: some View {
        Section {
            TextField("/path/to/project", text: $path)
                .font(.system(.subheadline, design: .monospaced))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("newSession.path")
            // prefix(8): the server sends up to 30 (all hosts pooled); eight
            // rows is what fits a .medium detent without burying the mode and
            // message sections below the fold.
            ForEach(suggestions.prefix(8)) { dir in
                Button {
                    path = dir.cwd
                } label: {
                    HStack {
                        Image(systemName: "clock.arrow.circlepath")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(dir.cwd)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.head)
                            .foregroundStyle(path == dir.cwd ? Theme.tint : .primary)
                        Spacer()
                        if path == dir.cwd {
                            Image(systemName: "checkmark")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.tint)
                        } else if let ago = Self.relativeLastUsed(dir.lastUsed) {
                            Text(ago)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text("Working Path")
        } footer: {
            if suggestions.isEmpty && options != nil {
                Text("No recent paths on this host yet — type one.")
            }
        }
    }

    private var messageSection: some View {
        Section {
            TextField("Optional — leave empty to start idle", text: $message, axis: .vertical)
                .lineLimit(3...6)
                .accessibilityIdentifier("newSession.message")
        } header: {
            Text("First Message")
        } footer: {
            if let task {
                Text("The session will be linked to “\(task.title)”.")
            }
        }
    }

    /// The warning that leads the form when Start cannot work right now.
    ///
    /// Non-blocking on purpose: every field below still does its job, and a user
    /// may well be filling this in *while* walking over to open the laptop lid.
    /// What it must not do is arrive late — as `createError`, after the host, the
    /// path and the whole first message have been typed — which is exactly what
    /// the 2026-09-17 report described.
    ///
    /// Same warning idiom this app already uses for "a human has to deal with
    /// this": `exclamationmark.triangle.fill` beside stacked text in
    /// `Theme.warning` (`PermissionRequestCard`, `LetterReaderView`'s decision
    /// card, this sheet's own `createError` row). `Theme.warning`, not
    /// `Theme.danger`: nothing has failed yet.
    ///
    /// An `HStack` rather than a `Label`, for ONE measured reason: a `Label`
    /// merges its content into a single accessibility element, which swallows the
    /// button whole — automation could not find it and VoiceOver could not reach
    /// it. The icon is decorative either way, so it is hidden and the two lines
    /// carry the message.
    private func startBlockedSection(_ reason: String) -> some View {
        Section {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Sessions can't start right now")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.warning)
                        .accessibilityIdentifier("newSession.startBlocked")
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    // The one thing the user can do from here besides wait. Start
                    // is the other, and it stays enabled — this sheet warns, it
                    // does not decide.
                    Button("Check again") { Task { await loadOptions() } }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.tint)
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("newSession.startBlocked.recheck")
                }
                .multilineTextAlignment(.leading)
                // Wrap, never truncate. The server's sentence carries the one
                // fact the app cannot know — how long the box has been gone —
                // and a truncated line drops exactly that at large text sizes.
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func unavailableSection(_ error: String) -> some View {
        Section {
            VStack(spacing: 10) {
                Image(systemName: "icloud.slash")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Retry") { Task { await loadOptions() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.tint)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
    }

    /// "2h ago"-style stamp for a suggestion row (nil = unparseable).
    static func relativeLastUsed(_ iso: String) -> String? {
        guard let date = WalnutTask.parseISO(iso) else { return nil }
        return date.formatted(.relative(presentation: .named))
    }

    // MARK: - Actions

    // Key carries no server identity: correctness relies on ConnectionStore.
    // disconnect() calling DiskCache.clearAll() when the pairing changes. If
    // in-place server switching is ever added, key this by server URL or the
    // old box's hosts will appear as launch targets (Start → 400 Unknown host).
    private static let optionsCacheKey = "session-launch-options"
    /// Preselect exactly once per sheet — a background refresh must never yank
    /// a host/path the user is already editing.
    @State private var didPreselect = false

    private func loadOptions() async {
        loadFailed = nil
        // Instant paint: hosts + suggestions from the last successful fetch.
        // Hosts/frequent dirs change rarely — showing yesterday's list beats
        // showing a spinner; the live fetch below reconciles in the background.
        if options == nil,
           let cached = await DiskCache.loadAsync(SessionLaunchOptions.self, key: Self.optionsCacheKey) {
            apply(cached)
        }
        do {
            let opts = try await api.sessionLaunchOptions()
            // A fetch that worked PROVES the relay is up, so a warning left from
            // an earlier attempt is now a lie — drop it here, in the success
            // branch, so both entry points (first open and the Check again /
            // Retry refresh) clear it. Deliberately NOT cleared at the top of
            // this function next to `loadFailed`: on a link that is still down
            // that would blink the warning off and back on every refresh.
            startBlockedReason = nil
            DiskCache.save(opts, key: Self.optionsCacheKey)
            apply(opts)
        } catch let APIError.server(_, code, _, _, _) where code == "not_supported_cloud" {
            // Only a PRE-2026-08 cloud server answers this (current replicas
            // relay launch-options to the primary over the bridge). Same two
            // distinct actions as ever: `options = nil` overrides the cached
            // form already painted THIS open; `DiskCache.remove` stops every
            // FUTURE open from flashing a usable-looking form that then flips
            // to unavailable. Neither substitutes for the other.
            options = nil
            DiskCache.remove(key: Self.optionsCacheKey)
            startBlockedReason = nil
            loadFailed = "This cloud companion is too old to create sessions — update it, or connect the app to your primary box directly."
        } catch let APIError.server(_, code, msg, _, _) where code == "session_launch_needs_upgrade" || code == "bridge_offline" {
            // Transient/self-healing cloud-relay states: the daemon upgrades
            // on the next primary reconnect / the bridge redials. Keep the
            // cache (the form is valid once the relay recovers) and say so:
            // either the whole sheet is unavailable with Retry (nothing on
            // screen yet), or the form stays usable under a warning.
            let verdict = Self.launchOptionsFailure(
                code: code, serverMessage: msg, hasOptions: options != nil
            )
            startBlockedReason = verdict.warning
            loadFailed = verdict.blocking
        } catch {
            // With cached options on screen the form still works (host list is
            // near-static); only a truly empty sheet degrades to the error state.
            if options == nil {
                loadFailed = "Couldn't load launch options: \(error.localizedDescription)"
            }
        }
    }

    private func apply(_ opts: SessionLaunchOptions) {
        let previous = options
        options = opts
        // A refresh can drop the currently selected host (disabled/removed) —
        // an unknown selection renders the Picker blank and Start would 400.
        if !selectedHost.isEmpty, !opts.hosts.contains(where: { $0.alias == selectedHost }) {
            // Clear the path too when it was OUR suggestion for the dropped
            // host — otherwise the reset silently retargets "This Mac" with a
            // foreign cwd and the launch dies pre-first-turn. A hand-typed
            // path is the user's own; leave it.
            let wasSuggested = (previous?.dirs ?? []).contains {
                $0.host == selectedHost && $0.cwd == path
            }
            if wasSuggested { path = "" }
            selectedHost = ""
        }
        // Never preselect over something the user already typed: the empty
        // cache apply doesn't latch didPreselect (see below), so the live
        // fetch lands here while they may already be editing.
        guard !didPreselect, path.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        // Preselect the task's own host/path when they exist in this launch:
        // continuing work where the task lives beats the global default.
        // The remembered host must still be offered (it can have been
        // disabled/removed since).
        let taskSession = task.flatMap { t in
            tasks.sessions
                .filter { $0.taskId == t.id }
                .sorted(by: WalnutSession.recencySort)
                .first
        }
        if let taskSession, opts.hosts.contains(where: { $0.alias == taskSession.host }) {
            selectedHost = taskSession.host
            if let cwd = taskSession.cwd, !cwd.isEmpty { path = cwd }
            didPreselect = true
        } else if let top = opts.dirs.first {
            selectedHost = top.host
            path = top.cwd
            didPreselect = true
        }
        // No else-latch: an empty cache apply (zero dirs, no task session)
        // must not burn the one preselect — the live fetch right behind it
        // may carry real suggestions.
    }

    /// Copy for a failed create, from the server's error `code` plus the raw
    /// `message` it sent. Pure and static so the ladder is testable without a
    /// network or a view, and so both launchers (this sheet and
    /// `NewSessionChatView`) answer a given code identically.
    ///
    /// `bridge_offline` PREFERS the server's own sentence, unlike its neighbours,
    /// because the server is the only side that knows how long the primary has been
    /// unreachable. That branch (and the fixed sentence it falls back to) lives in
    /// `BridgeOfflineCopy`, shared with the three control ladders that answer the
    /// same outage. The two upgrade codes keep their client-side wording, because
    /// their server text is diagnostic rather than something to put in front of a
    /// person.
    static func createErrorMessage(code: String, serverMessage: String?) -> String {
        switch code {
        case "not_supported_cloud":
            return "This cloud companion is too old to create sessions — update it, or connect directly to your primary box."
        case "session_launch_needs_upgrade":
            return "Your primary box's daemon needs an update for mobile session launch — it updates automatically on its next reconnect. Try again in a minute."
        case "bridge_offline":
            return BridgeOfflineCopy.message(serverMessage: serverMessage)
        default:
            // Validation 4xx from the primary: its text IS the user-facing answer.
            return serverMessage ?? ""
        }
    }

    /// What a failed launch-options fetch must put on screen: nothing at all, a
    /// warning above a working form, or the whole form replaced.
    struct LaunchOptionsFailure: Equatable {
        /// Replaces the entire form with the retryable unavailable section.
        var blocking: String?
        /// Rides ABOVE a form that stays fully usable.
        var warning: String?
    }

    /// Verdict for the two self-healing relay failures (`bridge_offline`,
    /// `session_launch_needs_upgrade`). Pure and static so every rule below is
    /// testable without a network or a view.
    ///
    /// THE BUG THIS EXISTS TO CLOSE (2026-09-17 report): a user tried to create a
    /// session on a remote host from the phone, over and over, and it failed every
    /// time, while messages to an already-running session kept going through. Their
    /// MacBook was asleep with the lid shut, and sessions are created ON that box.
    /// The sheet said NOTHING: hosts and recent paths are restored from a disk
    /// cache on purpose (a near-static list beats a spinner), so `options` was
    /// non-nil, and the old code dropped the failure on the floor for exactly that
    /// case (`if options == nil`). Two states existed — a working form, and a fully
    /// unavailable sheet — and the state that actually happens is neither: the form
    /// is usable, and Start is doomed. So there are three now.
    ///
    /// `session_launch_needs_upgrade` earns the same warning as `bridge_offline`:
    /// the cloud relay serves the options fetch and the launch through the SAME
    /// `session.launch` bridge command, so a daemon too old to answer one is too
    /// old to answer the other. The failure is equally certain and the harm is
    /// identical (a typed-out prompt thrown away), which is the only thing this
    /// warning is about. They differ in COPY, not in whether to warn: the wording
    /// comes from `createErrorMessage`, so `bridge_offline` prefers the server's
    /// own sentence (only the server knows for how long the box has been gone)
    /// while the upgrade code keeps its client-side wording (its server text is
    /// diagnostic, not something to put in front of a person).
    ///
    /// Sharing that ladder with the create path is deliberate: the pre-flight
    /// warning and the post-Start error are the same fact, and they must not read
    /// like two different problems.
    static func launchOptionsFailure(
        code: String, serverMessage: String?, hasOptions: Bool
    ) -> LaunchOptionsFailure {
        let copy = createErrorMessage(code: code, serverMessage: serverMessage)
        // A usable form: warn, and leave everything else alone.
        guard !hasOptions else { return LaunchOptionsFailure(blocking: nil, warning: copy) }
        // Nothing on screen at all: keep degrading to the unavailable section,
        // still showing the server's raw sentence there. The fallback is only for
        // a server that sent no message — an empty error card explains nothing.
        let server = (serverMessage ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return LaunchOptionsFailure(blocking: server.isEmpty ? copy : server, warning: copy)
    }

    private func create() async {
        // Re-entry guard: `creating` disables the Start button, but a fast
        // double-tap can enqueue two Tasks in the same frame — the flag is the
        // only thing standing between one tap and two sessions.
        guard !creating else { return }
        creating = true
        createError = nil
        defer { creating = false }
        let cwd = path.trimmingCharacters(in: .whitespaces)
        let firstMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let created = try await api.createSession(
                cwd: cwd,
                host: selectedHost,
                message: firstMessage,
                taskId: task?.id,
                // bypass = the server default; send nil so old servers
                // (pre-mode contract) behave identically.
                mode: mode == .bypass ? nil : mode.rawValue
            )
            // Hand the first message to the conversation store so the pushed
            // page shows it (+ a Starting-session row) instantly — the message
            // rides SESSION_START server-side and won't reach the transcript
            // until the CLI spawns. ORDER MATTERS: must run before onCreated —
            // the presenter's navPath.append pushes the conversation view,
            // whose store consumes the stash in open(); stashing after would
            // race the consume on the same MainActor turn.
            SessionLaunchContext.stash(sessionId: created.sessionId, message: firstMessage)
            AppLog.info("session", "created session", [
                "sessionId": created.sessionId, "host": selectedHost, "mode": mode.rawValue,
            ])
            // Synthesize the row locally — the projection sweep may lag a
            // few seconds; the conversation view only needs id/host/status.
            // processStatus "idle" matches the server's pre-seeded record
            // (quick-start deliberately seeds 'idle' — 'running' would show a
            // phantom working badge on a CLI that hasn't spawned yet).
            let now = ISO8601DateFormatter().string(from: Date())
            let session = WalnutSession(
                id: created.sessionId,
                title: created.title,
                taskId: created.taskId,
                taskTitle: task?.title ?? created.title,
                project: task?.project,
                host: selectedHost,
                processStatus: "idle",
                model: nil,
                mode: mode == .bypass ? nil : mode.rawValue,
                startedAt: now,
                lastActiveAt: now,
                messageCount: 0,
                cwd: cwd,
                pinned: nil,
                focusTier: nil,
                description: nil
            )
            // Refresh the projection so the list catches up in the background.
            Task { await tasks.loadSessions() }
            onCreated(session)
            dismiss()
        } catch let APIError.server(_, code, msg, _, _) {
            createError = Self.createErrorMessage(code: code, serverMessage: msg)
        } catch {
            createError = error.localizedDescription
        }
    }
}
