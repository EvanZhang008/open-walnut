import SwiftUI

struct InboxItemExecutionWatch: ViewModifier {
    let key: InboxItemStore.Key
    private let store = InboxItemStore.shared
    @Environment(TasksStore.self) private var tasks
    private var taskState: String {
        let taskId = store.latest(key, lane: "task")?.taskId
        let task = tasks.tasks.first { $0.id == taskId }
        let sessions = tasks.sessions.filter { $0.taskId == taskId }
        return "\(task?.phase ?? "")|\(sessions.map { "\($0.id):\($0.processStatus)" }.joined(separator: "|"))"
    }
    func body(content: Content) -> some View {
        content.onAppear { store.appear(key) }
            .onDisappear { store.disappear(key) }
            .onChange(of: taskState) { _, _ in Task { await store.query(key) } }
            .transaction { $0.animation = nil }
    }
}
