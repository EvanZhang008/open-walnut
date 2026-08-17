import Foundation

// MARK: - Optimistic single-task delete + session metadata edits
//
// Instant-first rule (2026-08): every simple mutation applies to the local
// list synchronously, the API call runs behind it, and a failure reverts the
// exact rows it touched (plus a small error line — never a modal, never a
// spinner). These helpers keep TaskDetailSheet/SessionConversationView thin:
// the views fire and render store state.

extension TasksStore {
    // MARK: Task delete (DELETE /v1/tasks/:id)

    /// Delete one task optimistically: the row vanishes immediately; failure
    /// reinserts it at its old position. A 409 (active sessions) also marks
    /// the id in `deleteNeedsForceIds` so the caller can offer force-delete.
    /// Returns nil on success, an error message on failure.
    func deleteTask(id: String, force: Bool = false) async -> String? {
        noteUserTouched(id)
        var removedRow: WalnutTask?
        var removedIndex = 0
        if let idx = tasks.firstIndex(where: { $0.id == id }) {
            removedRow = tasks[idx]
            removedIndex = idx
            tasks.remove(at: idx)
        }
        do {
            try await transport.deleteTask(id: id, force: force)
            guard isActive else { return nil }
            deleteNeedsForceIds.remove(id)
            taskTiers[id] = nil
            DiskCache.save(tasks, key: "tasks-list")
            return nil
        } catch {
            // Revert: put the row back where it was.
            if let row = removedRow, !tasks.contains(where: { $0.id == id }) {
                tasks.insert(row, at: min(removedIndex, tasks.count))
            }
            if let apiError = error as? APIError, apiError.isConflict {
                deleteNeedsForceIds.insert(id)
                return apiError.localizedDescription
            }
            return error.localizedDescription
        }
    }

    // MARK: Session row rebuild (WalnutSession is immutable)

    static func withSessionMeta(
        _ s: WalnutSession, title: String? = nil
    ) -> WalnutSession {
        WalnutSession(
            id: s.id, title: title ?? s.title, taskId: s.taskId,
            taskTitle: s.taskTitle, project: s.project, host: s.host,
            processStatus: s.processStatus, model: s.model, mode: s.mode,
            startedAt: s.startedAt, lastActiveAt: s.lastActiveAt,
            messageCount: s.messageCount, cwd: s.cwd, pinned: s.pinned,
            focusTier: s.focusTier, description: s.description
        )
    }

    // MARK: Session rename (PATCH /v1/sessions/:id { title })

    /// Rename a session optimistically — the list row updates immediately;
    /// failure restores the old row. Returns nil on success.
    func renameSession(id: String, title: String) async -> String? {
        var original: WalnutSession?
        if let idx = sessions.firstIndex(where: { $0.id == id }) {
            original = sessions[idx]
            sessions[idx] = Self.withSessionMeta(sessions[idx], title: title)
        }
        do {
            _ = try await transport.patchSession(id: id, title: title, archived: nil, mode: nil)
            if isActive { DiskCache.save(sessions, key: "sessions-list") }
            return nil
        } catch {
            if let row = original, let idx = sessions.firstIndex(where: { $0.id == id }) {
                sessions[idx] = row
            }
            return error.localizedDescription
        }
    }

    // MARK: Session archive (PATCH /v1/sessions/:id { archived })

    /// Archive/unarchive optimistically. Archived sessions leave the
    /// projection, so archiving REMOVES the row immediately (that's what the
    /// server list will do); failure reinserts it. Returns nil on success.
    func setSessionArchived(id: String, archived: Bool) async -> String? {
        var removedRow: WalnutSession?
        var removedIndex = 0
        if archived, let idx = sessions.firstIndex(where: { $0.id == id }) {
            removedRow = sessions[idx]
            removedIndex = idx
            sessions.remove(at: idx)
        }
        do {
            _ = try await transport.patchSession(id: id, title: nil, archived: archived, mode: nil)
            if isActive { DiskCache.save(sessions, key: "sessions-list") }
            return nil
        } catch {
            if let row = removedRow, !sessions.contains(where: { $0.id == id }) {
                sessions.insert(row, at: min(removedIndex, sessions.count))
            }
            return error.localizedDescription
        }
    }
}
