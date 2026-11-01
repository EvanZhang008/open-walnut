import SwiftUI

/// The task menu's Sync section (the web's `TaskSyncMenuRows`): where the task stands against the
/// outside service its project syncs to, and what can change. Nothing for a task whose project
/// does not sync.
///
///   - a synced task: Make local, with what happens to its copy there (kept as it is, archived,
///     or neutralized: title and text replaced, then archived);
///   - a task kept local: why, Sync to <service>, and for one turned local whose copy is still
///     there, archive or neutralize that copy.
struct TaskSyncMenu: View {
    let task: WalnutTask
    @Environment(TasksStore.self) private var tasks: TasksStore?

    var body: some View {
        if let tasks {
            let standing = tasks.syncStanding(task)
            if let service = standing.service {
                menu(standing, service: tasks.serviceName(service), store: tasks)
            }
        }
    }

    private func menu(_ standing: SyncStanding, service: String, store: TasksStore) -> some View {
        let line = standing.keptLine(store.serviceName)
        let id = task.id
        return Menu {
            if !line.isEmpty {
                Text(line)
            }
            if standing.isSynced {
                Button { run { await store.makeLocal(taskId: id, outside: .keep) } } label: {
                    Label("Make local, keep its copy in \(service)", systemImage: "lock")
                }
                .accessibilityIdentifier("tasks.sync.makeLocal.keep")
                Button { run { await store.makeLocal(taskId: id, outside: .archive) } } label: {
                    Label("Make local, archive it in \(service)", systemImage: "archivebox")
                }
                .accessibilityIdentifier("tasks.sync.makeLocal.archive")
                Button { run { await store.makeLocal(taskId: id, outside: .neutralize) } } label: {
                    Label("Make local, neutralize it in \(service)", systemImage: "eye.slash")
                }
                .accessibilityIdentifier("tasks.sync.makeLocal.neutralize")
            } else {
                Button { run { await store.syncToProject(taskId: id) } } label: {
                    Label("Sync to \(service)", systemImage: "arrow.up.circle")
                }
                .accessibilityIdentifier("tasks.sync.toProject")
            }
            if standing.outsideCopyKept {
                Button { run { await store.changeOutsideCopy(taskId: id, action: .archive) } } label: {
                    Label("Archive its copy in \(service)", systemImage: "archivebox")
                }
                .accessibilityIdentifier("tasks.sync.outside.archive")
                Button { run { await store.changeOutsideCopy(taskId: id, action: .neutralize) } } label: {
                    Label("Neutralize its copy in \(service)", systemImage: "eye.slash")
                }
                .accessibilityIdentifier("tasks.sync.outside.neutralize")
            }
            if standing.keptWithoutHold {
                Button { run { await store.makeLocal(taskId: id, outside: .keep) } } label: {
                    Label("Keep it local", systemImage: "lock")
                }
                .accessibilityIdentifier("tasks.sync.keepLocal")
            }
        } label: {
            Label("Sync: \(standing.summary(store.serviceName))",
                  systemImage: standing.isSynced ? "arrow.triangle.2.circlepath" : "lock")
        }
        .accessibilityIdentifier("tasks.sync.menu")
    }

    private func run(_ work: @escaping @MainActor () async -> Void) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { @MainActor in await work() }
    }
}

/// The create pages' Local / <service> choice (the web's `SyncChoiceField`), as a form section.
/// The caller shows it only when the task's project syncs to an outside service.
struct SyncChoiceSection: View {
    let service: String
    @Binding var local: Bool

    var body: some View {
        Section {
            Picker("Sync", selection: $local) {
                Text("Local").tag(true)
                Text(service).tag(false)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("tasks.create.syncChoice")
        } header: {
            Text("Sync")
        } footer: {
            Text(local
                 ? "Stays in Walnut, never sent to \(service)."
                 : "Sent to \(service) once Walnut checked it is not private.")
        }
    }
}
