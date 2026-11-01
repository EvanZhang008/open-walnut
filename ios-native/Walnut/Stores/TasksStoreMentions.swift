import Foundation

/// The task list feeds the task-mention table (`TaskMentionResolver`), so a task
/// mentioned in chat text reads as its current title and opens it.
///
/// Coalesced: a feed burst writes `tasks` once per row, and rebuilding the table on
/// each write would be O(rows x writes). The sync runs once at the end of the
/// main-actor turn and compares the whole table, so a burst that changes no title
/// (a phase move, a read marker) re-renders nothing, except a pill that shows the
/// moved task's status dot (`TaskMentionResolver.state(for:)`).
extension TasksStore {
    func scheduleTaskMentionSync() {
        guard feedsTaskMentions, !taskMentionSyncScheduled else { return }
        taskMentionSyncScheduled = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.taskMentionSyncScheduled = false
            self.syncTaskMentionsNow()
        }
    }

    /// Push the current list into the shared table now. Internal for tests.
    func syncTaskMentionsNow() {
        var titles: [String: String] = [:]
        var states: [String: String] = [:]
        titles.reserveCapacity(tasks.count)
        states.reserveCapacity(tasks.count)
        for task in tasks {
            titles[task.id] = TaskMentions.shownTitle(task.title, orgRole: task.orgRole)
            states[task.id] = TeamStatusModel.state(of: task).rawValue
        }
        TaskMentionResolver.shared.update(titles, states: states)
    }
}
