import Foundation

/// Fixture time. Every timestamp in the demo is an offset from the moment the
/// demo was entered, so the data always reads as recent ("12m ago", "today at
/// 2:00 PM") however long after the build it is opened.
struct DemoClock {
    let now: Date
    let calendar: Calendar

    init(now: Date = Date(), calendar: Calendar = .current) {
        self.now = now
        self.calendar = calendar
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func iso(_ date: Date) -> String { iso.string(from: date) }

    /// `now` shifted by `seconds` (negative = the past).
    func ago(_ seconds: TimeInterval) -> String { Self.iso(now.addingTimeInterval(-seconds)) }
    func minutesAgo(_ m: Double) -> String { ago(m * 60) }
    func hoursAgo(_ h: Double) -> String { ago(h * 3600) }
    func daysAgo(_ d: Double) -> String { ago(d * 86_400) }

    /// Epoch milliseconds, the unit letters and routines use.
    func msAgo(_ seconds: TimeInterval) -> Double { (now.timeIntervalSince1970 - seconds) * 1000 }
    func msFromNow(_ seconds: TimeInterval) -> Double { (now.timeIntervalSince1970 + seconds) * 1000 }

    /// A local wall-clock time on a day relative to today, as an ISO instant.
    /// Times that land before `now` on day 0 stay where they are on purpose: a
    /// calendar with a 9:00 block already behind the current time is normal.
    func at(day: Int, hour: Int, minute: Int = 0) -> String {
        let start = calendar.startOfDay(for: now)
        let dayStart = calendar.date(byAdding: .day, value: day, to: start) ?? start
        let date = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: dayStart) ?? dayStart
        return Self.iso(date)
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
}
