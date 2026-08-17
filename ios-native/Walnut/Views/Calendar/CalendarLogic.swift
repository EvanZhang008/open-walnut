import Foundation
import os

/// Pure date math + bucketing for the Tasks-tab calendar. Everything here is
/// static and parameterized on a `Calendar` (which carries the time zone +
/// locale), so CalendarLogicTests can drive the exact production code with
/// fixed zones (DST transitions, Sunday- vs Monday-first locales) without
/// touching the device clock.
///
/// Task date strings come in three shapes (mirrors WalnutTask.parseISO +
/// QuickParsedTask.parseLocalDate — the wire keeps dates as strings):
///   "2026-08-09"                — date-only, the user's local DAY
///   "2026-08-09T09:00:00"       — LOCAL wall clock, no zone suffix
///   "2026-08-09T16:00:00Z"/-07: — absolute instant; convert to the local day
enum CalendarLogic {

    // MARK: - Parsing

    struct ParsedTaskDate: Equatable {
        let date: Date
        /// False for date-only values — renders in the all-day bucket.
        let hasTime: Bool
    }

    /// Memoized parse results — bucketing runs over every task × 3 date fields
    /// per body pass, and DateFormatter parses are ~30-60µs each (same
    /// rationale as WalnutTask.dateCache). Keyed by zone + raw string so tests
    /// injecting other zones never poison production entries.
    private static let parseCache = OSAllocatedUnfairLock(initialState: [String: ParsedTaskDate?]())
    private static let parseCacheLimit = 16_384

    /// Zone-suffixed ISO datetimes ("...Z" / "...+02:00"). Thread-safe.
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    /// Parse one task date string into an instant + all-day flag, resolving
    /// bare (zone-less) values against the calendar's time zone.
    static func parseTaskDate(_ raw: String?, calendar: Calendar) -> ParsedTaskDate? {
        guard let raw, !raw.isEmpty else { return nil }
        let key = calendar.timeZone.identifier + "|" + raw
        if let hit = parseCache.withLock({ $0[key] }) { return hit }
        let parsed = parseTaskDateUncached(raw, calendar: calendar)
        parseCache.withLock {
            if $0.count >= parseCacheLimit { $0.removeAll(keepingCapacity: true) }
            $0[key] = parsed
        }
        return parsed
    }

    private static func parseTaskDateUncached(_ raw: String, calendar: Calendar) -> ParsedTaskDate? {
        // Date-only: "yyyy-MM-dd" → local midnight, all-day.
        if raw.count == 10, !raw.contains("T") {
            guard let date = localFormatter("yyyy-MM-dd", calendar: calendar).date(from: raw) else { return nil }
            return ParsedTaskDate(date: date, hasTime: false)
        }
        guard raw.count > 10, raw.contains("T") else { return nil }
        // Zone-suffixed datetime → absolute instant (ISO8601DateFormatter).
        let timePart = raw[raw.index(raw.startIndex, offsetBy: 10)...]
        let hasZoneSuffix = timePart.contains("Z") || timePart.contains("+")
            || timePart.dropFirst().contains("-") // "-" after the "T" = offset
        if hasZoneSuffix {
            guard let date = isoFractional.date(from: raw) ?? isoPlain.date(from: raw) else { return nil }
            return ParsedTaskDate(date: date, hasTime: true)
        }
        // Bare local wall clock (the quick-parse / PATCH contract shape).
        for format in ["yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] {
            if let date = localFormatter(format, calendar: calendar).date(from: raw) {
                return ParsedTaskDate(date: date, hasTime: true)
            }
        }
        return nil
    }

    private static func localFormatter(_ format: String, calendar: Calendar) -> DateFormatter {
        let f = DateFormatter()
        f.dateFormat = format
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = calendar.timeZone
        return f
    }

    // MARK: - Day keys

