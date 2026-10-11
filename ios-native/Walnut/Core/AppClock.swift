import Foundation
import os

/// The clock behind every time the app SHOWS: "5m ago", today on the calendar, the
/// due labels, and the demo's sample data. It is the device clock, with one
/// exception: the demo with a pinned clock.
///
/// THE DEMO PIN. The App Store screenshots are taken in the demo under a 9:41 status
/// bar, and the demo times its sample data from the moment it starts (a plan "for
/// today" with times later in the day, letters written this morning). A capture made
/// at 3 PM on a Friday read "Plan for today" with its first item on Monday (App Store
/// gate, 2026-10-09). A Debug build launched in the demo with
/// `-walnutDemoNow <ISO 8601 instant>` runs from that instant instead: the demo
/// server and every screen that reads the time move by the same offset, so "14m ago"
/// still means 14 minutes before the "now" the screen shows. Outside the demo the
/// argument is ignored, and a Release build never reads it.
///
/// Only what is SHOWN goes through here. Timeouts, retry ladders and the like keep
/// the device clock: they measure intervals, which an offset does not change.
enum AppClock {
    /// The launch argument (`-walnutDemoNow 2026-10-06T09:41:00-07:00`).
    static let demoPinArgument = "-walnutDemoNow"

    private static let offset = OSAllocatedUnfairLock(initialState: TimeInterval(0))

    /// How far the shown clock runs ahead of the device's: 0 unless the demo is pinned.
    static var demoOffset: TimeInterval { offset.withLock { $0 } }

    /// Now, as the app shows it.
    static func now() -> Date { Date().addingTimeInterval(demoOffset) }

    /// A moment on the shown clock, on the device's clock: the system's relative
    /// formatters read the device clock, so they are handed this.
    static func onDeviceClock(_ date: Date) -> Date { date.addingTimeInterval(-demoOffset) }

    /// `date.formatted(.relative(presentation: .named))` ("5 minutes ago",
    /// "yesterday"), said against `now()`.
    static func relativeNamed(_ date: Date) -> String {
        onDeviceClock(date).formatted(.relative(presentation: .named))
    }

    static func isToday(_ date: Date, calendar: Calendar = .current) -> Bool {
        calendar.isDate(date, inSameDayAs: now())
    }

    static func isTomorrow(_ date: Date, calendar: Calendar = .current) -> Bool {
        guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: now()) else { return false }
        return calendar.isDate(date, inSameDayAs: tomorrow)
    }

    static func isYesterday(_ date: Date, calendar: Calendar = .current) -> Bool {
        guard let yesterday = calendar.date(byAdding: .day, value: -1, to: now()) else { return false }
        return calendar.isDate(date, inSameDayAs: yesterday)
    }

    /// The start of the shown today.
    static func startOfToday(calendar: Calendar = .current) -> Date {
        calendar.startOfDay(for: now())
    }

    /// The instant a launch argument list pins, nil when it pins none (or garbage).
    static func pinnedInstant(in arguments: [String]) -> Date? {
        guard let i = arguments.firstIndex(of: demoPinArgument), i + 1 < arguments.count else { return nil }
        let text = arguments[i + 1]
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: text) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text)
    }

    /// The offset a launch asks for: the pin minus now, only in the demo.
    static func demoPinOffset(arguments: [String], demoActive: Bool, now: Date = Date()) -> TimeInterval {
        guard demoActive, let pin = pinnedInstant(in: arguments) else { return 0 }
        return pin.timeIntervalSince(now)
    }

    /// Read the pin: at launch, and when the demo is entered (the shown clock then
    /// starts at the pin again, with the demo's fresh sample data). Debug builds only.
    static func applyDemoPin(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        demoActive: Bool = DemoMode.isActive
    ) {
        #if DEBUG
        let value = demoPinOffset(arguments: arguments, demoActive: demoActive)
        offset.withLock { $0 = value }
        if value != 0 {
            AppLog.info("demo", "demo clock pinned", ["offsetSeconds": String(Int(value.rounded()))])
        }
        #endif
    }

    /// Leaving the demo: the shown clock is the device's again.
    static func clearDemoPin() {
        offset.withLock { $0 = 0 }
    }
}
