import Foundation

// MARK: - The board's status sections, as pure values
//
// 2026-10-29, the user: the hidden work should not be behind filter switches ("Show done",
// "Show waiting") but in sections, collapsed by default, that open on a tap. The web's home
// task panel and this board draw the same headings (`web/src/components/tasks/
// status-sections.ts` is the web's half of this file):
//
//   Watching           open    tasks the user watches, whatever their state, from every tier
//   Needs you          open    open tasks whose one user status says the user is needed, To read
//                              ones included (nothing asked, a result or an answer to read:
//                              2026-11-03, the user wants no separate To read), each row's third
//                              line saying what it needs (`TeamStatusModel.needLine`)
//   Working            open    everything else that is open: the board's own bands
//   Waiting / snoozed  folded  phase WAITING, or a start date still to come under "Now"
//   Completed          folded  done
//
// A watched task is drawn in Watching only. Every rule here is a static function over plain
// values, so WalnutTests drives the same logic the screen runs.

/// One status section of the board.
enum BoardStatusSection: String, CaseIterable, Identifiable {
    case watching, needs, working, waiting, done

    var id: String { rawValue }

    /// The heading's words, the web's verbatim.
    var label: String {
        switch self {
        case .watching: return "Watching"
        case .needs: return "Needs you"
        case .working: return "Working"
        case .waiting: return "Waiting / snoozed"
        case .done: return "Completed"
        }
    }

    /// The heading's SF Symbol.
    var systemImage: String {
        switch self {
        case .watching: return "eye"
        case .needs: return "exclamationmark.circle"
        case .working: return "circle.lefthalf.filled"
        case .waiting: return "clock"
        case .done: return "checkmark.circle"
        }
    }

    /// Open on a first visit: what is in front of the user now. Waiting and Completed fold.
    var defaultOpen: Bool {
        switch self {
        case .watching, .needs, .working: return true
        case .waiting, .done: return false
        }
    }
}

/// The sections of one board pass. The Working rows are the bands themselves
/// (`BoardAssembly.bands`), so only their count is carried here.
struct BoardStatusSections: Equatable {
    var watching: [BoardRow] = []
    var needs: [BoardRow] = []
    var waiting: [BoardRow] = []
    var done: [BoardRow] = []
    /// Rows the bands draw under Working.
    var workingCount = 0
    /// False while a query is live: search shows its own results and no section at all.
    var active = false

    static let none = BoardStatusSections()

    /// The rows a section draws itself (Working draws the bands, so it has none here).
    func rows(_ section: BoardStatusSection) -> [BoardRow] {
        switch section {
        case .watching: return watching
        case .needs: return needs
        case .working: return []
        case .waiting: return waiting
        case .done: return done
        }
    }

    func count(_ section: BoardStatusSection) -> Int {
        section == .working ? workingCount : rows(section).count
    }

    /// Working always has its heading; every other section only when it holds a row.
    func isShown(_ section: BoardStatusSection) -> Bool {
        guard active else { return false }
        return section == .working || !rows(section).isEmpty
    }

    /// Some section other than Working holds rows, so an empty Working is no empty board.
    var drawsRows: Bool {
        !(watching.isEmpty && needs.isEmpty && waiting.isEmpty && done.isEmpty)
    }
}

/// One project's run of rows inside a section.
struct BoardSectionRun: Equatable, Identifiable {
    /// The project name, "" = Inbox.
    let project: String
    let rows: [BoardRow]

    var id: String { BoardModel.projectBandId(project) }
    var label: String { project.isEmpty ? NewTaskSeed.inboxHeader : project }
}

enum BoardStatusSectionModel {

    /// Rows a section draws before its "Show N more" row, and how many more each tap adds.
    static let batch = 30

