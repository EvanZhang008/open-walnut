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

    /// The task this row is ABOUT, whether or not the projection carries that task.
    ///
    /// A session-only row is not a row about a session: it is a row about the task
    /// that session was started for, drawn from the session because the phone's slim
    /// projection does not have the task. The session already names its owner
    /// (`task_id`, decoded), so "which task is this" is answerable in both cases and
    /// only a session with no owner at all has no answer.
    ///
    /// This exists because the board used TWO id spaces and one of them was invisible
    /// to everything else on the screen (measured, R25): a session-only row keyed
    /// itself by the CLI session UUID (`board.row.a1d81a24-…`) while every other row
    /// keyed itself by the task id, so the search dedup's visible-id set never
    /// matched the server's hit for that same task and the task drew TWICE, 55pt
    /// apart — once as the board row and once as a "Server Search" row.
    var owningTaskId: String? {
        if let id = task?.id, !id.isEmpty { return id }
        if let id = session?.taskId, !id.isEmpty { return id }
        return nil
    }

    /// Stable identity — the TASK when there is one, so a newer session for the
    /// same task replaces the session without the row losing its place (and
    /// without an expanded row collapsing under the user).
    ///
    /// ONE id space: the owning task id whenever it is resolvable (from the task, or
    /// from the session's own `task_id` when the projection lacks the task), and the
    /// session id only for a session that owns nothing. Uniqueness survives because
    /// the band assembly emits a task-driven row and a session-only row for the same
    /// task id by construction never both happen — `unfiledRows` and `projectBands`
    /// each skip a session whose task the projection already rendered.
    var id: String { owningTaskId ?? session?.id ?? "" }

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

/// How the board groups its rows — the phone's half of the desktop's grouping
/// control (`[['project','By project'],['none','Flat']]` in ViewDropdown).
///
/// The desktop's other value is "Flat" because its default grouping IS project.
/// The board's own structure is the tier split, so the pair here is tier (its
/// native shape) vs project (the desktop's) — a third "flat" option would throw
/// away the one thing that makes this screen a board.
enum BoardGrouping: String, CaseIterable, Identifiable {
    case tier, project
    var id: String { rawValue }
    var label: String {
        switch self {
        case .tier: return "Tier"
        case .project: return "By project"
        }
    }
}

/// The desktop's date filter, in the two values that earn their place on a phone
/// (`DATE_FILTER_OPTIONS` also has Overdue / This week / No date, which live in a
/// "More…" dropdown there — a menu inside a filter bar inside a board is three
/// levels for a filter the user has never asked for on the phone).
enum BoardDateFilter: String, CaseIterable, Identifiable {
    case all, now
    var id: String { rawValue }
    var label: String {
        switch self {
        case .all: return "All"
        case .now: return "Now"
        }
    }
}

/// One band: a sticky heading plus its rows and a create affordance at the foot.
///
/// `bandId` is a tier id under `.tier` grouping and `proj:<name>` under
/// `.project` — it is an IDENTITY, used for the scroll anchor, the accessibility
/// id and the `hide done` set, and never parsed back apart. What the heading's
/// `+` files into is stated outright by `createSeed` instead of inferred from the
/// id, which is what lets a project heading create into that project without the
/// view learning a second mapping.
struct BoardBand: Identifiable, Equatable {
    let bandId: String
    let label: String
    let rows: [BoardRow]
    /// Rows this band is currently suppressing because `hide done` is on. Shown
    /// on the heading so hiding is never a silent disappearance.
    let hiddenDone: Int
    /// What the foot's `+` creates, or nil for a band with no create affordance.
    /// The tail band has none on purpose: it is the COMPLEMENT of the others, so
    /// "create here" has no destination to mean.
    let createSeed: NewTaskSeed?

    var id: String { bandId }
    /// The heading's number is what you can actually SEE in the band — toggling
    /// `hide done` changes it, which is the feedback that the toggle worked. A
    /// count that included hidden rows would disagree with the rows below it.
    var count: Int { rows.count }
}

enum BoardModel {

