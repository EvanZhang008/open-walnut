#if DEBUG
import SwiftUI

/// Maestro E2E harness for the calendar (DEBUG only): launching the app with
/// `-calendar-harness` (see RootView) boots straight into CalendarTabView with
/// the REAL TasksStore hydrating from whatever server the sim's defaults point
/// at — the E2E script seeds tasks over /api/v1 and asserts the grid/agenda.
/// Exists so the calendar is drivable end-to-end before (and independent of)
/// the Tasks-tab wiring, which another surface owns.
struct CalendarHarnessView: View {
    @Environment(TasksStore.self) private var tasks

    var body: some View {
        CalendarTabView()
            .navigationTitle("Calendar")
            .navigationBarTitleDisplayMode(.inline)
            // The harness bypasses MainTabView, whose .task normally hydrates
            // the stores — hydrate here instead.
            .task { await tasks.initialize() }
    }
}
#endif
