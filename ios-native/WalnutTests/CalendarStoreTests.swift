import EventKit
import XCTest
@testable import Walnut

/// MOCK layer (mock-gradient ladder, layer 2): DeviceCalendarStore driven
/// through a scripted CalendarEventProvider — the real store logic (lazy
/// permission ask, denied degradation, per-month fetch + cache, day
/// bucketing) runs against fixture events, no real calendar access. Plus a
/// store-level task pass: fixture tasks straddling a month boundary flow
/// through the production bucketing exactly as CalendarTabView consumes it.
final class CalendarStoreTests: XCTestCase {

    private var la: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        c.locale = Locale(identifier: "en_US_POSIX")
        c.firstWeekday = 1
        return c
    }

    private func date(_ iso: String) -> Date {
        CalendarLogic.parseTaskDate(iso, calendar: la)!.date
    }

    // MARK: - Scripted provider (the EventKit seam)

    private final class ScriptedProvider: CalendarEventProvider, @unchecked Sendable {
        var status: EKAuthorizationStatus
        var grantOnRequest: Bool
        var fixtureEvents: [DeviceCalendarEvent]
        private(set) var requestCount = 0
        private(set) var fetchWindows: [(from: Date, to: Date)] = []

        init(status: EKAuthorizationStatus, grantOnRequest: Bool = true,
             events: [DeviceCalendarEvent] = []) {
            self.status = status
            self.grantOnRequest = grantOnRequest
            self.fixtureEvents = events
        }

        var authorizationStatus: EKAuthorizationStatus { status }

        func requestAccess() async -> Bool {
            requestCount += 1
            status = grantOnRequest ? .fullAccess : .denied
            return grantOnRequest
        }

        func events(from: Date, to: Date) -> [DeviceCalendarEvent] {
            fetchWindows.append((from, to))
            return fixtureEvents.filter { $0.start < to && $0.end > from }
        }
    }

    private func fixtureEvent(id: String, start: String, end: String, allDay: Bool = false) -> DeviceCalendarEvent {
        DeviceCalendarEvent(
            id: id, title: "Event \(id)", start: date(start), end: date(end),
            isAllDay: allDay, colorRed: nil, colorGreen: nil, colorBlue: nil,
            calendarTitle: "Fixture"
        )
    }

    // MARK: - Permission flow

    @MainActor
    func testUndeterminedAsksOnceAndGrants() async {
        let provider = ScriptedProvider(status: .notDetermined, grantOnRequest: true)
        let store = DeviceCalendarStore(provider: provider, calendar: la)
        XCTAssertEqual(store.access, .undetermined)
        await store.requestAccessIfNeeded()
        XCTAssertEqual(store.access, .granted)
        XCTAssertEqual(provider.requestCount, 1)
        // Second open: no re-ask.
        await store.requestAccessIfNeeded()
        XCTAssertEqual(provider.requestCount, 1)
    }

    @MainActor
    func testDeniedDegradesGracefullyAndNeverFetches() async {
        let provider = ScriptedProvider(status: .notDetermined, grantOnRequest: false)
        let store = DeviceCalendarStore(provider: provider, calendar: la)
        await store.requestAccessIfNeeded()
        XCTAssertEqual(store.access, .denied)
        // Fetching a month while denied is a hard no-op — the task layer
        // must keep working with zero events, zero provider calls.
        await store.loadMonth(containing: date("2026-08-15"))
        XCTAssertTrue(provider.fetchWindows.isEmpty)
        XCTAssertTrue(store.eventsByDay.isEmpty)
        XCTAssertTrue(store.events(on: "2026-08-15").isEmpty)
    }

    @MainActor
    func testPreDeniedStatusNeverAsksAgain() async {
        let provider = ScriptedProvider(status: .denied)
        let store = DeviceCalendarStore(provider: provider, calendar: la)
        XCTAssertEqual(store.access, .denied)
        await store.requestAccessIfNeeded()
        XCTAssertEqual(provider.requestCount, 0)
    }

    @MainActor
    func testWriteOnlyAccessTreatedAsDenied() {
        let provider = ScriptedProvider(status: .writeOnly)
        let store = DeviceCalendarStore(provider: provider, calendar: la)
        XCTAssertEqual(store.access, .denied)
    }

    // MARK: - Month fetch + cache

    @MainActor
    func testMonthFetchBucketsEventsByLocalDay() async {
        let provider = ScriptedProvider(status: .fullAccess, events: [
            fixtureEvent(id: "a", start: "2026-08-09T10:00:00", end: "2026-08-09T11:00:00"),
            fixtureEvent(id: "b", start: "2026-08-09T22:00:00", end: "2026-08-10T09:00:00"),
        ])
        let store = DeviceCalendarStore(provider: provider, calendar: la)
        await store.loadMonth(containing: date("2026-08-15"))
        XCTAssertEqual(store.events(on: "2026-08-09").map(\.id), ["a", "b"])
        XCTAssertEqual(store.events(on: "2026-08-10").map(\.id), ["b"])
        XCTAssertTrue(store.events(on: "2026-08-11").isEmpty)
    }

    @MainActor
    func testMonthFetchIsCachedPerMonth() async {
        let provider = ScriptedProvider(status: .fullAccess)
        let store = DeviceCalendarStore(provider: provider, calendar: la)
        await store.loadMonth(containing: date("2026-08-15"))
        await store.loadMonth(containing: date("2026-08-20")) // same month → cache hit
        XCTAssertEqual(provider.fetchWindows.count, 1)
        await store.loadMonth(containing: date("2026-09-01")) // new month → fetch
        XCTAssertEqual(provider.fetchWindows.count, 2)
    }

    @MainActor
    func testFetchWindowPadsMonthForGridSpillDays() async {
        // The Aug grid shows Jul 26–31 spill days; the window must cover them.
        let provider = ScriptedProvider(status: .fullAccess, events: [
            fixtureEvent(id: "spill", start: "2026-07-27T10:00:00", end: "2026-07-27T11:00:00"),
        ])
        let store = DeviceCalendarStore(provider: provider, calendar: la)
        await store.loadMonth(containing: date("2026-08-15"))
        XCTAssertEqual(provider.fetchWindows.count, 1)
        XCTAssertLessThanOrEqual(provider.fetchWindows[0].from, date("2026-07-26"))
        XCTAssertGreaterThanOrEqual(provider.fetchWindows[0].to, date("2026-09-06"))
        XCTAssertEqual(store.events(on: "2026-07-27").map(\.id), ["spill"])
    }

    @MainActor
    func testInvalidateDropsCacheAndRefetches() async {
        let provider = ScriptedProvider(status: .fullAccess, events: [
            fixtureEvent(id: "a", start: "2026-08-09T10:00:00", end: "2026-08-09T11:00:00"),
        ])
        let store = DeviceCalendarStore(provider: provider, calendar: la)
        await store.loadMonth(containing: date("2026-08-15"))
        XCTAssertFalse(store.events(on: "2026-08-09").isEmpty)
        store.invalidate()
        XCTAssertTrue(store.events(on: "2026-08-09").isEmpty)
        await store.loadMonth(containing: date("2026-08-15"))
        XCTAssertEqual(provider.fetchWindows.count, 2)
        XCTAssertFalse(store.events(on: "2026-08-09").isEmpty)
    }

    // MARK: - Store-level task pass (fixture tasks across a month boundary)

    private func fixtureTask(id: String, due: String? = nil, start: String? = nil) -> WalnutTask {
        WalnutTask(
            id: id, title: "Task \(id)", status: "todo", phase: "TODO",
            priority: "none", project: "", dueDate: due,
            createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: nil,
            startDate: start, endDate: nil
        )
    }

    func testTasksAcrossMonthBoundaryLandInBothMonthsGrids() {
        // Exactly what CalendarTabView renders: one buckets pass over the
        // whole store list; each month's grid picks its own days out of it.
        let tasks = [
            fixtureTask(id: "aug31", due: "2026-08-31"),
            fixtureTask(id: "sep1", due: "2026-09-01T09:00:00"),
            fixtureTask(id: "span", due: "2026-09-02", start: "2026-08-30"),
        ]
        let buckets = CalendarLogic.bucketTasks(tasks, calendar: la)
        XCTAssertEqual(buckets["2026-08-31"]?.map(\.task.id), ["aug31"])
        XCTAssertEqual(buckets["2026-09-01"]?.map(\.task.id), ["sep1"])
        XCTAssertEqual(buckets["2026-08-30"]?.map(\.kind), [.start])
        XCTAssertEqual(buckets["2026-09-02"]?.map(\.kind), [.due])

        // August grid: the Sep 1–5 spill cells still show the Sep days'
        // items because bucketing is grid-independent (keyed by day).
        let augWeeks = CalendarLogic.monthGrid(containing: date("2026-08-15"), calendar: la)
        let augKeys = Set(augWeeks.flatMap { $0 }.map(\.dayKey))
        XCTAssertTrue(augKeys.contains("2026-09-01"))
        XCTAssertNotNil(buckets["2026-09-01"])

        let sepWeeks = CalendarLogic.monthGrid(containing: date("2026-09-15"), calendar: la)
        let sepKeys = Set(sepWeeks.flatMap { $0 }.map(\.dayKey))
        XCTAssertTrue(sepKeys.contains("2026-08-31"))
        XCTAssertNotNil(buckets["2026-08-31"])
    }

    @MainActor
    func testTaskAndEventMergeForOneDayThroughStore() async {
        // End-to-end through the mock seam: scripted events + fixture tasks
        // merged for one day, exactly the agenda's data path.
        let provider = ScriptedProvider(status: .fullAccess, events: [
            fixtureEvent(id: "standup", start: "2026-08-09T09:00:00", end: "2026-08-09T09:15:00"),
        ])
        let store = DeviceCalendarStore(provider: provider, calendar: la)
        await store.loadMonth(containing: date("2026-08-09"))
        let taskBuckets = CalendarLogic.bucketTasks(
            [fixtureTask(id: "report", due: "2026-08-09T10:00:00")], calendar: la
        )
        let rows = CalendarLogic.agendaRows(
            tasks: taskBuckets["2026-08-09"] ?? [],
            events: store.events(on: "2026-08-09")
        )
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.first?.id, "event-standup") // 09:00 before 10:00
        XCTAssertEqual(rows.last?.id, "task-due:report")
    }
}
