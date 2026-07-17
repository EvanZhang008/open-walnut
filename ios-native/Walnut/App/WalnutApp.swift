import SwiftUI

@main
struct WalnutApp: App {
    @State private var connection: ConnectionStore
    @State private var chat: ChatStore
    @State private var notes: NotesStore
    @State private var tasks: TasksStore

    init() {
        CrashReporter.shared.start()
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
struct RootView: View {
    @Environment(ConnectionStore.self) private var connection

    var body: some View {
        if connection.isConfigured {
            MainTabView()
        } else {
            SetupView()
        }
    }
}

struct MainTabView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ChatStore.self) private var chat
    @Environment(NotesStore.self) private var notes
    @Environment(TasksStore.self) private var tasks
    @Environment(\.scenePhase) private var scenePhase

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
        .onChange(of: scenePhase) { _, phase in
            // Foregrounding: revive the SSE stream and refresh status.
            if phase == .active {
                chat.connectStream()
                Task { await connection.refreshStatus() }
            } else if phase == .background {
                chat.closeStream()
            }
        }
    }
}
