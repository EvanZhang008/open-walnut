import Foundation

/// The Tasks view of an Org node on the phone, the web side bar's Tasks (`org-task-tabs.ts`):
/// which tasks are the node's work, by status (Watching, Needs you, Working, Waiting / snoozed,
/// Completed) or by pin group (the home panel's tiers, then the tasks not pinned). Pure; pinned in
/// `OrgNodeTasksModelTests`.
enum OrgNodeTasksModel {
    /// How the Tasks view draws the node's work (the web's Status | by pin group).
    enum Mode: String, CaseIterable, Identifiable {
        case status, pins
        var id: String { rawValue }
        var label: String {
            switch self {
            case .status: return "Status"
            case .pins: return "Pin groups"
            }
        }
    }

    /// The status groups, in the home panel's order.
    enum Group: String, CaseIterable, Identifiable {
        case watching, needs, working, waiting, done
        var id: String { rawValue }
        var label: String {
            switch self {
            case .watching: return "Watching"
            case .needs: return "Needs you"
            case .working: return "Working"
            case .waiting: return "Waiting / snoozed"
            case .done: return "Completed"
            }
        }
        /// Open on a page's first look: what is in front of him now (the home rule).
        /// What needs him and what runs now open; what waits and what is done stay folded.
        var openByDefault: Bool { self == .watching || self == .needs || self == .working }
    }

    struct Section: Equatable, Identifiable {
        let id: String
        let title: String
        let rows: [WalnutTask]
        let openByDefault: Bool
    }

    /// Completed work stays listed this long (the web's ORG_DONE_WINDOW_DAYS).
    static let doneWindowDays = 7

    /// The ids of the node's open work: a VP's, the teams of every project it leads; Main's, the
    /// teams of every project. The node's own task is its chat, never a row.
    static func teamIds(nodeId: String, isMain: Bool, tree: OrgTreeWire?) -> Set<String> {
        var ids = Set<String>()
        for p in ledProjects(nodeId: nodeId, isMain: isMain, tree: tree) {
            for team in p.teams ?? [] { ids.formUnion(team.allIds) }
        }
        ids.remove(nodeId)
        return ids
    }

    /// The projects the node leads: its own (it is their lead) and every project led by its VP
    /// (`vp` names the leading VP's own project); Main, every project.
    static func ledProjects(nodeId: String, isMain: Bool, tree: OrgTreeWire?) -> [OrgProjectWire] {
        guard let tree else { return [] }
        if isMain { return tree.projects }
        let own = tree.projects.filter { $0.lead?.id == nodeId }
        let names = Set(own.map(\.project))
        return own + tree.projects.filter { p in p.lead?.id != nodeId && p.vp.map(names.contains) == true }
    }

    /// The projects the node's work lives in (for the recently completed rows).
    static func projects(nodeId: String, isMain: Bool, tree: OrgTreeWire?) -> Set<String> {
        Set(ledProjects(nodeId: nodeId, isMain: isMain, tree: tree).map(\.project))
    }

    /// The node's tasks: its open team work, plus what finished in its projects this week.
    static func tasks(nodeId: String, isMain: Bool, tree: OrgTreeWire?, all: [WalnutTask], now: Date = AppClock.now()) -> [WalnutTask] {
        let ids = teamIds(nodeId: nodeId, isMain: isMain, tree: tree)
        let projects = projects(nodeId: nodeId, isMain: isMain, tree: tree)
        let cutoff = now.addingTimeInterval(-Double(doneWindowDays) * 86_400)
        return all.filter { t in
            guard t.id != nodeId, t.orgRole != "main", t.orgRole != "lead" else { return false }
            if TeamStatusModel.state(of: t) == .done {
                let at = WalnutTask.parseISO(t.completedAt ?? t.updatedAt) ?? .distantPast
                return at >= cutoff && (ids.contains(t.id) || projects.contains(t.project))
            }
            return ids.contains(t.id)
        }
    }

