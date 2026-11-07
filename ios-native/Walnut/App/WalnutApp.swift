import SwiftUI
import UIKit

@main
struct WalnutApp: App {
    /// Home-screen Quick Action delivery ("Voice to Walnut"). SwiftUI has no
    /// scene-phase hook for shortcut items, so a minimal UIKit delegate catches
    /// them and hands them to `VoiceQuickAction.shared`. It does nothing else.
    @UIApplicationDelegateAdaptor(QuickActionDelegate.self) private var quickActionDelegate
    @State private var connection: ConnectionStore
    @State private var chat: ChatStore
    @State private var notes: NotesStore
    @State private var tasks: TasksStore
    @State private var inbox: InboxStore
    /// App-scoped so a collapsed HTML preview survives leaving the tab it was
    /// opened from — the whole point of the dock (see FilePreviewDock).
    @State private var filePreview: FilePreviewDock

    init() {
        // Arm the activation gate before anything else so every subsystem
        // below can ask "are we actually in front of the user?".
        _ = LaunchGate.shared
        // A UI test starts from no kept view choices (UITestLaunch), whatever the run before left.
        ViewMemory.eraseWhenAsked()
        LaunchTrace.mark(
            LaunchGate.shared.launchedInBackground
                ? "app init (BACKGROUND launch — prewarm/push)"
                : "app init"
        )
        // Telemetry is deliberately NOT gated: MetricKit crash delivery and
        // AppLog uploads never drive SwiftUI, and a crash report that waits for
        // an activation that may never come is a lost crash report.
        CrashReporter.shared.start()
        // Cache device identity while the main thread is definitely alive —
        // frozen-main-thread uploads depend on it (see AppLog).
        AppLog.shared.captureDeviceIdentity()
        // Live freeze detector — reports an unresponsive main thread FROM a
        // background thread, while the freeze is still happening. Self-gated:
        // it starts disarmed and arms on didBecomeActive.
        MainThreadWatchdog.shared.start()
        // Freeze CONTEXT registry: views/stores push cheap state here so the
        // watchdog's report (written from a background thread while the main
        // thread is dead) can say WHERE the app froze, not just that it did.
        FreezeContext.shared.start()
        // Flight recorder: periodically samples that same registry into the
        // uploaded log, so a field incident can be reconstructed minute by
        // minute instead of only at the instant of a freeze. Also subscribes
        // memory warnings and scene transitions.
        Breadcrumbs.start()
        AppLog.info("launch", "app init", [
            "launchedInBackground": LaunchGate.shared.launchedInBackground ? "true" : "false",
            "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?",
            "memoryMB": String(FreezeContext.residentMemoryMB()),
        ])
        // The demo server lives in memory and starts again from its sample data
        // on every launch; the demo's cached copies go with it, before any store
        // reads them, so a relaunch is the same fresh demo and not a mix of the
        // last run's changes and the sample data.
        if DemoMode.isActive {
            // The demo's clock pin (Debug builds only) before anything reads the
            // demo server, which times its sample data from it.
            AppClock.applyDemoPin()
            DemoEntry.startFreshAtLaunch()
        }
        // Attached-file copies an earlier run left (a draft, a send given up on): a
        // day old and no kept send needs them. Off the main thread.
        Task.detached(priority: .background) { ComposerFileStore.purgeStale(keeping: PendingFileSends.keptFileIDs()) }
        let connection = ConnectionStore()
        let chat = ChatStore()
        let notes = NotesStore()
        let tasks = TasksStore()
        let inbox = InboxStore()
        chat.connection = connection
        notes.connection = connection
        tasks.connection = connection
        inbox.connection = connection
        // The demo's in-process server must claim URLSession.shared before
        // anything can use it (a no-op for every real server).
        DemoMode.registerGlobally()
        _connection = State(initialValue: connection)
        _chat = State(initialValue: chat)
        _notes = State(initialValue: notes)
        _tasks = State(initialValue: tasks)
        _inbox = State(initialValue: inbox)
        // Cheap by construction: two nils, an empty array, a lifecycle
        // registration and one notification observer. No network, no disk, no
        // WKWebView until a file is actually previewed — so it is safe on the
        // launch path that must report syncDiskLoads=0.
        let filePreview = FilePreviewDock()
        LocalDataReset.register(tasks: tasks, chat: chat, notes: notes, inbox: inbox, filePreview: filePreview)
        _filePreview = State(initialValue: filePreview)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(connection)
                .environment(chat)
                .environment(notes)
                .environment(tasks)
                .environment(inbox)
                .environment(filePreview)
                .tint(Theme.tint)
        }
    }
}

