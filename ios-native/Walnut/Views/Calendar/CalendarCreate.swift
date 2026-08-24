import Foundation

/// Turning a tap on the calendar into the task it should create. Pure math so
/// the "which hour did I just tap?" and "what dates go on the wire?" rules are
/// asserted without a simulator.
///
/// Why the calendar creates with `start_date` and not `due_date`: tapping 2 PM
/// means "I am doing this at 2 PM", which is a working block, and start_date is
/// the field the timeline lays out as a block. A tap on the ALL-DAY band has no
/// hour, so it creates a date-only `due_date` instead — the same thing the
/// month agenda's quick add has always done.
enum CalendarCreate {

    /// Vertical tap → the slot it lands in. Slots are 15-minute so a tap reads
    /// as the time the user aimed at, not the top of the hour.
    static let slotMinutes: Double = 15
    /// Length given to a block created by a tap. Matches
    /// CalendarTimeline.defaultTaskMinutes, so a tapped block renders at the
    /// same size as any other timed task.
    static let defaultDurationMinutes: Double = 60

    /// What a tap resolved to. `nil` end = no end_date on the wire (the server
    /// rejects an end without a start, and refuses end < start).
    ///
    /// `Identifiable` so `.sheet(item:)` presents it: the id encodes the slot,
    /// so tapping a DIFFERENT slot while the sheet is up re-seeds it instead of
    /// silently keeping the old time.
    struct Draft: Equatable, Identifiable {
        let day: Date
        /// Local wall-clock start, snapped to the slot grid. nil for an all-day
        /// draft (the all-day band was tapped).
        let start: Date?
        let end: Date?

        var isAllDay: Bool { start == nil }

        var id: String {
            "\(day.timeIntervalSince1970)-\(start?.timeIntervalSince1970 ?? -1)"
        }
    }

    /// Snap a y offset inside a day column to its slot start.
    /// `minuteHeight` is the view's points-per-minute (1 today).
    static func slotStart(
        atY y: CGFloat, minuteHeight: CGFloat, day: Date, calendar: Calendar
    ) -> Date? {
        guard minuteHeight > 0 else { return nil }
        let rawMinutes = Double(y / minuteHeight)
        // Clamp INTO the day: a tap in the bottom padding must not create a
        // task at 00:00 the next day.
        let clamped = min(max(rawMinutes, 0), CalendarLayout.minutesPerDay - slotMinutes)
        let snapped = (clamped / slotMinutes).rounded(.down) * slotMinutes
        let dayStart = calendar.startOfDay(for: day)
        return calendar.date(
            byAdding: .minute, value: Int(snapped), to: dayStart
        )
    }

    /// A tap on an empty hour slot → a timed draft of the default duration,
    /// truncated at midnight so the draft never spills into the next day (the
    /// server would take it, but a block the user can't see on the day they
    /// tapped is a lie).
    static func timedDraft(
        atY y: CGFloat, minuteHeight: CGFloat, day: Date, calendar: Calendar
    ) -> Draft? {
        guard let start = slotStart(atY: y, minuteHeight: minuteHeight, day: day, calendar: calendar)
        else { return nil }
        let dayStart = calendar.startOfDay(for: day)
        guard let nextDay = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return nil }
        let naturalEnd = start.addingTimeInterval(defaultDurationMinutes * 60)
        let end = min(naturalEnd, nextDay)
        return Draft(day: dayStart, start: start, end: end > start ? end : nil)
    }

    /// A tap on the all-day band → a date-only draft for that day.
    static func allDayDraft(day: Date, calendar: Calendar) -> Draft {
        Draft(day: calendar.startOfDay(for: day), start: nil, end: nil)
    }

    // MARK: - Wire values

    /// `start_date` / `end_date` / `due_date` for a draft, in the shapes the
    /// contract accepts: date-only "yyyy-MM-dd" for an all-day draft's due
    /// date, bare LOCAL wall clock for timed values (the same shape
    /// QuickParsedTask.parseLocalDate and CalendarLogic already round-trip —
    /// sending a Z instant here would shift the block by the UTC offset).
    struct WireDates: Equatable {
        var dueDate: String?
        var startDate: String?
        var endDate: String?
    }

    static func wireDates(for draft: Draft, calendar: Calendar) -> WireDates {
        guard let start = draft.start else {
            return WireDates(dueDate: dayString(draft.day, calendar: calendar))
        }
        return WireDates(
            startDate: localString(start, calendar: calendar),
            endDate: draft.end.map { localString($0, calendar: calendar) }
        )
    }

    /// "yyyy-MM-dd" in the calendar's zone.
    static func dayString(_ date: Date, calendar: Calendar) -> String {
        CalendarLogic.dayKey(date, calendar: calendar)
    }

    /// "yyyy-MM-dd'T'HH:mm:ss" in the calendar's zone (no suffix = local wall
    /// clock, per the PATCH contract).
    static func localString(_ date: Date, calendar: Calendar) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = calendar.timeZone
        return f.string(from: date)
    }

    /// Human label for the create sheet's header ("Sun, Aug 23 at 2:00 PM" /
    /// "Sun, Aug 23 · all-day").
    static func label(for draft: Draft, calendar: Calendar) -> String {
        var f = Date.FormatStyle.dateTime
            .weekday(.abbreviated).month(.abbreviated).day()
        f.timeZone = calendar.timeZone
        let dayText = draft.day.formatted(f)
        guard let start = draft.start else { return "\(dayText) · all-day" }
        var t = Date.FormatStyle.dateTime.hour().minute()
        t.timeZone = calendar.timeZone
        return "\(dayText) at \(start.formatted(t))"
    }
}