    /// Canonical per-day bucket key: "yyyy-MM-dd" in the calendar's zone.
    static func dayKey(_ date: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// "yyyy-MM" — event-cache key for one visible month.
    static func monthKey(_ date: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }

    // MARK: - Month grid

    struct GridDay: Equatable, Identifiable {
        let date: Date
        let dayKey: String
        let dayNumber: Int
        /// False for the leading/trailing spill days of adjacent months.
        let inMonth: Bool
        var id: String { dayKey }
    }

    /// Full weeks covering the month that contains `anchor`, honoring the
    /// calendar's `firstWeekday` (Sunday-first en_US, Monday-first de_DE, …).
    /// Day stepping uses `date(byAdding:.day)` — never 86 400-second math — so
    /// DST-transition days (23h/25h in America/Los_Angeles) stay correct.
    static func monthGrid(containing anchor: Date, calendar: Calendar) -> [[GridDay]] {
        guard let firstOfMonth = startOfMonth(anchor, calendar: calendar),
              let dayCount = calendar.range(of: .day, in: .month, for: firstOfMonth)?.count
        else { return [] }
        let weekdayOfFirst = calendar.component(.weekday, from: firstOfMonth)
        let leading = (weekdayOfFirst - calendar.firstWeekday + 7) % 7
        let totalCells = ((leading + dayCount + 6) / 7) * 7
        guard let gridStart = calendar.date(byAdding: .day, value: -leading, to: firstOfMonth) else { return [] }

        var days: [GridDay] = []
        days.reserveCapacity(totalCells)
        var cursor = gridStart
        for _ in 0..<totalCells {
            days.append(GridDay(
                date: cursor,
                dayKey: dayKey(cursor, calendar: calendar),
                dayNumber: calendar.component(.day, from: cursor),
                inMonth: calendar.isDate(cursor, equalTo: firstOfMonth, toGranularity: .month)
            ))
            guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
            cursor = next
        }
        return stride(from: 0, to: days.count, by: 7).map { Array(days[$0..<min($0 + 7, days.count)]) }
    }

    /// Local midnight of the first day of `anchor`'s month.
    static func startOfMonth(_ anchor: Date, calendar: Calendar) -> Date? {
        calendar.date(from: calendar.dateComponents([.year, .month], from: anchor))
    }

    /// Month navigation (chevrons/swipe) — pinned to the 1st so repeated +1
    /// from Jan 31 can never skip February.
    static func addMonths(_ delta: Int, to anchor: Date, calendar: Calendar) -> Date {
        guard let first = startOfMonth(anchor, calendar: calendar),
              let moved = calendar.date(byAdding: .month, value: delta, to: first)
        else { return anchor }
        return moved
    }

    /// Weekday header symbols rotated to the calendar's firstWeekday.
    static func orderedWeekdaySymbols(calendar: Calendar) -> [String] {
        let symbols = calendar.veryShortWeekdaySymbols // Sunday-first per Foundation
        let shift = calendar.firstWeekday - 1
        return Array(symbols[shift...] + symbols[..<shift])
    }

    // MARK: - Task bucketing

    struct TaskItem: Equatable, Identifiable {
        enum Kind: String {
            case start, due, end
        }

        let kind: Kind
        let task: WalnutTask
        let date: Date
        let hasTime: Bool
        /// Unique across kinds — a task with start+due emits two items.
        var id: String { "\(kind.rawValue):\(task.id)" }
    }

    /// Project open tasks into per-day items. One item per present date field:
    /// due_date and start_date always; end_date only when it lands on a
    /// DIFFERENT day than the start (same-day ends are a duration detail, not
    /// a second calendar entry). Done tasks are filtered — the calendar shows
    /// the plan, not the history (mirrors the web calendar-items scope rule).
    static func bucketTasks(_ tasks: [WalnutTask], calendar: Calendar) -> [String: [TaskItem]] {
        var buckets: [String: [TaskItem]] = [:]
        func add(_ kind: TaskItem.Kind, _ raw: String?, _ task: WalnutTask) {
            guard let parsed = parseTaskDate(raw, calendar: calendar) else { return }
            let key = dayKey(parsed.date, calendar: calendar)
            buckets[key, default: []].append(
                TaskItem(kind: kind, task: task, date: parsed.date, hasTime: parsed.hasTime)
            )
        }
        for task in tasks where !task.isDone {
            add(.due, task.dueDate, task)
            add(.start, task.startDate, task)
            if let end = task.endDate, let parsedEnd = parseTaskDate(end, calendar: calendar) {
                let endKey = dayKey(parsedEnd.date, calendar: calendar)
                let startKey = parseTaskDate(task.startDate, calendar: calendar)
                    .map { dayKey($0.date, calendar: calendar) }
                if endKey != startKey { add(.end, end, task) }
            }
        }
        for key in buckets.keys {
            buckets[key]?.sort(by: taskItemOrder)
        }
        return buckets
    }

    /// All-day first, then by clock time; ties by kind (start → due → end),
    /// then title — fully deterministic for stable rendering + tests.
    private static func taskItemOrder(_ a: TaskItem, _ b: TaskItem) -> Bool {
        if a.hasTime != b.hasTime { return !a.hasTime }
        if a.date != b.date { return a.date < b.date }
        if a.kind != b.kind { return kindRank(a.kind) < kindRank(b.kind) }
        return a.task.title.localizedCaseInsensitiveCompare(b.task.title) == .orderedAscending
    }

    private static func kindRank(_ kind: TaskItem.Kind) -> Int {
        switch kind {
        case .start: return 0
        case .due: return 1
        case .end: return 2
        }
    }

    // MARK: - Event bucketing

    /// Fan device events out to every local day they span (clamped to a sane
    /// cap so a corrupt event can't loop). An event ending EXACTLY at local
    /// midnight does not bleed into that next day — covers the timed
    /// 10pm–midnight case AND any all-day representation that ends at the
    /// next midnight (EK's own all-day events end at 23:59:59, which the
    /// `cursor <= end` walk already handles).
    static func bucketEvents(_ events: [DeviceCalendarEvent], calendar: Calendar) -> [String: [DeviceCalendarEvent]] {
        var buckets: [String: [DeviceCalendarEvent]] = [:]
        let spanCapDays = 62
        for event in events {
            let end = max(event.start, event.end)
            var cursor = calendar.startOfDay(for: event.start)
            var hops = 0
            while cursor <= end, hops <= spanCapDays {
                if hops > 0, cursor == end { break } // midnight-exclusive end
                buckets[dayKey(cursor, calendar: calendar), default: []].append(event)
                guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
                cursor = next
                hops += 1
            }
        }
        for key in buckets.keys {
            buckets[key]?.sort { a, b in
                if a.isAllDay != b.isAllDay { return a.isAllDay }
                if a.start != b.start { return a.start < b.start }
                return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
            }
        }
        return buckets
    }

    // MARK: - Agenda merge

    /// One agenda list row — tasks and device events share the day list but
    /// stay distinct types (events render read-only with their own styling).
    enum AgendaRow: Equatable, Identifiable {
        case task(TaskItem)
        case event(DeviceCalendarEvent)

        var id: String {
            switch self {
            case .task(let item): return "task-\(item.id)"
            case .event(let event): return "event-\(event.id)"
            }
        }
    }

    /// Merge one day's tasks + events into display order: all-day items lead
    /// (all-day events, then dateless-time tasks), timed items follow sorted
    /// by clock time (tasks before events on exact ties).
    static func agendaRows(tasks: [TaskItem], events: [DeviceCalendarEvent]) -> [AgendaRow] {
        var allDay: [AgendaRow] = []
        var timed: [(Date, Int, AgendaRow)] = []
        for event in events {
            if event.isAllDay { allDay.append(.event(event)) }
            else { timed.append((event.start, 1, .event(event))) }
        }
        for item in tasks {
            if item.hasTime { timed.append((item.date, 0, .task(item))) }
            else { allDay.append(.task(item)) }
        }
        // All-day: events first (they visually anchor the day), tasks after.
        allDay.sort { a, b in
            let aEvent = if case .event = a { true } else { false }
            let bEvent = if case .event = b { true } else { false }
            if aEvent != bEvent { return aEvent }
            return a.id < b.id
        }
        timed.sort { a, b in
            if a.0 != b.0 { return a.0 < b.0 }
            if a.1 != b.1 { return a.1 < b.1 }
            return a.2.id < b.2.id
        }
        return allDay + timed.map(\.2)
    }
}
