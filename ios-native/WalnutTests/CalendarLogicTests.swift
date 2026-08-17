import XCTest
@testable import Walnut

/// UNIT layer (mock-gradient ladder, layer 1): pure date math + bucketing in
/// CalendarLogic, driven with FIXED time zones and locales — no device clock,
/// no EventKit, no network. Covers the boundaries that break calendars in the
/// field: DST transition days, Sunday- vs Monday-first weeks, month spill,
/// date-only vs datetime task values, zone-suffixed instants, and midnight-
/// exact event ends.
final class CalendarLogicTests: XCTestCase {

    /// America/Los_Angeles, Sunday-first (en_US) — the primary user's setup.
    private var la: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        c.locale = Locale(identifier: "en_US_POSIX")
        c.firstWeekday = 1
        return c
    }

    /// Same zone, Monday-first — the de_DE-style week layout.
    private var laMondayFirst: Calendar {
        var c = la
        c.firstWeekday = 2
        return c
    }

    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        c.locale = Locale(identifier: "en_US_POSIX")
        c.firstWeekday = 1
        return c
    }

    private func date(_ iso: String, _ calendar: Calendar) -> Date {
        guard let parsed = CalendarLogic.parseTaskDate(iso, calendar: calendar) else {
            XCTFail("fixture date failed to parse: \(iso)")
            return Date(timeIntervalSince1970: 0)
        }
        return parsed.date
    }

    private func task(
        id: String, due: String? = nil, start: String? = nil, end: String? = nil,
        status: String = "todo", title: String? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: title ?? "Task \(id)", status: status,
            phase: status == "done" ? "COMPLETE" : "TODO",
            priority: "none", project: "", dueDate: due,
            createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: nil,
            startDate: start, endDate: end
        )
    }

    // MARK: - parseTaskDate

    func testParsesDateOnlyAsLocalMidnightAllDay() {
        let parsed = CalendarLogic.parseTaskDate("2026-08-09", calendar: la)
        XCTAssertNotNil(parsed)
        XCTAssertFalse(parsed!.hasTime)
        XCTAssertEqual(CalendarLogic.dayKey(parsed!.date, calendar: la), "2026-08-09")
        // Local midnight in LA, not UTC midnight.
        XCTAssertEqual(la.component(.hour, from: parsed!.date), 0)
    }

    func testParsesBareLocalWallClock() {
        // The quick-parse / PATCH contract shape: local wall clock, no zone.
        let parsed = CalendarLogic.parseTaskDate("2026-08-09T21:30:00", calendar: la)
        XCTAssertNotNil(parsed)
        XCTAssertTrue(parsed!.hasTime)
        XCTAssertEqual(la.component(.hour, from: parsed!.date), 21)
        XCTAssertEqual(CalendarLogic.dayKey(parsed!.date, calendar: la), "2026-08-09")
    }

    func testParsesMinutesOnlyWallClock() {
        let parsed = CalendarLogic.parseTaskDate("2026-08-09T09:00", calendar: la)
        XCTAssertNotNil(parsed)
        XCTAssertTrue(parsed!.hasTime)
        XCTAssertEqual(la.component(.hour, from: parsed!.date), 9)
    }

    func testParsesZuluInstantIntoLocalDay() {
        // 2026-08-10T05:00Z = 2026-08-09 22:00 PDT — the local day must win.
        let parsed = CalendarLogic.parseTaskDate("2026-08-10T05:00:00Z", calendar: la)
        XCTAssertNotNil(parsed)
        XCTAssertTrue(parsed!.hasTime)
        XCTAssertEqual(CalendarLogic.dayKey(parsed!.date, calendar: la), "2026-08-09")
        // Same instant read with a UTC calendar buckets to the 10th.
        XCTAssertEqual(CalendarLogic.dayKey(parsed!.date, calendar: utc), "2026-08-10")
    }

    func testParsesNegativeOffsetInstant() {
        // The "-07:00" suffix contains a "-" after the T — must be detected
        // as a zone suffix, not treated as a bare wall clock.
        let parsed = CalendarLogic.parseTaskDate("2026-08-09T22:00:00-07:00", calendar: la)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(CalendarLogic.dayKey(parsed!.date, calendar: la), "2026-08-09")
        XCTAssertEqual(la.component(.hour, from: parsed!.date), 22)
    }

    func testParsesPositiveOffsetAndFractionalSeconds() {
        XCTAssertNotNil(CalendarLogic.parseTaskDate("2026-08-09T10:00:00+02:00", calendar: la))
        XCTAssertNotNil(CalendarLogic.parseTaskDate("2026-08-09T10:00:00.123Z", calendar: la))
    }

    func testRejectsJunk() {
        XCTAssertNil(CalendarLogic.parseTaskDate(nil, calendar: la))
        XCTAssertNil(CalendarLogic.parseTaskDate("", calendar: la))
        XCTAssertNil(CalendarLogic.parseTaskDate("not a date", calendar: la))
        XCTAssertNil(CalendarLogic.parseTaskDate("2026-13-45", calendar: la))
    }

    func testParseCacheIsZoneKeyed() {
        // The same raw string parsed under two zones must not share a cache
        // entry — a bare wall clock is a DIFFERENT instant per zone.
        let inLA = CalendarLogic.parseTaskDate("2026-08-09T12:00:00", calendar: la)
        let inUTC = CalendarLogic.parseTaskDate("2026-08-09T12:00:00", calendar: utc)
        XCTAssertNotEqual(inLA?.date, inUTC?.date)
    }

    // MARK: - Month grid

    func testAugust2026SundayFirstGrid() {
        // Aug 1, 2026 is a Saturday → Sunday-first grid leads with 6 spill
        // days (Jul 26–31) and covers 6 weeks (42 cells).
        let weeks = CalendarLogic.monthGrid(containing: date("2026-08-15", la), calendar: la)
        XCTAssertEqual(weeks.count, 6)
        XCTAssertTrue(weeks.allSatisfy { $0.count == 7 })
        let flat = weeks.flatMap { $0 }
        XCTAssertEqual(flat.first?.dayKey, "2026-07-26")
        XCTAssertFalse(flat.first!.inMonth)
        XCTAssertEqual(flat[6].dayKey, "2026-08-01")
        XCTAssertTrue(flat[6].inMonth)
        XCTAssertEqual(flat.filter(\.inMonth).count, 31)
        // First column is all Sundays.
        for week in weeks {
            XCTAssertEqual(la.component(.weekday, from: week[0].date), 1)
        }
    }

    func testAugust2026MondayFirstGrid() {
        // Monday-first: Aug 1 (Saturday) sits at column index 5; the grid
        // leads with 5 spill days (Jul 27–31).
        let weeks = CalendarLogic.monthGrid(containing: date("2026-08-15", laMondayFirst), calendar: laMondayFirst)
        let flat = weeks.flatMap { $0 }
        XCTAssertEqual(flat.first?.dayKey, "2026-07-27")
        XCTAssertEqual(flat[5].dayKey, "2026-08-01")
        XCTAssertEqual(flat.filter(\.inMonth).count, 31)
        for week in weeks {
            XCTAssertEqual(laMondayFirst.component(.weekday, from: week[0].date), 2)
        }
    }

    func testMonthStartingExactlyOnFirstWeekdayHasNoLeadingSpill() {
        // Feb 1, 2026 is a Sunday and Feb 2026 has exactly 28 days →
        // a Sunday-first grid is exactly 4 spill-free weeks.
        let weeks = CalendarLogic.monthGrid(containing: date("2026-02-10", la), calendar: la)
        XCTAssertEqual(weeks.count, 4)
        let flat = weeks.flatMap { $0 }
        XCTAssertEqual(flat.count, 28)
        XCTAssertTrue(flat.allSatisfy(\.inMonth))
        XCTAssertEqual(flat.first?.dayKey, "2026-02-01")
        XCTAssertEqual(flat.last?.dayKey, "2026-02-28")
    }

    func testSpringForwardDSTGridHasEveryDayExactlyOnce() {
        // March 8, 2026 (23-hour day in LA) — day stepping must not skip or
        // duplicate any day around the transition.
        let weeks = CalendarLogic.monthGrid(containing: date("2026-03-15", la), calendar: la)
        let keys = weeks.flatMap { $0 }.map(\.dayKey)
        XCTAssertEqual(Set(keys).count, keys.count, "grid has duplicate days")
        XCTAssertTrue(keys.contains("2026-03-08"))
        XCTAssertEqual(keys.filter { $0.hasPrefix("2026-03-") }.count, 31)
    }

    func testFallBackDSTGridHasEveryDayExactlyOnce() {
        // November 1, 2026 (25-hour day in LA).
        let weeks = CalendarLogic.monthGrid(containing: date("2026-11-15", la), calendar: la)
        let keys = weeks.flatMap { $0 }.map(\.dayKey)
        XCTAssertEqual(Set(keys).count, keys.count)
        XCTAssertTrue(keys.contains("2026-11-01"))
        XCTAssertEqual(keys.filter { $0.hasPrefix("2026-11-") }.count, 30)
    }

    func testAddMonthsPinsToFirstAndNeverSkipsFebruary() {
        // Jan 31 + 1 month with a naive 31-day step would land in March.
        let jan31 = date("2026-01-31", la)
        let feb = CalendarLogic.addMonths(1, to: jan31, calendar: la)
        XCTAssertEqual(CalendarLogic.monthKey(feb, calendar: la), "2026-02")
        // Repeated navigation walks every month exactly once.
        var cursor = jan31
        var visited: [String] = []
        for _ in 0..<12 {
            cursor = CalendarLogic.addMonths(1, to: cursor, calendar: la)
            visited.append(CalendarLogic.monthKey(cursor, calendar: la))
        }
        XCTAssertEqual(visited, [
            "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07",
            "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01",
        ])
        // And back down again.
        XCTAssertEqual(
            CalendarLogic.monthKey(CalendarLogic.addMonths(-1, to: feb, calendar: la), calendar: la),
            "2026-01"
        )
    }

    func testOrderedWeekdaySymbolsRotateWithFirstWeekday() {
        let sundayFirst = CalendarLogic.orderedWeekdaySymbols(calendar: la)
        let mondayFirst = CalendarLogic.orderedWeekdaySymbols(calendar: laMondayFirst)
        XCTAssertEqual(sundayFirst.count, 7)
        XCTAssertEqual(Array(sundayFirst.dropFirst()) + [sundayFirst[0]], mondayFirst)
    }

    // MARK: - Task bucketing

    func testDueDateOnlyTaskBucketsToItsLocalDay() {
        let buckets = CalendarLogic.bucketTasks([task(id: "a", due: "2026-08-09")], calendar: la)
        XCTAssertEqual(buckets["2026-08-09"]?.count, 1)
        XCTAssertEqual(buckets["2026-08-09"]?.first?.kind, .due)
        XCTAssertEqual(buckets["2026-08-09"]?.first?.hasTime, false)
    }

    func testStartAndDueEmitTwoItems() {
        let buckets = CalendarLogic.bucketTasks(
            [task(id: "a", due: "2026-08-12", start: "2026-08-09")], calendar: la
        )
        XCTAssertEqual(buckets["2026-08-09"]?.map(\.kind), [.start])
        XCTAssertEqual(buckets["2026-08-12"]?.map(\.kind), [.due])
    }

    func testSameDayEndIsSuppressedDifferentDayEndEmits() {
        // Same local day as start → duration detail, no separate chip.
        let sameDay = CalendarLogic.bucketTasks(
            [task(id: "a", start: "2026-08-09T09:00:00", end: "2026-08-09T11:00:00")], calendar: la
        )
        XCTAssertEqual(sameDay["2026-08-09"]?.map(\.kind), [.start])
        // Later day → its own "Ends" item.
        let crossDay = CalendarLogic.bucketTasks(
            [task(id: "b", start: "2026-08-09T09:00:00", end: "2026-08-10T11:00:00")], calendar: la
        )
        XCTAssertEqual(crossDay["2026-08-09"]?.map(\.kind), [.start])
        XCTAssertEqual(crossDay["2026-08-10"]?.map(\.kind), [.end])
    }

    func testDoneTasksAreExcluded() {
        let buckets = CalendarLogic.bucketTasks(
            [task(id: "a", due: "2026-08-09", status: "done")], calendar: la
        )
        XCTAssertTrue(buckets.isEmpty)
    }

    func testZuluDueDateBucketsToLocalDayNotUTCDay() {
        // 05:00Z on the 10th is still the evening of the 9th in LA.
        let buckets = CalendarLogic.bucketTasks(
            [task(id: "a", due: "2026-08-10T05:00:00Z")], calendar: la
        )
        XCTAssertEqual(buckets["2026-08-09"]?.count, 1)
        XCTAssertNil(buckets["2026-08-10"])
    }

    func testDayBucketOrderingAllDayFirstThenClockTime() {
        let buckets = CalendarLogic.bucketTasks([
            task(id: "late", due: "2026-08-09T17:00:00"),
            task(id: "allday", due: "2026-08-09"),
            task(id: "early", due: "2026-08-09T08:00:00"),
        ], calendar: la)
        XCTAssertEqual(buckets["2026-08-09"]?.map(\.task.id), ["allday", "early", "late"])
    }

    func testTasksWithoutDatesNeverAppear() {
        let buckets = CalendarLogic.bucketTasks([task(id: "a")], calendar: la)
        XCTAssertTrue(buckets.isEmpty)
    }

    // MARK: - Event bucketing

    private func event(
        id: String, start: String, end: String, allDay: Bool = false, title: String? = nil
    ) -> DeviceCalendarEvent {
        DeviceCalendarEvent(
            id: id, title: title ?? "Event \(id)",
            start: date(start, la), end: date(end, la), isAllDay: allDay,
            colorRed: nil, colorGreen: nil, colorBlue: nil, calendarTitle: nil
        )
    }

    func testSingleDayEventBucketsOnce() {
        let buckets = CalendarLogic.bucketEvents(
            [event(id: "e", start: "2026-08-09T10:00:00", end: "2026-08-09T11:00:00")], calendar: la
        )
        XCTAssertEqual(buckets.keys.sorted(), ["2026-08-09"])
    }

    func testMultiDayEventFansOutToEverySpannedDay() {
        let buckets = CalendarLogic.bucketEvents(
            [event(id: "e", start: "2026-08-09T22:00:00", end: "2026-08-11T09:00:00")], calendar: la
        )
        XCTAssertEqual(buckets.keys.sorted(), ["2026-08-09", "2026-08-10", "2026-08-11"])
    }

    func testEventEndingExactlyAtMidnightDoesNotBleedIntoNextDay() {
        // 10pm–midnight: midnight belongs to the NEXT day's key, but the
        // event is over the instant that day starts.
        let buckets = CalendarLogic.bucketEvents(
            [event(id: "e", start: "2026-08-09T22:00:00", end: "2026-08-10T00:00:00")], calendar: la
        )
        XCTAssertEqual(buckets.keys.sorted(), ["2026-08-09"])
    }

    func testEventSpanningDSTTransitionCoversBothDays() {
        // Crosses the Nov 1, 2026 fall-back (25h day) — day walk must not
        // get stuck or skip.
        let buckets = CalendarLogic.bucketEvents(
            [event(id: "e", start: "2026-10-31T23:00:00", end: "2026-11-01T03:00:00")], calendar: la
        )
        XCTAssertEqual(buckets.keys.sorted(), ["2026-10-31", "2026-11-01"])
    }

    func testCorruptEventSpanIsCapped() {
        // A year-long (or corrupt) span must not build 365 buckets.
        let buckets = CalendarLogic.bucketEvents(
            [event(id: "e", start: "2026-01-01T00:00:00", end: "2027-01-01T00:00:00")], calendar: la
        )
        XCTAssertLessThanOrEqual(buckets.count, 63)
    }

    // MARK: - Agenda merge

    func testAgendaMergeOrdersAllDayEventsThenTasksThenTimedByClock() {
        let dayTasks = CalendarLogic.bucketTasks([
            task(id: "timed", due: "2026-08-09T10:00:00"),
            task(id: "allday", due: "2026-08-09"),
        ], calendar: la)["2026-08-09"] ?? []
        let events = [
            event(id: "morning", start: "2026-08-09T09:00:00", end: "2026-08-09T09:30:00"),
            event(id: "holiday", start: "2026-08-09", end: "2026-08-09T23:00:00", allDay: true),
        ]
        let rows = CalendarLogic.agendaRows(tasks: dayTasks, events: events)
        XCTAssertEqual(rows.map(\.id), [
            "event-holiday",     // all-day event leads
            "task-due:allday",   // all-day task follows
            "event-morning",     // 09:00
            "task-due:timed",    // 10:00
        ])
    }

    func testAgendaTimedTieBreaksTaskBeforeEvent() {
        let dayTasks = CalendarLogic.bucketTasks(
            [task(id: "t", due: "2026-08-09T09:00:00")], calendar: la
        )["2026-08-09"] ?? []
        let events = [event(id: "e", start: "2026-08-09T09:00:00", end: "2026-08-09T10:00:00")]
        let rows = CalendarLogic.agendaRows(tasks: dayTasks, events: events)
        XCTAssertEqual(rows.map(\.id), ["task-due:t", "event-e"])
    }

    func testAgendaEmptyInputsProduceEmptyRows() {
        XCTAssertTrue(CalendarLogic.agendaRows(tasks: [], events: []).isEmpty)
    }
}