    /// The status sections. A watched task is drawn in Watching only.
    static func statusSections(_ tasks: [WalnutTask]) -> [Section] {
        var rows: [Group: [WalnutTask]] = [:]
        for t in tasks {
            let state = TeamStatusModel.state(of: t)
            if state != .done, isWatched(t) { rows[.watching, default: []].append(t); continue }
            switch state {
            case .needs, .read: rows[.needs, default: []].append(t)
            case .working: rows[.working, default: []].append(t)
            case .waiting: rows[.waiting, default: []].append(t)
            case .done: rows[.done, default: []].append(t)
            }
        }
        return Group.allCases.compactMap { g in
            guard let list = rows[g], !list.isEmpty else { return nil }
            return Section(id: g.rawValue, title: g.label, rows: list.sorted(by: newestFirst), openByDefault: g.openByDefault)
        }
    }

    /// The pin groups: each tier in the home panel's order with the node's open tasks pinned to it,
    /// then the open tasks not pinned. `tierOf` is the task's tier id, nil when it is not pinned.
    static func pinSections(_ tasks: [WalnutTask], tiers: [(id: String, label: String)], tierOf: (WalnutTask) -> String?) -> [Section] {
        let open = tasks.filter { TeamStatusModel.state(of: $0) != .done }
        var byTier: [String: [WalnutTask]] = [:]
        var loose: [WalnutTask] = []
        for t in open {
            if t.pinned == true, let tier = tierOf(t) { byTier[tier, default: []].append(t) } else { loose.append(t) }
        }
        var out: [Section] = []
        var known = Set<String>()
        for tier in tiers {
            known.insert(tier.id)
            guard let list = byTier[tier.id], !list.isEmpty else { continue }
            out.append(Section(id: "tier-\(tier.id)", title: tier.label, rows: list.sorted(by: newestFirst), openByDefault: tier.id == "focus"))
        }
        // A tier this build does not list (a custom one not loaded yet) still shows its rows.
        for (tier, list) in byTier where !known.contains(tier) {
            out.append(Section(id: "tier-\(tier)", title: "Pinned", rows: list.sorted(by: newestFirst), openByDefault: false))
        }
        if !loose.isEmpty {
            out.append(Section(id: "unpinned", title: "Not pinned", rows: loose.sorted(by: newestFirst), openByDefault: false))
        }
        // The first group opens when Focus has none: a page of closed headings shows no work.
        if let first = out.first, !out.contains(where: \.openByDefault) {
            out[0] = Section(id: first.id, title: first.title, rows: first.rows, openByDefault: true)
        }
        return out
    }

    static func isWatched(_ t: WalnutTask) -> Bool {
        !(t.watchedAt ?? "").trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// The one line under a row's title: what it needs from him, else what it does now, else on
    /// whom it waits. Never a phase name or a command line.
    static func line(_ t: WalnutTask) -> String? {
        let state = TeamStatusModel.state(of: t)
        let s = t.userStatus
        if state == .done { return nil }
        if state == .needs, let need = TeamStatusModel.needLine(s) { return "\(need.category.label): \(need.text)" }
        if let now = s?.now?.trimmingCharacters(in: .whitespacesAndNewlines), !now.isEmpty { return now }
        // Between a turn's end and its report the wait words are a placeholder: none.
        if state == .waiting, s?.transient != true { return TeamStatusModel.waitingLine(s) }
        return nil
    }

    private static func newestFirst(_ a: WalnutTask, _ b: WalnutTask) -> Bool {
        stamp(a) > stamp(b)
    }

    private static func stamp(_ t: WalnutTask) -> Date {
        if TeamStatusModel.state(of: t) == .done { return WalnutTask.parseISO(t.completedAt ?? t.updatedAt) ?? .distantPast }
        return WalnutTask.parseISO(t.userStatus?.at) ?? WalnutTask.parseISO(t.updatedAt) ?? .distantPast
    }
}