    /// Trailing band for every task NO tier claims.
    ///
    /// This band is the board's completeness guarantee, and it was originally
    /// much narrower ("live work that is not pinned", session-gated). That
    /// version had a hole big enough to lose a task in: the bands above are
    /// built from the tier split, so a task with no tier had a row ONLY if it
    /// also had a live session. Create a task, have the tier write not land (or
    /// land and then get overwritten by a split that hasn't caught up), and the
    /// task existed in the store, in search, in every other view — and was
    /// absent from the one screen whose whole job is showing tasks. The user hit
    /// exactly that: "I created a task in Pinned and it just disappeared."
    ///
    /// The rule now is the one a task list can actually promise: a task is on
    /// this board, full stop. A tier decides WHICH band, never WHETHER.
    static let activeTierId = "unpinned"
    static let activeLabel = "Everything else"

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

    // MARK: - Date filter ("Now")

    /// The desktop's "Now" rule, ported (`TodoPanel.matchesDateFilter` case
    /// `'now'` → `isDeferredByStart`): a task is hidden only when its START date
    /// says the work begins later. A due date is a DEADLINE — it marks a row
    /// overdue, it never hides one, because the day you most need to see a task
    /// is the day it was due.
    ///
    /// A done row is exempt. The desktop applies the same exemption
    /// (`t.status !== 'done' && !matchesDateFilter(…)`), and on this board it
    /// matters more: hiding completions is what the band's own `hide done` is
    /// for, and a date filter that quietly did it too would make that toggle
    /// look broken.
    ///
    /// One thing the desktop does that this cannot: inherit a parent's
    /// `start_date` when the task has none. The mobile projection carries no
    /// `parent_task_id`, so there is no chain to walk — a subtask with no start
    /// date of its own reads as actionable now. That is the honest answer from
    /// the data this surface has, not an approximation of the other one.
    static func isDeferred(_ row: BoardRow, filter: BoardDateFilter, now: Date) -> Bool {
        guard filter == .now, let task = row.task, !task.isDone else { return false }
        guard let start = task.startDateValue else { return false }
        return start > now
    }

    /// Everything a band checks before it keeps a row: the query, then the date
    /// filter. Both callers go through this so a row can never be admitted by one
    /// grouping and rejected by the other.
    static func admits(
        _ row: BoardRow, query: String, dateFilter: BoardDateFilter, now: Date
    ) -> Bool {
        matches(row, query: query) && !isDeferred(row, filter: dateFilter, now: now)
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
    ///   - grouping: tier bands (the board's own shape) or project bands (the
    ///     desktop's). Same rows either way — only the headings change.
    ///   - dateFilter: "Now" hides work whose start date hasn't arrived.
    ///   - hiddenDoneTiers: bands whose `hide done` is on. Done rows are dropped
    ///     from those bands only — everywhere else a completed task stays EXACTLY
    ///     where it was, struck through, because the position is the memory of
    ///     where the work happened.
    ///   - now: injected so the date filter is testable without a clock.
    static func bands(
        tasks: [WalnutTask],
        sessions: [WalnutSession],
        tierOf: [String: String],
        tierOrder: [String: [String]],
        customTiers: [FocusTierInfo],
        query: String = "",
        grouping: BoardGrouping = .tier,
        dateFilter: BoardDateFilter = .all,
        hiddenDoneTiers: Set<String> = [],
        now: Date = Date()
    ) -> [BoardBand] {
        if grouping == .project {
            return projectBands(
                tasks: tasks, sessions: sessions, query: query,
                dateFilter: dateFilter, hiddenDoneTiers: hiddenDoneTiers, now: now
            )
        }
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
        // Ids a tier band actually RENDERED. The tail band takes its complement,
        // so "claimed by a tier" and "shown in a tier" can never disagree — an id
        // the map claims but no band could render (task gone from the projection,
        // or filtered out) still gets its chance below instead of vanishing.
        var claimed = Set<String>()

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
                // Claimed the moment a band OWNS the id, before the search
                // filter: a query that hides the row must not push it into the
                // tail band, which would render it twice as the query narrows.
                claimed.insert(id)
                guard admits(row, query: query, dateFilter: dateFilter, now: now) else { continue }
                if row.isDone {
                    doneCount += 1
                    if hidingDone { continue }
                }
                rows.append(row)
            }
            guard !rows.isEmpty || doneCount > 0 else { continue }
            bands.append(BoardBand(
                bandId: tier.id, label: tier.label,
                rows: rows,
                hiddenDone: hidingDone ? doneCount : 0,
                createSeed: NewTaskSeed.tier(tier.id)
            ))
        }

