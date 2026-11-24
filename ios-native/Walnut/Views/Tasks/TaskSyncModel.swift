import Foundation
import UIKit

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

    var isChecking: Bool {
        if case .checking = self { return true }
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

    /// The Sync menu's own row ("Sync: Local, not in Tracker"), measured with SyncMenuText's lines.
    func menuRow(_ name: (String) -> String) -> String { "Sync: \(summary(name))" }

    /// The menu's short line for why a task is local (or being checked), when it has one. The
    /// server's reason when it fits the menu's two lines, else the line of its kind: the menu row
    /// above already names the service.
    func note(fits: (String) -> Bool = SyncMenuText.fitsMenu) -> String? {
        switch self {
        case .checking: return SyncMenuText.checking.text("")
        case .kept(_, let hold):
            guard let hold else { return SyncMenuText.noReason.text("") }
            if let reason = hold.reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty,
               fits(reason) {
                return reason
            }
            return SyncMenuText.kind(of: hold).text("")
        default: return nil
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

/// Every line the task menu's Sync section shows (TaskSyncMenu reads its text only from here). An
/// iOS menu row shows at most two lines and cuts the rest ("Kept local when it w…", 2026-11-24), so
/// each line must fit two lines of the menu's body font: PrivateTasksTests measures every case, and
/// a new one that does not fit fails there. A server reason is shown only when `fitsMenu` says it
/// fits; otherwise the line of its kind stands in.
enum SyncMenuText: CaseIterable {
    // Why it is local, or being checked (no service name: the Sync row above names it).
    case checking, noReason, privateWords, privateModel, privateOther, unjudged, madeLocalWithProject, madeLocal
    case projectSyncsNowhere
    // Actions.
    case makeLocalKeep, makeLocalArchive, makeLocalNeutralize, syncTo, archiveCopy, neutralizeCopy, keepLocal

    func text(_ service: String) -> String {
        switch self {
        case .checking: return "Checking if it is private"
        case .noReason: return "No reason recorded"
        case .privateWords: return "It matches a private-word rule"
        case .privateModel: return "The AI check found it private"
        case .privateOther: return "It was found private"
        case .unjudged: return "Walnut could not check it yet"
        case .madeLocalWithProject: return "Made local with its project"
        case .madeLocal: return "Made local on purpose"
        case .projectSyncsNowhere: return "Its project syncs nowhere"
        case .makeLocalKeep: return "Make local, keep its copy in \(service)"
        case .makeLocalArchive: return "Make local, archive it in \(service)"
        case .makeLocalNeutralize: return "Make local, neutralize it in \(service)"
        case .syncTo: return "Sync to \(service)"
        case .archiveCopy: return "Archive its copy in \(service)"
        case .neutralizeCopy: return "Neutralize its copy in \(service)"
        case .keepLocal: return "Keep it local"
        }
    }

    /// The line of a hold's kind, for a reason too long for the menu (or none).
    static func kind(of hold: WalnutSyncHold) -> SyncMenuText {
        switch hold.state {
        case "private": return hold.by == "words" ? .privateWords : hold.by == "model" ? .privateModel : .privateOther
        case "unjudged": return .unjudged
        case "checking": return .checking
        default: return hold.via == "project" ? .madeLocalWithProject : .madeLocal
        }
    }

    /// The width a menu row's text gets on a phone (an iOS menu is about 250 pt wide; its icon
    /// column and margins leave about 165 pt, measured on the iPhone 16 Pro simulator) and the
    /// two lines it shows.
    static let menuTextWidth: CGFloat = 160
    static let menuLines = 2

    /// Whether `text` fits the menu's two lines in the body font at the reader's text size.
    static func fitsMenu(_ text: String) -> Bool {
        fits(text, font: UIFont.preferredFont(forTextStyle: .body))
    }

    static func fits(_ text: String, font: UIFont) -> Bool {
        let box = (text as NSString).boundingRect(
            with: CGSize(width: menuTextWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font], context: nil)
        return box.height <= font.lineHeight * CGFloat(menuLines) + 1
    }
}
