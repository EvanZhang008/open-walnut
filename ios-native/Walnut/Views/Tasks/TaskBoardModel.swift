import Foundation

// MARK: - The board's data model, as pure values
//
// The board is ONE list of tasks grouped by pin tier. A task that HAS a session
// shows that session's state on the same row and expands into it — there is no
// second "session" object on this screen, and no card. That is the whole point:
// a session is a task that has a session, so one row type carries both.
//
// Every rule that decides what a band contains, in what order, what a row says,
// and what a tapped tier token does is a static function over plain values here,
// so WalnutTests drives the REAL logic without a store, a network, or a running
// app. The views in TaskBoardList/TaskBoardRow only lay these values out.

/// One row: a task, the session that belongs to it, or (for a legacy session
/// whose owning task never reached the projection) a session on its own.
struct BoardRow: Identifiable, Equatable {
    var task: WalnutTask?
    var session: WalnutSession?

    /// Stable identity — the TASK when there is one, so a newer session for the
    /// same task replaces the session without the row losing its place (and
    /// without an expanded row collapsing under the user).
    var id: String { task?.id ?? session?.id ?? "" }

    var title: String {
        if let task, !task.title.isEmpty { return task.title }
        return session?.rowTitle ?? ""
    }

    var isDone: Bool { task?.isDone ?? false }

    /// Project label, "" = Inbox (matches the rest of the app).
    var project: String { task?.project ?? session?.project ?? "" }

    /// A tier token can only move a TASK. A session-only row has nothing to pin,
    /// so its picker is absent rather than a control that quietly does nothing.
    var canRetier: Bool { task != nil }
}

/// What the row's second line says about the work. Derived ONLY from fields the
/// slim projection actually carries (`process_status`, `last_active_at`, and the
/// owning task's `phase`) — nothing here is inferred from data we do not have.
enum BoardRowState: Equatable {
    /// A CLI process is working right now.
    case running
    /// Alive but not working: it is waiting on the machine or on a human.
    case waiting
    /// Alive/finished AND the task is in AGENT_COMPLETE — the agent handed the
    /// work back and a human owes it a look. The one state worth its own colour.
    case handedBack
    /// The CLI is gone (a normal end).
    case ended
    /// The CLI died badly.
    case failed
    /// No session has ever run for this task.
    case none

    /// Leading word shown on the row and in the expanded strip.
    var word: String {
        switch self {
        case .running: return "running"
        case .waiting: return "waiting"
        case .handedBack: return "handed back"
        case .ended: return "session ended"
        case .failed: return "session failed"
        case .none: return "no session yet"
        }
    }
}

/// One tier band: a sticky heading plus its rows and a create affordance at the
/// foot. `tierId` is the WIRE tier id, which is what makes "the heading's `+`
/// files into the tier the heading names" a one-liner rather than a mapping.
struct BoardBand: Identifiable, Equatable {
    let tierId: String
    let label: String
    /// Rail glyph — one character, unique across the rendered bands.
    let letter: String
    let rows: [BoardRow]
    /// Rows this band is currently suppressing because `hide done` is on. Shown
    /// on the heading so hiding is never a silent disappearance.
    let hiddenDone: Int

    var id: String { tierId }
    /// The heading's number is what you can actually SEE in the band — toggling
    /// `hide done` changes it, which is the feedback that the toggle worked. A
    /// count that included hidden rows would disagree with the rows below it.
    var count: Int { rows.count }
}

enum BoardModel {

    /// Trailing band for live work that is NOT on the pinned board. Without it,
    /// starting a session on an unpinned task would make that work invisible on
    /// the one screen that shows work — a silent hole, not a clean design.
    static let activeTierId = "unpinned"
    static let activeLabel = "Active, unpinned"

    // MARK: - Session join ("a session IS a task that has a session")