/// Setup gate: first run (or after disconnect) shows setup; otherwise the tabs.
/// Lifecycle fan-out lives HERE, not on MainTabView: during SetupView (first
/// run / after disconnect) MainTabView doesn't exist, and a hub that never
/// hears about background would leave its suspended flag stale for stores
/// created later.
struct RootView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            #if DEBUG
            // Engine harness (Maestro E2E for the timeline rendering engine):
            // `--timeline-harness` boots straight into a synthetic timeline —
            // no server, no pairing. DEBUG builds only. Substring match:
            // Maestro's launchArguments encode flags as "-timeline-harness".
            if ProcessInfo.processInfo.arguments.contains(where: { $0.contains("timeline-harness") }) {
                NavigationStack { TimelineHarnessView() }
            } else if ProcessInfo.processInfo.arguments.contains(where: { $0.contains("askq-harness") }) {
                // AskUserQuestion card harness: renders the real card against a
                // real-shape payload so the question + every option can be seen
                // without holding a live CLI blocked mid-turn.
                NavigationStack { AskQuestionHarnessView() }
            } else if ProcessInfo.processInfo.arguments.contains(where: { $0.contains("perm-harness") }) {
                // Permission card harness: a Claude prompt's remembering options,
                // an ACP adapter's own options and the plain pair, side by side.
                NavigationStack { PermissionOptionsHarnessView() }
            } else if ProcessInfo.processInfo.arguments.contains(where: { $0.contains("calendar-harness") }) {
                // Calendar E2E harness (Maestro): boots straight into the
                // Tasks-tab calendar against the configured server — lets the
                // calendar be driven end-to-end before its tab wiring lands.
                NavigationStack { CalendarHarnessView() }
            } else if connection.isConfigured {
                MainTabView()
            } else {
                SetupView()
            }
            #else
            if connection.isConfigured {
                MainTabView()
            } else {
                SetupView()
            }
            #endif
        }
        // First-frame budget proof (see LaunchTrace): must report
        // syncDiskLoads=0, i.e. nothing on this path waited on disk.
        .onAppear { LaunchTrace.markFirstFrame() }
        // The lock-screen work card's links (`walnut://work?list=…`): MainTabView shows the list.
        .onOpenURL { url in WorkCardLinkBox.shared.open(url) }
        .demoModeChrome()
        // Report model/OS once per launch. Also the BACKFILL path: devices
        // paired before /devices/self existed get labelled on their next open.
        // Gated: a background/prewarm launch must not start network work.
        .task {
            LaunchGate.shared.whenActive { connection.reportDeviceInfo() }
            // In-app attention time → the console's human-time clocks. Gated on
            // first activation like everything else here: a background/prewarm
            // launch must start no timer and post nothing. `start()` subscribes
            // the attention signal + the lifecycle fan-out; `setActive(true)`
            // opens the first window, since no scenePhase CHANGE fires for the
            // phase the app launched into.
            LaunchGate.shared.whenActive {
                TimeHeartbeatReporter.shared.start()
                TimeHeartbeatReporter.shared.setActive(true)
                // The lock-screen work card can only start while the app is in front.
                WorkCardController.shared.appBecameActive()
            }
        }
        // `.background` is the ONLY suspend trigger. `willResignActive` also
        // fires for transient interruptions the app never leaves for — the
        // control center swipe, an incoming call banner, the app switcher, any
        // system alert — and suspending there tore down live work (voice
        // recording, streaming) mid-use with no matching resume, because
        // `.active` only comes back if the scene actually left it.
        .onChange(of: scenePhase) { _, phase in
            // Every transition on the tape — `inactive` included. A freeze that
            // starts during an interruption looks identical to one that starts
            // in normal use unless the phase trail is in the log.
            Breadcrumbs.scenePhase(Self.phaseName(phase))
            // Attention time counts ONLY while the app is genuinely in front of
            // the user, so this reads every phase — `.inactive` included (the app
            // switcher, a system alert, the screen locking). Idempotent, and this
            // is the ONLY writer of that flag: the reporter deliberately does not
            // take presence from LifecycleHub, whose teardown also fires while the
            // app is in the foreground (Settings → Disconnect).
            TimeHeartbeatReporter.shared.setActive(phase == .active)
            if phase == .active {
                LifecycleHub.shared.resumeAll()
                Task { await connection.refreshStatus() }
                // The tag rules are read before any task is opened, so a first open
                // draws its pills already decided instead of the raw tags for a moment.
                Task { await TagDisplayStore.shared.refreshIfStale() }
                // Whether the session chat always shows what Walnut added to a message.
                Task { await WalnutAdditionsSetting.shared.refreshIfStale() }
                // "The app is on screen" — only read by the server in
                // `when-inactive` mode, where it's what keeps a letter quiet
                // while the user is already looking at Walnut.
                PushRegistration.shared.reportActive(true)
                // A permission ask held back because the server could not send
                // yet is tried again on every return to the foreground.
                PushRegistration.shared.recheckOnForeground()
                // Start, refresh or end the lock-screen work card from the server's numbers.
                WorkCardController.shared.appBecameActive()
            } else if phase == .background {
                LifecycleHub.shared.suspendAll()
                // From here the server's silent pushes keep the card current.
                WorkCardController.shared.appWentBackground()
                // Release the lease immediately so the very next letter buzzes,
                // rather than waiting for it to expire.
                PushRegistration.shared.reportActive(false)
            }
        }
    }

    private static func phaseName(_ phase: ScenePhase) -> String {
        switch phase {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "unknown"
        }
    }
}

