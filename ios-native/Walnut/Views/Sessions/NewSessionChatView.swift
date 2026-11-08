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

    /// Set by a presenter that offers the text's other exit: "Save as todo" beside send
    /// creates a task from the words (first line the title, the rest its description)
    /// in the picked project, starts nothing, and calls this so the presenter can close
    /// the page. nil = no such exit. A draft about a TASK never offers it: that task
    /// already exists, and a second one would be a duplicate.
    var onSavedAsTodo: (() -> Void)? = nil

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
    @State private var mode: NewSessionSheet.PermissionMode = NewSessionChatView.draftStart(inDemo: DemoMode.isActive).mode
    @State private var model: String?
    /// The user picked the mode / the model here: until then the pills show the project's
    /// launch defaults (`launchDefaults`) and the create call leaves them to the server.
    @State private var modeTouched = false
    @State private var modelTouched = false
    @State private var showPathPicker = false
    @State private var creating = false
    @State private var launchingMessage: String?
    /// The first message's photos and files, uploaded before the create call.
    @State private var uploads = NewSessionUploads()
    /// They go up now: the page may be left (the launch then stops), unlike
    /// during the create call itself.
    @State private var uploading = false
    /// Their upload failed: the message stays on the page with Retry and Remove.
    @State private var launchFailed = false
    @State private var pendingLaunch: PendingLaunch?
    @State private var createError: String?
    @State private var didPreselect = false
    /// New task opened this draft with an email's context: the composer takes the keyboard.
    @State private var contentLink = ContentActionLink.shared
    @State private var composerFocus = 0
    /// The project the new task files under ("" = Inbox, where the server's organize
    /// pass may still offer a home). Only for a task-less draft: a draft about a task
    /// keeps that task's project.
    @State private var project = ""
    @State private var showProjectPicker = false
    /// The Sync pill in a project that syncs to an outside service: Local by default, the web
    /// draft's Sync chip (a launch's task is local unless its creator picks the service).
    @State private var syncLocal = true
    /// The folder the draft itself put in (its preselect), for `picksEdited`.
    @State private var offeredCwd = ""
    @State private var offeredHost = ""
    private let initialMode = NewSessionChatView.draftStart(inDemo: DemoMode.isActive).mode

    /// A pick of his that the launch has not taken: the folder, mode, model, project or sync.
    /// His words are kept in the draft store; these are not, so a push waits for them.
    private var picksEdited: Bool {
        cwd != offeredCwd || host != offeredHost || mode != initialMode || model != nil
            || !project.isEmpty || !syncLocal
    }

    /// Same key the sheet uses, so a cached launch-options payload is shared
    /// rather than fetched twice.
    private static let optionsCacheKey = "session-launch-options"

    var body: some View {
        VStack(spacing: 0) {
            if let createError, !dynamicTypeSize.isAccessibilitySize {
                ErrorBanner(text: createError) { self.createError = nil }
            }
            if let launchingMessage {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        MessageRow(message: launchingRow(launchingMessage))
                        // One card per file, each with its own progress, and once an
                        // upload failed, how far each got with its Retry and Remove.
                        VStack(spacing: 0) {
                            ForEach(uploads.chips(failed: launchFailed), id: \.self) { chip in
                                TimelineFileChipView(
                                    chip: chip, onOpen: { _ in },
                                    onRetry: { Task { _ = await runLaunch(fromComposer: false) } },
                                    onRemove: { id in Task { await removeLaunchFile(id) } }
                                )
                            }
                        }
                        if launchFailed {
                            // At the accessibility sizes the banner is not drawn: the
                            // reason sits here instead.
                            if let createError, dynamicTypeSize.isAccessibilitySize {
                                Text(createError)
                                    .font(.footnote)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.horizontal, 16)
                            }
                            HStack(spacing: 12) {
                                Button("Retry") { Task { _ = await runLaunch(fromComposer: false) } }
                                    .buttonStyle(.borderedProminent)
                                    .accessibilityIdentifier("newSessionChat.retryLaunch")
                                Button("Edit message") { editFailedLaunch() }
                                    .buttonStyle(.bordered)
                                    .accessibilityIdentifier("newSessionChat.editLaunch")
                            }
                            .padding(.horizontal, 16)
                        } else {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text(uploading ? "Uploading…" : "Starting the session…")
                                    .font(.subheadline).foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 16)
                        }
                    }
                    .padding(.vertical, 16)
                }
                .accessibilityIdentifier("newSessionChat.launching")
            } else {
                introOrStatus
            }
        }
        .keyboardSafeComposerContent()
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if launchingMessage == nil && !dynamicTypeSize.isAccessibilitySize { launchBar }
                ComposerBar(
                    placeholder: launchingMessage != nil ? (launchFailed ? "Retry or edit the message above" : "Starting the session…") : canLaunch ? "Describe the first task…" : "Pick a folder to start",
                    busy: creating,
                    // A launch that failed waits for its Retry or Edit above.
                    disabled: !canLaunch || launchFailed,
                    // Not at the accessibility sizes: there the folder pill right
                    // above says "Choose folder…" and the box says "Pick a folder
                    // to start", and this third copy took three more lines of a
                    // bar that already left the page about 30 pt (gate r4, F5).
                    disabledNotice: launchingMessage != nil || canLaunch || dynamicTypeSize.isAccessibilitySize ? nil : Self.folderNotice,
                    // The page names the failed create; a second notice crowds out Retry.
                    showsRefusedNotice: false,
                    maximumInputLines: dynamicTypeSize.isAccessibilitySize ? 2 : 6,
                    // Nothing here can HOLD a send made during the create call, and a
                    // second one would create a second session, so the button stays
                    // greyed while `creating` (see `ComposerPrimaryAction`). A create
                    // that fails still returns the words to the draft, because
                    // `launch` answers false and the composer restores on false.
                    busyAcceptsSend: false,
                    // Draft is keyed to the DRAFT, not to a session id that
                    // doesn't exist yet, so text typed before launching survives
                    // a path change and a backgrounding.
                    draftKey: ContentActionLink.newSessionDraftKey,
                    focusRequest: composerFocus,
                    // No live model pill (`modelSource`): a draft has no session to
                    // switch. Its own model and mode pills take that seat, and both
                    // choices RIDE the create call. At the accessibility sizes they
                    // sit beside the folder pill instead (`pillRow`): stacked here
                    // they made the box about 180 pt taller (gate r4, F5).
                    controlsAccessory: launchingMessage != nil || launchPillsInPillRow ? nil : AnyView(launchPills),
                    hostProvenance: connection.map {
                        .chat(status: $0.status, online: $0.online)
                    },
                    secondaryAction: saveAsTodoAction,
                    // No session exists yet: the files go to the machine Walnut runs
                    // on, and the server takes them on to the session's host.
                    onSendFiles: { text, images, files in await launch(message: text, images: images, files: files) },
                    onSend: { text, images in await launch(message: text, images: images) }
                )
            }
        }
        .navigationTitle(launchingMessage == nil ? "New Session" : taskTitle ?? (launchFailed ? "Not started" : "Starting session…"))
        .navigationBarTitleDisplayMode(.inline)
        // While files go up the page can be left (the launch stops, `pageLeft`, and his words go
        // back to the draft); during the create call itself it cannot. Before a launch, a pick
        // the draft store does not keep holds it too.
        .holdsNavigation(creating ? !uploading : picksEdited)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") { dismiss() }.disabled(creating && !uploading)
            }
        }
        .onDisappear { pageLeft() }
        .sheet(isPresented: $showProjectPicker) {
            TaskProjectPicker(current: project) { picked in project = picked }
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
        .onAppear {
            // Words of a launch an earlier run of the app did not finish come back.
            NewSessionLaunchWords.offerBack(draftKey: ContentActionLink.newSessionDraftKey)
            // At the accessibility sizes the box shows two lines, so a caret at the end would leave
            // the email's context out of sight and the draft looking empty: it stays unfocused there.
            if contentLink.takeDraftFocus(), !dynamicTypeSize.isAccessibilitySize { composerFocus += 1 }
        }
        // One focus per request: back to 0 once the composer has taken it, so a rebuilt
        // composer (a failed create, the launching row) does not pull the keyboard up again.
        .task(id: composerFocus) {
            guard composerFocus > 0 else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { composerFocus = 0 }
        }
        // New task again while this draft is already open.
        .onChange(of: contentLink.draftFocusPending) { _, pending in
            if pending, contentLink.takeDraftFocus(), !dynamicTypeSize.isAccessibilitySize { composerFocus += 1 }
        }
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
                if dynamicTypeSize.isAccessibilitySize {
                    if let createError {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(createError)
                                .font(.footnote)
                                .fixedSize(horizontal: false, vertical: true)
                            Button("Dismiss") { self.createError = nil }
                                .font(.footnote)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.danger.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier("newSessionChat.createError")
                    }
                    launchBar
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
                // Where the pills' values come from when the project set them (its
                // launch defaults), and the engine a phone launch cannot run.
                if let line = launchDefaults?.line(modeTouched: modeTouched, modelTouched: modelTouched) {
                    Label(line, systemImage: "slider.horizontal.3")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("newSessionChat.projectDefaults")
                }
                // At the accessibility sizes the quick folders scroll with the page
                // instead of being pinned over the composer: pinned, the bar took
                // all but about 30 pt of the screen and cut the line above (gate r4,
                // F5). The folder pill and the composer stay pinned.
                if movesQuickFoldersIntoPage {
                    quickFolderRow
                        .padding(.horizontal, -12)
                }
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
                    // The composer takes most of the screen at the accessibility
                    // sizes: 120 pt above pushed this out of sight.
                    .padding(.top, dynamicTypeSize.isAccessibilitySize ? 8 : 120)
                    .accessibilityIdentifier("newSessionChat.emptyState")
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
            if !quickDirs.isEmpty, !movesQuickFoldersIntoPage {
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
                // WHICH PROJECT the work is filed under, picked here rather than by
                // where the add started (the user: the project is chosen on the create
                // page itself). Rides both exits: the session's task and the todo.
                if isTaskless {
                    Button {
                        showProjectPicker = true
                    } label: {
                        pill(
                            project.isEmpty ? NewTaskSeed.inboxHeader : AskProjectName.display(project),
                            icon: project.isEmpty ? "tray" : "folder",
                            active: !project.isEmpty
                        )
                    }
                    .disabled(creating)
                    .accessibilityIdentifier("newSessionChat.projectPill")
                    .accessibilityLabel("Project: \(project.isEmpty ? NewTaskSeed.inboxHeader : AskProjectName.display(project))")
                    // Local or the project's outside service, only in a project that syncs.
                    if let service = syncService {
                        let name = tasks?.serviceName(service) ?? service
                        Button {
                            syncLocal.toggle()
                        } label: {
                            pill(syncLocal ? "Sync: Local" : "Sync: \(name)",
                                 icon: syncLocal ? "lock" : "arrow.triangle.2.circlepath",
                                 active: !syncLocal)
                        }
                        .disabled(creating)
                        .accessibilityIdentifier("newSessionChat.syncPill")
                        .accessibilityLabel(syncLocal
                            ? "Sync: Local. Stays in Walnut, never sent to \(name)"
                            : "Sync: \(name). Sent there once Walnut checked it is not private")
                    }
                }
                if launchPillsInPillRow {
                    launchPills
                }
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
    /// sheet. Side by side, one line each: at the accessibility sizes they are
    /// in the folder pill's row, which scrolls sideways, not in the composer.
    private var launchPills: some View {
        // A pick while the create call runs would be a choice the launch already
        // went without.
        let state: ComposerControlsModel.PillState = creating ? .waiting : .ready
        return ComposerBar.pillLayout(stacked: false) {
            PillChip(
                text: shownMode.label,
                glyph: .chevron,
                state: state,
                wraps: false,
                rawID: false,
                menu: Self.modeMenu(selected: shownMode),
                menuID: "launchMode",
                accessibilityID: "newSessionChat.modePill",
                accessibilityLabel: "Permission mode: \(shownMode.label)\(launchDefaults?.mode != nil && !modeTouched ? ", project default" : "")",
                onSelect: { choice, _ in pick(choice) },
                onPresentedChange: { _, _ in }
            )
            PillChip(
                text: modelLabel,
                glyph: .chevron,
                state: state,
                wraps: false,
                rawID: false,
                menu: Self.modelMenu(selected: shownModel),
                menuID: "launchModel",
                accessibilityID: "newSessionChat.modelPill",
                accessibilityLabel: "Model: \(shownModel == nil ? "Default" : modelLabel)\(launchDefaults?.shownModel != nil && !modelTouched ? ", project default" : "")",
                onSelect: { choice, _ in pick(choice) },
                onPresentedChange: { _, _ in },
                // The same "Select model" sheet as a live composer's model pill.
                sheetTitle: ComposerModelPill.sheetTitle
            )
            .layoutPriority(1)
        }
    }

    private var modelLabel: String { Self.modelLabel(shownModel) }

    /// The project whose launch defaults this draft starts on: the one picked here, or the
    /// task's own for a draft about a task (the server reads the same, `mobileLaunchDefaults`).
    private var launchProject: String? {
        isTaskless ? project : tasks?.tasks.first { $0.id == taskId }?.project
    }

    /// Its engine, model and mode for a new task; nil when it sets none.
    private var launchDefaults: DraftLaunchDefaults? { tasks?.launchDefaults(launchProject)?.onHost(host) }

    /// What the pills show: the pick, else the project's default, else the draft's start.
    private var shownMode: NewSessionSheet.PermissionMode {
        modeTouched ? mode : launchDefaults?.mode ?? mode
    }
    private var shownModel: String? {
        modelTouched ? model : launchDefaults?.shownModel ?? model
    }

    private func pick(_ choice: PillMenu.Choice) {
        switch choice {
        case .model(let id):
            model = id.isEmpty ? nil : id
            // The project's own model picked again is still the project's (its engine, its line).
            modelTouched = !DraftLaunchDefaults.keepsProjectPair(picked: model, defaults: launchDefaults)
        case .mode(let raw):
            if let picked = NewSessionSheet.PermissionMode(rawValue: raw) {
                mode = picked
                modeTouched = true
            }
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

    /// The model pill's words: the picked alias, a project's model by its id, or "Default
    /// model" for none.
    static func modelLabel(_ model: String?) -> String {
        guard let model else { return "Default model" }
        return launchModels.first { $0.0 == model }?.1 ?? model
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
        } + (selected.map { id in launchModels.contains { $0.0 == id } ? [] : [PillMenu.Item(
            // A project's model the stable aliases do not name stays listed and checked.
            title: id, choice: .model(id), checked: true,
            accessibilityID: "newSessionChat.model.\(id)"
        )] } ?? [])
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

    /// Why the composer is off before a folder is chosen.
    static let folderNotice = "Choose the folder this session runs in."

    /// The mode and model pills ride the folder pill's row (it scrolls sideways) instead
    /// of the composer's: at the accessibility sizes, where stacked in the composer they
    /// made the box about 180 pt taller (gate r4, F5), and whenever Save as todo shares
    /// the composer's row, where the mode pill was squeezed to one letter beside it
    /// (2026-10-10).
    private var launchPillsInPillRow: Bool {
        dynamicTypeSize.isAccessibilitySize || saveAsTodoAction != nil
    }

    /// The quick folders sit in the page at the accessibility sizes (gate r4, F5).
    private var movesQuickFoldersIntoPage: Bool {
        !quickDirs.isEmpty && dynamicTypeSize.isAccessibilitySize
    }

    /// No task behind this draft: the launch (or the todo) makes one.
    private var isTaskless: Bool { (taskId ?? "").isEmpty }

    private var saveAsTodoAction: ComposerSecondaryAction? {
        guard isTaskless, onSavedAsTodo != nil else { return nil }
        return ComposerSecondaryAction(
            title: "Save as todo",
            shortTitle: "Todo",
            systemImage: "checklist",
            accessibilityID: "newSessionChat.saveAsTodo",
            refusedNotice: "The todo was not saved. Your words are back in the composer.",
            perform: { text in await saveAsTodo(text) }
        )
    }

    private var hostLabel: String? {
        guard !host.isEmpty else { return nil }
        return options?.hosts.first { $0.alias == host }?.label
    }

    private var hostSentence: String {
        host.isEmpty ? "on this Mac" : "on \(hostLabel ?? host)"
    }

    /// The web's quick-folder membership (`quickDirsFor`): most-used, then most
    /// recent of the rest, one chip per folder name. Not the server list's head:
    /// that carried the same folder twice when the wire had two rows for it.
    private var quickDirs: [SessionLaunchOptions.Dir] {
        PathRanking.quickDirs(options?.dirs ?? [], current: (cwd, host))
    }

    private func isCurrent(_ dir: SessionLaunchOptions.Dir) -> Bool {
        PathRanking.pathChipKey(dir: dir) == PathRanking.pathChipKey(cwd: cwd, host: host.isEmpty ? nil : host)
    }

    /// Spell the full path out when no chip is lit for it, or when the lit chip's
    /// name is shared by another known folder.
    private var showsPathSummary: Bool {
        Self.showsPathSummary(cwd: cwd, host: host, quickDirs: quickDirs, allDirs: options?.dirs ?? [])
    }

    /// The quiet empty state: only while nothing else has a claim on the page.
    private var showsEmptyState: Bool {
        !showsPathSummary && !creating && loadFailed == nil && (taskId ?? "").isEmpty
    }

    static func showsPathSummary(cwd: String, host: String, quickDirs: [SessionLaunchOptions.Dir],
                                 allDirs: [SessionLaunchOptions.Dir] = []) -> Bool {
        guard !cwd.isEmpty else { return false }
        let key = PathRanking.pathChipKey(cwd: cwd, host: host.isEmpty ? nil : host)
        if !quickDirs.contains(where: { PathRanking.pathChipKey(dir: $0) == key }) { return true }
        // The lit chip says only the folder name: spell the path out when another
        // checkout shares it, or the phone cannot tell which one this is.
        let name = PathRanking.quickChipNameKey(cwd: cwd, host: host)
        let here = trimmedPath(cwd)
        return allDirs.contains {
            PathRanking.quickChipNameKey(cwd: $0.cwd, host: $0.host) == name && trimmedPath($0.cwd) != here
        }
    }

    private static func trimmedPath(_ cwd: String) -> String {
        var p = Substring(cwd)
        while p.count > 1 && p.hasSuffix("/") { p = p.dropLast() }
        return String(p)
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
            offeredHost = ""
            offeredCwd = ""
            didPreselect = false
        }
        // Preselect the FIRST QUICK CHIP exactly once, and never over a choice
        // the user already made (the empty-cache apply doesn't latch, so the live
        // fetch behind it can still seed a real suggestion). The chip row and the
        // preselect must agree: a preselect from the server list's head that is
        // not in the row would open the page with no chip lit AND the full path.
        guard Self.draftStart(inDemo: DemoMode.isActive).preselectFolder,
              !didPreselect, cwd.isEmpty, let top = Self.preselectedDir(opts.dirs) else { return }
        cwd = top.cwd
        host = top.host
        offeredCwd = cwd
        offeredHost = host
        didPreselect = true
    }

    /// What a fresh draft opens on. In the demo: no folder picked and the Default
    /// mode, so a sample chore does not open on a code folder with Bypass (App
    /// Store gate, r5b). Everywhere else: the first quick chip, and Bypass.
    static func draftStart(inDemo: Bool) -> (preselectFolder: Bool, mode: NewSessionSheet.PermissionMode) {
        inDemo ? (false, .default) : (true, .bypass)
    }

    /// The folder a fresh draft opens on: the first quick chip, so the lit chip and
    /// the preselect are one fact; the listing's head only when the row is empty.
    static func preselectedDir(_ dirs: [SessionLaunchOptions.Dir]) -> SessionLaunchOptions.Dir? {
        PathRanking.quickDirs(dirs).first ?? dirs.first
    }

    // MARK: - Launch

    /// The words and photos of a launch whose files go up first: kept by the page
    /// once the composer has let go of them, so a failed upload can be retried
    /// here or given back (`giveBackToDraft`).
    struct PendingLaunch {
        let text: String
        let images: [SelectedImage]
    }

    /// One create call carrying everything picked here, then hand the pre-seeded
    /// session to the presenter. Returns false on failure so the composer keeps
    /// the text (its no-loss contract) instead of clearing it into the void.
    ///
    /// Attached photos and files are uploaded first with no session
    /// (`NewSessionUploads`, `UploadTarget.unbound`), and the first message names
    /// their paths: photos under the pictures header, so they reach the session
    /// and its timeline as pictures, files under the files header. The server
    /// takes them on to the session's host before that message goes. While they
    /// go up, each file's card shows how far it is; a failed upload keeps the
    /// message on this page (answering true: the page holds it), each card saying
    /// how far it got, with Retry and Remove. Leaving the page mid-upload makes
    /// no session: the words, photos and files go back to the composer's draft,
    /// and what the host already has is not sent again.
    private func launch(message: String, images: [SelectedImage] = [], files: [ComposerFile] = []) async -> Bool {
        guard !creating, canLaunch, !launchFailed else { return false }
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if images.isEmpty && files.isEmpty {
            uploads.release()
        } else {
            do {
                try await uploads.prepare(images: images, files: files)
            } catch {
                createError = error.localizedDescription
                AppLog.warn("session", "new session's photos not prepared", ["error": String(describing: error)])
                return false
            }
        }
        pendingLaunch = PendingLaunch(text: text, images: images)
        // The composer let go of the words: until the launch ends they are kept
        // where an app iOS ends finds them again (`NewSessionLaunchWords`).
        NewSessionLaunchWords.keep(text, draftKey: ContentActionLink.newSessionDraftKey)
        return await runLaunch(fromComposer: true)
    }

    /// Upload what the launch carries, then create the session. `fromComposer`:
    /// the composer is waiting on the answer and puts the message back in its
    /// draft on false; from this page's own Retry, the page does that itself.
    private func runLaunch(fromComposer: Bool) async -> Bool {
        guard let pending = pendingLaunch, !creating else { return false }
        creating = true
        createError = nil
        launchFailed = false
        defer { creating = false; uploading = false }
        launchingMessage = pending.text
        var wireText = pending.text
        if !uploads.isEmpty {
            uploading = true
            do {
                let sent = try await uploads.upload()
                wireText = ComposerFile.messageText(pending.text, imagePaths: sent.imagePaths, paths: sent.filePaths)
            } catch {
                uploading = false
                if uploads.abandoned { return leaveLaunch(fromComposer: fromComposer) }
                AppLog.warn("session", "new session's files not uploaded", ["error": String(describing: error)])
                launchFailed = true
                createError = error.localizedDescription
                return true
            }
            uploading = false
        }
        // Left while the files went up: no session for a page nobody looks at.
        guard !uploads.abandoned else { return leaveLaunch(fromComposer: fromComposer) }
        let pair = DraftLaunchDefaults.wirePair(picked: shownModel, touched: modelTouched, defaults: launchDefaults)
        // The task's sessions before the launch: one answered without an id is the new one after.
        let known = Set((tasks?.sessions ?? []).filter { $0.taskId != nil && $0.taskId == taskId }.map(\.id))
        do {
            let launched = try await api.launchSession(
                cwd: cwd,
                host: host,
                message: wireText,
                // The originating task, when this draft came from one. `nil` (the
                // toolbar entrance) keeps the server's own behaviour: it creates the
                // task that owns the new session.
                taskId: taskId,
                // bypass is the server default; send nil so an older server
                // behaves identically. What the project's launch defaults decide is
                // left to the server, which applies and records them.
                mode: DraftLaunchDefaults.wireMode(picked: shownMode, touched: modeTouched, defaults: launchDefaults),
                model: pair.model,
                // Only for a task-less draft, and only when picked: absent keeps the
                // server's own Inbox + organize behaviour.
                project: isTaskless && !project.isEmpty ? project : nil,
                syncToProject: isTaskless && syncService != nil && !syncLocal,
                namesClaude: pair.namesClaude
            )
            // The project's engine issues its own session ids (Codex): the answer names only the
            // task, and its session appears once the engine is up. The page keeps "Starting".
            guard let sessionId = launched.sessionId else {
                // Started either way: the server holds the files and the words.
                uploads.finish()
                pendingLaunch = nil
                NewSessionLaunchWords.release(draftKey: ContentActionLink.newSessionDraftKey)
                if let tasks, let session = await DraftLaunchDefaults.awaitSession(taskId: launched.taskId, excluding: known, in: tasks) {
                    SessionLaunchContext.stash(sessionId: session.id, message: wireText)
                    AppLog.info("session", "created session from chat draft (provider-issued id)", [
                        "sessionId": session.id, "taskId": launched.taskId, "host": host,
                    ])
                    onCreated(session)
                    return true
                }
                // Started, but not up yet: the task holds it. Never false here, or a send
                // again would start a second session.
                AppLog.info("session", "chat draft launch: session not up yet", ["taskId": launched.taskId])
                tasks?.transientNotice = "Started. The session shows in its task once it is up."
                dismiss()
                return true
            }
            let created = SessionCreated(sessionId: sessionId, taskId: launched.taskId, title: launched.title)
            // ORDER MATTERS (same as NewSessionSheet): stash BEFORE onCreated,
            // because the presenter's push mounts the conversation view whose
            // store consumes the stash in open().
            SessionLaunchContext.stash(sessionId: created.sessionId, message: wireText)
            // The server holds the files now: the phone's copies are done.
            uploads.finish()
            pendingLaunch = nil
            NewSessionLaunchWords.release(draftKey: ContentActionLink.newSessionDraftKey)
            AppLog.info("session", "created session from chat draft", [
                "sessionId": created.sessionId, "host": host, "mode": shownMode.rawValue,
                "model": shownModel ?? "default",
                // Logged because "which task owns this session" is the thing that used
                // to be silently nothing on every draft.
                "taskId": created.taskId, "linkedTaskId": taskId ?? "-",
            ])
            let now = ISO8601DateFormatter().string(from: AppClock.now())
            let session = WalnutSession(
                id: created.sessionId,
                title: created.title,
                taskId: created.taskId,
                // The task's real title when this draft was about one; the server's
                // echo (which for a task-less draft IS the new task's title) otherwise.
                taskTitle: taskTitle ?? created.title,
                project: isTaskless && !project.isEmpty ? project : nil,
                host: host,
                // 'idle' matches the server's pre-seeded record: 'running' would
                // paint a working badge on a CLI that hasn't spawned.
                processStatus: "idle",
                model: shownModel,
                mode: shownMode == .bypass ? nil : shownMode.rawValue,
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
            createError = NewSessionSheet.createErrorMessage(code: code, serverMessage: msg)
            return leaveLaunch(fromComposer: fromComposer)
        } catch {
            createError = error.localizedDescription
            return leaveLaunch(fromComposer: fromComposer)
        }
    }

    /// The launch ends without a session: its words, photos and files go back to
    /// the composer, by the composer itself when it is the caller (false), else
    /// here. The files keep their copies and what the host has of them.
    private func leaveLaunch(fromComposer: Bool) -> Bool {
        launchingMessage = nil
        launchFailed = false
        if !fromComposer { giveBackToDraft() }
        pendingLaunch = nil
        NewSessionLaunchWords.release(draftKey: ContentActionLink.newSessionDraftKey)
        uploads.release()
        return false
    }

    /// The failed launch's words, photos and files, back in the composer's draft
    /// (its Edit, or the page being left): nothing is lost, and the next send
    /// resumes the uploads.
    private func giveBackToDraft() {
        guard let pending = pendingLaunch else { return }
        let drafts = ComposerDrafts.shared
        let key = ContentActionLink.newSessionDraftKey
        ComposerBar.restoreRefusedDraft(pending.text, pending.images, draftKey: key, drafts: drafts)
        let files = uploads.files
        drafts.setFiles(files + drafts.files(key).filter { new in !files.contains { $0.id == new.id } }, key: key)
    }

    /// The failed launch's Edit: everything back in the composer.
    private func editFailedLaunch() {
        giveBackToDraft()
        pendingLaunch = nil
        NewSessionLaunchWords.release(draftKey: ContentActionLink.newSessionDraftKey)
        uploads.release()
        launchingMessage = nil
        launchFailed = false
        createError = nil
    }

    /// One file dropped from the failed launch (its card's Remove), and the rest
    /// sent again at once. A launch left with nothing at all is over.
    private func removeLaunchFile(_ id: String) async {
        uploads.remove(id)
        guard let pending = pendingLaunch, !(pending.text.isEmpty && uploads.isEmpty) else {
            pendingLaunch = nil
            NewSessionLaunchWords.release(draftKey: ContentActionLink.newSessionDraftKey)
            launchingMessage = nil
            launchFailed = false
            createError = nil
            return
        }
        _ = await runLaunch(fromComposer: false)
    }

    /// The page goes away (Cancel, a swipe, the app moving on): a launch whose
    /// files go up stops and makes no session, and one that failed goes back to
    /// the draft.
    private func pageLeft() {
        if uploading {
            uploads.abandon()
        } else if launchFailed {
            editFailedLaunch()
        }
    }

    /// The launching message as the page draws it: the words and the photos.
    private func launchingRow(_ text: String) -> ChatMessage {
        var row = ChatMessage(id: "launching", role: "user", text: text, createdAt: "", kind: nil)
        let photos = pendingLaunch?.images.map(\.jpegData) ?? []
        if !photos.isEmpty { row.localImages = photos }
        row.pending = !launchFailed
        return row
    }

    // MARK: - Save as todo

    /// The words as a task: the first line its title, the rest its description (the web
    /// draft's split, `handleDraftSaveAsTask`), in the picked project, born in Focus where
    /// the board and a new session's task both land, so the todo is on the board at once.
    /// Answers false (words back in the composer) when the create fails.
    private func saveAsTodo(_ text: String) async -> Bool {
        guard let tasks, !creating else { return false }
        creating = true
        createError = nil
        defer { creating = false }
        do {
            guard let created = try await Self.createTodo(
                from: text, project: project, local: syncService != nil && syncLocal, in: tasks
            ) else {
                return false
            }
            AppLog.info("session", "saved a draft as a todo", [
                "taskId": created.id, "project": project.isEmpty ? "-" : project,
            ])
            tasks.transientNotice = "Saved to \(tasks.tierLabel(for: Self.todoTier))"
            onSavedAsTodo?()
            return true
        } catch let APIError.server(_, _, msg, _, _) {
            createError = msg
            return false
        } catch {
            createError = error.localizedDescription
            return false
        }
    }

    /// The create itself, apart from the page so a test can drive it: one task, no
    /// session, filed in `project` ("" = Inbox) and pinned to `todoTier`. nil when the
    /// words hold no title; throws what the create threw.
    /// `local`: the Sync pill reads Local in a project that syncs.
    static func createTodo(
        from text: String, project: String, local: Bool = false, in tasks: TasksStore
    ) async throws -> WalnutTask? {
        let (title, description) = todoParts(text)
        guard !title.isEmpty else { return nil }
        return try await tasks.createTask(
            title: title,
            project: project.isEmpty ? nil : project,
            description: description,
            pin: .tier(todoTier),
            local: local ? true : nil
        )
    }

    /// The outside service the picked project syncs to, or nil (no Sync pill).
    private var syncService: String? {
        guard isTaskless else { return nil }
        return tasks?.projectService(project)
    }

    /// Where a saved todo is pinned: Focus, the tier a phone draft's session task is
    /// born in (`MOBILE_DRAFT_TIER` server-side), so either exit lands in the same place.
    static let todoTier = "focus"

    /// First line = title, the rest = description (nil when there is none).
    static func todoParts(_ text: String) -> (title: String, description: String?) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let newline = trimmed.firstIndex(where: \.isNewline) else { return (trimmed, nil) }
        let title = trimmed[..<newline].trimmingCharacters(in: .whitespaces)
        let rest = trimmed[newline...].trimmingCharacters(in: .whitespacesAndNewlines)
        return (title, rest.isEmpty ? nil : rest)
    }
}

/// The words of a new session's first message while its launch has not made the
/// session yet (its files go up, their upload failed, the create call runs). The
/// composer let go of them on send and the page holds them in its own state,
/// which ends with the app: so they are also kept in the drafts store, whose
/// words survive the app being ended, under a key of their own (never in the box
/// twice while the launch holds them). The next time the page opens, words left
/// there by a launch that never ended go back into the composer's draft.
@MainActor
enum NewSessionLaunchWords {
    /// A launch of this run holds the words: a page opened meanwhile leaves them.
    private(set) static var held = false

    static func key(for draftKey: String) -> String { draftKey + "~launching" }

    static func keep(_ text: String, draftKey: String) {
        held = true
        ComposerDrafts.shared.setDraft(text, key: key(for: draftKey))
    }

    /// The launch ended: it made its session, or its words went back to the composer.
    static func release(draftKey: String) {
        held = false
        ComposerDrafts.shared.clear(key(for: draftKey))
    }

    /// Words an earlier run's launch kept go back into the draft, ahead of what is there.
    static func offerBack(draftKey: String) {
        guard !held else { return }
        let drafts = ComposerDrafts.shared
        let kept = drafts.draft(key(for: draftKey))
        guard !kept.isEmpty else { return }
        AppLog.info("session", "a launch's words were offered back", ["chars": String(kept.count)])
        ComposerBar.restoreRefusedDraft(kept, [], draftKey: draftKey, drafts: drafts)
        drafts.clear(key(for: draftKey))
    }
}