        // The tail band honours `hide done` like every other band. It did not until
        // 2026-08-29, and the asymmetry was the biggest one on the screen: this band
        // holds the complement of every tier, which on the real board is 2,903 of 3,161
        // rows, so the one band where a completed backlog actually buries the live work
        // was the one band that could not fold it away.
        let unfiled = unfiledRows(
            tasks: tasks, sessions: sessions, sessionOf: sessionOf,
            claimed: claimed, query: query, dateFilter: dateFilter,
            hideDone: hiddenDoneTiers.contains(activeTierId), now: now
        )
        if !unfiled.rows.isEmpty || unfiled.hiddenDone > 0 {
            bands.append(BoardBand(
                bandId: activeTierId, label: activeLabel,
                rows: unfiled.rows, hiddenDone: unfiled.hiddenDone,
                // Still NO create affordance, and that stays deliberate: the band is
                // the COMPLEMENT of the others, so "create here" has no destination to
                // mean. Hiding done rows is a question about the rows you are looking
                // at; creating is a question about where a new row would go.
                createSeed: nil
            ))
        }
        return bands
    }

    // MARK: - Project grouping (the desktop's "By project")

    /// Band id prefix for a project band. Namespaced because the two groupings
    /// share the `hide done` set and the scroll-anchor space, and a project
    /// literally called "focus" would otherwise collide with the Focus tier.
    static let projectBandPrefix = "proj:"

    /// The board grouped by project instead of by tier.
    ///
    /// Every row the tier grouping would show is here too — the tail band exists
    /// there because tiers claim only a subset, while a project band is defined
    /// over ALL tasks, so completeness comes for free and there is nothing left
    /// over. A session with no owning task still needs somewhere to live, and it
    /// files under the project the SESSION reports (Inbox when it reports none),
    /// which is the same rule `BoardRow.project` already uses for its label.
    ///
    /// Order inside a band: live work first, then recency, done last — the same
    /// comparator the tail band uses, because with tier order gone (`pin_order`
    /// is a tier concept) recency is the only ordering the data still carries.
    static func projectBands(
        tasks: [WalnutTask],
        sessions: [WalnutSession],
        query: String,
        dateFilter: BoardDateFilter,
        hiddenDoneTiers: Set<String>,
        now: Date
    ) -> [BoardBand] {
        let sessionOf = latestSessionByTask(sessions)
        // Same decorate-sort-undecorate shape as `unfiledRows`, for the same
        // reason: this grouping is defined over ALL tasks, so a bucket can be
        // thousands of rows, and a `BoardRow` payload makes every swap copy two
        // whole structs. Buckets hold indices into one flat `rows` array; the
        // per-project sort moves Ints and Dates, and each row is copied exactly
        // once, when its band is built.
        var rows: [BoardRow] = []
        rows.reserveCapacity(tasks.count)
        var buckets: [String: [(index: Int, live: Bool, done: Bool, at: Date)]] = [:]

        func add(_ row: BoardRow, at: Date, live: Bool) {
            guard admits(row, query: query, dateFilter: dateFilter, now: now) else { return }
            buckets[row.project, default: []].append((rows.count, live, row.isDone, at))
            rows.append(row)
        }

        for task in tasks {
            let session = sessionOf[task.id]
            add(BoardRow(task: task, session: session),
                at: session?.lastActiveValue ?? task.updatedAtValue ?? .distantPast,
                live: session?.statusKind.isAlive == true)
        }
        let taskIds = Set(tasks.map(\.id))
        for session in sessions {
            // Only the LATEST session speaks for its task, and a task in the
            // projection already emitted its row above.
            if let taskId = session.taskId, !taskId.isEmpty {
                guard sessionOf[taskId]?.id == session.id, !taskIds.contains(taskId) else { continue }
            }
            add(BoardRow(task: nil, session: session),
                at: session.lastActiveValue ?? .distantPast,
                live: session.statusKind.isAlive)
        }

        // Inbox ("") leads, then projects A→Z — the same order the project
        // sections elsewhere in this app use, so switching grouping doesn't also
        // reshuffle into an unfamiliar sequence.
        let names = buckets.keys.sorted { a, b in
            if a.isEmpty != b.isEmpty { return a.isEmpty }
            return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
        }
        return names.compactMap { name in
            let bandId = projectBandPrefix + name
            let label = name.isEmpty ? NewTaskSeed.inboxHeader : name
            let hidingDone = hiddenDoneTiers.contains(bandId)
            let sorted = buckets[name, default: []].sorted { a, b in
                if a.done != b.done { return !a.done }
                if a.live != b.live { return a.live }
                return a.at > b.at
            }
            let doneCount = sorted.count { $0.done }
            let bandRows = (hidingDone ? sorted.filter { !$0.done } : sorted).map { rows[$0.index] }
            guard !bandRows.isEmpty || doneCount > 0 else { return nil }
            return BoardBand(
                bandId: bandId, label: label,
                rows: bandRows,
                hiddenDone: hidingDone ? doneCount : 0,
                // A project heading's `+` files into THAT project and leaves the
                // pin unspecified — the same call `NewTaskSeed.project` already
                // makes for the project sections on the other filters.
                createSeed: NewTaskSeed.project(label)
            )
        }
    }

    /// Every task no tier band claimed, plus sessions with no owning task at all
    /// (older rows). Live work first, then the rest by recency.
    ///
    /// `claimed` is the set of ids the tier bands ALREADY rendered, passed in
    /// rather than recomputed from `tierOf`: that map is the optimistic local
    /// one, and the bands above skip an id whose task the projection no longer
    /// has. Deriving membership from the map instead of from what was actually
    /// rendered is how a row goes missing from BOTH halves — it is the exact
    /// shape of the disappearing-task bug, one level up.
    ///
    /// Ordering, and why it is not just "most recent":
    ///  - a live session sorts above everything (this band is also the tail
    ///    where unpinned running work shows up, which is what it was born for),
    ///  - then by last activity, session or task, newest first,
    ///  - done rows sink, so a long completed history never buries the top.
    ///
    /// Cost note (the perf fixture is 2,000 tasks / 500 sessions): this walks the
    /// TASK list now, which the session-gated version deliberately avoided. That
    /// was the right trade when the band could only hold session-bearing rows —
    /// walking 2,000 tasks to find ~10 was 4x the work for the same answer. It is
    /// not the right trade for a band that must be able to hold any task: the
    /// only way to know a task is unclaimed is to look at it. The search filter
    /// still runs BEFORE the sort key is computed (measured 3.79ms/pass vs
    /// 0.98ms filter-during-collection), and the cheapest rejection stays first
    /// because `lastActiveValue` is the expensive part (2.09ms per 500 calls).
    ///
    /// Walking the task list is the only linear cost this function is allowed to
    /// add. The session loop below must stay O(sessions) with dictionary/set
    /// lookups: a `tasks.contains(where:)` in there made the whole pass ~33ms at
    /// fixture scale, and it read as innocuous right next to the walk this note
    /// already justifies. "We accepted ONE walk over the tasks" is not a licence
    /// for a second one per session.
    /// The tail band's rows plus how many done rows it is suppressing.
    ///
    /// Two values because the heading needs both: the rows to draw, and the count for
    /// `show done (N)` so hiding is never a silent disappearance. Returning them
    /// together rather than letting the caller re-count is what keeps this band's
    /// arithmetic to ONE pass over the tasks — at the tail's real scale (2,903 rows) a
    /// second walk to count completions is the kind of "obviously cheap" line the perf
    /// gate exists to catch.
    struct Tail: Equatable {
        let rows: [BoardRow]
        let hiddenDone: Int
    }

    static func unfiledRows(
        tasks: [WalnutTask],
        sessions: [WalnutSession],
        sessionOf: [String: WalnutSession],
        claimed: Set<String>,
        query: String,
        dateFilter: BoardDateFilter = .all,
        /// `hide done` is on for the tail band — done rows are dropped here and
        /// counted, exactly as a tier band does it.
        hideDone: Bool = false,
        now: Date = Date()
    ) -> Tail {
        // The sort payload is an INDEX, not a `BoardRow`. `BoardRow` holds two
        // whole structs (a WalnutTask and a WalnutSession, ~15 stored properties
        // between them, most of them String/Optional), so every swap the sort
        // performs copies all of that, and this band went from "the handful of
        // live rows" to "every task no tier claimed" — at the perf fixture's
        // scale that is ~1,780 rows instead of ~10, and n log n swaps of a fat
        // payload is where the remaining ~20ms of the board pass lived. Sorting
        // Int32-sized keys and paying exactly ONE row copy per row at the end is
        // the same decorate-sort-undecorate shape `WalnutTask.openSorted` /
        // `doneSorted` already use for the task list, and it is why that pass
        // measures 1.3ms on the identical fixture.
        var keys: [(index: Int, live: Bool, done: Bool, at: Date)] = []
        var rows: [BoardRow] = []
        // Both arrays are sized up front. `BoardRow` is two large structs, so an
        // append that has to grow the buffer re-copies every row already in it,
        // and geometric growth over ~1,780 rows pays that several times. The
        // bound is generous (not every task reaches a row) and it is exact enough
        // for the only thing it buys: zero reallocations.
        keys.reserveCapacity(tasks.count)
        rows.reserveCapacity(tasks.count)

        // Built on first use only (see the call site below for why that is
        // almost never), then reused for every remaining session.
        var memoizedTaskIds: Set<String>?
        func taskIdSet() -> Set<String> {
            if let memoizedTaskIds { return memoizedTaskIds }
            let ids = Set(tasks.map(\.id))
            memoizedTaskIds = ids
            return ids
        }

        // Counted during the same pass that builds the rows, like the tier bands do.
        var doneCount = 0

        for task in tasks where !claimed.contains(task.id) {
            let session = sessionOf[task.id]
            let row = BoardRow(task: task, session: session)
            guard admits(row, query: query, dateFilter: dateFilter, now: now) else { continue }
            if row.isDone {
                doneCount += 1
                if hideDone { continue }
            }
            keys.append((
                rows.count,
                session?.statusKind.isAlive == true,
                row.isDone,
                session?.lastActiveValue ?? task.updatedAtValue ?? .distantPast
            ))
            rows.append(row)
        }

        // A session whose owning task never reached the projection is still real
        // work someone started; it has always had a row here and keeps one.
        for session in sessions {
            guard let taskId = session.taskId, !taskId.isEmpty else {
                let row = BoardRow(task: nil, session: session)
                guard admits(row, query: query, dateFilter: dateFilter, now: now) else { continue }
                keys.append((rows.count, session.statusKind.isAlive, false,
                             session.lastActiveValue ?? .distantPast))
                rows.append(row)
                continue
            }
            // Only the LATEST session represents its task (one row per task),
            // and the task-driven pass above already emitted it if the task is
            // in the projection.
            guard sessionOf[taskId]?.id == session.id else { continue }
            guard !claimed.contains(taskId) else { continue }
            // Membership by SET, not by `tasks.contains(where:)`. That linear
            // scan was O(sessions x tasks) and it did not look expensive next to
            // everything else in this function: at the perf fixture's 2,000 tasks
            // / 500 sessions it alone took one board pass from ~1ms to ~33ms, and
            // `TasksDerivedPerfTests` (idle < 5ms, keystroke < 8ms, live query <
            // 4ms) failed on all three budgets at once. The rule this restates:
            // a per-item membership test inside a loop over the other collection
            // is a quadratic walk wearing a one-line disguise, and a body pass
            // that runs on every keystroke is where that gets felt.
            //
            // The set is built lazily because the common shape reaches this line
            // zero times: a session whose task is in the projection is already
            // rejected by `claimed` or by the `sessionOf` latest-session check
            // just above, so an ordinary board never pays for the set at all.
            guard !taskIdSet().contains(taskId) else { continue }
            let row = BoardRow(task: nil, session: session)
            guard admits(row, query: query, dateFilter: dateFilter, now: now) else { continue }
            keys.append((rows.count, session.statusKind.isAlive, false,
                         session.lastActiveValue ?? .distantPast))
            rows.append(row)
        }

        // Comparator unchanged (done sinks, then live first, then recency): only
        // what it moves changed, from whole rows to indices.
        let ordered = keys.sorted { a, b in
            if a.done != b.done { return !a.done }
            if a.live != b.live { return a.live }
            return a.at > b.at
        }.map { rows[$0.index] }
        return Tail(rows: ordered, hiddenDone: hideDone ? doneCount : 0)
    }

    // MARK: - Band chips (the floating bar) — a VIEW over the bands, never a query
    //
    // The chips ARE the bands: one chip per rendered band, in band order, plus a
    // leading `All`. That is deliberate to the point of being the rule this
    // section exists to state: chip selection must not open a second way to
    // decide what a band contains.
    //
    // The disappearing-task bug (see `activeTierId`) came from two code paths
    // disagreeing about membership, and a chip row is exactly the shape that
    // invites a third one ("just re-query the tier for this chip"). So a chip
    // carries a band ID and a count it read OFF the band, and filtering is a
    // `filter` over the very array the rows are rendered from. One assembly, one
    // answer, and a chip can never show a count the band below it disagrees with.
    //
    // Chips mirror what is RENDERED, so an empty tier has no chip for the same
    // reason it has no heading: there is nothing to select.

    /// One chip in the board's floating band bar.
    struct BandChip: Identifiable, Equatable {
        /// The band this chip selects, or nil for the `All` chip (whole board).
        let bandId: String?
        let label: String
        /// The band's own visible count (`All` carries their sum).
        let count: Int

        var id: String { bandId ?? "__all__" }
    }

    /// Label on the chip that clears the band filter.
    static let allChipLabel = "All"

    static func chips(_ bands: [BoardBand]) -> [BandChip] {
        var chips = [BandChip(
            bandId: nil, label: allChipLabel,
            count: bands.reduce(0) { $0 + $1.count }
        )]
        chips.append(contentsOf: bands.map {
            BandChip(bandId: $0.bandId, label: $0.label, count: $0.count)
        })
        return chips
    }

    /// The bands a chip selection leaves on screen.
    ///
    /// An UNKNOWN selection returns the whole board rather than nothing, and that
    /// is the load-bearing half. A selected band can disappear under the user
    /// (its last row completed, `hide done` swallowed it, a query narrowed it
    /// away, the grouping changed) and a filter that answered "no bands" there
    /// would show an empty board with no explanation — the disappearing-task
    /// failure mode again, one level up. Falling back to All means the worst case
    /// is "you are looking at more than you asked for", which the chip row itself
    /// makes obvious.
    static func filtered(_ bands: [BoardBand], selected: String?) -> [BoardBand] {
        guard let selected, bands.contains(where: { $0.bandId == selected }) else { return bands }
        return bands.filter { $0.bandId == selected }
    }

    /// Which chip should read as selected, given a (possibly stale) selection.
    /// nil = the `All` chip, which is also the answer for a band that has gone
    /// away — so the highlighted chip always agrees with the rows below it.
    static func selectedChip(_ bands: [BoardBand], selected: String?) -> String? {
        guard let selected, bands.contains(where: { $0.bandId == selected }) else { return nil }
        return selected
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

    /// Every id a server search hit could legitimately be about, for the rows the
    /// board is already showing.
    ///
    /// `rowIds` answers "what is this row keyed by" and is what the local task
    /// sections dedup against. This answers the different question the server-hit
    /// dedup asks — "is this hit about something already on screen" — and it is a
    /// SUPERSET on purpose, because one row can be named three ways: the row's own
    /// key, the owning task id, and (for a session-only row) the session id the
    /// server answers a session hit with. Keying the row by the task id fixed the
    /// duplicate at its source (see `BoardRow.owningTaskId`); carrying all three here
    /// is what makes the dedup indifferent to which id a row happened to be keyed by,
    /// so the same defect cannot come back through a new row shape.
    static func searchDedupIds(_ bands: [BoardBand]) -> Set<String> {
        var ids = Set<String>()
        for band in bands {
            for row in band.rows {
                if !row.id.isEmpty { ids.insert(row.id) }
                if let owning = row.owningTaskId, !owning.isEmpty { ids.insert(owning) }
                if let sessionId = row.session?.id, !sessionId.isEmpty { ids.insert(sessionId) }
            }
        }
        return ids
    }

    // MARK: - Tier tokens (move tier from the row's long-press menu)

    /// One tier choice for a row.
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
