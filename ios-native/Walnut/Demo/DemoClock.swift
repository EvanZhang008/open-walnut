import Foundation

/// Fixture time. Every timestamp in the demo is an offset from the moment the
/// demo was entered, so the data always reads as recent ("12m ago", "today at
/// 2:00 PM") however long after the build it is opened.
struct DemoClock {
    let now: Date
    let calendar: Calendar

    /// `now` defaults to the demo's clock (`AppClock`: the device clock, or the
    /// pinned one).
    init(now: Date = AppClock.now(), calendar: Calendar = .current) {
        self.now = now
        self.calendar = calendar
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func iso(_ date: Date) -> String { iso.string(from: date) }

    /// A moment `seconds` before now, as the demo shows it: in waking hours
    /// (see `waking(_:)`), so a demo opened in the morning has no letter written
    /// at 3:42 AM.
    func past(_ seconds: TimeInterval) -> Date { waking(now.addingTimeInterval(-seconds)) }
    func ago(_ seconds: TimeInterval) -> String { Self.iso(past(seconds)) }
    func minutesAgo(_ m: Double) -> String { ago(m * 60) }
    func hoursAgo(_ h: Double) -> String { ago(h * 3600) }
    func daysAgo(_ d: Double) -> String { ago(d * 86_400) }

    /// Epoch milliseconds, the unit letters and routines use.
    func msAgo(_ seconds: TimeInterval) -> Double { past(seconds).timeIntervalSince1970 * 1000 }
    func msFromNow(_ seconds: TimeInterval) -> Double { (now.timeIntervalSince1970 + seconds) * 1000 }

    /// Waking hours: everything the demo dates in the past is between 6:00 AM
    /// and 9:00 PM. It was 8:00 AM, and a demo opened at 7:50 AM folded the
    /// last hours into the evening before, so every recent item read "11 hours
    /// ago" (App Store gate, 2026-10-05).
    static let wakingStartHour = 6
    static let wakingEndHour = 21
    /// Where the evening the nights are folded into starts.
    static let eveningStartHour = 19

    /// A past moment moved into waking hours, keeping the order of any two
    /// moments (the mapping only ever grows): from 6:00 AM to 7:00 PM a time
    /// stays where it is; an evening and the night after it (7:00 PM to 6:00 AM)
    /// are folded into 7:00 to 9:00 PM of that evening. While that night is the
    /// current one, only the part already behind the clock is folded, so a
    /// demo opened at 8:30 PM keeps its last minutes as they are, and one
    /// opened at 3:00 AM reads as if the day ended at 9:00 PM. A moment after
    /// now is returned unchanged.
    func waking(_ moment: Date) -> Date {
        guard moment <= now else { return moment }
        // To the millisecond first: a routine's 8:00 AM run comes back from
        // "seconds ago" a hair early, and 7:59:59.9999 belongs to the night.
        let t = min(now, Date(timeIntervalSince1970: (moment.timeIntervalSince1970 * 1000).rounded() / 1000))
        func wall(_ dayOffset: Int, from day: Date, _ hour: Int) -> Date {
            let start = calendar.date(byAdding: .day, value: dayOffset, to: calendar.startOfDay(for: day)) ?? day
            return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: start) ?? start
        }
        let morning = wall(0, from: t, Self.wakingStartHour)
        let eveningToday = wall(0, from: t, Self.eveningStartHour)
        if t >= morning, t < eveningToday { return t }
        // The evening this night belongs to, and the morning that ends it.
        let evening = t >= eveningToday ? eveningToday : wall(-1, from: t, Self.eveningStartHour)
        let nextMorning = wall(1, from: evening, Self.wakingStartHour)
        let room = TimeInterval((Self.wakingEndHour - Self.eveningStartHour) * 3600)
        let span = min(now, nextMorning).timeIntervalSince(evening)
        guard span > room else { return t }
        return evening.addingTimeInterval(t.timeIntervalSince(evening) * room / span)
    }

