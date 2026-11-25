import Foundation
import Observation

/// Which rewrite of each Org node's Brief this phone has read, as the web keeps its own per browser
/// (`web/src/components/org/org-brief-model.ts`: `walnut.org.briefSeen`). The Brief tab and the bar
/// under the node's chat wear a dot while the row's `brief_at` is newer than the mark; opening the
/// Brief marks it at once, and the letter read marks its own `at`. One shared store, so every
/// surface drops the dot in the same frame.
@Observable
@MainActor
final class OrgBriefSeen {
    static let shared = OrgBriefSeen(defaults: AppPrefs.defaults)

    static let key = "walnut.org.briefSeen"
    /// The newest marks kept: there are a handful of leads, never thousands (the web keeps 50 too).
    static let kept = 50

    private(set) var seen: [String: String]
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
        seen = (defaults.dictionary(forKey: Self.key) as? [String: String]) ?? [:]
    }

    /// The Brief written at `briefAt` has not been read here (the web's `briefUnread`).
    func isNew(_ taskId: String, briefAt: String?) -> Bool {
        Self.unread(seen: seen[taskId], at: briefAt)
    }

    /// The Brief written at `at` was read here. A mark never moves back.
    func markSeen(_ taskId: String, at: String?) {
        guard let at, let next = Self.marking(seen, taskId: taskId, at: at) else { return }
        seen = next
        defaults.set(next, forKey: Self.key)
    }

    /// A local-data reset: every mark goes (the defaults domain is removed with it).
    func eraseAll() {
        seen = [:]
        defaults.removeObject(forKey: Self.key)
    }

    // MARK: - The rule (the web's, so one node reads the same on both)

    nonisolated static func unread(seen: String?, at: String?) -> Bool {
        guard let at, let atDate = WalnutTask.parseISO(at) else { return false }
        guard let seen, let seenDate = WalnutTask.parseISO(seen) else { return true }
        return atDate > seenDate
    }

    /// The map with `taskId` marked at `at`, the newest `kept` marks only; nil when the mark it
    /// holds is as new or newer (nothing to write).
    nonisolated static func marking(_ map: [String: String], taskId: String, at: String) -> [String: String]? {
        guard let atDate = WalnutTask.parseISO(at) else { return nil }
        if let was = map[taskId], let wasDate = WalnutTask.parseISO(was), wasDate >= atDate { return nil }
        var next = map
        next[taskId] = at
        if next.count > kept {
            let newest = next.sorted { (WalnutTask.parseISO($0.value) ?? .distantPast) > (WalnutTask.parseISO($1.value) ?? .distantPast) }
            next = Dictionary(uniqueKeysWithValues: Array(newest.prefix(kept)))
        }
        return next
    }
}

extension OrgNodeTab {
    /// The Brief segment's words: a dot after them while a rewrite is unread (the Threads segment
    /// carries its count the same way).
    static func briefLabel(new: Bool) -> String { new ? "Brief •" : "Brief" }
}
