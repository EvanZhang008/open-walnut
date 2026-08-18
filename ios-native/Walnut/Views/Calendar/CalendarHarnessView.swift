#if DEBUG
import SwiftUI

/// Maestro/simctl E2E harness for the calendar (DEBUG only): launching the app
/// with `-calendar-harness` boots straight into CalendarTabView with the REAL
/// TasksStore hydrating from whatever server the sim's defaults point at — the
/// E2E script seeds tasks over /api/v1 and asserts the views.
///
/// `-calendar-view <list|day|multiday|month>` additionally forces the starting
/// view. Needed because a harness can't reliably preset the persisted choice:
/// `simctl spawn defaults write` targets a different domain store than the app's
/// sandboxed container plist, and cfprefsd caches the container copy over any
/// direct file edit. A launch argument is read by the app itself, so it always
/// wins — and it keeps every view screenshot-able without depending on tapping
/// through a menu.
struct CalendarHarnessView: View {
    @Environment(TasksStore.self) private var tasks

    var body: some View {
        CalendarTabView(forcedMode: Self.forcedMode, forcedDay: Self.forcedDay)
            .navigationTitle("Calendar")
            .navigationBarTitleDisplayMode(.inline)
            // The harness bypasses MainTabView, whose .task normally hydrates
            // the stores — hydrate here instead.
            .task { await tasks.initialize() }
    }

    /// `-calendar-view <mode>` → the mode to open in, nil when absent/unknown.
    /// Substring-matched like the harness flag itself: Maestro encodes launch
    /// arguments with a leading dash.
    static var forcedMode: CalendarViewMode? {
        value(after: "calendar-view").flatMap(CalendarViewMode.init(rawValue:))
    }

    /// `-calendar-day <yyyy-MM-dd>` → the day to open on (default: today). Lets
    /// a screenshot run verify "some other day is selected" states — the ones a
    /// user reaches by tapping the week strip or drilling in from the month —
    /// without driving taps.
    static var forcedDay: Date? {
        guard let raw = value(after: "calendar-day") else { return nil }
        return CalendarLogic.parseTaskDate(raw, calendar: .current)?.date
    }

    private static func value(after flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(where: { $0.contains(flag) }),
              index + 1 < args.count
        else { return nil }
        return args[index + 1]
    }
}
#endif