    /// Watched: `watched_at` is set (an older server never sends it, so nothing is).
    static func isWatched(_ task: WalnutTask?) -> Bool {
        guard let at = task?.watchedAt else { return false }
        return !at.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// The state section a row belongs to, the web's `stateSectionOf`: done wins, then the
    /// user's turn (`BoardModel.needsHuman`, the rule the red dot reads, To read included; a
    /// snoozed status never is), then a park or a
    /// snooze (a start date still to come, which only the `Now` date filter treats as one),
    /// else Working. A session-only row has no task to read, so it is Working.
    static func stateSection(
        _ row: BoardRow, dateFilter: BoardDateFilter, now: Date
    ) -> BoardStatusSection {
        guard let task = row.task else { return .working }
        if task.isDone || task.phase == "COMPLETE" { return .done }
        if BoardModel.needsHuman(task) { return .needs }
        if task.isWaiting || BoardModel.isDeferred(row, filter: dateFilter, now: now) { return .waiting }
        return .working
    }

    /// The latest activity of a row: creation, the last edit, its session's last activity,
    /// and its completion while it is done (the web's `recentActivityTime(t, 'updated')`).
    static func activity(_ row: BoardRow) -> Date {
        var best = Date.distantPast
        func consider(_ iso: String?) {
            if let date = WalnutTask.parseISO(iso), date > best { best = date }
        }
        consider(row.task?.createdAt)
        consider(row.task?.updatedAt)
        consider(row.session?.lastActiveAt)
        if row.task?.isDone == true { consider(row.task?.completedAt) }
        return best
    }

    /// When a waiting row wakes: its WAITING clock, else its start date (its own, else the
    /// one it inherits from a parent under "Now").
    static func wakeAt(_ row: BoardRow) -> Date? {
        guard let task = row.task else { return nil }
        if task.isWaiting, let clock = WalnutTask.parseISO(nonEmpty(task.waitUntil)) { return clock }
        return WalnutTask.parseISO(nonEmpty(task.startDate) ?? nonEmpty(row.inheritedStart))
    }

    /// Order inside a section, the web's `sortSectionTasks`: Watching in the order the user
    /// added them (a new watch lands at the foot, nothing reshuffles); Needs you (To read rows
    /// among them) latest activity first; Waiting the soonest wake first, then the ones with no clock by latest
    /// activity; Completed the latest completion first. Ties keep the id order, so the same
    /// input always draws the same list.
    static func sorted(_ section: BoardStatusSection, _ rows: [BoardRow]) -> [BoardRow] {
        switch section {
        case .watching:
            return rows.map { ($0, WalnutTask.parseISO($0.task?.watchedAt)) }
                .sorted { a, b in
                    switch (a.1, b.1) {
                    case let (l?, r?) where l != r: return l < r
                    case (.some, nil): return true
                    case (nil, .some): return false
                    default: return a.0.id < b.0.id
                    }
                }
                .map(\.0)
        case .waiting:
            return rows.map { ($0, wakeAt($0), activity($0)) }
                .sorted { a, b in
                    switch (a.1, b.1) {
                    case let (l?, r?) where l != r: return l < r
                    case (.some, nil): return true
                    case (nil, .some): return false
                    default: return a.2 != b.2 ? a.2 > b.2 : a.0.id < b.0.id
                    }
                }
                .map(\.0)
        case .done:
            return rows.map { row -> (BoardRow, Date) in
                let at = WalnutTask.parseISO(row.task?.completedAt ?? row.task?.updatedAt) ?? .distantPast
                return (row, at)
            }
            .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.id < $1.0.id }
            .map(\.0)
        case .needs, .working:
            return rows.map { ($0, activity($0)) }
                .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.id < $1.0.id }
                .map(\.0)
        }
    }

    /// A section's rows gathered by project, projects in the order their first row appears,
    /// so the project holding the most urgent row leads. Keyed by the exact name, as the
    /// project bands are (`PinnedTierOrder.Exact`).
    static func projectRuns(_ rows: [BoardRow]) -> [BoardSectionRun] {
        var order: [PinnedTierOrder.Exact] = []
        var byProject: [PinnedTierOrder.Exact: [BoardRow]] = [:]
        for row in rows {
            let key = PinnedTierOrder.Exact(row.project)
            if byProject[key] == nil { order.append(key) }
            byProject[key, default: []].append(row)
        }
        return order.map { BoardSectionRun(project: $0.string, rows: byProject[$0] ?? []) }
    }

    /// The rows a section draws when `shown` of them are allowed: runs are taken in order,
    /// the run the cut falls in is trimmed, and the runs after it are not drawn.
    static func visibleRuns(_ runs: [BoardSectionRun], shown: Int) -> [BoardSectionRun] {
        var left = max(0, shown)
        var out: [BoardSectionRun] = []
        for run in runs where left > 0 {
            let take = Array(run.rows.prefix(left))
            left -= take.count
            out.append(BoardSectionRun(project: run.project, rows: take))
        }
        return out
    }

    /// The "Show N more" row's words: the next batch, at most what is left.
    static func showMoreLabel(total: Int, shown: Int) -> String? {
        let more = total - shown
        guard more > 0 else { return nil }
        return "Show \(min(more, batch)) more"
    }

    /// Build the sections of one pass.
    ///
    /// - Parameters:
    ///   - scoped: the board rows of the view (the honoured tier, or the whole pinned
    ///     board), WAITING rows included, in board order.
    ///   - watched: every watched row of the projection, from any tier and pinned or not:
    ///     a watched task is in front of the user in every view.
    ///   - workingCount: the rows the bands then draw.
    static func make(
        scoped: [BoardRow], watched: [BoardRow], workingCount: Int,
        dateFilter: BoardDateFilter, now: Date
    ) -> BoardStatusSections {
        var needs: [BoardRow] = []
        var waiting: [BoardRow] = []
        var done: [BoardRow] = []
        var seen = Set<String>()
        for row in scoped where seen.insert(row.id).inserted {
            if isWatched(row.task) { continue }
            switch stateSection(row, dateFilter: dateFilter, now: now) {
            case .needs: needs.append(row)
            case .waiting: waiting.append(row)
            case .done: done.append(row)
            case .working, .watching: continue
            }
        }
        var watchedSeen = Set<String>()
        let watching = watched.filter { watchedSeen.insert($0.id).inserted }
        return BoardStatusSections(
            watching: sorted(.watching, watching),
            needs: sorted(.needs, needs),
            waiting: sorted(.waiting, waiting),
            done: sorted(.done, done),
            workingCount: workingCount,
            active: true
        )
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}

