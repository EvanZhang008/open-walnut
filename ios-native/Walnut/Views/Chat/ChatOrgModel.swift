import Foundation

/// The Chat drawer's org view, pure: the CEO on top, then one row per VP, the same rows the web
/// Org page's channel list builds (`web/src/components/org/org-channels-model.ts` `buildChannels`).
///
///   rows    a project under another project's VP folds into that VP's row (its counts are the
///           VP's), so a VP leading five projects is one row; the Inbox has no VP and no row here
///   state   needs    something in the row needs the user: a task's status (`user_status`) or,
///                    on a VP's own row, the VP itself
///           working  a task in the row is Working (the web counts the team, not the VP)
///           waiting  anything else
///   order   needs, working, waiting; inside one state the newest move first (the VP or any task
///           in the row, by `updated_at`), then by project name, as the Org page sorts
///
/// The CEO's row is its own state (it waits on the user itself), else Working while any VP's
/// team works, as on the web.
enum ChatOrgModel {
    struct Row: Identifiable, Equatable {
        enum Kind: Equatable { case ceo, vp }
        /// "ceo", or `project:<key>`.
        let id: String
        let kind: Kind
        let name: String
        /// The task the user talks to: Main, or the VP. nil = not made yet (the tap asks the
        /// server for it: `POST /org/main`, `POST /org/contact`).
        let contactId: String?
        /// The project a VP's contact is asked for when it has none yet.
        let project: String
        let state: UserState
        /// What needs the user here (the badge), the same count the web row shows.
        let needs: Int
        let working: Int
        let open: Int
        /// The VP's projects besides its own (shown as "+N").
        let ledProjects: [String]
        /// One line under the name.
        let line: String
    }

    static let ceoName = "CEO"

