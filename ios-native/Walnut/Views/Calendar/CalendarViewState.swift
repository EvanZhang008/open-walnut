import Foundation

/// The four calendar views, mirroring Apple Calendar's switcher.
enum CalendarViewMode: String, CaseIterable, Identifiable {
    /// Day-grouped stream of events + tasks (Apple: "List").
    case list
    /// One day, hour timeline (Apple: "Day").
    case day
    /// Two side-by-side day timelines (Apple: "Multi-Day").
    case multiDay = "multiday"
    /// Month grid.
    case month

    var id: String { rawValue }

    /// Menu order matches Apple's: Day, Multi-Day, List, Month.
    static let menuOrder: [CalendarViewMode] = [.day, .multiDay, .list, .month]

    var title: String {
        switch self {
        case .list: return "List"
        case .day: return "Day"
        case .multiDay: return "Multi-Day"
        case .month: return "Month"
        }
    }

    /// SF Symbols chosen to read the same way Apple's switcher does.
    var systemImage: String {
        switch self {
        case .list: return "list.bullet"
        case .day: return "calendar.day.timeline.left"
        case .multiDay: return "rectangle.split.2x1"
        case .month: return "square.grid.3x3"
        }
    }

    /// Days rendered per page in the timeline views (0 = not a timeline view).
    var timelineDayCount: Int {
        switch self {
        case .day: return 1
        // iPhone portrait: Apple shows a bit more than two days; two full
        // columns is the honest phone-width version of that.
        case .multiDay: return 2
        case .list, .month: return 0
        }
    }

    /// True for the views that carry the top week strip.
    var showsWeekStrip: Bool {
        switch self {
        case .day, .multiDay: return true
        case .list, .month: return false
        }
    }
}

/// Persisted view choice. Kept as a tiny value type (not a store) so the state
/// machine is unit-testable against an injected UserDefaults suite — the real
/// app uses `.standard`, tests use a throwaway suite.
struct CalendarViewPreference {
    static let key = "walnut.calendar.viewMode"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Restore the last view, defaulting to Day (Apple's default and the one
    /// that answers "what am I doing now?").
    func load() -> CalendarViewMode {
        guard let raw = defaults.string(forKey: Self.key),
              let mode = CalendarViewMode(rawValue: raw)
        else { return .day }
        return mode
    }

    func save(_ mode: CalendarViewMode) {
        defaults.set(mode.rawValue, forKey: Self.key)
    }
}

/// Pure transition rules for the calendar's selection + view mode. The view
/// owns the @State; every rule that decides "which day is selected after X"
/// lives here so it can be asserted without a simulator.
enum CalendarViewTransition {

    /// Result of a transition: the new mode plus the day that should be
    /// selected (always local midnight).
    struct Outcome: Equatable {
        let mode: CalendarViewMode
        let selectedDay: Date
    }

    /// Switching views keeps the selected day — the user's place in time is
    /// the one thing a view switch must never lose.
    static func switching(
        to mode: CalendarViewMode, selectedDay: Date, calendar: Calendar
    ) -> Outcome {
        Outcome(mode: mode, selectedDay: calendar.startOfDay(for: selectedDay))
    }

    /// Tapping a day in the MONTH grid drills into that day's Day view
    /// (Apple's behavior), so a month tap is never a dead end.
    static func tappingMonthDay(_ day: Date, calendar: Calendar) -> Outcome {
        Outcome(mode: .day, selectedDay: calendar.startOfDay(for: day))
    }

    /// Tapping a day in the week strip selects it without changing the view.
    static func tappingStripDay(
        _ day: Date, mode: CalendarViewMode, calendar: Calendar
    ) -> Outcome {
        Outcome(mode: mode, selectedDay: calendar.startOfDay(for: day))
    }

    /// The "Today" button: jump to today, keeping the current view.
    static func jumpingToToday(
        now: Date, mode: CalendarViewMode, calendar: Calendar
    ) -> Outcome {
        Outcome(mode: mode, selectedDay: calendar.startOfDay(for: now))
    }
}
