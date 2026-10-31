import Foundation

/// The task list feeds the task-mention table (`TaskMentionResolver`), so a task
/// mentioned in chat text reads as its current title and opens it.
///
/// Coalesced: a feed burst writes `tasks` once per row, and rebuilding the table on
/// each write would be O(rows x writes). The sync runs once at the end of the
/// main-actor turn and compares the whole table, so a burst that changes no title
/// (a phase move, a read marker) re-renders nothing.
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
        titles.reserveCapacity(tasks.count)
        for task in tasks {
            titles[task.id] = TaskMentions.shownTitle(task.title, orgRole: task.orgRole)
        }
        TaskMentionResolver.shared.update(titles)
    }
}
