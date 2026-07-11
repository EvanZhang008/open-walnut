import SwiftUI

/// Sessions tab — first-class access to the Claude Code sessions started from
/// Walnut. PINNED (alive) on top, then ACTIVE, then RECENT (stopped), same
/// structure as the desktop Task panel. Tapping a row opens the live
/// SessionDetailSheet (alive sessions poll fresh transcripts every 5s).
struct SessionsView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(TasksStore.self) private var tasks

    @State private var selected: WalnutSession?

    var body: some View {
        NavigationStack {
            Group {
                if tasks.sessionsNotSyncedYet && tasks.sessions.isEmpty {
                    notSyncedState
                } else {
                    list
                }
            }
            .navigationTitle("Sessions")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { StatusBadge() }
            }
            .sheet(item: $selected) { session in
                SessionDetailSheet(session: session)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    private var list: some View {
        List {
            if !connection.online {
                OfflineBanner(text: "Offline — sessions are read-only from cache")
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            sections

            if let synced = tasks.sessionsSyncedAt {
                Section {
                    Text("Synced \(synced.formatted(.relative(presentation: .named)))")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("sessions.list")
        .refreshable { await tasks.loadSessions() }
        .task { await tasks.loadSessions() }
    }

    /// Pin state is inherited from the owning task, so MANY old stopped
    /// sessions carry pinned=true; Pinned only surfaces the alive ones,
    /// everything dead sorts into Recent by recency.
    @ViewBuilder
    private var sections: some View {
        let pinned = tasks.pinnedSessions.filter { $0.statusKind.isAlive }
        let pinnedIds = Set(pinned.map(\.id))
        let active = tasks.activeSessions.filter { !pinnedIds.contains($0.id) }
        let recent = tasks.sessions
            .filter { !$0.statusKind.isAlive }
            .sorted(by: WalnutSession.recencySort)

        if pinned.isEmpty && active.isEmpty && recent.isEmpty {
            Section {
                Text("No agent sessions.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        } else {
            if !pinned.isEmpty {
                Section("Pinned") {
                    ForEach(pinned) { session in row(session) }
                }
            }
            if !active.isEmpty {
                Section("Active") {
                    ForEach(active) { session in row(session) }
                }
            }
            if !recent.isEmpty {
                Section("Recent") {
                    ForEach(recent) { session in row(session) }
                }
            }
        }
    }

    private func row(_ session: WalnutSession) -> some View {
        Button { selected = session } label: {
            SessionRowView(session: session)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("sessions.tab.row.\(session.id)")
    }

    private var notSyncedState: some View {
        ContentUnavailableView {
            Label("Sessions not synced yet", systemImage: "arrow.triangle.2.circlepath")
        } description: {
            Text("This companion hasn't received its first session sync. Check back in a moment.")
        } actions: {
            Button("Retry") { Task { await tasks.loadSessions() } }
                .buttonStyle(.borderedProminent)
                .tint(Theme.tint)
        }
    }
}