    static func projectKey(_ project: String?) -> String {
        (project ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// The node's own state from the task list: its `user_status`, else its phase.
    static func ownState(_ id: String?, phase: String?, tasks: [String: WalnutTask]) -> UserState {
        if let id, let task = tasks[id] { return TeamStatusModel.state(of: task) }
        switch phase {
        case "COMPLETE": return .done
        case "IN_PROGRESS": return .working
        case "NEED_ACTION": return .needs
        default: return .waiting
        }
    }

    static func rows(tree: OrgTreeWire, tasks: [WalnutTask]) -> [Row] {
        let byId = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let vps = vpRows(tree.projects, tasks: byId)
        // What needs the user under the VPs listed here. The web also counts the Inbox, which is a
        // row there; on the phone the CEO's line adds up to the rows below it.
        let teamNeeds = vps.reduce(0) { $0 + $1.needs }
        return [ceoRow(tree, vpCount: vps.count, teamNeeds: teamNeeds, tasks: byId)] + vps
    }

    private static func ceoRow(_ tree: OrgTreeWire, vpCount: Int, teamNeeds: Int, tasks: [String: WalnutTask]) -> Row {
        let own = tree.main.map { ownState($0.id, phase: $0.phase, tasks: tasks) } ?? .waiting
        let ownNeeds = own == .needs ? 1 : 0
        let state: UserState = ownNeeds > 0 ? .needs : tree.counts.running > 0 ? .working : .waiting
        // The web's Main line: how many VPs, what works, and what needs the user under them.
        var parts = ["\(vpCount) \(vpCount == 1 ? "VP" : "VPs")"]
        if tree.counts.running > 0 { parts.append("\(tree.counts.running) working") }
        if teamNeeds > 0 { parts.append("\(teamNeeds) \(teamNeeds == 1 ? "needs" : "need") you") }
        return Row(
            id: "ceo", kind: .ceo, name: ceoName, contactId: tree.main?.id, project: "",
            state: state, needs: ownNeeds, working: tree.counts.running, open: tree.counts.open,
            ledProjects: [], line: parts.joined(separator: " · ")
        )
    }

    /// The web's `vpNodes` + `projectRow`: one row per project that is not under another VP's
    /// row, with the projects under it folded in. The Inbox is not a VP.
    private static func vpRows(_ projects: [OrgProjectWire], tasks: [String: WalnutTask]) -> [Row] {
        let named = projects.filter { !projectKey($0.project).isEmpty }
        let own = Set(named.filter { $0.vp == nil }.map { projectKey($0.project) })
        var led: [String: [OrgProjectWire]] = [:]
        for p in named {
            if let vp = p.vp.map(projectKey), own.contains(vp) { led[vp, default: []].append(p) }
        }
        var rows: [(row: Row, rank: Int, at: Date, index: Int)] = []
        for (index, p) in named.enumerated() {
            if let vp = p.vp.map(projectKey), own.contains(vp) { continue }
            let under = p.vp == nil ? led[projectKey(p.project)] ?? [] : []
            let counts = under.reduce(p.counts) { $0 + $1.counts }
            // A VP leading several projects waits on the user once, on its own project's row.
            let leadNeeds = p.lead != nil && p.vp == nil
                && ownState(p.lead?.id, phase: p.lead?.phase, tasks: tasks) == .needs ? 1 : 0
            let needs = counts.needsYou + leadNeeds
            let state: UserState = needs > 0 ? .needs : counts.running > 0 ? .working : .waiting
            let name = p.lead?.name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                ?? p.project.trimmingCharacters(in: .whitespacesAndNewlines)
            let row = Row(
                id: "project:\(projectKey(p.project))", kind: .vp, name: name,
                contactId: p.contactId ?? p.lead?.id, project: p.project,
                state: state, needs: needs, working: counts.running, open: counts.open,
                ledProjects: under.map(\.project), line: line(state: state, open: counts.open)
            )
            // The web's `lastAt`: the VP (on its own row) and every task under the row.
            let ids = (p.vp == nil ? [p.lead?.id].compactMap { $0 } : [])
                + ([p] + under).flatMap { ($0.teams ?? []).flatMap(\.allIds) }
            let at = ids.compactMap { tasks[$0]?.updatedAtValue }.max() ?? .distantPast
            rows.append((row, rank(state), at, index))
        }
        return rows.sorted { a, b in
            if a.rank != b.rank { return a.rank < b.rank }
            if a.at != b.at { return a.at > b.at }
            let byName = a.row.project.localizedStandardCompare(b.row.project)
            return byName == .orderedSame ? a.index < b.index : byName == .orderedAscending
        }.map(\.row)
    }

    private static func rank(_ s: UserState) -> Int {
        switch s {
        case .needs: return 0
        case .working: return 1
        case .waiting: return 2
        case .done: return 3
        }
    }

    /// The row's state in words, with how much is open under it.
    static func line(state: UserState, open: Int) -> String {
        guard open > 0 else { return state == .waiting ? "Nothing open" : state.label }
        return "\(state.label) · \(open) open"
    }

    /// The avatar's letters: "WA" for one word, "PL" for "Personal Life".
    static func initials(_ name: String) -> String {
        let words = name.replacingOccurrences(of: "[-_.]+", with: " ", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace)
        guard let first = words.first else { return "?" }
        if words.count == 1 { return String(first.prefix(2)).uppercased() }
        return (String(first.prefix(1)) + String(words[1].prefix(1))).uppercased()
    }

    /// The web's avatar palette, picked by the same name hash, so a VP wears one color everywhere.
    static let palette: [Int] = [
        0x5B8DEF, 0xE8833A, 0x3BAA75, 0xA35CDB, 0xD9534F, 0x2AA7B8, 0xC69214, 0x6C7A89, 0xE05297, 0x4F6BD8,
    ]

    static func avatarColor(_ name: String) -> Int {
        var h: UInt32 = 0
        // The web hashes UTF-16 code units (`charCodeAt`).
        for unit in name.utf16 { h = h &* 31 &+ UInt32(unit) }
        return palette[Int(h % UInt32(palette.count))]
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