    /// Latest session per task id, by last-active. One pass, no per-row search:
    /// the board renders every band from this one dictionary.
    static func latestSessionByTask(_ sessions: [WalnutSession]) -> [String: WalnutSession] {
        var latest: [String: WalnutSession] = [:]
        for session in sessions {
            guard let taskId = session.taskId, !taskId.isEmpty else { continue }
            if let current = latest[taskId], WalnutSession.recencySort(current, session) { continue }
            latest[taskId] = session
        }
        return latest
    }

    /// Row state from the projection's own fields (see BoardRowState).
    static func state(task: WalnutTask?, session: WalnutSession?) -> BoardRowState {
        guard let session else { return .none }
        // AGENT_COMPLETE outranks the process state on purpose: a CLI can sit
        // idle for hours after handing back, and "waiting" would bury the one
        // row that needs a human.
        if task?.phase == "AGENT_COMPLETE" { return .handedBack }
        switch session.statusKind {
        case .running: return .running
        case .idle: return .waiting
        case .error: return .failed
        case .stopped, .unknown: return .ended
        }
    }

    /// Compact age ("2m", "1h", "3d") for the row's second line. A row shows
    /// several of these, so the long relative form ("3 days ago") costs a line
    /// wrap on a two-line title. Pure so the tests don't need a clock.
    static func shortAge(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    // MARK: - Search

    /// Case-insensitive match over everything the row SHOWS (title, project) plus
    /// the session's host — the two things a person searches a board for.
    static func matches(_ row: BoardRow, query: String) -> Bool {
        guard !query.isEmpty else { return true }
        if row.title.localizedCaseInsensitiveContains(query) { return true }
        if row.project.localizedCaseInsensitiveContains(query) { return true }
        if let host = row.session?.host, host.localizedCaseInsensitiveContains(query) { return true }
        return false
    }

    // MARK: - Band assembly

    /// Rows of one tier, in the ORDER THE SERVER KEEPS THEM.
    ///
    /// This is what makes "a new task lands at the foot of its band" true rather
    /// than aspirational: `pin_order` is max+1 for a new pin, and the tier split
    /// endpoint returns each bucket already in pin order — so following that
    /// array is following the server's placement. Ids the split hasn't caught up
    /// with yet (an optimistic local pin) are appended, which is also the foot.
    static func orderedIds(splitOrder: [String], extras: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for id in splitOrder where !seen.contains(id) {
            seen.insert(id)
            out.append(id)
        }
        for id in extras where !seen.contains(id) {
            seen.insert(id)
            out.append(id)
        }
        return out
    }

    /// The whole board.
    ///
    /// - Parameters:
    ///   - tierOf: taskId → tier id (TasksStore.taskTiers).
    ///   - tierOrder: tier id → ordered task ids (the split's own arrays).
    ///   - hiddenDoneTiers: bands whose `hide done` is on. Done rows are dropped
    ///     from those bands only — everywhere else a completed task stays EXACTLY
    ///     where it was, struck through, because the position is the memory of
    ///     where the work happened.
    static func bands(
        tasks: [WalnutTask],
        sessions: [WalnutSession],
        tierOf: [String: String],
        tierOrder: [String: [String]],
        customTiers: [FocusTierInfo],
        query: String = "",
        hiddenDoneTiers: Set<String> = []
    ) -> [BoardBand] {
        let sessionOf = latestSessionByTask(sessions)

        // The lookup table holds only the tasks a band CAN contain — the ones some
        // tier claims, from either source. Building it over the whole projection
        // was a 2,000-entry dictionary per body pass to serve ~220 lookups, and at
        // field scale the projection grows while the pinned board does not, so the
        // wasted share only gets worse.
        //
        // Both sources are unioned rather than just the map, because dropping an
        // id that the ORDER names but the map has not caught up with would silently
        // hide a row. They agree today (one `adoptSplit`), and this keeps that an
        // optimization rather than a dependency.
        var wanted = Set(tierOf.keys)
        for ids in tierOrder.values { wanted.formUnion(ids) }

        // `extrasByTier` rides the same walk: it is the FALLBACK ordering for ids
        // the split hasn't caught up with, kept in the tasks list's own (already
        // sorted) order so it is stable.
        var taskById: [String: WalnutTask] = [:]
        var extrasByTier: [String: [String]] = [:]
        taskById.reserveCapacity(wanted.count)
        for task in tasks where wanted.contains(task.id) {
            taskById[task.id] = task
            if let tier = tierOf[task.id] {
                extrasByTier[tier, default: []].append(task.id)
            }
        }

        let ordered: [(id: String, label: String)] =
            TasksStore.builtinTiers.map { ($0.id, $0.label) }
            + customTiers.map { ($0.id, $0.label) }

        var bands: [BoardBand] = []
        var letters = Set<String>()

        for tier in ordered {
            let ids = orderedIds(
                splitOrder: tierOrder[tier.id] ?? [],
                extras: extrasByTier[tier.id] ?? []
            )
            // ONE pass that builds, search-filters and counts. Three chained
            // `filter`/`count` calls over the same array is three walks and two
            // throwaway arrays per band per body pass; a band is rebuilt on every
            // keystroke, so the pass count is what the budget notices.
            //
            // A tier's bucket can name a task this projection no longer has
            // (deleted elsewhere) — that id is skipped rather than rendered as
            // an empty row.
            let hidingDone = hiddenDoneTiers.contains(tier.id)
            var rows: [BoardRow] = []
            rows.reserveCapacity(ids.count)
            var doneCount = 0
            for id in ids {
                guard let task = taskById[id] else { continue }
                let row = BoardRow(task: task, session: sessionOf[id])
                guard matches(row, query: query) else { continue }
                if row.isDone {
                    doneCount += 1
                    if hidingDone { continue }
                }
                rows.append(row)
            }
            guard !rows.isEmpty || doneCount > 0 else { continue }
            bands.append(BoardBand(
                tierId: tier.id, label: tier.label,
                letter: railLetter(for: tier.label, taken: &letters),
                rows: rows,
                hiddenDone: hidingDone ? doneCount : 0
            ))
        }

        let active = activeRows(
            tasks: tasks, sessions: sessions, sessionOf: sessionOf,
            tierOf: tierOf, query: query
        )
        if !active.isEmpty {
            bands.append(BoardBand(
                tierId: activeTierId, label: activeLabel,
                letter: railLetter(for: activeLabel, taken: &letters),
                rows: active, hiddenDone: 0
            ))
        }
        return bands
    }

    /// Live work that is not pinned: unpinned tasks whose latest session is
    /// alive, plus sessions with no owning task at all (older rows). Most
    /// recently active first — this band is a tail, not a place you file things.
    ///
    /// Two deliberate shapes, both measured on the perf fixture (2,000 tasks /
    /// 500 sessions, live query):
    ///
    ///  - It iterates the SESSIONS, not the tasks. A row here needs a live
    ///    session by definition, so the alive sessions ARE the candidate set —
    ///    walking 2,000 tasks to find the handful with one is 4x the work for the
    ///    same answer, and the gap widens as the projection grows (the session
    ///    list is capped at 500 by contract; the task list is not).
    ///  - The search filter runs BEFORE the sort, and before the sort key is even
    ///    computed: filter-after-sort measured 3.79ms/pass, filter-during-
    ///    collection 0.98ms. Sorting rows a query is about to discard is the whole
    ///    difference, and the cheapest rejection comes first because
    ///    `lastActiveValue` is the expensive one (2.09ms per 500 calls).
    static func activeRows(
        tasks: [WalnutTask],
        sessions: [WalnutSession],
        sessionOf: [String: WalnutSession],
        tierOf: [String: String],
        query: String
    ) -> [BoardRow] {
        var taskById: [String: WalnutTask] = [:]
        var rows: [(row: BoardRow, at: Date)] = []
        for session in sessions {
            guard session.statusKind.isAlive else { continue }
            guard let taskId = session.taskId, !taskId.isEmpty else {
                // No owning task — the session is the row, and it can't be
                // pinned, so no tier check applies.
                let row = BoardRow(task: nil, session: session)
                guard matches(row, query: query) else { continue }
                rows.append((row, session.lastActiveValue ?? .distantPast))
                continue
            }
            // Pinned work already has a band; the tail is for everything else.
            guard tierOf[taskId] == nil else { continue }
            // Only the LATEST session represents its task (one row per task).
            guard sessionOf[taskId]?.id == session.id else { continue }
            // The task lookup is built lazily and only over the ids that got this
            // far — a dictionary over the whole projection would cost more than
            // the lookups it serves.
            if taskById.isEmpty {
                for task in tasks { taskById[task.id] = task }
            }
            guard let task = taskById[taskId], task.pinned != true else { continue }
            let row = BoardRow(task: task, session: session)
            guard matches(row, query: query) else { continue }
            rows.append((row, session.lastActiveValue ?? .distantPast))
        }
        return rows.sorted { $0.at > $1.at }.map(\.row)
    }

    /// One-character rail glyph, unique across the rendered bands. Uniqueness
    /// matters twice: the rail must not show two identical buttons, and the
    /// glyph rides an accessibility identifier that automation matches as a
    /// REGEX — so it stays inside [A-Z0-9] and never grows a `|`.
    static func railLetter(for label: String, taken: inout Set<String>) -> String {
        let letters = label.uppercased().filter { $0.isLetter || $0.isNumber }
        for character in letters {
            let candidate = String(character)
            if !taken.contains(candidate) {
                taken.insert(candidate)
                return candidate
            }
        }
        // Every letter of the label is already spoken for: fall back to digits,
        // which cannot collide because the set of used ones is right here.
        for digit in 0...9 {
            let candidate = String(digit)
            if !taken.contains(candidate) {
                taken.insert(candidate)
                return candidate
            }
        }
        return "•"
    }

    /// Every row id the bands already render.
    ///
    /// Used to keep a search on the board from showing a task TWICE: the bands
    /// hold pinned work, the search hits below hold matching open tasks, and a
    /// pinned task that matched belongs to both sets. Two rows for one task on one
    /// screen is exactly the confusion this design removes.
    static func rowIds(_ bands: [BoardBand]) -> Set<String> {
        var ids = Set<String>()
        for band in bands {
            for row in band.rows { ids.insert(row.id) }
        }
        return ids
    }

    // MARK: - Expand / collapse

    /// Toggle a row's expansion.
    ///
    /// Deliberately a SET, not a single id. Force-collapsing the previously open
    /// row is the thing that yanks the scroll position: if that row sits above
    /// the viewport, its expansion shrinking away moves every visible row up by
    /// the height of a session panel. A disclosure list has no reason to enforce
    /// one-at-a-time, and the row you tapped is by definition on screen — so
    /// nothing above the viewport ever changes height.
    static func toggleExpanded(_ current: Set<String>, _ id: String) -> Set<String> {
        var next = current
        if next.contains(id) { next.remove(id) } else { next.insert(id) }
        return next
    }

    // MARK: - Tier tokens (move tier in two taps, no drag)

    /// One token in an expanded row's picker.
    struct TierToken: Identifiable, Equatable {
        let tierId: String
        let label: String
        let selected: Bool
        /// The "Unpin" token — takes the task off the board entirely.
        let isUnpin: Bool
        var id: String { isUnpin ? "unpin" : tierId }
    }

    /// What a tapped token should do. Returned rather than performed so the rule
    /// is testable and the view stays a dumb caller.
    enum TierAction: Equatable {
        case setTier(String)
        case unpin
        /// The token that is already selected — spend no request on it.
        case noop
    }

    static func tokens(current: String?, choices: [(id: String, label: String)]) -> [TierToken] {
        var tokens = choices.map {
            TierToken(tierId: $0.id, label: $0.label, selected: $0.id == current, isUnpin: false)
        }
        tokens.append(TierToken(tierId: "", label: "Unpin", selected: false, isUnpin: true))
        return tokens
    }

    static func action(for token: TierToken, current: String?) -> TierAction {
        if token.isUnpin { return current == nil ? .noop : .unpin }
        if token.tierId == current { return .noop }
        return .setTier(token.tierId)
    }
}
