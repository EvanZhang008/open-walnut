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

    init() {
        // Arm the activation gate before anything else so every subsystem
        // below can ask "are we actually in front of the user?".
        _ = LaunchGate.shared
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
        let connection = ConnectionStore()
        let chat = ChatStore()
        let notes = NotesStore()
        let tasks = TasksStore()
        let inbox = InboxStore()
        chat.connection = connection
        notes.connection = connection
        tasks.connection = connection
        inbox.connection = connection
        _connection = State(initialValue: connection)
        _chat = State(initialValue: chat)
        _notes = State(initialValue: notes)
        _tasks = State(initialValue: tasks)
        _inbox = State(initialValue: inbox)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(connection)
                .environment(chat)
                .environment(notes)
                .environment(tasks)
                .environment(inbox)
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
                // "The app is on screen" — only read by the server in
                // `when-inactive` mode, where it's what keeps a letter quiet
                // while the user is already looking at Walnut.
                PushRegistration.shared.reportActive(true)
            } else if phase == .background {
                LifecycleHub.shared.suspendAll()
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

    /// Tab identity, needed so out-of-band entry points can bring the right tab
    /// forward: the voice Quick Action needs Chat (its composer owns the mic),
    /// and a tapped letter push needs Inbox (its list owns the reader). A warm
    /// launch can land on any tab, so neither consumer can assume it is on
    /// screen when the request arrives.
    enum Tab: Hashable { case chat, inbox, notes, tasks, settings }

    /// Which time-tracking lane a tab counts as. The Chat tab is the main-agent
    /// conversation, so it is `chat`; every other tab is `triage` — the board,
    /// the inbox, notes, settings are all "looking after my stuff", which is what
    /// the console means by that lane. A session conversation is NOT here: it is
    /// pushed on top of a tab and takes its own claim (see AttentionContext).
    static func attentionTarget(for tab: Tab) -> AttentionTarget {
        tab == .chat ? .chat : .triage
    }

    @State private var selection: Tab = .chat
    @State private var quickAction = VoiceQuickAction.shared
    @State private var letterLink = LetterDeepLink.shared

    var body: some View {
        TabView(selection: $selection) {
            // freezeScreen: names the visible surface for freeze reports, and
            // (via FreezeContext's crumb sink) puts the appear/leave pair on the
            // uploaded tape — so the full navigation trail survives in a field
            // log even though the snapshot keeps only the current screen plus
            // one level of history. Tabs are the coarse level;
            // SessionConversationView pushes a finer "session:<id-prefix>" on
            // top of whichever tab it came from.
            ChatView()
                .freezeScreen("chat")
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
                .tag(Tab.chat)
            // Human Inbox: letters agents wrote for the human. The badge is the
            // unread LETTER count only — a letter is never cleared by opening a
            // panel, so this number means "documents you haven't read".
            InboxView()
                .freezeScreen("inbox")
                .tabItem { Label("Inbox", systemImage: "envelope") }
                .badge(inbox.unreadCount)
                .tag(Tab.inbox)
            NotesView()
                .freezeScreen("notes")
                .tabItem { Label("Notes", systemImage: "doc.text") }
                .tag(Tab.notes)
            TasksView()
                .freezeScreen("tasks")
                .tabItem { Label("Tasks", systemImage: "checklist") }
                .tag(Tab.tasks)
            SettingsView()
                .freezeScreen("settings")
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
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
            }
            // The selected tab IS the base time-tracking lane. Read from the
            // selection rather than from each tab's onAppear: TabView keeps
            // off-screen tabs alive, so appear/disappear is the less reliable of
            // the two signals, and this is one place instead of five.
            AttentionContext.shared.setBase(Self.attentionTarget(for: selection))
        }
        .onChange(of: selection) { _, tab in
            AttentionContext.shared.setBase(Self.attentionTarget(for: tab))
        }
        .onChange(of: quickAction.pending) { _, request in
            if request != nil { selection = .chat }
        }
        // A TAPPED letter push brings the Inbox forward; InboxView consumes the
        // mailbox and opens that letter. Only the tab switch happens here.
        .onChange(of: letterLink.pending) { _, request in
            if request != nil { selection = .inbox }
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
                await notes.initialize()
                await tasks.initialize()
                await inbox.initialize()
                LaunchTrace.mark("store hydration done")
                // Closes the launch timeline on the tape: process start →
                // first frame (LaunchTrace) → stores ready. A field report of
                // "the app was stuck on open" is answerable from these three.
                AppLog.info("launch", "store hydration done", [
                    "elapsedMs": String(Int(Date().timeIntervalSince(started) * 1000)),
                    "sinceProcessStartMs": String(
                        Int(Date().timeIntervalSince(LaunchTrace.processStart) * 1000)
                    ),
                    "memoryMB": String(FreezeContext.residentMemoryMB()),
                ])
            }
        }
    }
}
