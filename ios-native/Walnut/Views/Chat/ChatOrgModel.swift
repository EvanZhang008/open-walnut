import Foundation

/// The Chat drawer's org view, pure: the CEO on top, then one row per VP, the same rows the web
/// Org page's channel list builds (`web/src/components/org/org-channels-model.ts` `buildChannels`).
///
///   rows    a project under another project's VP folds into that VP's row (its counts are the
///           VP's), so a VP leading five projects is one row; the Inbox has no VP and no row here
///   threads the CEO's and a VP's own Threads (the user's own requests to it, `user_status.threads`)
///           come first: the row's line names them ("1 thread: <title>", "3 threads") while one
///           waits on him, or while no task under the row asks him anything (a thread that only
///           shows an answer never hides a task's ask); the ones waiting on him lead its badge
///   state   needs    something in the row needs the user: a thread waiting on him, a task's
///                    status (`user_status`) or, on a VP's own row, the VP itself
///           working  a task in the row is Working (the web counts the team, not the VP)
///           waiting  anything else
///   order   needs, working, waiting; inside one state the newest move first (the VP or any task
///           in the row, by `updated_at`), then by project name, as the Org page sorts
///
/// The CEO's row is its own state (its threads or a wait on the user itself), else Working while
/// any VP's team works, as on the web. A node whose status reads Needs you because of its threads
/// (`source: "thread"`) counts as those threads, never once more as an ask of its own.
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
        /// The node's own Threads that hold something for the user (nil = none shown).
        var threads: WalnutThreadCounts? = nil
        /// `line` names a thread he (or the node) pinned: the row wears a pin (web `latestPinned`).
        var linePinned = false
    }

    static let ceoName = "CEO"

    /// "1 thread", "3 threads": the words every surface counts them in (web `threadCountLabel`).
    static func threadCountLabel(_ n: Int) -> String {
        "\(n) thread\(n == 1 ? "" : "s")"
    }

    /// A row's line about its Threads: how many his view shows (the number the Threads tab
    /// counts), then the newest waiting on him, else the newest shown (web `threadLine`).
    static func threadLine(_ c: WalnutThreadCounts) -> String {
        let label = threadCountLabel(c.shown)
        guard let title = c.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { return label }
        return "\(label): \(title)"
    }

    /// The node's own Threads when they hold something for the user (web `threadsOf`).
    static func threadsOf(_ id: String?, tasks: [String: WalnutTask]) -> WalnutThreadCounts? {
        guard let id, let c = tasks[id]?.userStatus?.threads, c.shown > 0 else { return nil }
        return c
    }

    /// Needs you on the node itself, apart from its threads: a status whose source is its threads
    /// is those threads, counted once (web `collectFlatAlerts`).
    static func ownNeeds(_ id: String?, phase: String?, tasks: [String: WalnutTask]) -> Int {
        guard ownState(id, phase: phase, tasks: tasks) == .needs else { return 0 }
        if let id, tasks[id]?.userStatus?.source == "thread" { return 0 }
        return 1
    }

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
        // What the tasks under the VPs listed here ask the user. The web also counts the Inbox,
        // which is a row there; on the phone the CEO's line adds up to the rows below it. A VP's
        // own threads are counted as threads on its row, never as a Needs you here.
        let teamNeeds = vps.reduce(0) { $0 + $1.needs - ($1.threads?.needs ?? 0) }
        return [ceoRow(tree, vpCount: vps.count, teamNeeds: teamNeeds, tasks: byId)] + vps
    }

    private static func ceoRow(_ tree: OrgTreeWire, vpCount: Int, teamNeeds: Int, tasks: [String: WalnutTask]) -> Row {
        let threads = threadsOf(tree.main?.id, tasks: tasks)
        let needs = (threads?.needs ?? 0)
            + (tree.main.map { ownNeeds($0.id, phase: $0.phase, tasks: tasks) } ?? 0)
        let state: UserState = needs > 0 ? .needs : tree.counts.running > 0 ? .working : .waiting
        // The web's Main line: its own threads first, then how many VPs, what works, and what
        // needs the user under them. A thread waiting on him names itself in place of the count.
        var parts = ["\(vpCount) \(vpCount == 1 ? "VP" : "VPs")"]
        if let threads {
            parts.insert(threads.needs > 0 ? threadLine(threads) : threadCountLabel(threads.shown), at: 0)
        }
        if tree.counts.running > 0 { parts.append("\(tree.counts.running) working") }
        if teamNeeds > 0 { parts.append("\(teamNeeds) \(teamNeeds == 1 ? "needs" : "need") you") }
        return Row(
            id: "ceo", kind: .ceo, name: ceoName, contactId: tree.main?.id, project: "",
            state: state, needs: needs, working: tree.counts.running, open: tree.counts.open,
            ledProjects: [], line: parts.joined(separator: " · "), threads: threads,
            linePinned: (threads?.needs ?? 0) > 0 && threads?.titlePinned == true
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
            // A VP leading several projects waits on the user once, on its own project's row:
            // its threads waiting on him first, then the VP itself unless those are its ask.
            let ownRow = p.lead != nil && p.vp == nil
            let threads = ownRow ? threadsOf(p.lead?.id, tasks: tasks) : nil
            let leadNeeds = ownRow ? ownNeeds(p.lead?.id, phase: p.lead?.phase, tasks: tasks) : 0
            // To read is Needs you on the phone: the server counts it apart (`toRead`).
            let asks = counts.needsYou + counts.read + leadNeeds
            let needs = (threads?.needs ?? 0) + asks
            let state: UserState = needs > 0 ? .needs : counts.running > 0 ? .working : .waiting
            // Its threads name the row while one waits on him, or while nothing else asks him.
            let threadsLine = threads.flatMap { $0.needs > 0 || asks == 0 ? threadLine($0) : nil }
            let name = p.lead?.name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                ?? p.project.trimmingCharacters(in: .whitespacesAndNewlines)
            let row = Row(
                id: "project:\(projectKey(p.project))", kind: .vp, name: name,
                contactId: p.contactId ?? p.lead?.id, project: p.project,
                state: state, needs: needs, working: counts.running, open: counts.open,
                ledProjects: under.map(\.project),
                line: threadsLine ?? line(state: state, open: counts.open), threads: threads,
                linePinned: threadsLine != nil && threads?.titlePinned == true
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
        case .needs, .read: return 0
        case .working: return 1
        case .waiting: return 2
        case .done: return 3
        }
    }

    /// The row's state in words; "Nothing open" for a quiet VP with no work. No "N open" count
    /// (2026-11-03, the user, on the web's node header: "remove xx open not needed").
    static func line(state: UserState, open: Int) -> String {
        open > 0 || state != .waiting ? state.label : "Nothing open"
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
