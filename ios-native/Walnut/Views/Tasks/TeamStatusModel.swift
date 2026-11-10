import Foundation

/// The phone's twin of the web Board's Status view (`web/src/components/board/board-status-model.ts`):
/// a lead's team by the one user status the server keeps on each task (`user_status`,
/// `src/core/user-status.ts`), in the same order and with the same counts as the web
/// Board, the Org page and the task list. Pure: unit-pinned in `TeamStatusModelTests`.
///
/// `read` (To read, 2026-11-02) is decoded but never drawn as its own group (2026-11-03, the
/// user: "I dont wnat serpeate to read"): a To read task is shown and counted under Needs you,
/// its third line saying what there is to read (`needLine`). `shown` is that fold.
enum UserState: String, CaseIterable {
    case needs, read, working, waiting, done

    /// The groups a person sees, in order: no To read among them.
    static let groups: [UserState] = [.needs, .working, .waiting, .done]

    /// The group a state is drawn in: To read is Needs you.
    var shown: UserState { self == .read ? .needs : self }

    /// The four names a person reads on every surface (src/core/user-status.ts USER_STATE_LABELS).
    var label: String {
        switch self {
        case .needs: return "Needs you"
        // To read is drawn and named as Needs you (`shown`).
        case .read: return "Needs you"
        case .working: return "Working"
        case .waiting: return "Waiting / snoozed"
        case .done: return "Completed"
        }
    }
}

/// What a Needs you row asks of the user, the word that leads its third line (server
/// `user_status.category`, the web's labels).
enum NeedCategory: String, CaseIterable {
    case look, decide, review, close

