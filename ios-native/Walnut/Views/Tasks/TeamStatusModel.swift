import Foundation

/// The phone's twin of the web Board's Status view (`web/src/components/board/board-status-model.ts`):
/// a lead's team by the one user status the server keeps on each task (`user_status`,
/// `src/core/user-status.ts`), in the same order and with the same counts as the web
/// Board, the Org page and the task list. Pure: unit-pinned in `TeamStatusModelTests`.
enum UserState: String, CaseIterable {
    case needs, working, waiting, done

    var label: String {
        switch self {
        case .needs: return "Needs you"
        case .working: return "Working"
        case .waiting: return "Waiting"
        case .done: return "Done"
        }
    }
}

struct TeamStatusRow: Identifiable, Equatable {
    let task: WalnutTask
    let state: UserState
    let status: WalnutUserStatus?
    /// 0 = the lead itself, 1 = a direct subtask.
    let depth: Int
    var id: String { task.id }
    var isStuck: Bool { state == .waiting && status?.kind == "stuck" }
}

struct TeamStatusCounts: Equatable {
    var needs = 0, working = 0, waiting = 0, done = 0

    subscript(_ s: UserState) -> Int {
        switch s {
        case .needs: return needs
        case .working: return working
        case .waiting: return waiting
        case .done: return done
        }
    }
}

struct TeamStatusBoard: Equatable {
    var counts = TeamStatusCounts()
    var needs: [TeamStatusRow] = []
    var working: [TeamStatusRow] = []
    var waiting: [TeamStatusRow] = []
    var done: [TeamStatusRow] = []
    var stuck: Int { waiting.filter(\.isStuck).count }
    var notStarted: Int { waiting.filter { $0.status?.kind == "not-started" }.count }
    var open: [TeamStatusRow] { needs + working + waiting }
    /// The lead has a team to show (one subtask at least, open or recently done).
    var hasTeam: Bool { open.count + done.count > 1 }

    func rows(_ s: UserState) -> [TeamStatusRow] {
        switch s {
        case .needs: return needs
        case .working: return working
        case .waiting: return waiting
        case .done: return done
        }
    }
}

enum TeamStatusModel {
    /// Finished tasks older than this are left out (the web's RECENT_COMPLETED_DAYS).
    static let doneWindowDays = 7
    /// Levels walked below the lead (the web's TEAM_DEPTH_CAP).
    static let depthCap = 8

    /// The stored status, else what the phase alone says (a server that predates `user_status`),
    /// as an older Walnut meant it: NEED_ACTION was "handed back to you", the row dot's rule
    /// (`BoardModel.needsHuman`) and the server's `fallbackUserState`.
    static func state(of task: WalnutTask) -> UserState {
        if task.isDone || task.phase == "COMPLETE" { return .done }
        if let raw = task.userStatus?.state, let s = UserState(rawValue: raw) { return s }
        switch task.phase {
        case "IN_PROGRESS": return .working
        case "NEED_ACTION": return .needs
        default: return .waiting
        }
    }

    private static let waitOrder: [String: Int] = [
        "stuck": 0, "you": 1, "task": 2, "lead": 3, "machine": 4, "time": 5, "other": 6, "not-started": 9,
    ]

    static func rowTime(_ row: TeamStatusRow) -> Date {
        let t = row.task
        if row.state == .done { return WalnutTask.parseISO(t.completedAt ?? t.updatedAt) ?? .distantPast }
        return [WalnutTask.parseISO(row.status?.at), WalnutTask.parseISO(t.updatedAt)].compactMap { $0 }.max() ?? .distantPast
    }

    static func build(ownerId: String, tasks: [WalnutTask], now: Date = AppClock.now()) -> TeamStatusBoard {
        var children: [String: [WalnutTask]] = [:]
        for t in tasks { if let p = t.parentTaskId, p != t.id { children[p, default: []].append(t) } }
        var members: [(WalnutTask, Int)] = []
        if let owner = tasks.first(where: { $0.id == ownerId }) { members.append((owner, 0)) }
        var seen: Set<String> = [ownerId]
        func visit(_ id: String, _ depth: Int) {
            guard depth <= depthCap else { return }
            for c in children[id] ?? [] where !seen.contains(c.id) {
                seen.insert(c.id)
                members.append((c, depth))
                visit(c.id, depth + 1)
            }
        }
        visit(ownerId, 1)

        let cutoff = now.addingTimeInterval(-Double(doneWindowDays) * 86_400)
        var board = TeamStatusBoard()
        for (task, depth) in members {
            let s = state(of: task)
            if s == .done, (WalnutTask.parseISO(task.completedAt ?? task.updatedAt) ?? .distantPast) < cutoff { continue }
            let row = TeamStatusRow(task: task, state: s, status: s == .done ? nil : task.userStatus, depth: depth)
            switch s {
            case .needs: board.needs.append(row); board.counts.needs += 1
            case .working: board.working.append(row); board.counts.working += 1
            case .waiting: board.waiting.append(row); board.counts.waiting += 1
            case .done: board.done.append(row); board.counts.done += 1
            }
        }
        let newest: (TeamStatusRow, TeamStatusRow) -> Bool = { rowTime($0) > rowTime($1) }
        board.needs.sort(by: newest)
        board.working.sort(by: newest)
        board.done.sort(by: newest)
        board.waiting.sort { a, b in
            let ka = waitOrder[a.status?.kind ?? "other"] ?? 6
            let kb = waitOrder[b.status?.kind ?? "other"] ?? 6
            return ka != kb ? ka < kb : newest(a, b)
        }
        return board
    }

    /// "10 working, 16 waiting (1 stuck, 5 not started), 12 done in the last 7 days."
    static func countsLine(_ b: TeamStatusBoard) -> String {
        let extra = [b.stuck > 0 ? "\(b.stuck) stuck" : nil, b.notStarted > 0 ? "\(b.notStarted) not started" : nil]
            .compactMap { $0 }.joined(separator: ", ")
        let waiting = "\(b.counts.waiting) waiting" + (extra.isEmpty ? "" : " (\(extra))")
        return "\(b.counts.working) working, \(waiting), \(b.counts.done) done in the last \(doneWindowDays) days."
    }

    /// A waiting row's line: "Waiting on another task: …", "Stuck. …", "Not started yet".
    static func waitingLine(_ s: WalnutUserStatus?) -> String {
        let on = (s?.waitingOn ?? "").trimmingCharacters(in: .whitespaces)
        switch s?.kind {
        case "stuck": return "Stuck. " + (on.isEmpty ? "Nothing will wake it." : on)
        case "not-started": return on.isEmpty ? "Not started yet" : on
        case "time":
            if let until = WalnutTask.parseISO(s?.until) {
                return "Waiting until " + until.formatted(date: .abbreviated, time: .shortened)
            }
            return "Waiting"
        default:
            guard let first = on.first else { return "Waiting" }
            return "Waiting on " + first.lowercased() + on.dropFirst()
        }
    }
}
