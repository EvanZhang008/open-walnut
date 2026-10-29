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
        // The status's own time: any other edit (a pin, a rename) is not news about the work.
        return WalnutTask.parseISO(row.status?.at) ?? WalnutTask.parseISO(t.updatedAt) ?? .distantPast
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

    /// An agent's sentence (or a title) as a clause inside other words: no closing period,
    /// semicolon or colon, so "Title (Pick a date.); Other" reads "Title (Pick a date); Other".
    /// A question or an ellipsis keeps its mark.
    static func clause(_ text: String) -> String {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = t.last, ".;:!\u{3002}\u{FF1B}\u{FF1A}\u{FF01}".contains(last), !t.hasSuffix("...") { t.removeLast() }
        return t
    }

    /// Stuck is a kind of waiting: a done task keeps the report it had, and never reads Stuck.
    static func isStuck(_ task: WalnutTask) -> Bool {
        state(of: task) == .waiting && task.userStatus?.kind == "stuck"
    }

    /// A due date in a few words: "today", "Oct 30", "today 6:00 PM" (twin of the web Board's formatDue).
    static func dueText(_ at: String, now: Date = Date()) -> String {
        let raw = at.trimmingCharacters(in: .whitespaces)
        let bare = raw.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
        let date: Date?
        if bare {
            let f = DateFormatter()
            f.calendar = Calendar(identifier: .gregorian)
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyy-MM-dd"
            date = f.date(from: raw)
        } else {
            date = WalnutTask.parseISO(raw)
        }
        guard let d = date else { return raw }
        let time = d.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDate(d, inSameDayAs: now) { return bare ? "today" : "today \(time)" }
        let day = d.formatted(.dateTime.month(.abbreviated).day())
        return bare ? day : "\(day) \(time)"
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
            guard let first = on.first else { return "Waiting for a set time" }
            return "Waiting on " + first.lowercased() + on.dropFirst()
        default:
            guard let first = on.first else { return "Waiting" }
            return "Waiting on " + first.lowercased() + on.dropFirst()
        }
    }
}

/// The phone's twin of `formatLiveActivity` (`src/core/live-activity.ts`): a running task's
/// live action in one line, against the phone's clock. Pinned in `TeamStatusModelTests`.
enum LiveActivityFormat {
    /// No tool call for this long (and none running) reads as gone quiet (LIVE_QUIET_MS).
    static let quietAfter: TimeInterval = 5 * 60

    struct Line: Equatable {
        let action: String
        let quiet: Bool
        let text: String
    }

    /// "40 s", "12 min", "1 h 5 min".
    static func span(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds.isFinite ? seconds : 0))
        if s < 60 { return "\(s) s" }
        let min = s / 60
        if min < 60 { return "\(min) min" }
        let rest = min % 60
        return rest == 0 ? "\(min / 60) h" : "\(min / 60) h \(rest) min"
    }

    static func cost(_ usd: Double?) -> String? {
        guard let usd, usd.isFinite, usd > 0 else { return nil }
        return usd < 0.01 ? "<$0.01" : String(format: "$%.2f", usd)
    }

    /// An MCP tool loses its `mcp__server__` prefix.
    static func toolLabel(_ name: String) -> String {
        guard name.hasPrefix("mcp__") else { return name }
        let rest = name.dropFirst(5)
        guard let sep = rest.range(of: "__") else { return name }
        return "\(rest[..<sep.lowerBound]): \(rest[sep.upperBound...])"
    }

    static func line(_ a: WalnutLiveActivity, now: Date = AppClock.now()) -> Line {
        let since = WalnutTask.parseISO(a.since)
        let turn = WalnutTask.parseISO(a.turnStartedAt)
        let quietFrom = WalnutTask.parseISO(a.lastToolAt) ?? turn ?? since
        let quiet = a.kind != "tool" && quietFrom.map { now.timeIntervalSince($0) >= quietAfter } == true
        let spanText = since.map { span(now.timeIntervalSince($0)) }
        let action: String
        if quiet, let from = quietFrom {
            action = "No tool call for " + span(now.timeIntervalSince(from))
        } else if a.kind == "tool" {
            let label = toolLabel(a.tool ?? "a tool")
            let head = (a.target?.isEmpty == false) ? "\(label): \(a.target!)" : label
            action = head + (spanText.map { " · \($0)" } ?? "")
        } else {
            action = (a.kind == "writing" ? "Writing" : "Thinking") + (spanText.map { " · \($0)" } ?? "")
        }
        let parts = [action, turn.map { "turn " + span(now.timeIntervalSince($0)) }, cost(a.costUsd)].compactMap { $0 }
        return Line(action: action, quiet: quiet, text: parts.joined(separator: " · "))
    }
}