    /// A local wall-clock time on a day relative to today, as an ISO instant.
    /// Times that land before `now` on day 0 stay where they are on purpose: a
    /// calendar with a 9:00 block already behind the current time is normal.
    func at(day: Int, hour: Int, minute: Int = 0) -> String {
        Self.iso(date(day: day, hour: hour, minute: minute))
    }

    /// `at(day:hour:minute:)` as a date.
    func date(day: Int, hour: Int, minute: Int = 0) -> Date {
        let start = calendar.startOfDay(for: now)
        let dayStart = calendar.date(byAdding: .day, value: day, to: start) ?? start
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: dayStart) ?? dayStart
    }

    /// A bare local day (`YYYY-MM-DD`) relative to today, the due-date shape.
    func day(_ offset: Int) -> String {
        let start = calendar.startOfDay(for: now)
        let date = calendar.date(byAdding: .day, value: offset, to: start) ?? start
        let f = DateFormatter()
        f.calendar = calendar
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = calendar.timeZone
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    /// The next given weekday (1 = Sunday … 7 = Saturday) at least one day out.
    func nextWeekday(_ weekday: Int) -> Int {
        let today = calendar.component(.weekday, from: now)
        var delta = (weekday - today + 7) % 7
        if delta == 0 { delta = 7 }
        return delta
    }

    /// The weekday name of a day relative to today ("Thursday").
    func weekdayName(_ offset: Int) -> String {
        let start = calendar.startOfDay(for: now)
        let date = calendar.date(byAdding: .day, value: offset, to: start) ?? start
        let f = DateFormatter()
        f.calendar = calendar
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = calendar.timeZone
        f.dateFormat = "EEEE"
        return f.string(from: date)
    }

    /// Monday to Friday, the days work is planned on.
    func isWorkday(_ day: Int) -> Bool {
        let weekday = calendar.component(.weekday, from: date(day: day, hour: 12))
        return weekday != 1 && weekday != 7
    }

    /// The first work day after day `offset` (relative to today).
    func workday(after offset: Int) -> Int {
        var day = offset + 1
        while !isWorkday(day) { day += 1 }
        return day
    }

    /// The day offset of a date (0 = today).
    func dayOffset(of date: Date) -> Int {
        calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
    }

    /// When the TestFlight build goes out: the first work day after the crash
    /// review it waits on, at 11:00 AM. Never on a weekend.
    func shipDay(_ plan: Plan) -> Int { workday(after: dayOffset(of: plan.review)) }

    /// "at 2:00 PM" on the plan's own day, "on Monday at 2:00 PM" on another.
    func when(_ date: Date, planDay: Int) -> String {
        let day = dayOffset(of: date)
        return day == planDay
            ? "at \(Self.timeText(date))"
            : "on \(weekdayName(day)) at \(Self.timeText(date))"
    }

    /// What the rest of Focus waits for, said on a plan for `planDay`: today's
    /// work waits until the next work day ("tomorrow", or "Monday" on a Friday
    /// or a Saturday); a plan for tomorrow puts the rest later in the week, or
    /// into next week when that day is a Friday or a weekend day.
    func restWaitsUntil(planDay: Int) -> String {
        if planDay == 0 {
            let next = workday(after: 0)
            return next == 1 ? "tomorrow" : weekdayName(next)
        }
        return isWorkday(planDay + 1) ? "later in the week" : "next week"
    }

    /// The plan the chat wrote a few minutes ago: the day it is for, the dentist
    /// call and the crash review block. Nothing in it may be behind the clock.
    ///
    /// - The call is made in office hours, 10:30 AM to 5:00 PM, at least 30
    ///   minutes out (the next half hour), and never on a Sunday (it moves to
    ///   Monday).
    /// - The review is work: on a weekday, two hours after the call and not
    ///   before 2:00 PM, starting by 5:00 PM. When that does not fit the plan's
    ///   day (a weekend, or too late), it is the next work day at 2:00 PM, and
    ///   the plan names that day (App Store gate, 2026-10-05: a Sunday 2:00 PM
    ///   review, and a Friday one at 7:00 PM).
    /// - While a call still fits today, the plan is for today. Later in the day
    ///   it is for tomorrow, at the usual 10:30 AM and 2:00 PM, and says so.
    struct Plan {
        /// 0 = today, 1 = tomorrow (relative to `now`).
        let day: Int
        let call: Date
        let review: Date
        /// When the user asked for it (the conversation's first message), in
        /// waking hours: opened at night, the plan was asked for the evening
        /// before, and its "tomorrow" is the day the demo is opened.
        let askedAt: Date
    }

    /// The plan conversation's title. It is read now, so it says "today" or
    /// "tomorrow" only when the plan was asked for today; a plan from the
    /// evening before is titled with its weekday ("Plan for Friday").
    func planTitle(_ plan: Plan) -> String {
        calendar.isDate(plan.askedAt, inSameDayAs: now)
            ? "Plan for \(dayWord(plan.day, saidAt: plan.askedAt))"
            : "Plan for \(weekdayName(plan.day))"
    }

    /// How long before `now` the plan was asked for; the conversation's
    /// timestamps use the same offset (both pass through `waking(_:)`).
    static let planAskedMinutesAgo: Double = 14

    func plan() -> Plan {
        let start = calendar.startOfDay(for: now)
        func at(_ day: Int, _ hour: Int, _ minute: Int) -> Date {
            let dayStart = calendar.date(byAdding: .day, value: day, to: start) ?? start
            return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: dayStart) ?? dayStart
        }
        let soon = now.addingTimeInterval(30 * 60).timeIntervalSince(start)
        let slot = start.addingTimeInterval((soon / 1800).rounded(.up) * 1800)
        let callToday = max(slot, at(0, 10, 30))
        let day = callToday <= at(0, 17, 0) ? 0 : 1
        var call = day == 0 ? callToday : at(1, 10, 30)
        if calendar.component(.weekday, from: call) == 1 {
            call = at(day + 1, 10, 30)
        }
        var review = max(call.addingTimeInterval(2 * 3600), at(day, 14, 0))
        if !isWorkday(day) || review > at(day, 17, 0) {
            let next = workday(after: day)
            review = max(call.addingTimeInterval(2 * 3600), at(next, 14, 0))
        }
        return Plan(day: day, call: call, review: review, askedAt: past(Self.planAskedMinutesAgo * 60))
    }

    /// "today" or "tomorrow" for a day offset from `now`, said at `date`
    /// (a message written before midnight calls the next day "tomorrow").
    func dayWord(_ offset: Int, saidAt date: Date) -> String {
        let target = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: now)) ?? now
        let said = calendar.startOfDay(for: date)
        let gap = calendar.dateComponents([.day], from: said, to: target).day ?? 0
        switch gap {
        case 0: return "today"
        case 1: return "tomorrow"
        default: return weekdayName(offset)
        }
    }

    /// Day offsets for the kitchen quotes: the task is due four days out, and the
    /// third shop promised to call back the day before. Both stay ahead of the
    /// clock and inside the coming week, so a weekday name says which day.
    static let quotesDueInDays = 4
    static let quotesCallbackInDays = 3
    /// The train tickets task is due three days out.
    static let trainDueInDays = 3

    /// A wall-clock time the way this phone writes one ("2:00 PM", "14:00"),
    /// as the calendar shows it.
    static func timeText(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f.string(from: date)
    }

    /// When a job that runs at `hour`:00 on `weekdays` (1 = Sunday … 7 = Saturday)
    /// last ran and next runs, as seconds before and after now, so a routine's
    /// "last run" and "next run" agree with its schedule whenever the demo opens.
    func lastAndNextRun(hour: Int, weekdays: Set<Int>) -> (ago: TimeInterval, ahead: TimeInterval) {
        let start = calendar.startOfDay(for: now)
        var last: Date?
        var next: Date?
        for offset in -8...8 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: start),
                  weekdays.contains(calendar.component(.weekday, from: day)),
                  let run = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)
            else { continue }
            if run <= now { last = run } else if next == nil { next = run }
        }
        return (now.timeIntervalSince(last ?? now), (next ?? now).timeIntervalSince(now))
    }
}
