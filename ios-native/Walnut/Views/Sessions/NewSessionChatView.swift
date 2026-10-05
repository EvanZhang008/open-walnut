import SwiftUI

/// Start a session by CHATTING: a chat page whose composer is already there, with
/// the folder/host and model pickable above it, and whose first message launches
/// the session and then continues in it.
///
/// This is the phone's version of the web console's draft column
/// (`DraftLaunchBar.tsx` + the composer beneath it), and it keeps that layout's
/// two decisions:
///  - **Where it runs sits directly ABOVE the composer**: the quick-folder row,
///    then the folder/host pill LEFT-ALIGNED on the last row, so "where does this
///    run" stays glued to the message that answers it.
///  - **The permission mode and the model live IN the composer's bottom row**
///    (`launchPills`), where a live session's mode and model pills sit and where
///    the web draft puts them, inside the floating card the way ChatGPT draws
///    its composer (user, 2026-10-03). They used to be two more pills up in the
///    folder row.
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
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
                    // Nothing here can HOLD a send made during the create call, and a
                    // second one would create a second session, so the button stays
                    // greyed while `creating` (see `ComposerPrimaryAction`). A create
                    // that fails still returns the words to the draft, because
                    // `launch` answers false and the composer restores on false.
                    busyAcceptsSend: false,
                    // Draft is keyed to the DRAFT, not to a session id that
                    // doesn't exist yet, so text typed before launching survives
                    // a path change and a backgrounding.
                    draftKey: "draft:new-session",
                    // No live model pill (`modelSource`): a draft has no session to
                    // switch. Its own model and mode pills take that seat, and both
                    // choices RIDE the create call.
                    controlsAccessory: AnyView(launchPills),
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

    /// The page above the composer. Not a transcript (there is none yet): load
    /// errors, the task link, and the full path only when the launch bar below
    /// does not already show the folder. Otherwise the same quiet empty state the
    /// Chat tab shows before its first message: a full phone screen with nothing
    /// on it reads as "still loading" (QA), where the web draft's narrow column
    /// can simply stay blank.
    private var introOrStatus: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if showsEmptyState {
                    VStack(spacing: 8) {
                        Image(systemName: "terminal")
                            .font(.system(size: 36, weight: .light))
                            .foregroundStyle(.quaternary)
                        Text("Your first message starts the session")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 120)
                    .accessibilityIdentifier("newSessionChat.emptyState")
                }
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
                // The full path, ONLY when nothing else on the page says where the
                // session runs: no quick-folder row, or a folder picked by hand that
                // is not in it. With the row up, the highlighted chip and the folder
                // pill already answer that, and a monospaced path above them was the
                // same fact a third time (user feedback, 2026-10-03).
                if showsPathSummary {
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
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
    }

    /// The launch bar, the web draft's two rows in the web's order: the quick-folder
    /// row on top (the row whose CONTENT changes most between launches, so it never
    /// sits where a fixed control is aimed for), then the folder/host pill,
    /// LEFT-ALIGNED and glued to the composer card below it. On the page's own
    /// color, like the card's surroundings: the rows sit on the page, above the box.
    private var launchBar: some View {
        VStack(spacing: 0) {
            if !quickDirs.isEmpty {
                quickFolderRow
                Divider().padding(.horizontal, 12)
            }
            pillRow
        }
        .background(ComposerCard.backdrop, ignoresSafeAreaEdges: [])
    }

    /// Quick folders: the most-used and most-recent directories, one tap each,
    /// labelled by BASENAME (a host only when two chips share a name). The
    /// caption is what keeps the chips and the pills under them from reading as
    /// one wall of buttons. The current folder's chip renders active and stays
    /// in the row: picks never reshuffle it.
    private var quickFolderRow: some View {
        let chips = quickDirs
        return VStack(alignment: .leading, spacing: 4) {
            // The placeholder ink, not `.secondary`: at caption2 on the bar the
            // system secondary measured 3.4:1 in light mode (QA), and this caption
            // is the one thing that says the row below is folders.
            Text("Quick folders")
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(FieldPlaceholder.ink)
                .padding(.horizontal, 12)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(chips) { dir in
                        Button {
                            cwd = dir.cwd
                            host = dir.host
                            didPreselect = true
                        } label: {
                            Text(PathRanking.quickChipLabel(
                                dir, among: chips,
                                hostLabel: options?.hosts.first { $0.alias == dir.host }?.label
                            ))
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                isCurrent(dir) ? Theme.tintSoft : Color(.tertiarySystemFill),
                                in: Capsule()
                            )
                            // The web's accent border on the lit chip. Without it
                            // the tinted fill sat 1.04:1 from the bar in dark mode
                            // and the chosen folder was the FAINTEST chip in the row.
                            .overlay(
                                Capsule().strokeBorder(Theme.tint, lineWidth: isCurrent(dir) ? 1 : 0)
                            )
                            .foregroundStyle(isCurrent(dir) ? Theme.tint : .primary)
                        }
                        .accessibilityIdentifier("newSessionChat.quickDir")
                        .accessibilityAddTraits(isCurrent(dir) ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 12)
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 6)
        .accessibilityIdentifier("newSessionChat.quickFolders")
    }

    private var pillRow: some View {
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
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    // MARK: - Model and mode, on the composer's bottom row

    /// The draft's permission-mode and model pills, handed to the composer for its
    /// bottom row in the live row's order (mode, then model). The same `PillChip`
    /// a live session's pills are, so the row reads like one: the mode pill's
    /// menu opens above it (with the keyboard up the first tap puts the keyboard
    /// away; a SwiftUI `Menu` in this row lost taps over the keyboard, see
    /// `ComposerBar.plusButton`), and the model pill opens the "Select model"
    /// sheet. Side by side, stacked at the accessibility sizes, like the live
    /// pills (`ComposerBar.pillLayout`).
    private var launchPills: some View {
        let stacked = dynamicTypeSize.isAccessibilitySize
        // A pick while the create call runs would be a choice the launch already
        // went without.
        let state: ComposerControlsModel.PillState = creating ? .waiting : .ready
        return ComposerBar.pillLayout(stacked: stacked) {
            PillChip(
                text: mode.label,
                glyph: .chevron,
                state: state,
                wraps: stacked,
                rawID: false,
                menu: Self.modeMenu(selected: mode),
                menuID: "launchMode",
                accessibilityID: "newSessionChat.modePill",
                accessibilityLabel: "Permission mode: \(mode.label)",
                onSelect: { choice, _ in pick(choice) },
                onPresentedChange: { _, _ in }
            )
            PillChip(
                text: modelLabel,
                glyph: .chevron,
                state: state,
                wraps: stacked,
                rawID: false,
                menu: Self.modelMenu(selected: model),
                menuID: "launchModel",
                accessibilityID: "newSessionChat.modelPill",
                accessibilityLabel: "Model: \(model == nil ? "Default" : modelLabel)",
                onSelect: { choice, _ in pick(choice) },
                onPresentedChange: { _, _ in },
                // The same "Select model" sheet as a live composer's model pill.
                sheetTitle: ComposerModelPill.sheetTitle
            )
            .layoutPriority(1)
        }
    }

    private var modelLabel: String { Self.modelLabel(model) }

    private func pick(_ choice: PillMenu.Choice) {
        switch choice {
        case .model(let id):
            model = id.isEmpty ? nil : id
        case .mode(let raw):
            if let picked = NewSessionSheet.PermissionMode(rawValue: raw) { mode = picked }
        case .effort, .retry, .none:
            return
        }
    }

    /// Aliases the launch route accepts (`resolveModelSwitchValue`). A draft has
    /// no session, so there is no live per-host catalog to read: these are the
    /// stable ids, and the live catalog takes over in the session's own pill.
    static let launchModels: [(String, String)] = [
        ("opus", "Opus"),
        ("sonnet", "Sonnet"),
        ("haiku", "Haiku"),
    ]

    /// The model pill's words: the picked alias, or "Default model" for none.
    static func modelLabel(_ model: String?) -> String {
        model.flatMap { id in launchModels.first { $0.0 == id }?.1 } ?? "Default model"
    }

    /// The draft's menus never go stale (they are rebuilt from two @State values,
    /// and a pick lands synchronously), so one fixed token serves every one.
    private static let draftMenuToken = ComposerControlsModel.MenuToken(generation: 0, version: 0)

    /// Default, then the stable aliases; the current pick checked. Default is the
    /// empty id (`pick` maps it back to nil, which sends no model).
    static func modelMenu(selected: String?) -> PillMenu {
        let items = [PillMenu.Item(
            title: "Default", choice: .model(""), checked: selected == nil,
            accessibilityID: "newSessionChat.model.default"
        )] + launchModels.map { id, label in
            PillMenu.Item(
                title: label, choice: .model(id), checked: selected == id,
                accessibilityID: "newSessionChat.model.\(id)"
            )
        }
        let current = items.first(where: \.checked)?.title
        return PillMenu(sections: [.init(title: ComposerControlsModel.heading("Model", current: current), items: items)],
                        token: draftMenuToken)
    }

    /// Every permission mode, the current one checked, headed like the live
    /// composer's mode menu ("Mode: Bypass").
    static func modeMenu(selected: NewSessionSheet.PermissionMode) -> PillMenu {
        let items = NewSessionSheet.PermissionMode.allCases.map { m in
            PillMenu.Item(
                title: m.label, choice: .mode(m.rawValue), checked: m == selected,
                accessibilityID: "newSessionChat.mode.\(m.rawValue)"
            )
        }
        return PillMenu(sections: [.init(title: ComposerControlsModel.heading("Mode", current: selected.label), items: items)],
                        token: draftMenuToken)
    }

    private func pill(_ text: String, icon: String, active: Bool) -> some View {
        HStack(spacing: 4) {
            // Decorative: VoiceOver otherwise reads the symbol's name ("Move"
            // for the folder) ahead of the pill's own words.
            Image(systemName: icon).font(.system(size: 10, weight: .semibold))
                .accessibilityHidden(true)
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

    /// The web's quick-folder membership (`quickDirsFor`): most-used, then most
    /// recent of the rest, one chip per directory. Not the server list's head: that
    /// carried the same folder twice when the wire had two rows for it.
    private var quickDirs: [SessionLaunchOptions.Dir] {
        PathRanking.quickDirs(options?.dirs ?? [])
    }

    private func isCurrent(_ dir: SessionLaunchOptions.Dir) -> Bool {
        PathRanking.pathChipKey(dir: dir) == PathRanking.pathChipKey(cwd: cwd, host: host.isEmpty ? nil : host)
    }

    /// Spell the full path out only when no chip is lit for it.
    private var showsPathSummary: Bool {
        Self.showsPathSummary(cwd: cwd, host: host, quickDirs: quickDirs)
    }

    /// The quiet empty state: only while nothing else has a claim on the page.
    private var showsEmptyState: Bool {
        !showsPathSummary && !creating && loadFailed == nil && (taskId ?? "").isEmpty
    }

    static func showsPathSummary(cwd: String, host: String, quickDirs: [SessionLaunchOptions.Dir]) -> Bool {
        guard !cwd.isEmpty else { return false }
        let key = PathRanking.pathChipKey(cwd: cwd, host: host.isEmpty ? nil : host)
        return !quickDirs.contains { PathRanking.pathChipKey(dir: $0) == key }
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
            loadFailed = "This cloud companion is too old to create sessions. Update it, or connect to your primary box directly."
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
        // Preselect the FIRST QUICK CHIP exactly once, and never over a choice
        // the user already made (the empty-cache apply doesn't latch, so the live
        // fetch behind it can still seed a real suggestion). The chip row and the
        // preselect must agree: a preselect from the server list's head that is
        // not in the row would open the page with no chip lit AND the full path.
        guard !didPreselect, cwd.isEmpty, let top = Self.preselectedDir(opts.dirs) else { return }
        cwd = top.cwd
        host = top.host
        didPreselect = true
    }

    /// The folder a fresh draft opens on: the first quick chip, so the lit chip and
    /// the preselect are one fact; the listing's head only when the row is empty.
    static func preselectedDir(_ dirs: [SessionLaunchOptions.Dir]) -> SessionLaunchOptions.Dir? {
        PathRanking.quickDirs(dirs).first ?? dirs.first
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
            // Same ladder as the form-shaped launcher, including the reason
            // `bridge_offline` prefers the server's sentence (see that function).
            createError = NewSessionSheet.createErrorMessage(code: code, serverMessage: msg)
            return false
        } catch {
            createError = error.localizedDescription
            return false
        }
    }
}
