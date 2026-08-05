import SwiftUI
import UIKit

@main
struct WalnutApp: App {
    @State private var connection: ConnectionStore
    @State private var chat: ChatStore
    @State private var notes: NotesStore
    @State private var tasks: TasksStore

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
        let connection = ConnectionStore()
        let chat = ChatStore()
        let notes = NotesStore()
        let tasks = TasksStore()
        chat.connection = connection
        notes.connection = connection
        tasks.connection = connection
        _connection = State(initialValue: connection)
        _chat = State(initialValue: chat)
        _notes = State(initialValue: notes)
        _tasks = State(initialValue: tasks)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(connection)
                .environment(chat)
                .environment(notes)
                .environment(tasks)
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
            if connection.isConfigured {
                MainTabView()
            } else {
                SetupView()
            }
        }
        // First-frame budget proof (see LaunchTrace): must report
        // syncDiskLoads=0, i.e. nothing on this path waited on disk.
        .onAppear { LaunchTrace.markFirstFrame() }
        // Report model/OS once per launch. Also the BACKFILL path: devices
        // paired before /devices/self existed get labelled on their next open.
        // Gated: a background/prewarm launch must not start network work.
        .task {
            LaunchGate.shared.whenActive { connection.reportDeviceInfo() }
        }
        // `.background` is the ONLY suspend trigger. `willResignActive` also
        // fires for transient interruptions the app never leaves for — the
        // control center swipe, an incoming call banner, the app switcher, any
        // system alert — and suspending there tore down live work (voice
        // recording, streaming) mid-use with no matching resume, because
        // `.active` only comes back if the scene actually left it.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                LifecycleHub.shared.resumeAll()
                Task { await connection.refreshStatus() }
            } else if phase == .background {
                LifecycleHub.shared.suspendAll()
            }
        }
    }
}

struct MainTabView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ChatStore.self) private var chat
    @Environment(NotesStore.self) private var notes
    @Environment(TasksStore.self) private var tasks

    var body: some View {
        TabView {
            ChatView()
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
            NotesView()
                .tabItem { Label("Notes", systemImage: "doc.text") }
            TasksView()
                .tabItem { Label("Tasks", systemImage: "checklist") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        // Hydration is gated on first activation (P0-2). A background/prewarm
        // launch that ran this immediately did the whole cold-start path —
        // status probe, three store hydrations, first SwiftUI render — while
        // the OS still charged it against the scene-update allowance, and the
        // process got killed (0x8BADF00D, build 27).
        .task {
            LaunchGate.shared.whenActive {
                LaunchTrace.mark("store hydration start")
                await connection.refreshStatus()
                await chat.initialize()
                await notes.initialize()
                await tasks.initialize()
                LaunchTrace.mark("store hydration done")
            }
        }
    }
}
