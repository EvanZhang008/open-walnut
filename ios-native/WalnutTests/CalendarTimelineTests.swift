import XCTest
@testable import Walnut

/// UNIT layer for the day-column projection (CalendarTimeline) and the calendar
/// view state machine (CalendarViewMode / CalendarViewPreference /
/// CalendarViewTransition): task spans → blocks, all-day banding, list sections,
/// and view switch / restore behavior. Fixed zone, no simulator.
final class CalendarTimelineTests: XCTestCase {

    private var la: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        c.locale = Locale(identifier: "en_US_POSIX")
        c.firstWeekday = 1
        return c
    }

    private func date(_ iso: String) -> Date {
        guard let parsed = CalendarLogic.parseTaskDate(iso, calendar: la) else {
            XCTFail("fixture date failed to parse: \(iso)")
            return Date(timeIntervalSince1970: 0)
        }
        return parsed.date
    }

    private func task(
        id: String, due: String? = nil, start: String? = nil, end: String? = nil,
        status: String = "todo"
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: "Task \(id)", status: status,
            phase: status == "done" ? "COMPLETE" : "TODO",
            priority: "none", project: "", dueDate: due,
            createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: nil,
            startDate: start, endDate: end
        )
    }

    private func event(
        id: String, start: String, end: String, allDay: Bool = false
    ) -> DeviceCalendarEvent {
        DeviceCalendarEvent(
            id: id, title: "Event \(id)", start: date(start), end: date(end),
            isAllDay: allDay, colorRed: nil, colorGreen: nil, colorBlue: nil,
            calendarTitle: "Fixture"
        )
    }

    // MARK: - Task spans

    func testTimedStartWithEndBecomesOneWorkSpan() {
        let spans = CalendarTimeline.taskSpans(
            task(id: "a", start: "2026-08-09T09:00:00", end: "2026-08-09T11:00:00"), calendar: la
        )
        XCTAssertEqual(spans.count, 1)
        XCTAssertEqual(spans[0].kind, .start)
        XCTAssertEqual(spans[0].start, date("2026-08-09T09:00:00"))
        XCTAssertEqual(spans[0].end, date("2026-08-09T11:00:00"))
    }

    func testTimedStartWithoutEndGetsTheDefaultDuration() {
        let spans = CalendarTimeline.taskSpans(task(id: "a", start: "2026-08-09T09:00:00"), calendar: la)
        XCTAssertEqual(spans.count, 1)
        XCTAssertEqual(
            spans[0].end.timeIntervalSince(spans[0].start),
            CalendarTimeline.defaultTaskMinutes * 60
        )
    }

    func testEndEarlierThanStartFallsBackToTheDefaultDuration() {
        // Corrupt data must not produce a negative-height block.
        let spans = CalendarTimeline.taskSpans(
            task(id: "a", start: "2026-08-09T11:00:00", end: "2026-08-09T09:00:00"), calendar: la
        )
        XCTAssertEqual(spans.count, 1)
        XCTAssertGreaterThan(spans[0].end, spans[0].start)
    }

    func testTimedDueOutsideTheWorkSpanEmitsItsOwnDeadlineSpan() {
        let spans = CalendarTimeline.taskSpans(
            task(id: "a", due: "2026-08-09T17:00:00", start: "2026-08-09T09:00:00", end: "2026-08-09T10:00:00"),
            calendar: la
        )
        XCTAssertEqual(spans.map(\.kind), [.start, .due])
        XCTAssertEqual(spans[1].start, date("2026-08-09T17:00:00"))
    }

    func testTimedDueInsideTheWorkSpanIsNotDrawnTwice() {
        let spans = CalendarTimeline.taskSpans(
            task(id: "a", due: "2026-08-09T10:00:00", start: "2026-08-09T09:00:00", end: "2026-08-09T11:00:00"),
            calendar: la
        )
        XCTAssertEqual(spans.map(\.kind), [.start], "the deadline already sits inside the work span")
    }

    func testDateOnlyValuesProduceNoTimedSpans() {
        XCTAssertTrue(CalendarTimeline.taskSpans(task(id: "a", due: "2026-08-09"), calendar: la).isEmpty)
        XCTAssertTrue(CalendarTimeline.taskSpans(
            task(id: "b", start: "2026-08-09", end: "2026-08-10"), calendar: la
        ).isEmpty)
    }

    func testDoneTasksProduceNoSpans() {
        XCTAssertTrue(CalendarTimeline.taskSpans(
            task(id: "a", start: "2026-08-09T09:00:00", status: "done"), calendar: la
        ).isEmpty)
    }

    func testBucketTaskSpansFansCrossDaySpansOutToEveryTouchedDay() {
        let buckets = CalendarTimeline.bucketTaskSpans(
            [task(id: "a", start: "2026-08-09T22:00:00", end: "2026-08-11T09:00:00")], calendar: la
        )
        XCTAssertEqual(buckets.keys.sorted(), ["2026-08-09", "2026-08-10", "2026-08-11"])
    }

    func testBucketTaskSpansCapsACorruptSpan() {
        let buckets = CalendarTimeline.bucketTaskSpans(
            [task(id: "a", start: "2026-01-01T00:00:00", end: "2027-01-01T00:00:00")], calendar: la
        )
        XCTAssertLessThanOrEqual(buckets.count, 63)
    }

    // MARK: - Day layout

    func testLayoutPlacesTimedEventsAsBlocksAndAllDayAsBanners() {
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"),
            allDayTasks: [],
            spans: [],
            events: [
                event(id: "meeting", start: "2026-08-09T09:00:00", end: "2026-08-09T10:00:00"),
                event(id: "holiday", start: "2026-08-09", end: "2026-08-09T23:59:00", allDay: true),
            ],
            calendar: la
        )
        XCTAssertEqual(layout.allDay.map(\.id), ["event-holiday"])
        XCTAssertEqual(layout.blocks.map(\.id), ["event-meeting"])
        XCTAssertEqual(layout.blocks[0].startMinutes, 540)
        XCTAssertEqual(layout.blocks[0].endMinutes, 600)
    }

    func testDateOnlyTaskItemsRideTheAllDayBand() {
        let items = CalendarLogic.bucketTasks([task(id: "a", due: "2026-08-09")], calendar: la)["2026-08-09"] ?? []
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"), allDayTasks: items, spans: [], events: [], calendar: la
        )
        XCTAssertEqual(layout.allDay.map(\.id), ["task-due:a"])
        XCTAssertTrue(layout.blocks.isEmpty, "a day-granular task never gets a fake hour")
    }

    func testTimedTaskItemsPassedAsAllDayTasksAreIgnored() {
        // The container hands the whole day bucket over; only the date-only ones
        // belong in the band (the timed ones arrive as spans).
        let items = CalendarLogic.bucketTasks(
            [task(id: "a", due: "2026-08-09T10:00:00")], calendar: la
        )["2026-08-09"] ?? []
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"), allDayTasks: items, spans: [], events: [], calendar: la
        )
        XCTAssertTrue(layout.allDay.isEmpty)
    }

    func testTaskSpanBecomesABlockKeyedLikeItsTaskItem() {
        let spans = CalendarTimeline.bucketTaskSpans(
            [task(id: "a", start: "2026-08-09T09:00:00", end: "2026-08-09T10:30:00")], calendar: la
        )
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"),
            allDayTasks: [], spans: spans["2026-08-09"] ?? [], events: [], calendar: la
        )
        XCTAssertEqual(layout.blocks.map(\.id), ["task-start:a"])
        XCTAssertEqual(layout.blocks[0].startMinutes, 540)
        XCTAssertEqual(layout.blocks[0].endMinutes, 630)
    }

    func testOverlappingTaskAndEventShareTheColumnInTwoLanes() {
        let spans = CalendarTimeline.bucketTaskSpans(
            [task(id: "a", start: "2026-08-09T09:00:00", end: "2026-08-09T11:00:00")], calendar: la
        )
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"),
            allDayTasks: [],
            spans: spans["2026-08-09"] ?? [],
            events: [event(id: "standup", start: "2026-08-09T09:30:00", end: "2026-08-09T10:00:00")],
            calendar: la
        )
        XCTAssertEqual(layout.blocks.count, 2)
        XCTAssertEqual(Set(layout.blocks.map(\.columnCount)), [2])
        XCTAssertEqual(layout.blocks.map(\.column).sorted(), [0, 1])
    }

    func testMiddleDayOfAMultiDayEventBecomesABannerNotAFullHeightBlock() {
        let multi = event(id: "trip", start: "2026-08-09T22:00:00", end: "2026-08-11T09:00:00")
        let middle = CalendarTimeline.layout(
            day: date("2026-08-10"), allDayTasks: [], spans: [], events: [multi], calendar: la
        )
        XCTAssertEqual(middle.allDay.map(\.id), ["event-trip"])
        XCTAssertTrue(middle.blocks.isEmpty)
        XCTAssertEqual(middle.allDay[0].continuesBefore, true)
        XCTAssertEqual(middle.allDay[0].continuesAfter, true)
        // The first day keeps a real block, flat at the bottom.
        let first = CalendarTimeline.layout(
            day: date("2026-08-09"), allDayTasks: [], spans: [], events: [multi], calendar: la
        )
        XCTAssertEqual(first.blocks.map(\.id), ["event-trip"])
        XCTAssertEqual(first.blocks[0].continuesAfter, true)
        XCTAssertEqual(first.blocks[0].continuesBefore, false)
    }

    func testEventsOnOtherDaysAreDroppedFromThisColumn() {
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"),
            allDayTasks: [], spans: [],
            events: [event(id: "tomorrow", start: "2026-08-10T09:00:00", end: "2026-08-10T10:00:00")],
            calendar: la
        )
        XCTAssertTrue(layout.blocks.isEmpty)
        XCTAssertTrue(layout.allDay.isEmpty)
    }

    func testVeryShortBlockGetsAMinimumRenderedHeightWithoutInflatingItsLanes() {
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"),
            allDayTasks: [], spans: [],
            events: [
                event(id: "flash", start: "2026-08-09T09:00:00", end: "2026-08-09T09:05:00"),
                // Starts after the true end, before the inflated one: it must
                // still be full width, proving packing uses the TRUE end.
                event(id: "after", start: "2026-08-09T09:10:00", end: "2026-08-09T09:40:00"),
            ],
            calendar: la
        )
        let byId = Dictionary(uniqueKeysWithValues: layout.blocks.map { ($0.id, $0) })
        XCTAssertEqual(byId["event-flash"]?.endMinutes, 545)
        XCTAssertEqual(byId["event-flash"]?.heightMinutes, CalendarTimeline.minimumBlockMinutes)
        XCTAssertEqual(byId["event-flash"]?.columnCount, 1)
        XCTAssertEqual(byId["event-after"]?.columnCount, 1)
    }

    func testTwoEventsAtTheExactSameInstantStillGetSeparateLanes() {
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"),
            allDayTasks: [], spans: [],
            events: [
                event(id: "a", start: "2026-08-09T09:00:00", end: "2026-08-09T09:00:00"),
                event(id: "b", start: "2026-08-09T09:00:00", end: "2026-08-09T09:00:00"),
            ],
            calendar: la
        )
        XCTAssertEqual(layout.blocks.count, 2)
        XCTAssertEqual(Set(layout.blocks.map(\.columnCount)), [2])
    }

    func testBlockHeightNeverOverflowsTheColumn() {
        // A late 23:55 event: the height floor must clamp at the day's bottom.
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"),
            allDayTasks: [], spans: [],
            events: [event(id: "late", start: "2026-08-09T23:55:00", end: "2026-08-09T23:58:00")],
            calendar: la
        )
        let block = layout.blocks[0]
        XCTAssertLessThanOrEqual(block.displayEndMinutes, CalendarLayout.minutesPerDay)
        XCTAssertEqual(block.startMinutes + block.heightMinutes, CalendarLayout.minutesPerDay)
    }

    func testLayoutCarriesTheDayKey() {
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"), allDayTasks: [], spans: [], events: [], calendar: la
        )
        XCTAssertEqual(layout.dayKey, "2026-08-09")
        XCTAssertTrue(layout.blocks.isEmpty)
        XCTAssertTrue(layout.allDay.isEmpty)
    }

    func testAllDayBandKeepsEventsBeforeTasks() {
        let items = CalendarLogic.bucketTasks([task(id: "t", due: "2026-08-09")], calendar: la)["2026-08-09"] ?? []
        let layout = CalendarTimeline.layout(
            day: date("2026-08-09"),
            allDayTasks: items,
            spans: [],
            events: [event(id: "holiday", start: "2026-08-09", end: "2026-08-09T23:59:00", allDay: true)],
            calendar: la
        )
        XCTAssertEqual(layout.allDay.map(\.id), ["event-holiday", "task-due:t"])
    }

    // MARK: - List sections

    func testListSectionsSkipEmptyDaysButKeepTheSelectedOne() {
        let buckets = CalendarLogic.bucketTasks([task(id: "a", due: "2026-08-11")], calendar: la)
        let sections = CalendarTimeline.listSections(
            from: date("2026-08-09"), dayCount: 5,
            taskBuckets: buckets, eventsByDay: [:], calendar: la,
            alwaysInclude: ["2026-08-09"]
        )
        XCTAssertEqual(sections.map(\.dayKey), ["2026-08-09", "2026-08-11"])
        XCTAssertTrue(sections[0].isEmpty, "the kept selected day renders as an empty section")
        XCTAssertEqual(sections[1].rows.map(\.id), ["task-due:a"])
    }

    func testListSectionsMergeTasksAndEventsPerDayInAgendaOrder() {
        let buckets = CalendarLogic.bucketTasks([task(id: "t", due: "2026-08-09T10:00:00")], calendar: la)
        let sections = CalendarTimeline.listSections(
            from: date("2026-08-09"), dayCount: 1,
            taskBuckets: buckets,
            eventsByDay: ["2026-08-09": [event(id: "e", start: "2026-08-09T09:00:00", end: "2026-08-09T09:30:00")]],
            calendar: la
        )
        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].rows.map(\.id), ["event-e", "task-due:t"])
    }

    func testListSectionsWalkDSTDaysExactlyOnce() {
        // Every day in the window is present at most once even across the
        // 23-hour spring-forward day.
        let buckets = CalendarLogic.bucketTasks([
            task(id: "a", due: "2026-03-07"), task(id: "b", due: "2026-03-08"),
            task(id: "c", due: "2026-03-09"),
        ], calendar: la)
        let sections = CalendarTimeline.listSections(
            from: date("2026-03-06"), dayCount: 5,
            taskBuckets: buckets, eventsByDay: [:], calendar: la
        )
        XCTAssertEqual(sections.map(\.dayKey), ["2026-03-07", "2026-03-08", "2026-03-09"])
    }

    func testListSectionsRejectNonPositiveWindows() {
        XCTAssertTrue(CalendarTimeline.listSections(
            from: date("2026-08-09"), dayCount: 0,
            taskBuckets: [:], eventsByDay: [:], calendar: la
        ).isEmpty)
    }

    // MARK: - View mode

    func testMenuOrderMatchesApplesSwitcherAndCoversEveryMode() {
        XCTAssertEqual(CalendarViewMode.menuOrder, [.day, .multiDay, .list, .month])
        XCTAssertEqual(Set(CalendarViewMode.menuOrder), Set(CalendarViewMode.allCases))
    }

    func testTimelineDayCountsAndWeekStripFlags() {
        XCTAssertEqual(CalendarViewMode.day.timelineDayCount, 1)
        XCTAssertEqual(CalendarViewMode.multiDay.timelineDayCount, 2)
        XCTAssertEqual(CalendarViewMode.list.timelineDayCount, 0)
        XCTAssertEqual(CalendarViewMode.month.timelineDayCount, 0)
        XCTAssertTrue(CalendarViewMode.day.showsWeekStrip)
        XCTAssertTrue(CalendarViewMode.multiDay.showsWeekStrip)
        XCTAssertFalse(CalendarViewMode.list.showsWeekStrip)
        XCTAssertFalse(CalendarViewMode.month.showsWeekStrip)
    }

    func testEveryModeHasATitleAndASymbol() {
        for mode in CalendarViewMode.allCases {
            XCTAssertFalse(mode.title.isEmpty)
            XCTAssertFalse(mode.systemImage.isEmpty)
        }
        // Raw values are the persisted keys — a rename silently resets everyone's
        // remembered view, so pin them.
        XCTAssertEqual(CalendarViewMode.multiDay.rawValue, "multiday")
        XCTAssertEqual(Set(CalendarViewMode.allCases.map(\.rawValue)), ["list", "day", "multiday", "month"])
    }

    // MARK: - Persistence

    private func throwawayDefaults(_ name: String = #function) -> UserDefaults {
        let suite = "walnut.tests.calendar.\(name)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    func testFirstRunDefaultsToDayView() {
        let preference = CalendarViewPreference(defaults: throwawayDefaults())
        XCTAssertEqual(preference.load(), .day)
    }

    func testSavedModeIsRestored() {
        let defaults = throwawayDefaults()
        let preference = CalendarViewPreference(defaults: defaults)
        for mode in CalendarViewMode.allCases {
            preference.save(mode)
            XCTAssertEqual(CalendarViewPreference(defaults: defaults).load(), mode)
        }
    }

    func testUnknownStoredValueFallsBackToDayInsteadOfCrashing() {
        let defaults = throwawayDefaults()
        defaults.set("gantt", forKey: CalendarViewPreference.key)
        XCTAssertEqual(CalendarViewPreference(defaults: defaults).load(), .day)
    }

    // MARK: - Transitions

    func testSwitchingViewsKeepsTheSelectedDay() {
        let selected = date("2026-08-12T15:00:00")
        for mode in CalendarViewMode.allCases {
            let outcome = CalendarViewTransition.switching(to: mode, selectedDay: selected, calendar: la)
            XCTAssertEqual(outcome.mode, mode)
            XCTAssertEqual(CalendarLogic.dayKey(outcome.selectedDay, calendar: la), "2026-08-12")
            XCTAssertEqual(la.component(.hour, from: outcome.selectedDay), 0, "always normalized to midnight")
        }
    }

    func testTappingAMonthDayDrillsIntoThatDaysDayView() {
        let outcome = CalendarViewTransition.tappingMonthDay(date("2026-09-03T18:00:00"), calendar: la)
        XCTAssertEqual(outcome.mode, .day)
        XCTAssertEqual(CalendarLogic.dayKey(outcome.selectedDay, calendar: la), "2026-09-03")
    }

    func testTappingAStripDaySelectsItWithoutChangingTheView() {
        let outcome = CalendarViewTransition.tappingStripDay(
            date("2026-08-14"), mode: .multiDay, calendar: la
        )
        XCTAssertEqual(outcome.mode, .multiDay)
        XCTAssertEqual(CalendarLogic.dayKey(outcome.selectedDay, calendar: la), "2026-08-14")
    }

    func testTodayJumpKeepsTheCurrentViewAndLandsOnTodaysMidnight() {
        let now = date("2026-08-09T22:45:00")
        for mode in CalendarViewMode.allCases {
            let outcome = CalendarViewTransition.jumpingToToday(now: now, mode: mode, calendar: la)
            XCTAssertEqual(outcome.mode, mode)
            XCTAssertEqual(CalendarLogic.dayKey(outcome.selectedDay, calendar: la), "2026-08-09")
            XCTAssertEqual(la.component(.hour, from: outcome.selectedDay), 0)
        }
    }

    func testTodayJumpAcrossZonesResolvesTheLocalDay() {
        // 2026-08-10T05:00Z is still the 9th in LA and the 10th in UTC.
        var utc = la
        utc.timeZone = TimeZone(identifier: "UTC")!
        let now = date("2026-08-10T05:00:00Z")
        XCTAssertEqual(
            CalendarLogic.dayKey(
                CalendarViewTransition.jumpingToToday(now: now, mode: .day, calendar: la).selectedDay,
                calendar: la
            ),
            "2026-08-09"
        )
        XCTAssertEqual(
            CalendarLogic.dayKey(
                CalendarViewTransition.jumpingToToday(now: now, mode: .day, calendar: utc).selectedDay,
                calendar: utc
            ),
            "2026-08-10"
        )
    }
}
