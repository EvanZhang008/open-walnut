import SwiftUI
import UIKit

@main
struct WalnutApp: App {
    @State private var connection: ConnectionStore
    @State private var chat: ChatStore
    @State private var notes: NotesStore
    @State private var tasks: TasksStore

    init() {
        CrashReporter.shared.start()
        // Cache device identity while the main thread is definitely alive —
        // frozen-main-thread uploads depend on it (see AppLog).
        AppLog.shared.captureDeviceIdentity()
        // Live freeze detector — reports an unresponsive main thread FROM a
        // background thread, while the freeze is still happening.
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
        .task {
            await connection.refreshStatus()
            await chat.initialize()
            await notes.initialize()
            await tasks.initialize()
        }
    }
}
