import Foundation

/// Pure geometry + paging math for the Apple-Calendar-style views (list, single
/// day, multi-day, month). Everything is `static` and parameterized on a
/// `Calendar` (which carries the time zone + first weekday), so
/// CalendarLayoutTests drives the exact production code with fixed zones and
/// locales — no device clock, no simulator.
///
/// Vertical positioning is WALL-CLOCK based, not elapsed-seconds based: a 3 PM
/// event always sits on the "3 PM" gridline, including on the 23-hour spring-
/// forward day (where elapsed math would slide everything after 2 AM up by an
/// hour and land it on the wrong label). The cost is a visually empty band for
/// the skipped hour, which is honest — that hour did not exist.
enum CalendarLayout {

    /// Minutes in a rendered day column. Always 1440 even on DST days: the
    /// grid draws 24 wall-clock slots and a skipped/repeated hour shows up as
    /// an empty/dense band rather than a shifted grid.
    static let minutesPerDay: Double = 1440

    // MARK: - Time → offset

    /// Wall-clock minutes from `day`'s midnight, clamped to 0…1440.
    /// The next day's midnight maps to exactly 1440 so a span clipped at the
    /// day boundary reaches the bottom of the column.
    static func minutesIntoDay(_ date: Date, day: Date, calendar: Calendar) -> Double {
        let dayStart = calendar.startOfDay(for: day)
        guard let nextStart = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return 0 }
        if date <= dayStart { return 0 }
        if date >= nextStart { return minutesPerDay }
        let c = calendar.dateComponents([.hour, .minute, .second], from: date)
        return Double(c.hour ?? 0) * 60 + Double(c.minute ?? 0) + Double(c.second ?? 0) / 60
    }

    /// Red "now" line offset, or nil when `day` is not the day `now` falls in.
    static func nowMinutes(now: Date, day: Date, calendar: Calendar) -> Double? {
        guard calendar.isDate(now, inSameDayAs: day) else { return nil }
        return minutesIntoDay(now, day: day, calendar: calendar)
    }

    // MARK: - Cross-day clipping

    /// One span's footprint inside a single day column.
    struct DayBounds: Equatable {
        let startMinutes: Double
        let endMinutes: Double
        /// The span began before this day (block is flat on top).
        let continuesBefore: Bool
        /// The span runs past this day (block is flat on the bottom).
        let continuesAfter: Bool

        /// A span occupying the entire column — rendered as an all-day banner
        /// (Apple's behavior for the middle days of a multi-day event) rather
        /// than a full-height block that hides the hour grid.
        var coversWholeDay: Bool {
            startMinutes <= 0 && endMinutes >= CalendarLayout.minutesPerDay
        }
    }

    /// Intersect the half-open span `[start, end)` with `day`, returning nil
    /// when they don't touch. An event ending EXACTLY at midnight does not
    /// bleed into the next day (same rule as CalendarLogic.bucketEvents).
    /// A zero-length span is treated as a point and kept on its own day.
    static func clipToDay(start: Date, end: Date, day: Date, calendar: Calendar) -> DayBounds? {
        let dayStart = calendar.startOfDay(for: day)
        guard let nextStart = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return nil }
        let spanEnd = max(start, end)
        if start == spanEnd {
            guard start >= dayStart, start < nextStart else { return nil }
            let m = minutesIntoDay(start, day: dayStart, calendar: calendar)
            return DayBounds(startMinutes: m, endMinutes: m, continuesBefore: false, continuesAfter: false)
        }
        guard spanEnd > dayStart, start < nextStart else { return nil }
        return DayBounds(
            startMinutes: minutesIntoDay(max(start, dayStart), day: dayStart, calendar: calendar),
            endMinutes: minutesIntoDay(min(spanEnd, nextStart), day: dayStart, calendar: calendar),
            continuesBefore: start < dayStart,
            continuesAfter: spanEnd > nextStart
        )
    }

    // MARK: - Overlap packing

    /// Input to the column packer. `endMinutes` must be > `startMinutes` — the
    /// caller applies the minimum visible duration first, so two back-to-back
    /// point items don't collapse into one column.
    struct Packable: Equatable {
        let id: String
        let startMinutes: Double
        let endMinutes: Double
    }

    /// A packed item: `column` of `columnCount` side-by-side lanes. The view
    /// turns that into x = column/columnCount, width = 1/columnCount.
    struct Packed: Equatable, Identifiable {
        let id: String
        let startMinutes: Double
        let endMinutes: Double
        let column: Int
        let columnCount: Int
    }

    /// Apple-style overlap resolution: split each cluster of transitively
    /// overlapping items into the fewest side-by-side lanes that fit, reusing
    /// a lane as soon as its previous item has ended. `columnCount` is per
    /// CLUSTER, so a lone event later in the day stays full width.
    ///
    /// Order is fully deterministic (start, then longer first, then id) so the
    /// same input always produces the same lanes — a requirement for stable
    /// SwiftUI identity and for asserting layout in tests.
    static func packOverlaps(_ items: [Packable]) -> [Packed] {
        guard !items.isEmpty else { return [] }
        let sorted = items.sorted { a, b in
            if a.startMinutes != b.startMinutes { return a.startMinutes < b.startMinutes }
            let da = a.endMinutes - a.startMinutes
            let db = b.endMinutes - b.startMinutes
            if da != db { return da > db }
            return a.id < b.id
        }

        var packed: [Packed] = []
        packed.reserveCapacity(sorted.count)
        // Items of the cluster being built + the end minute of each lane.
        var cluster: [(item: Packable, column: Int)] = []
        var laneEnds: [Double] = []

        func flush() {
            let count = max(laneEnds.count, 1)
            for entry in cluster {
                packed.append(Packed(
                    id: entry.item.id,
                    startMinutes: entry.item.startMinutes,
                    endMinutes: entry.item.endMinutes,
                    column: entry.column,
                    columnCount: count
                ))
            }
            cluster.removeAll(keepingCapacity: true)
            laneEnds.removeAll(keepingCapacity: true)
        }

        for item in sorted {
            // A cluster ends when an item starts at/after EVERY open lane's
            // end — nothing after it can overlap anything in it.
            if !cluster.isEmpty, laneEnds.allSatisfy({ $0 <= item.startMinutes }) { flush() }
            if let free = laneEnds.indices.first(where: { laneEnds[$0] <= item.startMinutes }) {
                laneEnds[free] = item.endMinutes
                cluster.append((item, free))
            } else {
                cluster.append((item, laneEnds.count))
                laneEnds.append(item.endMinutes)
            }
        }
        flush()
        // Render order: top-to-bottom, left-to-right.
        return packed.sorted { a, b in
            if a.startMinutes != b.startMinutes { return a.startMinutes < b.startMinutes }
            if a.column != b.column { return a.column < b.column }
            return a.id < b.id
        }
    }

    // MARK: - Days, weeks, pages

    /// Local midnight of the first day of `anchor`'s week, honoring the
    /// calendar's `firstWeekday` (Sunday-first en_US, Monday-first de_DE, …).
    static func startOfWeek(containing anchor: Date, calendar: Calendar) -> Date {
        let dayStart = calendar.startOfDay(for: anchor)
        let weekday = calendar.component(.weekday, from: dayStart)
        let back = (weekday - calendar.firstWeekday + 7) % 7
        return calendar.date(byAdding: .day, value: -back, to: dayStart) ?? dayStart
    }

    /// Day stepping via `date(byAdding:.day)` — never 86 400-second math — so
    /// the 23h/25h DST days stay correct.
    static func addDays(_ delta: Int, to date: Date, calendar: Calendar) -> Date {
        calendar.date(byAdding: .day, value: delta, to: calendar.startOfDay(for: date))
            ?? calendar.startOfDay(for: date)
    }

    static func addWeeks(_ delta: Int, to date: Date, calendar: Calendar) -> Date {
        addDays(delta * 7, to: date, calendar: calendar)
    }

    /// Whole days between two dates' local midnights (negative when `to` is
    /// earlier). Uses calendar components, so DST days count as one day.
    static func dayOffset(from: Date, to: Date, calendar: Calendar) -> Int {
        calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: from),
            to: calendar.startOfDay(for: to)
        ).day ?? 0
    }

    /// Floor division — Swift's `/` truncates toward zero, which would map
    /// day -1 and day +1 to the same page index 0 for a 2-day pager.
    static func floorDiv(_ value: Int, _ divisor: Int) -> Int {
        guard divisor > 0 else { return 0 }
        let q = value / divisor
        return (value % divisor < 0) ? q - 1 : q
    }

    /// `count` consecutive days starting at `start`. `inMonth` is relative to
    /// the FIRST day's month, so a week/page straddling a month boundary dims
    /// the spill days exactly like the month grid does.
    static func dayRange(startingAt start: Date, count: Int, calendar: Calendar) -> [CalendarLogic.GridDay] {
        guard count > 0 else { return [] }
        let first = calendar.startOfDay(for: start)
        var days: [CalendarLogic.GridDay] = []
        days.reserveCapacity(count)
        var cursor = first
        for _ in 0..<count {
            days.append(CalendarLogic.GridDay(
                date: cursor,
                dayKey: CalendarLogic.dayKey(cursor, calendar: calendar),
                dayNumber: calendar.component(.day, from: cursor),
                inMonth: calendar.isDate(cursor, equalTo: first, toGranularity: .month)
            ))
            guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
            cursor = next
        }
        return days
    }

    /// The 7 days of the week containing `anchor` (the top week strip).
    static func weekDays(containing anchor: Date, calendar: Calendar) -> [CalendarLogic.GridDay] {
        dayRange(startingAt: startOfWeek(containing: anchor, calendar: calendar), count: 7, calendar: calendar)
    }

    // MARK: - Pager index math
    //
    // The day / multi-day views page by whole PAGES (1 or 2 days at a time),
    // anchored on a fixed `epoch` captured when the view appears. Deriving the
    // index from a fixed epoch (instead of "days since today") keeps page
    // indices stable across midnight and across re-renders.

    static func pageIndex(for date: Date, dayCount: Int, epoch: Date, calendar: Calendar) -> Int {
        guard dayCount > 0 else { return 0 }
        return floorDiv(dayOffset(from: epoch, to: date, calendar: calendar), dayCount)
    }

    static func pageStart(pageIndex: Int, dayCount: Int, epoch: Date, calendar: Calendar) -> Date {
        addDays(pageIndex * max(dayCount, 1), to: epoch, calendar: calendar)
    }

    /// The days rendered on one page of the day / multi-day pager.
    static func pageDays(
        pageIndex: Int, dayCount: Int, epoch: Date, calendar: Calendar
    ) -> [CalendarLogic.GridDay] {
        dayRange(
            startingAt: pageStart(pageIndex: pageIndex, dayCount: dayCount, epoch: epoch, calendar: calendar),
            count: max(dayCount, 1),
            calendar: calendar
        )
    }

    /// Keep the selected day inside the page it lands on: paging left/right
    /// moves the selection by a whole page, preserving the weekday offset when
    /// possible so the strip highlight doesn't jump to the page's first day.
    static func selection(
        forPage pageIndex: Int, dayCount: Int, epoch: Date,
        currentSelection: Date, calendar: Calendar
    ) -> Date {
        let start = pageStart(pageIndex: pageIndex, dayCount: dayCount, epoch: epoch, calendar: calendar)
        let currentPage = self.pageIndex(
            for: currentSelection, dayCount: dayCount, epoch: epoch, calendar: calendar
        )
        if currentPage == pageIndex { return calendar.startOfDay(for: currentSelection) }
        let offsetInPage = dayOffset(
            from: pageStart(pageIndex: currentPage, dayCount: dayCount, epoch: epoch, calendar: calendar),
            to: currentSelection,
            calendar: calendar
        )
        let clamped = min(max(offsetInPage, 0), max(dayCount - 1, 0))
        return addDays(clamped, to: start, calendar: calendar)
    }

    // MARK: - Hour labels

    /// 0…23 hour labels for the timeline gutter, formatted in the calendar's
    /// locale (12-hour "9 AM" in en_US, 24-hour "09" in de_DE).
    static func hourLabels(calendar: Calendar) -> [String] {
        let f = DateFormatter()
        f.locale = calendar.locale ?? .current
        f.timeZone = calendar.timeZone
        f.setLocalizedDateFormatFromTemplate("j")
        // A fixed, DST-free reference day so every label formats cleanly.
        var comps = DateComponents()
        comps.year = 2001; comps.month = 1; comps.day = 1
        return (0..<24).map { hour in
            comps.hour = hour
            guard let date = calendar.date(from: comps) else { return "\(hour)" }
            return f.string(from: date)
        }
    }
}
