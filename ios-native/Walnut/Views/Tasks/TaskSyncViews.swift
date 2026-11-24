import SwiftUI

/// The task menu's Sync section (the web's `TaskSyncMenuRows`): where the task stands against the
/// outside service its project syncs to, and what can change. Nothing for a task whose project
/// does not sync.
///
///   - a synced task: Make local, with what happens to its copy there (kept as it is, archived,
///     or neutralized: title and text replaced, then archived);
///   - a task kept local: why, Sync to <service>, and for one turned local whose copy is still
///     there, archive or neutralize that copy.
/// Every line's text comes from `SyncMenuText` (or a server reason `SyncStanding.note` found fits),
/// so each is measured against the menu's two lines (tests/scripts/ios-sync-menu-lines.test.ts).
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
        let id = task.id
        return Menu {
            if let note = standing.note() {
                Text(note)
            }
            if standing.isSynced {
                Button { run { await store.makeLocal(taskId: id, outside: .keep) } } label: {
                    Label(SyncMenuText.makeLocalKeep.text(service), systemImage: "lock")
                }
                .accessibilityIdentifier("tasks.sync.makeLocal.keep")
                Button { run { await store.makeLocal(taskId: id, outside: .archive) } } label: {
                    Label(SyncMenuText.makeLocalArchive.text(service), systemImage: "archivebox")
                }
                .accessibilityIdentifier("tasks.sync.makeLocal.archive")
                Button { run { await store.makeLocal(taskId: id, outside: .neutralize) } } label: {
                    Label(SyncMenuText.makeLocalNeutralize.text(service), systemImage: "eye.slash")
                }
                .accessibilityIdentifier("tasks.sync.makeLocal.neutralize")
            } else if standing.isChecking || store.projectSources.isEmpty || store.projectService(task.project) != nil {
                // Sources not read yet: offered, the server decides.
                Button { run { await store.syncToProject(taskId: id) } } label: {
                    Label(SyncMenuText.syncTo.text(service), systemImage: "arrow.up.circle")
                }
                .accessibilityIdentifier("tasks.sync.toProject")
            } else {
                // Its project syncs nowhere now (made local, or moved): the server answers 409
                // project_local, so there is nothing to send it to (the web's TaskSyncMenuRows).
                Text(SyncMenuText.projectSyncsNowhere.text(service))
            }
            if standing.outsideCopyKept {
                Button { run { await store.changeOutsideCopy(taskId: id, action: .archive) } } label: {
                    Label(SyncMenuText.archiveCopy.text(service), systemImage: "archivebox")
                }
                .accessibilityIdentifier("tasks.sync.outside.archive")
                Button { run { await store.changeOutsideCopy(taskId: id, action: .neutralize) } } label: {
                    Label(SyncMenuText.neutralizeCopy.text(service), systemImage: "eye.slash")
                }
                .accessibilityIdentifier("tasks.sync.outside.neutralize")
            }
            if standing.keptWithoutHold {
                Button { run { await store.makeLocal(taskId: id, outside: .keep) } } label: {
                    Label(SyncMenuText.keepLocal.text(service), systemImage: "lock")
                }
                .accessibilityIdentifier("tasks.sync.keepLocal")
            }
        } label: {
            Label(standing.menuRow(store.serviceName),
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
