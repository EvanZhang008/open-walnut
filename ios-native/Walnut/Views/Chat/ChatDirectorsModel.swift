import Foundation

/// The Directors in the Chat drawer's org view, pure, the twin of the web Org page's list
/// (`directorsOf` in `src/core/org/org-directors.ts`): which tasks under each VP are Directors,
/// in the tree's order, and how the two layouts the user picks from draw them.
///
///   fold      under a VP row with Directors, one "N directors" row (folded by default); opened,
///             its Directors, a nested one an indent deeper, under small project headings (the
///             VP's projects in order) when the user shows project names
///   sections  after the VPs, a "Directors" heading and every Director as a first-level row
///             wearing its VP's initial and colour, "<VP> · <state>" under its title
///
/// A task that is no Director is transparent: the Directors under it count as the nearest
/// Director's above (or as top level). One task is listed once, even when a VP reaches it
/// through two projects.
enum ChatDirectorsModel {
    struct Director: Identifiable, Equatable {
        let id: String
        let title: String
        let project: String
        let state: UserState
        /// 0 = a top Director under its VP; 1 = under another Director; and so on.
        let depth: Int
        /// The VP row it reports to (`ChatOrgModel.Row.id`) and that VP's name.
        let vpRowId: String
        let vpName: String
    }

    /// A project heading and its Directors; `project` nil when the user hides project names.
    struct ProjectGroup: Identifiable, Equatable {
        let project: String?
        let directors: [Director]
        var id: String { project ?? "" }
    }

    /// One VP's fold: how many Directors and the groups it opens on.
    struct Fold: Equatable {
        let vpRowId: String
        let count: Int
        let groups: [ProjectGroup]
    }

    /// "1 director", "7 directors".
    static func countLabel(_ n: Int) -> String {
        "\(n) director\(n == 1 ? "" : "s")"
    }

    /// The projects a VP row stands for, its own first, as the tree names them.
    static func projects(of row: ChatOrgModel.Row, in tree: OrgTreeWire) -> [OrgProjectWire] {
        let byKey = Dictionary(tree.projects.map { (ChatOrgModel.projectKey($0.project), $0) }, uniquingKeysWith: { a, _ in a })
        var seen = Set<String>()
        return ([row.project] + row.ledProjects).compactMap { name in
            let key = ChatOrgModel.projectKey(name)
            guard !key.isEmpty, seen.insert(key).inserted else { return nil }
            return byKey[key]
        }
    }

    /// A VP row's Directors per project, in the tree's order.
    static func directors(of row: ChatOrgModel.Row, tree: OrgTreeWire, tasks: [String: WalnutTask]) -> [(project: String, directors: [Director])] {
        var seen = Set<String>()
        return projects(of: row, in: tree).map { p in
            var out: [Director] = []
            walk(p.teams ?? [], depth: 0, project: p.project, row: row, tasks: tasks, seen: &seen, into: &out)
            return (p.project, out)
        }
    }

    private static func walk(
        _ nodes: [OrgTeamNodeWire], depth: Int, project: String, row: ChatOrgModel.Row,
        tasks: [String: WalnutTask], seen: inout Set<String>, into out: inout [Director]
    ) {
        for n in nodes {
            guard seen.insert(n.id).inserted else { continue }
            if n.director == true {
                out.append(Director(
                    id: n.id, title: title(n, tasks: tasks), project: n.project ?? project,
                    state: state(n, tasks: tasks), depth: depth, vpRowId: row.id, vpName: row.name
                ))
                walk(n.workers ?? [], depth: depth + 1, project: project, row: row, tasks: tasks, seen: &seen, into: &out)
            } else {
                walk(n.workers ?? [], depth: depth, project: project, row: row, tasks: tasks, seen: &seen, into: &out)
            }
        }
    }

    /// The fold of every VP row that has Directors, by row id.
    static func folds(rows: [ChatOrgModel.Row], tree: OrgTreeWire, tasks: [WalnutTask], showProjects: Bool) -> [String: Fold] {
        let byId = index(tasks)
        var out: [String: Fold] = [:]
        for row in rows where row.kind == .vp {
            let perProject = directors(of: row, tree: tree, tasks: byId).filter { !$0.directors.isEmpty }
            let count = perProject.reduce(0) { $0 + $1.directors.count }
            guard count > 0 else { continue }
            let groups = showProjects
                ? perProject.map { ProjectGroup(project: $0.project, directors: $0.directors) }
                : [ProjectGroup(project: nil, directors: perProject.flatMap { $0.directors })]
            out[row.id] = Fold(vpRowId: row.id, count: count, groups: groups)
        }
        return out
    }

    /// Every Director as one first-level row, VP by VP in the drawer's order.
    static func sections(rows: [ChatOrgModel.Row], tree: OrgTreeWire, tasks: [WalnutTask]) -> [Director] {
        let byId = index(tasks)
        var seen = Set<String>()
        return rows.filter { $0.kind == .vp }.flatMap { row in
            directors(of: row, tree: tree, tasks: byId).flatMap { $0.directors }.filter { seen.insert($0.id).inserted }
        }
    }

    /// The second line of a Director in the sections layout.
    static func sectionLine(_ d: Director) -> String {
        "\(d.vpName) · \(d.state.label)"
    }

    /// The round avatar's letter: the VP's first.
    static func vpInitial(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).first.map { String($0).uppercased() } ?? "?"
    }

    /// The row a tap opens, as an org node's: its own chat, or its first message when it has none.
    static func openRow(_ d: Director) -> ChatOrgModel.Row {
        ChatOrgModel.Row(
            id: "director:\(d.id)", kind: .director, name: d.title, contactId: d.id, project: d.project,
            state: d.state, needs: 0, working: 0, open: 0, ledProjects: [], line: d.state.label
        )
    }

    /// The same for a Director just made (it has no session yet).
    static func openRow(created task: WalnutTask) -> ChatOrgModel.Row {
        ChatOrgModel.Row(
            id: "director:\(task.id)", kind: .director, name: task.title, contactId: task.id, project: task.project,
            state: .waiting, needs: 0, working: 0, open: 0, ledProjects: [], line: UserState.waiting.label
        )
    }

    /// The tree with one task's Director mark changed, so a Remove shows at once (the reload that
    /// follows brings the server's answer, or puts it back after a failure).
    static func marking(_ tree: OrgTreeWire, id: String, director: Bool) -> OrgTreeWire {
        func mark(_ nodes: [OrgTeamNodeWire]?) -> [OrgTeamNodeWire]? {
            nodes?.map { n in
                var n = n
                if n.id == id { n.director = director }
                n.workers = mark(n.workers)
                return n
            }
        }
        var out = tree
        out.projects = tree.projects.map { p in
            var p = p
            p.teams = mark(p.teams)
            return p
        }
        return out
    }

    private static func index(_ tasks: [WalnutTask]) -> [String: WalnutTask] {
        Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    private static func title(_ n: OrgTeamNodeWire, tasks: [String: WalnutTask]) -> String {
        let t = (tasks[n.id]?.title ?? n.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "Untitled task" : t
    }

    /// The task list's status first (the feed keeps it current), else the tree's.
    private static func state(_ n: OrgTeamNodeWire, tasks: [String: WalnutTask]) -> UserState {
        if let task = tasks[n.id] { return TeamStatusModel.state(of: task) }
        if let s = n.userState.flatMap(UserState.init(rawValue:)) { return s.shown }
        return ChatOrgModel.ownState(nil, phase: n.phase, tasks: tasks)
    }
}
