import XCTest
@testable import Walnut

/// UNIT layer (mock-gradient ladder, layer 1) for the Apple-style multi-view
/// calendar: the LAYOUT MATH — time → vertical offset, cross-day clipping,
/// overlap lane packing, week/page paging, and the view-mode state machine.
/// Driven with FIXED time zones and locales, so DST days and Monday-first weeks
/// are asserted without a simulator or the device clock.
final class CalendarLayoutTests: XCTestCase {

    /// America/Los_Angeles, Sunday-first (en_US) — the primary user's setup.
    private var la: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        c.locale = Locale(identifier: "en_US_POSIX")
        c.firstWeekday = 1
        return c
    }

    private var laMondayFirst: Calendar {
        var c = la
        c.firstWeekday = 2
        return c
    }

    private func date(_ iso: String, _ calendar: Calendar? = nil) -> Date {
        let cal = calendar ?? la
        guard let parsed = CalendarLogic.parseTaskDate(iso, calendar: cal) else {
            XCTFail("fixture date failed to parse: \(iso)")
            return Date(timeIntervalSince1970: 0)
        }
        return parsed.date
    }

    // MARK: - minutesIntoDay

    func testMinutesIntoDayIsWallClockBased() {
        XCTAssertEqual(CalendarLayout.minutesIntoDay(
            date("2026-08-09T00:00:00"), day: date("2026-08-09"), calendar: la
        ), 0)
        XCTAssertEqual(CalendarLayout.minutesIntoDay(
            date("2026-08-09T09:30:00"), day: date("2026-08-09"), calendar: la
        ), 570)
        XCTAssertEqual(CalendarLayout.minutesIntoDay(
            date("2026-08-09T23:59:00"), day: date("2026-08-09"), calendar: la
        ), 1439)
    }

    func testMinutesIntoDayClampsOutsideTheDay() {
        let day = date("2026-08-09")
        // Before midnight → pinned to the top of the column.
        XCTAssertEqual(CalendarLayout.minutesIntoDay(date("2026-08-08T22:00:00"), day: day, calendar: la), 0)
        // Next midnight and beyond → the full column height.
        XCTAssertEqual(CalendarLayout.minutesIntoDay(date("2026-08-10T00:00:00"), day: day, calendar: la), 1440)
        XCTAssertEqual(CalendarLayout.minutesIntoDay(date("2026-08-11T05:00:00"), day: day, calendar: la), 1440)
    }

    func testSpringForwardKeepsWallClockGridlines() {
        // March 8, 2026 is a 23-hour day in LA (2 AM → 3 AM). Elapsed-seconds
        // math would place 3 PM at minute 780 (the 1 PM line); wall-clock math
        // keeps it on the 3 PM line at 900.
        let day = date("2026-03-08")
        XCTAssertEqual(CalendarLayout.minutesIntoDay(date("2026-03-08T15:00:00"), day: day, calendar: la), 900)
        // The skipped hour reads as an empty band, not a shift: 1 AM and 3 AM
        // are still 120 minutes apart on the grid.
        let oneAM = CalendarLayout.minutesIntoDay(date("2026-03-08T01:00:00"), day: day, calendar: la)
        let threeAM = CalendarLayout.minutesIntoDay(date("2026-03-08T03:00:00"), day: day, calendar: la)
        XCTAssertEqual(threeAM - oneAM, 120)
    }

    func testFallBackKeepsWallClockGridlines() {
        // November 1, 2026 is a 25-hour day in LA (1 AM repeats).
        let day = date("2026-11-01")
        XCTAssertEqual(CalendarLayout.minutesIntoDay(date("2026-11-01T15:00:00"), day: day, calendar: la), 900)
        // The last minute of the day still fits inside one column.
        XCTAssertLessThanOrEqual(
            CalendarLayout.minutesIntoDay(date("2026-11-01T23:30:00"), day: day, calendar: la),
            CalendarLayout.minutesPerDay
        )
    }

    // MARK: - nowMinutes (the red line)

    func testNowLineOnlyAppearsOnItsOwnDay() {
        let now = date("2026-08-09T14:15:00")
        XCTAssertEqual(CalendarLayout.nowMinutes(now: now, day: date("2026-08-09"), calendar: la), 855)
        XCTAssertNil(CalendarLayout.nowMinutes(now: now, day: date("2026-08-10"), calendar: la))
        XCTAssertNil(CalendarLayout.nowMinutes(now: now, day: date("2026-08-08"), calendar: la))
    }

    func testNowLineRespectsTheCalendarsZone() {
        // 2026-08-10T05:00Z is 22:00 on the 9th in LA — the line belongs to the
        // 9th's column there, and to the 10th's in UTC.
        var utc = la
        utc.timeZone = TimeZone(identifier: "UTC")!
        let now = date("2026-08-10T05:00:00Z")
        XCTAssertNotNil(CalendarLayout.nowMinutes(now: now, day: date("2026-08-09"), calendar: la))
        XCTAssertNotNil(CalendarLayout.nowMinutes(now: now, day: date("2026-08-10", utc), calendar: utc))
    }

    // MARK: - clipToDay

    func testClipWithinOneDayHasNoContinuationFlags() {
        let bounds = CalendarLayout.clipToDay(
            start: date("2026-08-09T09:00:00"), end: date("2026-08-09T10:30:00"),
            day: date("2026-08-09"), calendar: la
        )
        XCTAssertEqual(bounds?.startMinutes, 540)
        XCTAssertEqual(bounds?.endMinutes, 630)
        XCTAssertEqual(bounds?.continuesBefore, false)
        XCTAssertEqual(bounds?.continuesAfter, false)
    }

    func testClipCrossDaySpanMarksContinuationOnBothSides() {
        let start = date("2026-08-09T22:00:00")
        let end = date("2026-08-11T09:00:00")
        // First day: starts at 22:00, runs off the bottom.
        let first = CalendarLayout.clipToDay(start: start, end: end, day: date("2026-08-09"), calendar: la)
        XCTAssertEqual(first?.startMinutes, 1320)
        XCTAssertEqual(first?.endMinutes, 1440)
        XCTAssertEqual(first?.continuesBefore, false)
        XCTAssertEqual(first?.continuesAfter, true)
        // Middle day: whole column, both flags set → an all-day banner.
        let middle = CalendarLayout.clipToDay(start: start, end: end, day: date("2026-08-10"), calendar: la)
        XCTAssertEqual(middle?.startMinutes, 0)
        XCTAssertEqual(middle?.endMinutes, 1440)
        XCTAssertEqual(middle?.continuesBefore, true)
        XCTAssertEqual(middle?.continuesAfter, true)
        XCTAssertEqual(middle?.coversWholeDay, true)
        // Last day: flat on top, ends at 09:00.
        let last = CalendarLayout.clipToDay(start: start, end: end, day: date("2026-08-11"), calendar: la)
        XCTAssertEqual(last?.startMinutes, 0)
        XCTAssertEqual(last?.endMinutes, 540)
        XCTAssertEqual(last?.continuesBefore, true)
        XCTAssertEqual(last?.continuesAfter, false)
    }

    func testClipReturnsNilForUntouchedDays() {
        let start = date("2026-08-09T09:00:00")
        let end = date("2026-08-09T10:00:00")
        XCTAssertNil(CalendarLayout.clipToDay(start: start, end: end, day: date("2026-08-08"), calendar: la))
        XCTAssertNil(CalendarLayout.clipToDay(start: start, end: end, day: date("2026-08-10"), calendar: la))
    }

    func testSpanEndingExactlyAtMidnightDoesNotBleedIntoNextDay() {
        // 10pm–midnight: fills the bottom of the 9th, absent from the 10th.
        let start = date("2026-08-09T22:00:00")
        let end = date("2026-08-10T00:00:00")
        XCTAssertEqual(
            CalendarLayout.clipToDay(start: start, end: end, day: date("2026-08-09"), calendar: la)?.endMinutes,
            1440
        )
        XCTAssertNil(CalendarLayout.clipToDay(start: start, end: end, day: date("2026-08-10"), calendar: la))
    }

    func testZeroLengthSpanStaysOnItsOwnDayAsAPoint() {
        let instant = date("2026-08-09T13:00:00")
        let bounds = CalendarLayout.clipToDay(start: instant, end: instant, day: date("2026-08-09"), calendar: la)
        XCTAssertEqual(bounds?.startMinutes, 780)
        XCTAssertEqual(bounds?.endMinutes, 780)
        XCTAssertNil(CalendarLayout.clipToDay(start: instant, end: instant, day: date("2026-08-10"), calendar: la))
    }

    func testClipHandlesInvertedSpans() {
        // A corrupt event whose end precedes its start must not vanish or crash.
        let bounds = CalendarLayout.clipToDay(
            start: date("2026-08-09T10:00:00"), end: date("2026-08-09T09:00:00"),
            day: date("2026-08-09"), calendar: la
        )
        XCTAssertNotNil(bounds)
        XCTAssertEqual(bounds?.startMinutes, 600)
        XCTAssertEqual(bounds?.endMinutes, 600)
    }

    // MARK: - packOverlaps

    private func pack(_ triples: [(String, Double, Double)]) -> [CalendarLayout.Packed] {
        CalendarLayout.packOverlaps(triples.map {
            CalendarLayout.Packable(id: $0.0, startMinutes: $0.1, endMinutes: $0.2)
        })
    }

    func testNonOverlappingItemsAreEachFullWidth() {
        let packed = pack([("a", 540, 600), ("b", 660, 720), ("c", 780, 840)])
        XCTAssertEqual(packed.map(\.id), ["a", "b", "c"])
        XCTAssertTrue(packed.allSatisfy { $0.columnCount == 1 && $0.column == 0 })
    }

    func testTwoOverlappingItemsSplitIntoTwoColumns() {
        let packed = pack([("a", 540, 660), ("b", 600, 720)])
        XCTAssertEqual(packed.map(\.columnCount), [2, 2])
        XCTAssertEqual(packed.map(\.column), [0, 1])
    }

    func testThreeWayOverlapUsesThreeColumns() {
        let packed = pack([("a", 540, 720), ("b", 560, 700), ("c", 580, 690)])
        XCTAssertEqual(Set(packed.map(\.columnCount)), [3])
        XCTAssertEqual(packed.map(\.column).sorted(), [0, 1, 2])
    }

    func testLaneIsReusedOnceItsItemHasEnded() {
        // a covers the whole window; b then c fit one after another in lane 1.
        let packed = pack([("a", 540, 780), ("b", 550, 640), ("c", 650, 740)])
        let byId = Dictionary(uniqueKeysWithValues: packed.map { ($0.id, $0) })
        XCTAssertEqual(byId["a"]?.columnCount, 2, "two lanes suffice — b and c never overlap")
        XCTAssertEqual(byId["a"]?.column, 0)
        XCTAssertEqual(byId["b"]?.column, 1)
        XCTAssertEqual(byId["c"]?.column, 1)
    }

    func testColumnCountIsPerClusterNotPerDay() {
        // A crowded morning must not shrink a lone afternoon event.
        let packed = pack([("m1", 540, 660), ("m2", 550, 670), ("afternoon", 840, 900)])
        let byId = Dictionary(uniqueKeysWithValues: packed.map { ($0.id, $0) })
        XCTAssertEqual(byId["m1"]?.columnCount, 2)
        XCTAssertEqual(byId["m2"]?.columnCount, 2)
        XCTAssertEqual(byId["afternoon"]?.columnCount, 1, "later lone event stays full width")
    }

    func testBackToBackItemsShareOneLane() {
        // Touching at a single instant is not an overlap.
        let packed = pack([("a", 540, 600), ("b", 600, 660)])
        XCTAssertTrue(packed.allSatisfy { $0.columnCount == 1 })
    }

    func testIdenticalSpansGetDistinctColumnsDeterministically() {
        let first = pack([("b", 540, 600), ("a", 540, 600)])
        let second = pack([("a", 540, 600), ("b", 540, 600)])
        XCTAssertEqual(first, second, "packing must not depend on input order")
        XCTAssertEqual(first.map(\.id), ["a", "b"])
        XCTAssertEqual(first.map(\.column), [0, 1])
    }

    func testLongerItemTakesTheLeftLaneOnATie() {
        // Apple keeps the longer of two same-start items on the left.
        let packed = pack([("short", 540, 570), ("long", 540, 720)])
        let byId = Dictionary(uniqueKeysWithValues: packed.map { ($0.id, $0) })
        XCTAssertEqual(byId["long"]?.column, 0)
        XCTAssertEqual(byId["short"]?.column, 1)
    }

    func testChainedOverlapsFormOneClusterNotTwo() {
        // a–b overlap, b–c overlap, a–c do not: still ONE cluster, and c reuses
        // a's lane because a has ended by then.
        let packed = pack([("a", 540, 620), ("b", 600, 700), ("c", 660, 760)])
        XCTAssertEqual(Set(packed.map(\.columnCount)), [2])
        let byId = Dictionary(uniqueKeysWithValues: packed.map { ($0.id, $0) })
        XCTAssertEqual(byId["a"]?.column, 0)
        XCTAssertEqual(byId["b"]?.column, 1)
        XCTAssertEqual(byId["c"]?.column, 0)
    }

    func testEmptyInputPacksToNothing() {
        XCTAssertTrue(CalendarLayout.packOverlaps([]).isEmpty)
    }

    // MARK: - Weeks and day stepping

    func testStartOfWeekHonorsFirstWeekday() {
        // Aug 12, 2026 is a Wednesday.
        XCTAssertEqual(
            CalendarLogic.dayKey(CalendarLayout.startOfWeek(containing: date("2026-08-12"), calendar: la), calendar: la),
            "2026-08-09" // Sunday
        )
        XCTAssertEqual(
            CalendarLogic.dayKey(
                CalendarLayout.startOfWeek(containing: date("2026-08-12"), calendar: laMondayFirst),
                calendar: laMondayFirst
            ),
            "2026-08-10" // Monday
        )
    }

    func testStartOfWeekIsIdempotentOnTheFirstDay() {
        let sunday = CalendarLayout.startOfWeek(containing: date("2026-08-12"), calendar: la)
        XCTAssertEqual(CalendarLayout.startOfWeek(containing: sunday, calendar: la), sunday)
    }

    func testWeekDaysAreSevenConsecutiveDays() {
        let days = CalendarLayout.weekDays(containing: date("2026-08-12"), calendar: la)
        XCTAssertEqual(days.map(\.dayKey), [
            "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12",
            "2026-08-13", "2026-08-14", "2026-08-15",
        ])
    }

    func testWeekPagingAcrossSpringForwardKeepsSevenDistinctDays() {
        // The week containing the 23-hour day (March 8, 2026).
        let days = CalendarLayout.weekDays(containing: date("2026-03-10"), calendar: la)
        XCTAssertEqual(days.count, 7)
        XCTAssertEqual(Set(days.map(\.dayKey)).count, 7)
        XCTAssertTrue(days.map(\.dayKey).contains("2026-03-08"))
        // Next week is exactly 7 later, DST notwithstanding.
        let next = CalendarLayout.addWeeks(1, to: date("2026-03-10"), calendar: la)
        XCTAssertEqual(CalendarLogic.dayKey(next, calendar: la), "2026-03-17")
    }

    func testWeekPagingAcrossFallBackKeepsSevenDistinctDays() {
        let days = CalendarLayout.weekDays(containing: date("2026-11-03"), calendar: la)
        XCTAssertEqual(Set(days.map(\.dayKey)).count, 7)
        XCTAssertTrue(days.map(\.dayKey).contains("2026-11-01"))
    }

    func testAddDaysWalksEveryDayAcrossDSTExactlyOnce() {
        var keys: [String] = []
        var cursor = date("2026-03-05")
        for _ in 0..<10 {
            keys.append(CalendarLogic.dayKey(cursor, calendar: la))
            cursor = CalendarLayout.addDays(1, to: cursor, calendar: la)
        }
        XCTAssertEqual(Set(keys).count, 10, "no skipped or duplicated day around DST")
        XCTAssertTrue(keys.contains("2026-03-08"))
    }

    func testDayOffsetCountsDSTDaysAsOneDay() {
        XCTAssertEqual(
            CalendarLayout.dayOffset(from: date("2026-03-07"), to: date("2026-03-09"), calendar: la), 2
        )
        XCTAssertEqual(
            CalendarLayout.dayOffset(from: date("2026-11-01"), to: date("2026-10-31"), calendar: la), -1
        )
        XCTAssertEqual(
            CalendarLayout.dayOffset(from: date("2026-08-09T23:00:00"), to: date("2026-08-10T01:00:00"), calendar: la),
            1, "offsets are between local midnights, not elapsed hours"
        )
    }

    func testDayRangeMarksSpillDaysOfAnotherMonth() {
        // A 2-day page straddling the month boundary dims the spill day.
        let days = CalendarLayout.dayRange(startingAt: date("2026-08-31"), count: 2, calendar: la)
        XCTAssertEqual(days.map(\.dayKey), ["2026-08-31", "2026-09-01"])
        XCTAssertEqual(days.map(\.inMonth), [true, false])
    }

    func testDayRangeRejectsNonPositiveCounts() {
        XCTAssertTrue(CalendarLayout.dayRange(startingAt: date("2026-08-09"), count: 0, calendar: la).isEmpty)
        XCTAssertTrue(CalendarLayout.dayRange(startingAt: date("2026-08-09"), count: -3, calendar: la).isEmpty)
    }

    // MARK: - Pager math

    func testFloorDivRoundsTowardNegativeInfinity() {
        // Truncating division would map -1 and 1 to the same page.
        XCTAssertEqual(CalendarLayout.floorDiv(-1, 2), -1)
        XCTAssertEqual(CalendarLayout.floorDiv(1, 2), 0)
        XCTAssertEqual(CalendarLayout.floorDiv(-2, 2), -1)
        XCTAssertEqual(CalendarLayout.floorDiv(-3, 2), -2)
        XCTAssertEqual(CalendarLayout.floorDiv(4, 2), 2)
    }

    func testSingleDayPagerGivesEachDayItsOwnPage() {
        let epoch = date("2026-08-09")
        for offset in -3...3 {
            let day = CalendarLayout.addDays(offset, to: epoch, calendar: la)
            XCTAssertEqual(
                CalendarLayout.pageIndex(for: day, dayCount: 1, epoch: epoch, calendar: la), offset
            )
        }
    }

    func testMultiDayPagerGroupsTwoDaysPerPageInBothDirections() {
        let epoch = date("2026-08-09")
        let expected: [Int: Int] = [-4: -2, -3: -2, -2: -1, -1: -1, 0: 0, 1: 0, 2: 1, 3: 1]
        for (offset, page) in expected {
            let day = CalendarLayout.addDays(offset, to: epoch, calendar: la)
            XCTAssertEqual(
                CalendarLayout.pageIndex(for: day, dayCount: 2, epoch: epoch, calendar: la), page,
                "day offset \(offset)"
            )
        }
    }

    func testPageDaysMatchTheirPageIndexRoundTrip() {
        let epoch = date("2026-08-09")
        for page in -2...2 {
            let days = CalendarLayout.pageDays(pageIndex: page, dayCount: 2, epoch: epoch, calendar: la)
            XCTAssertEqual(days.count, 2)
            for day in days {
                XCTAssertEqual(
                    CalendarLayout.pageIndex(for: day.date, dayCount: 2, epoch: epoch, calendar: la), page
                )
            }
        }
    }

    func testPageDaysAcrossDSTStillSpanTwoDistinctDays() {
        let epoch = date("2026-03-07")
        let days = CalendarLayout.pageDays(pageIndex: 0, dayCount: 2, epoch: epoch, calendar: la)
        XCTAssertEqual(days.map(\.dayKey), ["2026-03-07", "2026-03-08"])
    }

    func testPagingForwardKeepsTheWeekdayOffsetInsideThePage() {
        // Selected the SECOND day of page 0; swiping right must land on the
        // second day of page 1, not snap back to its first.
        let epoch = date("2026-08-09")
        let selection = CalendarLayout.addDays(1, to: epoch, calendar: la)
        let next = CalendarLayout.selection(
            forPage: 1, dayCount: 2, epoch: epoch, currentSelection: selection, calendar: la
        )
        XCTAssertEqual(CalendarLogic.dayKey(next, calendar: la), "2026-08-12")
    }

    func testPagingBackwardKeepsTheWeekdayOffsetInsideThePage() {
        let epoch = date("2026-08-09")
        let selection = CalendarLayout.addDays(1, to: epoch, calendar: la)
        let prev = CalendarLayout.selection(
            forPage: -1, dayCount: 2, epoch: epoch, currentSelection: selection, calendar: la
        )
        XCTAssertEqual(CalendarLogic.dayKey(prev, calendar: la), "2026-08-08")
    }

    func testSelectionForCurrentPageIsUnchanged() {
        let epoch = date("2026-08-09")
        let selection = date("2026-08-10T15:00:00")
        let same = CalendarLayout.selection(
            forPage: 0, dayCount: 2, epoch: epoch, currentSelection: selection, calendar: la
        )
        // Normalized to midnight, but still the same day.
        XCTAssertEqual(CalendarLogic.dayKey(same, calendar: la), "2026-08-10")
        XCTAssertEqual(la.component(.hour, from: same), 0)
    }

    // MARK: - Hour labels

    func testHourLabelsAreTwentyFourAndLocaleFormatted() {
        let labels = CalendarLayout.hourLabels(calendar: la)
        XCTAssertEqual(labels.count, 24)
        XCTAssertEqual(Set(labels).count, 24, "no duplicate hour labels")
        // en_US_POSIX renders 12-hour with an AM/PM marker.
        XCTAssertTrue(labels[9].contains("9"))
        XCTAssertTrue(labels[15].contains("3"))
    }

    func testHourLabelsFollow24HourLocales() {
        var de = la
        de.locale = Locale(identifier: "de_DE")
        let labels = CalendarLayout.hourLabels(calendar: de)
        XCTAssertEqual(labels.count, 24)
        // 3 PM must read as 15 in a 24-hour locale, never as "3".
        XCTAssertTrue(labels[15].contains("15"), "got \(labels[15])")
    }
}
