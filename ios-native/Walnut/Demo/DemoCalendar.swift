import EventKit
import Foundation

/// The demo's device calendar. The demo never touches EventKit, so it never asks
/// for calendar access: a reviewer trying the demo would otherwise be asked to
/// share their real calendar with sample data. Instead the calendar view shows a
/// few sample events from here, next to the sample tasks.
///
/// None of them is on the day the chat's plan is for (today, or tomorrow late
/// in the day): the plan is written from the board, and an event it did not
/// mention would contradict it.
struct DemoCalendarProvider: CalendarEventProvider {
    var authorizationStatus: EKAuthorizationStatus { .fullAccess }

    func requestAccess() async -> Bool { true }

    /// From the demo server's clock, the one the chat's plan was made with. A fresh
    /// clock per query disagreed with the plan about its day once the time passed
    /// the plan's cut off (App Store gate, 2026-10-09).
    func events(from: Date, to: Date) -> [DeviceCalendarEvent] {
        Self.events(DemoServer.shared.clockNow).filter { $0.end > from && $0.start < to }
    }

    static func events(_ c: DemoClock) -> [DeviceCalendarEvent] {
        let planDay = c.plan().day
        var saturday = c.nextWeekday(7)
        if saturday <= planDay { saturday += 7 }
        func event(_ id: String, _ title: String, day: Int, hour: Int, minute: Int = 0,
                   minutes: Int, calendar: String, rgb: (Double, Double, Double)) -> DeviceCalendarEvent {
            let start = c.date(day: day, hour: hour, minute: minute)
            return DeviceCalendarEvent(
                id: "demo-event-\(id)", title: title, start: start,
                end: start.addingTimeInterval(TimeInterval(minutes * 60)), isAllDay: false,
                colorRed: rgb.0, colorGreen: rgb.1, colorBlue: rgb.2, calendarTitle: calendar
            )
        }
        let home = (0.20, 0.55, 0.85)
        let personal = (0.55, 0.35, 0.80)
        return [
            event("dinner", "Dinner at Ana's", day: planDay - 1, hour: 19, minutes: 120, calendar: "Personal", rgb: personal),
            event("coffee", "Coffee with Sam", day: planDay + 1, hour: 9, minutes: 30, calendar: "Home", rgb: home),
            event("yoga", "Yoga class", day: planDay + 2, hour: 18, minute: 30, minutes: 60, calendar: "Personal", rgb: personal),
            event("showroom", "Kitchen showroom visit", day: saturday, hour: 10, minutes: 60, calendar: "Home", rgb: home),
        ]
    }
}

extension DeviceCalendarStore {
    /// The store the calendar view uses: the phone's calendar for a real pairing,
    /// the sample one in the demo (which never touches EventKit).
    static func forCurrentPairing() -> DeviceCalendarStore {
        DemoMode.isActive
            ? DeviceCalendarStore(provider: DemoCalendarProvider())
            : DeviceCalendarStore()
    }
}
