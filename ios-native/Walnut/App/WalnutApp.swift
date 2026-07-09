import SwiftUI

@main
struct WalnutApp: App {
    @State private var connection: ConnectionStore
    @State private var chat: ChatStore
    @State private var notes: NotesStore

    init() {
        let connection = ConnectionStore()
        let chat = ChatStore()
        let notes = NotesStore()
        chat.connection = connection
        notes.connection = connection
        _connection = State(initialValue: connection)
        _chat = State(initialValue: chat)
        _notes = State(initialValue: notes)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(connection)
                .environment(chat)
                .environment(notes)
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
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            ChatView()
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
            NotesView()
                .tabItem { Label("Notes", systemImage: "doc.text") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .task {
            await connection.refreshStatus()
            await chat.initialize()
            await notes.initialize()
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
