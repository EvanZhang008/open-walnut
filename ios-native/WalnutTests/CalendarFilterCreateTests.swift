import XCTest
@testable import Walnut

/// UNIT layer for the two things the calendar was missing (dogfood R18: "the
/// calendar view is not useable basically, not able to create, not able to
/// click, or filter"): the FILTER rules and the tap→draft→wire create math.
/// Both are pure and calendar-parameterized, so a fixed zone drives the exact
/// production code without a simulator.
final class CalendarFilterCreateTests: XCTestCase {

    private var la: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        c.locale = Locale(identifier: "en_US_POSIX")
        c.firstWeekday = 1
        return c
    }

    private func task(
        id: String, project: String = "", due: String? = nil,
        start: String? = nil, end: String? = nil, status: String = "todo"
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: "Task \(id)", status: status,
            phase: status == "done" ? "COMPLETE" : "TODO",
            priority: "none", project: project, dueDate: due,
            createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: nil,
            startDate: start, endDate: end
        )
    }

    private func event(id: String, start: Date, end: Date) -> DeviceCalendarEvent {
        DeviceCalendarEvent(
            id: id, title: "Event \(id)", start: start, end: end, isAllDay: false,
            colorRed: nil, colorGreen: nil, colorBlue: nil, calendarTitle: nil
        )
    }

    private func date(_ iso: String) -> Date {
        guard let parsed = CalendarLogic.parseTaskDate(iso, calendar: la) else {
            XCTFail("fixture date failed to parse: \(iso)")
            return Date(timeIntervalSince1970: 0)
        }
        return parsed.date
    }

    // MARK: - Filter defaults

    func testDefaultFilterShowsEverything() {
        let f = CalendarFilter.unrestricted
        XCTAssertFalse(f.isActive)
        XCTAssertEqual(f.activeCount, 0)
        let tasks = [task(id: "a", project: "Walnut"), task(id: "b", project: "")]
        XCTAssertEqual(f.apply(toTasks: tasks).count, 2)
    }

    func testEmptyProjectSetMeansNoRestrictionNotNothing() {
        // The trap this pins: reading an empty Set as "show nothing" would open
        // a fresh install on a blank calendar.
        var f = CalendarFilter()
        f.projects = []
        XCTAssertEqual(f.apply(toTasks: [task(id: "a", project: "Walnut")]).count, 1)
    }

    // MARK: - Project filter

    func testProjectFilterKeepsOnlySelectedProjects() {
        var f = CalendarFilter()
        f.projects = ["Walnut"]
        let kept = f.apply(toTasks: [
            task(id: "a", project: "Walnut"),
            task(id: "b", project: "Stock Analyzer"),
            task(id: "c", project: ""),
        ])
        XCTAssertEqual(kept.map(\.id), ["a"])
    }

    func testInboxIsSelectableAsTheEmptyProject() {
        var f = CalendarFilter()
        f.projects = [""]
        let kept = f.apply(toTasks: [
            task(id: "inbox", project: ""),
            task(id: "named", project: "Walnut"),
        ])
        XCTAssertEqual(kept.map(\.id), ["inbox"])
        XCTAssertEqual(CalendarFilter.label(for: ""), "Inbox")
        XCTAssertEqual(CalendarFilter.label(for: "Walnut"), "Walnut")
    }

    // MARK: - Tasks / events toggles

    func testHidingTasksEmptiesTasksButNotEvents() {
        var f = CalendarFilter()
        f.showsTasks = false
        XCTAssertTrue(f.apply(toTasks: [task(id: "a")]).isEmpty)
        let e = event(id: "e", start: date("2026-08-23T09:00:00"), end: date("2026-08-23T10:00:00"))
        XCTAssertEqual(f.apply(toEvents: [e]).count, 1)
        XCTAssertEqual(f.activeCount, 1)
    }

    func testHidingEventsEmptiesEventsButNotTasks() {
        var f = CalendarFilter()
        f.showsEvents = false
        let e = event(id: "e", start: date("2026-08-23T09:00:00"), end: date("2026-08-23T10:00:00"))
        XCTAssertTrue(f.apply(toEvents: [e]).isEmpty)
        XCTAssertEqual(f.apply(toTasks: [task(id: "a")]).count, 1)
    }

    func testHideOverdueDropsOnlyOverdueTasks() {
        var f = CalendarFilter()
        f.hidesOverdue = true
        // isOverdue is relative to the DEVICE clock, so build the fixtures off
        // "now" rather than a frozen literal.
        let cal = Calendar.current
        let past = CalendarLogic.dayKey(
            cal.date(byAdding: .day, value: -3, to: Date())!, calendar: cal
        )
        let future = CalendarLogic.dayKey(
            cal.date(byAdding: .day, value: 3, to: Date())!, calendar: cal
        )
        let kept = f.apply(toTasks: [
            task(id: "old", due: past),
            task(id: "soon", due: future),
            task(id: "undated"),
        ])
        XCTAssertEqual(kept.map(\.id).sorted(), ["soon", "undated"])
    }

    func testActiveCountCountsEachNarrowingOnce() {
        var f = CalendarFilter()
        f.projects = ["Walnut", "Life"]   // one narrowing, not two
        f.showsEvents = false
        XCTAssertEqual(f.activeCount, 2)
    }

    // MARK: - Selectable projects

    func testSelectableProjectsOnlyListsProjectsWithDatedTasks() {
        let projects = CalendarFilter.selectableProjects(
            from: [
                task(id: "a", project: "Walnut", due: "2026-08-25"),
                task(id: "b", project: "Undated"),                       // no date → excluded
                task(id: "c", project: "Spans", start: "2026-08-25T09:00:00"),
                task(id: "d", project: "Ends", end: "2026-08-26"),
                task(id: "e", project: "", due: "2026-08-27"),           // Inbox
            ],
            selected: []
        )
        // Inbox first, then A→Z.
        XCTAssertEqual(projects, ["", "Ends", "Spans", "Walnut"])
    }

    func testSelectableProjectsAlwaysIncludesTheAlreadySelectedOnes() {
        // A selected project whose last dated task moved away must stay
        // listed — otherwise the filter can never be turned off.
        let projects = CalendarFilter.selectableProjects(
            from: [task(id: "a", project: "Walnut", due: "2026-08-25")],
            selected: ["Ghost"]
        )
        XCTAssertEqual(projects, ["Ghost", "Walnut"])
    }

    func testSelectableProjectsIgnoresDoneTasks() {
        let projects = CalendarFilter.selectableProjects(
            from: [task(id: "a", project: "Finished", due: "2026-08-25", status: "done")],
            selected: []
        )
        XCTAssertTrue(projects.isEmpty)
    }

    // MARK: - Filter persistence

    func testPreferenceRoundTripsAnActiveFilter() {
        let suite = UserDefaults(suiteName: "walnut.tests.calendarFilter.\(UUID().uuidString)")!
        let pref = CalendarFilterPreference(defaults: suite)
        var f = CalendarFilter()
        f.projects = ["Walnut", ""]
        f.showsEvents = false
        pref.save(f)
        XCTAssertEqual(pref.load(), f)
    }

    func testPreferenceStoresUnrestrictedAsAbsent() {
        let suite = UserDefaults(suiteName: "walnut.tests.calendarFilter.\(UUID().uuidString)")!
        let pref = CalendarFilterPreference(defaults: suite)
        var f = CalendarFilter()
        f.projects = ["Walnut"]
        pref.save(f)
        pref.save(.unrestricted)
        XCTAssertNil(suite.data(forKey: CalendarFilterPreference.key))
        XCTAssertEqual(pref.load(), .unrestricted)
    }

    func testCorruptPreferenceDegradesToUnrestricted() {
        let suite = UserDefaults(suiteName: "walnut.tests.calendarFilter.\(UUID().uuidString)")!
        suite.set(Data("not json".utf8), forKey: CalendarFilterPreference.key)
        XCTAssertEqual(CalendarFilterPreference(defaults: suite).load(), .unrestricted)
    }

    // MARK: - Tap → slot

    func testTapSnapsDownToTheFifteenMinuteSlot() {
        let day = date("2026-08-23")
        // y = 614 pt at 1 pt/min = 10:14 → snaps to 10:00.
        let slot = CalendarCreate.slotStart(atY: 614, minuteHeight: 1, day: day, calendar: la)
        XCTAssertEqual(la.component(.hour, from: slot!), 10)
        XCTAssertEqual(la.component(.minute, from: slot!), 0)
        // y = 620 → 10:20 → snaps to 10:15.
        let later = CalendarCreate.slotStart(atY: 620, minuteHeight: 1, day: day, calendar: la)
        XCTAssertEqual(la.component(.minute, from: later!), 15)
    }

    func testTapBelowTheGridClampsIntoTheSameDay() {
        // The bottom padding (floating-pill clearance) is inside the scroll
        // content: a tap there must not create tomorrow 00:00.
        let day = date("2026-08-23")
        let draft = CalendarCreate.timedDraft(atY: 1600, minuteHeight: 1, day: day, calendar: la)
        XCTAssertNotNil(draft)
        XCTAssertEqual(CalendarLogic.dayKey(draft!.start!, calendar: la), "2026-08-23")
        XCTAssertEqual(la.component(.hour, from: draft!.start!), 23)
        XCTAssertEqual(la.component(.minute, from: draft!.start!), 45)
    }

    func testTapAboveTheGridClampsToMidnight() {
        let draft = CalendarCreate.timedDraft(atY: -50, minuteHeight: 1, day: date("2026-08-23"), calendar: la)
        XCTAssertEqual(la.component(.hour, from: draft!.start!), 0)
        XCTAssertEqual(la.component(.minute, from: draft!.start!), 0)
    }

    func testZeroMinuteHeightIsRefusedNotDividedBy() {
        XCTAssertNil(CalendarCreate.slotStart(atY: 100, minuteHeight: 0, day: date("2026-08-23"), calendar: la))
    }

    // MARK: - Draft shape

    func testTimedDraftGetsTheDefaultHourLongWindow() {
        let draft = CalendarCreate.timedDraft(atY: 840, minuteHeight: 1, day: date("2026-08-23"), calendar: la)!
        XCTAssertEqual(la.component(.hour, from: draft.start!), 14)
        XCTAssertEqual(draft.end!.timeIntervalSince(draft.start!), 3600)
        XCTAssertFalse(draft.isAllDay)
    }

    func testLateNightDraftIsTruncatedAtMidnightNotSpilled() {
        // 23:45 + 60min would land at 00:45 tomorrow — the block would be
        // invisible on the day the user tapped.
        let draft = CalendarCreate.timedDraft(atY: 1425, minuteHeight: 1, day: date("2026-08-23"), calendar: la)!
        XCTAssertEqual(CalendarLogic.dayKey(draft.end!, calendar: la), "2026-08-24")
        XCTAssertEqual(la.component(.hour, from: draft.end!), 0)
        XCTAssertEqual(la.component(.minute, from: draft.end!), 0)
        XCTAssertEqual(draft.end!.timeIntervalSince(draft.start!), 15 * 60)
    }

    func testAllDayDraftHasNoStart() {
        let draft = CalendarCreate.allDayDraft(day: date("2026-08-23T15:00:00"), calendar: la)
        XCTAssertTrue(draft.isAllDay)
        XCTAssertNil(draft.start)
        XCTAssertEqual(CalendarLogic.dayKey(draft.day, calendar: la), "2026-08-23")
    }

    // MARK: - Wire values

    func testTimedDraftSendsBareLocalWallClockNotAZuluInstant() {
        // A Z instant here would shift the block by the UTC offset (7h in LA) —
        // the user taps 2 PM and the block renders at 9 PM.
        let draft = CalendarCreate.timedDraft(atY: 840, minuteHeight: 1, day: date("2026-08-23"), calendar: la)!
        let wire = CalendarCreate.wireDates(for: draft, calendar: la)
        XCTAssertEqual(wire.startDate, "2026-08-23T14:00:00")
        XCTAssertEqual(wire.endDate, "2026-08-23T15:00:00")
        XCTAssertNil(wire.dueDate, "a timed block is a start, not a deadline")
    }

    func testAllDayDraftSendsADateOnlyDueDateAndNoStart() {
        let wire = CalendarCreate.wireDates(
            for: CalendarCreate.allDayDraft(day: date("2026-08-23"), calendar: la), calendar: la
        )
        XCTAssertEqual(wire.dueDate, "2026-08-23")
        XCTAssertNil(wire.startDate, "the server rejects an end without a start; an all-day tap has neither")
        XCTAssertNil(wire.endDate)
    }

    func testWireValuesRoundTripBackThroughTheParserToTheSameSlot() {
        // The real contract: whatever we send must bucket back onto the day and
        // hour the user tapped. This is the assertion that would have caught a
        // zone bug end-to-end.
        for y in stride(from: CGFloat(0), through: 1425, by: 137) {
            let draft = CalendarCreate.timedDraft(atY: y, minuteHeight: 1, day: date("2026-08-23"), calendar: la)!
            let wire = CalendarCreate.wireDates(for: draft, calendar: la)
            let parsed = CalendarLogic.parseTaskDate(wire.startDate, calendar: la)
            XCTAssertEqual(parsed?.date, draft.start, "y=\(y) did not round-trip")
            XCTAssertEqual(parsed?.hasTime, true)
        }
    }

    func testCreatedTimedTaskLandsAsABlockOnTheTappedDay() {
        // End-to-end through the REAL projection: draft → wire → task → the
        // span the timeline lays out.
        let draft = CalendarCreate.timedDraft(atY: 540, minuteHeight: 1, day: date("2026-08-23"), calendar: la)!
        let wire = CalendarCreate.wireDates(for: draft, calendar: la)
        let created = task(id: "new", project: "Walnut", start: wire.startDate, end: wire.endDate)
        let spans = CalendarTimeline.bucketTaskSpans([created], calendar: la)
        XCTAssertEqual(spans["2026-08-23"]?.count, 1)
        let layout = CalendarTimeline.layout(
            day: date("2026-08-23"), allDayTasks: [], spans: spans["2026-08-23"] ?? [],
            events: [], calendar: la
        )
        XCTAssertEqual(layout.blocks.count, 1)
        XCTAssertEqual(layout.blocks.first?.startMinutes, 540, "9:00 AM tap → block at minute 540")
    }

    func testCreatedAllDayTaskLandsInTheAllDayBand() {
        let wire = CalendarCreate.wireDates(
            for: CalendarCreate.allDayDraft(day: date("2026-08-23"), calendar: la), calendar: la
        )
        let created = task(id: "new", due: wire.dueDate)
        let buckets = CalendarLogic.bucketTasks([created], calendar: la)
        let items = buckets["2026-08-23"] ?? []
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.first?.hasTime, false, "date-only → all-day band, never a fake hour")
        let layout = CalendarTimeline.layout(
            day: date("2026-08-23"), allDayTasks: items, spans: [], events: [], calendar: la
        )
        XCTAssertEqual(layout.allDay.count, 1)
        XCTAssertTrue(layout.blocks.isEmpty)
    }

    // MARK: - Filter + create together

    func testAFilteredOutProjectHidesAJustCreatedTask() {
        // The friction this pins: create into project X while the filter only
        // shows Y, and the new task vanishes. The view must therefore RELAX the
        // filter on create (verified in the UI); here we assert the rule that
        // makes that necessary is real.
        var f = CalendarFilter()
        f.projects = ["Walnut"]
        let created = task(id: "new", project: "Stock Analyzer", due: "2026-08-23")
        XCTAssertTrue(f.apply(toTasks: [created]).isEmpty)
        f.projects.insert("Stock Analyzer")
        XCTAssertEqual(f.apply(toTasks: [created]).count, 1)
    }

    // MARK: - The Calendar smart-list card's count

    @MainActor
    func testCalendarCardCountsDatedOpenTasksNotZero() {
        // The card read "0" above a grid full of dots, because it counted the
        // calendar's (deliberately empty) flat list slice (dogfood R18).
        let store = TasksStore(transport: MockTaskTransport())
        store.tasks = [
            task(id: "due", due: "2026-08-25"),
            task(id: "start", start: "2026-08-25T09:00:00"),
            task(id: "end", start: "2026-08-25T09:00:00", end: "2026-08-26T09:00:00"),
            task(id: "undated"),                                  // no date → not on a calendar
            task(id: "done", due: "2026-08-25", status: "done"),  // done → calendar shows the plan
        ]
        XCTAssertEqual(store.count(for: .calendar), 3)
        XCTAssertEqual(store.datedTasks.map(\.id).sorted(), ["due", "end", "start"])
        // Sessions stays the session count, not a task slice.
        XCTAssertEqual(store.count(for: .sessions), store.sessions.count)
    }

    func testLabelForDraftReadsAsAHumanTimeOnTheTappedDay() {
        let timed = CalendarCreate.timedDraft(atY: 840, minuteHeight: 1, day: date("2026-08-23"), calendar: la)!
        let label = CalendarCreate.label(for: timed, calendar: la)
        XCTAssertTrue(label.contains("Aug"), label)
        XCTAssertTrue(label.contains("23"), label)
        XCTAssertTrue(label.contains("at"), label)
        let allDay = CalendarCreate.label(
            for: CalendarCreate.allDayDraft(day: date("2026-08-23"), calendar: la), calendar: la
        )
        XCTAssertTrue(allDay.contains("all-day"), allDay)
    }
}