// MARK: - Which sections are open, persisted

/// The sections' open state in one defaults string: a JSON object holding only the sections
/// the user flipped away from their default (the web's `walnut-todo-status-sections`), so a
/// later change of a default reaches everyone who never touched that section.
enum BoardStatusSectionPrefs {
    static let openKey = "tasks.board.statusSections"

    /// Every section's open state. A value that is not JSON, not an object, or holds a
    /// non-boolean reads as the defaults for what it cannot say: a preference is never worth
    /// a section the user cannot open.
    static func decode(_ raw: String) -> [BoardStatusSection: Bool] {
        var open: [BoardStatusSection: Bool] = [:]
        for section in BoardStatusSection.allCases { open[section] = section.defaultOpen }
        guard
            let data = raw.data(using: .utf8), !data.isEmpty,
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any]
        else { return open }
        for section in BoardStatusSection.allCases {
            // A real JSON boolean only: Foundation bridges `1` to `true` under `as? Bool`.
            if let number = dictionary[section.rawValue] as? NSNumber,
               CFGetTypeID(number) == CFBooleanGetTypeID() {
                open[section] = number.boolValue
            }
        }
        return open
    }

    static func isOpen(_ section: BoardStatusSection, raw: String) -> Bool {
        decode(raw)[section] ?? section.defaultOpen
    }

    /// The stored string with one section set; "" when every section is at its default.
    static func setting(_ section: BoardStatusSection, open: Bool, raw: String) -> String {
        var state = decode(raw)
        state[section] = open
        var diff: [String: Bool] = [:]
        for key in BoardStatusSection.allCases where state[key] != key.defaultOpen {
            diff[key.rawValue] = state[key]
        }
        guard
            !diff.isEmpty,
            let data = try? JSONSerialization.data(withJSONObject: diff, options: [.sortedKeys]),
            let json = String(data: data, encoding: .utf8)
        else { return "" }
        return json
    }

    static func toggling(_ section: BoardStatusSection, raw: String) -> String {
        setting(section, open: !isOpen(section, raw: raw), raw: raw)
    }
}
