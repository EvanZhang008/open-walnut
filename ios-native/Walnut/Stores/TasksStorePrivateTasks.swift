import Foundation

// MARK: - Private tasks: Local or the project's service (server `src/core/private-tasks/`)
//
// A task can stay local inside a project that syncs to an outside service. The phone offers the
// web's three things: a Local / <service> choice where a task is created in such a project, and in
// the task menu "Make local" for a synced task (its copy there kept, archived or neutralized) and
// "Sync to <service>" for one kept local. The server owns every rule (the private words, the model
// check, who may send a task out); the phone only asks and shows the answer.

extension TasksStore {
    static let projectSourcesCacheKey = "project-sources"

    /// A project counts as syncing only on a server that keeps tasks local in it: `source_name`
    /// came with that feature (2026-11-01). An older server sends `source` but ignores `local` and
    /// has no make-local route, so offering Local there would promise what it does not do.
    static func indexSources(_ rows: [WalnutProjectSource]) -> [String: WalnutProjectSource] {
        var out: [String: WalnutProjectSource] = [:]
        for row in rows where row.source == "local" || !(row.sourceName ?? "").isEmpty {
            out[row.name.lowercased()] = row
        }
        return out
    }

    /// Fetch which projects sync. Best-effort like `loadProjectOrder`: an old server, a replica
    /// hiccup or an offline phone keeps the last known answer.
    func loadProjectSources() async {
        guard isActive else { return }
        do {
            let rows = try await transport.projectSources()
            guard isActive else { return }
            DiskCache.save(rows, key: Self.projectSourcesCacheKey)
            let indexed = Self.indexSources(rows)
            guard indexed != projectSources else { return }
            projectSources = indexed
        } catch {
            AppLog.debug("tasks", "project sources load failed", ["error": error.localizedDescription])
        }
    }

    /// The launch defaults of `project` (its engine, model and mode for a new task), or nil when
    /// it sets none, is Inbox or unknown.
    func launchDefaults(_ project: String?) -> DraftLaunchDefaults? {
        guard let project, !project.isEmpty else { return nil }
        return DraftLaunchDefaults(project: project, metadata: projectSources[project.lowercased()]?.metadata)
    }

    /// The outside service a new task in `project` would go to, or nil.
    func projectService(_ project: String?) -> String? {
        ProjectSync.service(of: project, in: projectSources)
    }

    /// A service's name for the user: the server's `source_name`, else its id.
    func serviceName(_ source: String) -> String {
        projectSources.values.first { $0.source == source && !($0.sourceName ?? "").isEmpty }?.sourceName ?? source
    }

    func syncStanding(_ task: WalnutTask) -> SyncStanding {
        SyncStanding.of(task, projectSource: projectSources[task.project.lowercased()]?.source)
    }

    /// The menu's Make local: the task stops syncing and keeps all of its content in its project.
    func makeLocal(taskId: String, outside: OutsideCopyChoice) async {
        await changeSync(taskId: taskId, what: "make local (\(outside.rawValue))") {
            let answer = try await self.transport.makeTaskLocal(id: taskId, outside: outside)
            return (answer.task, answer.outcome ?? "Made local")
        }
    }

    /// The menu's Sync to <service>: the task gets its project's source and is sent there.
    func syncToProject(taskId: String) async {
        await changeSync(taskId: taskId, what: "sync to project") {
            let answer = try await self.transport.syncTaskToProject(id: taskId)
            let name = self.serviceName(answer.task.source ?? answer.service ?? "")
            if let error = answer.syncError, !error.isEmpty {
                return (answer.task, "Linked to \(name); sending it failed (\(error)). Walnut tries again on the next change.")
            }
            return (answer.task, "Sent to \(name)")
        }
    }

    /// Archive or neutralize the copy a task turned local left in the service.
    func changeOutsideCopy(taskId: String, action: OutsideCopyChoice) async {
        await changeSync(taskId: taskId, what: "outside copy (\(action.rawValue))") {
            let answer = try await self.transport.changeOutsideCopy(id: taskId, action: action)
            let name = self.serviceName(answer.task.syncHold?.target ?? "")
            return (answer.task, action == .archive ? "Its copy in \(name) was archived" : "Its copy in \(name) was neutralized and archived")
        }
    }

    /// One change: the answer's task replaces the row (the feed confirms it), the server's
    /// sentence is the toast, a refusal is the error toast and the row stays as it was.
    private func changeSync(taskId: String, what: String, _ work: () async throws -> (WalnutTask, String)) async {
        noteUserTouched(taskId)
        AppLog.info("tasks", "private tasks: \(what)", ["taskId": taskId])
        do {
            let (row, notice) = try await work()
            guard isActive else { return }
            if let idx = tasks.firstIndex(where: { $0.id == row.id }) {
                // The answer is the plain projection: keep what its running session does now
                // until the reload below brings the list row.
                var updated = row
                if updated.liveActivity == nil { updated.liveActivity = tasks[idx].liveActivity }
                tasks[idx] = updated
            }
            transientNotice = notice
            Task { await self.loadTasks() }
        } catch {
            AppLog.warn("tasks", "private tasks: \(what) failed", [
                "taskId": taskId, "error": String(describing: error),
            ])
            guard isActive else { return }
            transientError = "Sync not changed: \(error.localizedDescription)"
        }
    }
}
