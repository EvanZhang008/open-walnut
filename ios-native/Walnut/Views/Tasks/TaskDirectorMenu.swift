import SwiftUI

/// The task page's ⋯ menu: Make it a Director, or Remove from Directors, by the server's rule
/// (`DirectorRule`). Shown only while Directors are on, and only for work under a project (never
/// the CEO, a VP or a router, and never the Inbox).
struct TaskDirectorMenu: View {
    let task: WalnutTask
    /// Its subtasks as the task page last read them (nil: not read yet, the list's are counted).
    let children: [TaskDetail.Relative]?
    @Environment(TasksStore.self) private var tasks
    @State private var settings = DirectorsSettingsStore.shared
    /// The choice just written, until the list's row carries it.
    @State private var written: DirectorChoice?
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        if settings.value.enabled, DirectorRule.canChoose(task) {
            let isDirector = Self.isDirector(task: task, written: written, children: children, list: tasks.tasks)
            Menu {
                Button {
                    write(isDirector ? .no : .yes)
                } label: {
                    if isDirector {
                        Label("Remove from Directors", systemImage: "person.badge.minus")
                    } else {
                        Label("Make it a Director", systemImage: "person.badge.plus")
                    }
                }
                .accessibilityIdentifier(isDirector ? "task.director.remove" : "task.director.make")
            } label: {
                Image(systemName: "ellipsis.circle")
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .disabled(busy)
            .accessibilityLabel("More")
            .accessibilityIdentifier("task.menu")
            .onChange(of: task.director) { written = nil }
            .alert("Couldn't change Directors", isPresented: Binding(
                get: { failure != nil },
                set: { if !$0 { failure = nil } }
            )) {
                Button("OK", role: .cancel) { failure = nil }
            } message: {
                Text(verbatim: failure ?? "")
            }
        }
    }

    /// Its choice (the one just written first), else whether it leads an open subtask.
    static func isDirector(task: WalnutTask, written: DirectorChoice?, children: [TaskDetail.Relative]?, list: [WalnutTask]) -> Bool {
        let open = children.map { $0.filter { $0.phase != "COMPLETE" && $0.status != "done" }.count }
            ?? DirectorRule.openWorkers(of: task.id, in: list)
        return DirectorRule.isDirector(written ?? task.director, openWorkers: open)
    }

    private func write(_ choice: DirectorChoice) {
        busy = true
        written = choice
        Task {
            do {
                tasks.adoptRow(try await tasks.api.setDirector(taskId: task.id, choice))
            } catch {
                written = nil
                failure = error.localizedDescription
            }
            busy = false
        }
    }
}