struct MainTabView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ChatStore.self) private var chat
    @Environment(NotesStore.self) private var notes
    @Environment(TasksStore.self) private var tasks
    @Environment(InboxStore.self) private var inbox
    /// WRITTEN, never read in `body`. Holding the reference costs nothing: Observation
    /// only records a dependency when a property is READ during a body pass, and this
    /// five-tab body reads none — which is the same reason the dock bar lives in its own
    /// leaf overlay (`FilePreviewDockOverlay`) instead of here. Optional because
    /// `RootView`'s DEBUG harness roots bypass the store wiring.
    @Environment(FilePreviewDock.self) private var filePreview: FilePreviewDock?

    /// Tab identity, needed so out-of-band entry points can bring the right tab
    /// forward: the voice Quick Action needs Chat (its composer owns the mic),
    /// and a tapped letter push needs Inbox (its list owns the reader). A warm
    /// launch can land on any tab, so neither consumer can assume it is on
    /// screen when the request arrives.
    enum Tab: String, Hashable { case chat, inbox, notes, tasks, settings }

    /// Which time-tracking lane a tab counts as. The Chat tab is the main-agent
    /// conversation, so it is `chat`; every other tab is `triage` — the board,
    /// the inbox, notes, settings are all "looking after my stuff", which is what
    /// the console means by that lane. A session conversation is NOT here: it is
    /// pushed on top of a tab and takes its own claim (see AttentionContext).
    static func attentionTarget(for tab: Tab) -> AttentionTarget {
        tab == .chat ? .chat : .triage
    }

    /// Which COMPOSER SURFACE a tab is, for the file-preview dock's clearance.
    ///
    /// Identity only. Nothing here says whether a tab has a composer — that is the
    /// composers' own business (they register for a surface), and a list of
    /// "composer-less tabs" maintained here is exactly the kind of thing that goes stale
    /// the day a tab grows an input. What this table buys is that the seat can stop
    /// clearing a composer on ANOTHER tab: with a preview docked, `file.dock.bar`
    /// measured [12,575][390,620] identically on Settings, Notes, Inbox and Tasks —
    /// stranded ~171pt up, over a row of content — because the dock had no way to ask
    /// which surface was in front. See `ComposerSurfaceID`.
    static func composerSurface(for tab: Tab) -> ComposerSurfaceID {
        switch tab {
        case .chat: return .chatTab
        case .inbox: return .tab("inbox")
        case .notes: return .tab("notes")
        case .tasks: return .tab("tasks")
        case .settings: return .tab("settings")
        }
    }

    /// The tab the user left, kept across a relaunch (`ViewMemory`): each tab puts back its
    /// own page (the Chat tab's session, the Tasks tab's last opened), so a launch that always
    /// came up on Chat left the VP he had open on Tasks behind Ask Walnut. A push, a link or
    /// the voice Quick Action still picks its own tab below.
    @State private var selection: Tab = ViewMemory.read("app", "tab", initial: Tab.chat)
    @State private var quickAction = VoiceQuickAction.shared
    @State private var letterLink = LetterDeepLink.shared
    /// Approvals a script waits on (`walnut approve`): their sheet opens over any tab.
    @State private var approvals = ApprovalCenter.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var contentLink = ContentActionLink.shared
    @State private var orgLink = OrgNodeLink.shared
    @State private var workCardLink = WorkCardLinkBox.shared

    var body: some View {
        TabView(selection: $selection) {
            // freezeScreen: names the visible surface for freeze reports, and
            // (via FreezeContext's crumb sink) puts the appear/leave pair on the
            // uploaded tape — so the full navigation trail survives in a field
            // log even though the snapshot keeps only the current screen plus
            // one level of history. Tabs are the coarse level;
            // SessionConversationView pushes a finer "session:<id-prefix>" on
            // top of whichever tab it came from.
            // composerCovered: TabView keeps every tab alive, and SwiftUI re-runs a
            // hidden tab's composer appear and disappear without end (2026-11-02: the
            // Chat tab's composer looped at 30% CPU while the Inbox was in front). A
            // tab out of sight tells its composers so (ComposerCoveredGuardTests).
            ChatView()
                .environment(\.composerCovered, selection != .chat)
                .freezeScreen("chat")
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
                .tag(Tab.chat)
            // Human Inbox: letters agents wrote for the human. The badge is the
            // unread LETTER count only — a letter is never cleared by opening a
            // panel, so this number means "documents you haven't read".
            InboxView()
                .environment(\.composerCovered, selection != .inbox)
                .freezeScreen("inbox")
                .tabItem { Label("Inbox", systemImage: "envelope") }
                .badge(inbox.unreadCount)
                .tag(Tab.inbox)
            NotesView()
                .environment(\.composerCovered, selection != .notes)
                .freezeScreen("notes")
                .tabItem { Label("Notes", systemImage: "doc.text") }
                .tag(Tab.notes)
            TasksTabView()
                .environment(\.composerCovered, selection != .tasks)
                .freezeScreen("tasks")
                .tabItem { Label("Tasks", systemImage: "checklist") }
                .tag(Tab.tasks)
            SettingsView()
                .environment(\.composerCovered, selection != .settings)
                .freezeScreen("settings")
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        // The collapsed HTML preview's seat. An OVERLAY, never a
        // `safeAreaInset`: an inset that appears mid-scroll changes the enclosing
        // list's visible rect and yanks the content offset, and this bar appears
        // exactly when the user has just dismissed something and is scrolling
        // again. Painted over the content, the scroll view never learns it is
        // there. It lives on the TAB VIEW rather than inside a tab because the
        // whole point of the seat is surviving the trip to another tab to go ask
        // the AI something. `FilePreviewDockOverlay` reads the dock store itself
        // so this five-tab body is not invalidated by dock state changes.
        .overlay(alignment: .bottom) { FilePreviewDockOverlay() }
        // Talk to Walnut's words that did not reach the CEO chat, offered on return.
        .talkUnsentSheet()
        // Voice Quick Action: switch to Chat so its composer is on screen and
        // can pick the request up. Both edges are needed — a cold launch has the
        // mailbox already armed before this view exists (`onAppear`), a warm one
        // arms it while the app sits on another tab (`onChange`). The composer
        // owns the mic; this only decides which tab is in front.
        // One appear hook for both mailboxes, so which tab wins is decided here
        // rather than by SwiftUI's modifier order. Voice goes first: it is a
        // live microphone with a 2-minute TTL, a letter can wait a tap.
        .onAppear {
            if quickAction.pending != nil {
                selection = .chat
            } else if letterLink.pending != nil {
                selection = .inbox
            } else if orgLink.pending != nil || contentLink.chat != nil {
                // A cold launch from a link: its tab, never the one kept from before.
                selection = .chat
            } else if contentLink.draft != nil {
                selection = .tasks
            }
            // The selected tab IS the base time-tracking lane. Read from the
            // selection rather than from each tab's onAppear: TabView keeps
            // off-screen tabs alive, so appear/disappear is the less reliable of
            // the two signals, and this is one place instead of five.
            AttentionContext.shared.setBase(Self.attentionTarget(for: selection))
            // Same signal, second consumer: which surface the file-preview seat has to
            // clear. Also read from the SELECTION and for a sharper version of the same
            // reason — a retained tab's composer keeps reporting (and re-running its
            // `onAppear`) while the user is somewhere else, so a composer that exists is
            // no evidence at all about what is on screen.
            filePreview?.setComposerSurfaceBase(Self.composerSurface(for: selection))
        }
        .onChange(of: selection) { _, tab in
            ViewMemory.write(tab, "app", "tab")
            AttentionContext.shared.setBase(Self.attentionTarget(for: tab))
            filePreview?.setComposerSurfaceBase(Self.composerSurface(for: tab))
            // Leaving the Inbox ends the visit the Unread filter was keeping read
            // rows for (the console clears them when its panel closes).
            if tab != .inbox { inbox.forgetKeptRows() }
        }
        // A tap on the lock-screen work card: its list, over whichever tab is in front.
        .sheet(item: Binding(get: { workCardLink.pending }, set: { workCardLink.pending = $0 })) { list in
            // Full height: a short list on a half sheet left the blurred chat showing through.
            WorkCardSheet(list: list)
                .presentationDetents([.large])
        }
        .sheet(item: Binding(get: { approvals.presented }, set: { approvals.presented = $0 })) { approval in
            ApprovalSheet(approval: approval)
                .interactiveDismissDisabled(approval.isPending)
        }
        // Coming forward: re-read what waits, and show the oldest one not closed yet.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                await approvals.refresh()
                approvals.presentNextIfAny()
            }
        }
        .onChange(of: quickAction.pending) { _, request in
            if request != nil { selection = .chat }
        }
        // A TAPPED letter push brings the Inbox forward; InboxView consumes the
        // mailbox and opens that letter. Only the tab switch happens here.
        .onChange(of: letterLink.pending) { _, request in
            if request != nil { selection = .inbox }
        }
        // Talk to CEO's "Open chat" brings Chat forward, New task brings Tasks forward; each
        // tab takes its own request (ChatView opens the CEO's session, TasksTabView the draft).
        .onChange(of: contentLink.chat) { _, request in
            if request != nil { selection = .chat }
        }
        .onChange(of: contentLink.draft) { _, request in
            if request != nil { selection = .tasks }
        }
        // An Org node's page (a thread push): ChatView opens the node's chat and its page.
        .onChange(of: orgLink.pending) { _, request in
            if request != nil { selection = .chat }
        }
        // Any letter push (a silent one included) refreshes the list, so the tab
        // badge is right even when the user is reading something else. This does
        // NOT navigate — a background delivery is not a user instruction.
        .onChange(of: letterLink.arrivals) { _, _ in
            inbox.refreshFromPush(letterId: letterLink.pending?.letterId)
        }
        // Hydration is gated on first activation (P0-2). A background/prewarm
        // launch that ran this immediately did the whole cold-start path —
        // status probe, three store hydrations, first SwiftUI render — while
        // the OS still charged it against the scene-update allowance, and the
        // process got killed (0x8BADF00D, build 27).
        .task {
            LaunchGate.shared.whenActive {
                LaunchTrace.mark("store hydration start")
                let started = Date()
                await connection.refreshStatus()
                await chat.initialize()
                DemoEntry.didHydrateChat(chat)
                await notes.initialize()
                await tasks.initialize()
                await inbox.initialize()
                await approvals.refresh()
                approvals.presentNextIfAny()
                LaunchTrace.mark("store hydration done")
                // Closes the launch timeline on the tape: process start →
                // first frame (LaunchTrace) → stores ready. A field report of
                // "the app was stuck on open" is answerable from these three.
                // Typed in steps: as one literal it ran past CI's type-check limit.
                let elapsedMs: Int = Int(Date().timeIntervalSince(started) * 1000)
                let sinceStartMs: Int = Int(Date().timeIntervalSince(LaunchTrace.processStart) * 1000)
                let fields: [String: String] = [
                    "elapsedMs": String(elapsedMs),
                    "sinceProcessStartMs": String(sinceStartMs),
                    "memoryMB": String(FreezeContext.residentMemoryMB()),
                ]
                AppLog.info("launch", "store hydration done", fields)
            }
        }
    }
}
