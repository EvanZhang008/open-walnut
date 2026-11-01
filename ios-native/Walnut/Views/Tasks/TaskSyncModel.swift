import Foundation

/// Where a task stands against the outside service its project syncs to (server
/// `src/core/private-tasks/`; the web's twin is `web/src/components/tasks/private-task-model.ts`).
/// The task menu's Sync section and the create pages' Local / <service> choice read it from here,
/// so they say what the web says.
enum SyncStanding: Equatable {
    /// Synced to `service` (a plugin id).
    case synced(service: String)
    /// Local in a project that syncs to `service`; `hold` says why when Walnut knows.
    case kept(service: String, hold: WalnutSyncHold?)
    /// Being checked before its first push to `service`.
    case checking(service: String, hold: WalnutSyncHold)
    /// Local in a project that does not sync (or the Inbox): nothing to choose.
    case local

    /// `projectSource` is the project's registry source ("local" or a plugin id).
    static func of(_ task: WalnutTask, projectSource: String?) -> SyncStanding {
        if let source = task.source, !source.isEmpty, source != "local" { return .synced(service: source) }
        if let hold = task.syncHold, hold.state == "checking" { return .checking(service: hold.target, hold: hold) }
        if let hold = task.syncHold, !hold.target.isEmpty, hold.target != "local" {
            return .kept(service: hold.target, hold: hold)
        }
        if let projectSource, !projectSource.isEmpty, projectSource != "local",
           !task.project.trimmingCharacters(in: .whitespaces).isEmpty {
            return .kept(service: projectSource, hold: task.syncHold)
        }
        return .local
    }

    var service: String? {
        switch self {
        case .synced(let s), .kept(let s, _), .checking(let s, _): return s
        case .local: return nil
        }
    }

    var isSynced: Bool {
        if case .synced = self { return true }
        return false
    }

    /// The short state the menu's Sync row reads ("Syncs to X", "Local, not in X").
    func summary(_ name: (String) -> String) -> String {
        switch self {
        case .synced(let s): return "Syncs to \(name(s))"
        case .checking: return "Checking…"
        case .kept(let s, _): return "Local, not in \(name(s))"
        case .local: return ""
        }
    }

    /// The one line a task kept local shows: why it is not in the service.
    func keptLine(_ name: (String) -> String) -> String {
        switch self {
        case .checking(let s, _): return "Checking whether it is private before it goes to \(name(s))"
        case .kept(let s, let hold):
            if let reason = hold?.reason, !reason.isEmpty { return "Kept out of \(name(s)): \(reason)" }
            return "Local, not synced to \(name(s))"
        default: return ""
        }
    }

    /// A task turned local whose copy is still in the service, as it was: it can be archived or
    /// neutralized there.
    var outsideCopyKept: Bool {
        if case .kept(_, let hold) = self { return hold?.outside == "kept" }
        return false
    }

    /// Kept local with no reason recorded (a local task in a project that syncs): it can be marked
    /// Local by choice, so Walnut never offers it to the service.
    var keptWithoutHold: Bool {
        if case .kept(_, let hold) = self { return hold == nil }
        return false
    }
}

enum ProjectSync {
    /// The outside service (plugin id) a new task in `project` would go to, or nil (a local
    /// project, the Inbox, a project the phone has not heard of).
    static func service(of project: String?, in sources: [String: WalnutProjectSource]) -> String? {
        let key = (project ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        guard !key.isEmpty, let source = sources[key]?.source, source != "local", !source.isEmpty else { return nil }
        return source
    }
}