    var label: String {
        switch self {
        case .look: return "Take a look"
        case .decide: return "Decide"
        case .review: return "Review"
        case .close: return "Can close"
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
    /// A Needs you row whose status only has something to read (To read).
    var isToRead: Bool { state == .needs && TeamStatusModel.isToRead(status) }
}

struct TeamStatusCounts: Equatable {
    /// To read tasks count under `needs`.
    var needs = 0, working = 0, waiting = 0, done = 0

    subscript(_ s: UserState) -> Int {
        switch s {
        case .needs, .read: return needs
        case .working: return working
        case .waiting: return waiting
        case .done: return done
        }
    }
}

struct TeamStatusBoard: Equatable {
    var counts = TeamStatusCounts()
    /// Needs you, To read rows among them.
    var needs: [TeamStatusRow] = []
    var working: [TeamStatusRow] = []
    var waiting: [TeamStatusRow] = []
    var done: [TeamStatusRow] = []
    var stuck: Int { waiting.filter(\.isStuck).count }
    /// Waiting rows nobody started: a category of their own (`TeamStatusChip.notStarted`).
    var notStartedRows: [TeamStatusRow] { waiting.filter { TeamStatusModel.isNotStarted($0.status) } }
    var notStarted: Int { notStartedRows.count }
    /// Waiting / snoozed without the not started ones.
    var waitingRows: [TeamStatusRow] { waiting.filter { !TeamStatusModel.isNotStarted($0.status) } }
    var open: [TeamStatusRow] { needs + working + waiting }
    /// The lead has a team to show (one subtask at least, open or recently done).
    /// Whether the owner's own row is among the rows (`build`'s `includeOwner`).
    var ownerIncluded = true
    var hasTeam: Bool { open.count + done.count > (ownerIncluded ? 1 : 0) }

    func rows(_ s: UserState) -> [TeamStatusRow] {
        switch s {
        case .needs, .read: return needs
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

    /// The stored status, else what the phase alone says (a server that predates `user_status`,
    /// or a state this build does not know), as an older Walnut meant it: NEED_ACTION was
    /// "handed back to you", the row dot's rule (`BoardModel.needsHuman`) and the server's
    /// `fallbackUserState`. The state as drawn: To read is Needs you (`UserState.shown`).
    static func state(of task: WalnutTask) -> UserState {
        if task.isDone || task.phase == "COMPLETE" { return .done }
        if let s = userState(task.userStatus) { return s.shown }
        switch task.phase {
        case "IN_PROGRESS": return .working
        case "NEED_ACTION": return .needs
        default: return .waiting
        }
    }

    /// The one user status as a state, nil when there is none this build can read. A server from
    /// before the To read state (2026-11-02, `legacyUserState`) sends it as `waiting` with
    /// `toRead` set; a snoozed status stays Waiting whatever it would be after its date.
    static func userState(_ s: WalnutUserStatus?) -> UserState? {
        guard let s, let state = UserState(rawValue: s.state) else { return nil }
        if state == .waiting, s.snoozed == nil, !(s.toRead ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
            return .read
        }
        return state
    }

    /// The status only has something to read (To read), nothing asked: drawn under Needs you.
    static func isToRead(_ s: WalnutUserStatus?) -> Bool { userState(s) == .read }

    private static let waitOrder: [String: Int] = [
        "stuck": 0, "you": 1, "task": 2, "lead": 3, "outside": 4, "machine": 4, "time": 5, "other": 6, "not-started": 9,
    ]

    static func rowTime(_ row: TeamStatusRow) -> Date {
        let t = row.task
        if row.state == .done { return WalnutTask.parseISO(t.completedAt ?? t.updatedAt) ?? .distantPast }
        // Working now: since its turn began, not since its last report ("Working · 1h ago").
        if row.state == .working, let began = WalnutTask.parseISO(t.liveActivity?.turnStartedAt) { return began }
        // The status's own time: any other edit (a pin, a rename) is not news about the work.
        return WalnutTask.parseISO(row.status?.at) ?? WalnutTask.parseISO(t.updatedAt) ?? .distantPast
    }

    /// `includeOwner` false leaves the owner's own row out: on its own page the leader is the page,
    /// so a row of it in its team reads as a mistake.
    static func build(ownerId: String, tasks: [WalnutTask], includeOwner: Bool = true, now: Date = AppClock.now()) -> TeamStatusBoard {
        var children: [String: [WalnutTask]] = [:]
        for t in tasks { if let p = t.parentTaskId, p != t.id { children[p, default: []].append(t) } }
        var members: [(WalnutTask, Int)] = []
        if includeOwner, let owner = tasks.first(where: { $0.id == ownerId }) { members.append((owner, 0)) }
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
        board.ownerIncluded = includeOwner && members.first?.1 == 0
        for (task, depth) in members {
            let s = state(of: task)
            if s == .done, (WalnutTask.parseISO(task.completedAt ?? task.updatedAt) ?? .distantPast) < cutoff { continue }
            let row = TeamStatusRow(task: task, state: s, status: s == .done ? nil : task.userStatus, depth: depth)
            switch s {
            case .needs, .read: board.needs.append(row); board.counts.needs += 1
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

    /// "10 Working, 11 Waiting / snoozed (1 with nothing to wake it), 5 Not started, 12 Completed in
    /// the last 7 days." To read tasks are Needs you, named in the line above it, never here. Not
    /// started is its own category, never a part of Waiting (the web's `countsLine`).
    static func countsLine(_ b: TeamStatusBoard) -> String {
        let extra = b.stuck > 0 ? " (\(b.stuck) with nothing to wake it)" : ""
        let waiting = "\(b.counts.waiting - b.notStarted) \(UserState.waiting.label)\(extra)"
        let notStarted = b.notStarted > 0 ? ", \(b.notStarted) \(notStartedLabel)" : ""
        return "\(b.counts.working) \(UserState.working.label), \(waiting)\(notStarted), \(b.counts.done) \(UserState.done.label) in the last \(doneWindowDays) days."
    }

    /// Not started: a task nobody started (never run, marked in progress with no session, a start
    /// that failed) and not snoozed, the web's `isNotStartedStatus` (2026-11-09, the owner: it is
    /// "completeli differnet" from wait and snooze). A snoozed one sleeps under Waiting / snoozed.
    static let notStartedLabel = "Not started"
    static func isNotStarted(_ s: WalnutUserStatus?) -> Bool {
        guard let s else { return false }
        return s.state == UserState.waiting.rawValue && s.kind == "not-started" && s.snoozed == nil
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

    /// Under a session's own "needs you" or a Board choice's: when it was last checked, or that it
    /// is not verified and may be done already. Nil for Walnut's live records (a prompt, a letter).
    /// Mirrors `checkedLine` in src/core/user-status.ts.
    static func checkedLine(_ s: WalnutUserStatus?, now: Date = AppClock.now()) -> (text: String, unverified: Bool)? {
        guard let s, s.state == "needs", s.source == "session" || s.source == "choice" else { return nil }
        guard let iso = s.checkedAt, let at = WalnutTask.parseISO(iso) else {
            // A Board choice with no recorded time was never checked.
            return s.source == "choice" && s.unverified == true ? ("Not verified: no check recorded, may be done already", true) : nil
        }
        let ago = RelativeTime.short(date: at, relativeTo: now)
        // A trigger watches the task, not necessarily this ask: shown, never a check.
        let ran = s.watchedAt.flatMap { WalnutTask.parseISO($0) }
        let watched = ran.map { "; its trigger ran \(RelativeTime.short(date: $0, relativeTo: now))" } ?? ""
        if s.unverified == true { return ("Not verified: last checked \(ago), may be done already\(watched)", true) }
        return ("Checked \(ago)\(watched)", false)
    }

    /// A To read status's words: the server's ("The result is ready"), else what there is to
    /// read. Nil when it says nothing and names no kind. Never the word Waiting; never "take a
    /// look" either, which the category word already says.
    static func readLine(_ s: WalnutUserStatus?) -> String? {
        let on = (s?.waitingOn ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !on.isEmpty { return on }
        switch s?.toRead?.trimmingCharacters(in: .whitespaces) {
        case "result": return "The result is ready"
        case "answer": return "It answered your question"
        case "turn": return "Its turn ended without asking you anything"
        default: return nil
        }
    }

    /// What a Needs you row's third line says: the category word, then its words.
    struct NeedLine: Equatable {
        let category: NeedCategory
        let text: String
        /// "Decide: Approve the deploy?"
        var line: String { "\(category.label): \(text)" }
    }

    /// A Needs you row's third line (2026-11-03, the user: "thridline cna show what need u ... in
    /// one line", then "give more category ... read, makde decison, review, see if can closed"):
    /// what kind of thing it needs, then its ask, else (To read) what there is to read. Nil when
    /// it has no words: no line is invented.
    static func needLine(_ s: WalnutUserStatus?) -> NeedLine? {
        let ask = (s?.ask ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let text = !ask.isEmpty ? ask : isToRead(s) ? readLine(s) : nil
        guard let text else { return nil }
        return NeedLine(category: needCategory(s), text: text)
    }

    /// The server's `category`, else (an older server, or a word this build does not know) what
    /// the status says: a finished result can close, anything else to read is a look, an error
    /// is a look, any other ask is a decision.
    static func needCategory(_ s: WalnutUserStatus?) -> NeedCategory {
        if let raw = s?.category?.trimmingCharacters(in: .whitespaces).lowercased(),
           let c = NeedCategory(rawValue: raw) { return c }
        if isToRead(s) { return s?.toRead?.trimmingCharacters(in: .whitespaces) == "result" ? .close : .look }
        if s?.source == "error" { return .look }
        return .decide
    }

    /// A waiting row's line: "Waiting on another task: …", "Nothing will wake it. …", "Not started yet".
    static func waitingLine(_ s: WalnutUserStatus?) -> String {
        let on = (s?.waitingOn ?? "").trimmingCharacters(in: .whitespaces)
        switch s?.kind {
        case "stuck": return on.isEmpty ? "Nothing will wake it." : "Nothing will wake it. " + on
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

