import XCTest
@testable import Walnut

/// The Routines screen's grouping and one-line rows (RoutineGroups.swift), the
/// phone twin of the console's tests/web/routine-groups.test.ts: global first,
/// then projects by name; failing routines lead their group and nothing else
/// reorders; the row says how often and when next, or why it is quiet; the opened
/// row's facts, error and history; the editor's draft and the bodies it sends; and
/// the server's newer fields decode (an older server's row without them still does).
final class RoutineGroupsTests: XCTestCase {

    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return c
    }()

    private lazy var now: Date = calendar.date(from: DateComponents(year: 2026, month: 11, day: 4, hour: 10))!

    private func job(
        _ id: String, project: String? = nil, enabled: Bool = true,
        schedule: RoutineJob.Schedule = .init(kind: "every", expr: nil, tz: nil, everyMs: 300_000, at: nil),
        state: RoutineJob.State? = nil, check: RoutineJob.Check? = nil
    ) -> RoutineJob {
        RoutineJob(
            id: id, name: id, description: nil, enabled: enabled, schedule: schedule,
            executor: .init(type: "session"), state: state, check: check,
            owner: project.map { .init(taskId: "t-\(id)", title: "Task \(id)", project: $0) }
        )
    }

    private func state(nextIn seconds: Double? = nil, lastStatus: String? = nil, pausedAgo: Double? = nil,
                       errors: Int? = nil, checkOutcome: String? = nil) -> RoutineJob.State {
        let ms = now.timeIntervalSince1970 * 1000
        var s = RoutineJob.State(
            nextRunAtMs: seconds.map { ms + $0 * 1000 }, lastRunAtMs: nil,
            lastStatus: lastStatus, lastError: nil, lastDurationMs: nil
        )
        s.pausedAtMs = pausedAgo.map { ms - $0 * 1000 }
        s.consecutiveErrors = errors
        s.lastCheck = checkOutcome.map { .init(atMs: ms, outcome: $0, error: nil) }
        return s
    }

    func testGlobalFirstThenProjectsByName() {
        let groups = RoutineGroups.groups([
            job("w1", project: "Walnut"), job("a1", project: "acme"), job("g1"),
            job("inbox", project: ""), job("w2", project: "Walnut"), job("m1", project: "Marina"),
        ])
        XCTAssertEqual(groups.map(\.id), ["global", "project:acme", "project:Marina", "project:Walnut"])
        XCTAssertEqual(groups.map(\.name), ["Global", "acme", "Marina", "Walnut"])
        XCTAssertEqual(groups[0].routines.map(\.id), ["g1", "inbox"])
        XCTAssertEqual(groups[3].routines.map(\.id), ["w1", "w2"])
        XCTAssertTrue(groups[0].isGlobal)
    }

    func testFailingRoutinesLeadTheirGroup() {
        let check = RoutineJob.Check(run: "x", host: "h")
        let groups = RoutineGroups.groups([
            job("b-ok", project: "P"),
            job("c-fail", project: "P", state: state(lastStatus: "error")),
            job("a-off", project: "P", enabled: false, state: state(pausedAgo: 60)),
            job("d-check", project: "P", state: state(checkOutcome: "error"), check: check),
            job("e-stopped", project: "P", enabled: false, state: state(errors: 5), check: check),
        ])
        XCTAssertEqual(groups[0].routines.map(\.id), ["c-fail", "d-check", "e-stopped", "a-off", "b-ok"])
        XCTAssertEqual(groups[0].failing, 3)
        XCTAssertEqual(RoutineGroups.healthLabel(groups[0].routines[2]), "Stopped")
        XCTAssertEqual(RoutineGroups.health(groups[0].routines[3]), .off)
    }

    func testSwitchingKeepsTheRowInPlace() {
        let jobs = [job("a"), job("b"), job("c")]
        let off = jobs.map { $0.id == "b" ? $0.switched(false, atMs: 1) : $0 }
        XCTAssertEqual(RoutineGroups.groups(off)[0].routines.map(\.id), RoutineGroups.groups(jobs)[0].routines.map(\.id))
        XCTAssertEqual(off[1].state?.pausedAtMs, 1)
        XCTAssertNil(off[1].switched(true, atMs: 2).state?.pausedAtMs)
    }

    /// For the whole visit, a refresh, a run or a switch that turns a routine failing
    /// (or calm) does not move it; a newcomer goes after the rows already shown.
    func testShownRowsKeepTheirPlaceForTheVisit() {
        let calm = [job("a", project: "P"), job("b", project: "P"), job("c", project: "P")]
        let shown = RoutineGroups.shownOrder(RoutineGroups.groups(calm))
        let failed = calm.map { $0.id == "c" ? job("c", project: "P", state: state(lastStatus: "error")) : $0 } + [job("d", project: "P")]
        XCTAssertEqual(RoutineGroups.groups(failed)[0].routines.map(\.id), ["c", "a", "b", "d"])
        XCTAssertEqual(RoutineGroups.keepingOrder(RoutineGroups.groups(failed), shown: shown)[0].routines.map(\.id),
                       ["a", "b", "c", "d"], "the shown rows keep their places; a newcomer goes after them")
        // Pausing a failing routine (error → off) leaves it where it was shown, first.
        let first = [job("a", project: "P"), job("z", project: "P", state: state(lastStatus: "error"))]
        let firstShown = RoutineGroups.shownOrder(RoutineGroups.groups(first))
        XCTAssertEqual(firstShown["project:P"], ["z", "a"], "the first load puts the failing one first")
        let paused = first.map { $0.id == "z" ? $0.switched(false, atMs: 1) : $0 }
        XCTAssertEqual(RoutineGroups.keepingOrder(RoutineGroups.groups(paused), shown: firstShown)[0].routines.map(\.id), ["z", "a"])
        XCTAssertEqual(RoutineGroups.keepingOrder(RoutineGroups.groups(paused), shown: [:])[0].routines.map(\.id), ["a", "z"],
                       "with nothing shown yet, the usual order")
        // A newcomer that is failing leads its group (the header counts it); others follow.
        let arrived = calm + [job("e", project: "P"), job("f", project: "P", state: state(lastStatus: "error"))]
        XCTAssertEqual(RoutineGroups.keepingOrder(RoutineGroups.groups(arrived), shown: shown)[0].routines.map(\.id),
                       ["f", "a", "b", "c", "e"])
    }

    /// A one-day-of-the-month cron in words; a one-time routine never says its time twice.
    func testMonthlyAndOneTime() {
        XCTAssertEqual(RoutineGroups.cadence(cron("0 9 1 * *"), calendar: calendar), "Monthly on the 1st at \(t(at(5, 9)))")
        XCTAssertEqual(RoutineGroups.cadence(cron("30 8 22 * *"), calendar: calendar), "Monthly on the 22nd at \(t(at(5, 8, 30)))")
        XCTAssertEqual(RoutineGroups.cadence(cron("0 9 13 * *"), calendar: calendar), "Monthly on the 13th at \(t(at(5, 9)))")
        XCTAssertEqual(RoutineGroups.cadence(cron("0 9 1 * 1"), calendar: calendar), "At \(t(at(5, 9))) on the 1st and on Mondays",
                       "a day of the month and of the week: either runs it")
        XCTAssertEqual(RoutineGroups.cadence(cron("0 9 1 * 1"), raw: true, calendar: calendar), "At \(t(at(5, 9))) on the 1st and on Mondays")
        XCTAssertEqual(RoutineGroups.cadence(cron("0 9 1,15 * *"), calendar: calendar), "At \(t(at(5, 9))) on the 1st and 15th")
        XCTAssertEqual(timing(cron("0 9 1 * *"), next: at(5, 9)), "Monthly on the 1st at \(t(at(5, 9))) · tomorrow")
        XCTAssertEqual(RoutineGroups.ordinal(2), "2nd")
        XCTAssertEqual(RoutineGroups.ordinal(3), "3rd")
        XCTAssertEqual(RoutineGroups.ordinal(11), "11th")
        XCTAssertEqual(RoutineGroups.ordinal(31), "31st")
        let once = RoutineJob.Schedule(kind: "at", expr: nil, tz: nil, everyMs: nil, at: "2026-11-07T11:45:00.000Z")
        let row = timing(once, next: at(7, 3, 45))
        XCTAssertTrue(row.hasPrefix("Once at "), row)
        XCTAssertFalse(row.contains("·"), "a one-time routine's line says its moment once: \(row)")
        let oneTime = job("o", schedule: once, state: state(nextIn: at(7, 3, 45).timeIntervalSince(now)))
        XCTAssertFalse(RoutineGroups.whenFact(oneTime, now: now, calendar: calendar).contains("Next run"))
    }

    /// A 200 from Run Now can be a refusal: the phone says why, never "Started".
    func testRunResultRefusal() throws {
        func result(_ json: String) throws -> RoutineRunResult? {
            try JSONDecoder().decode(RoutineRunEnvelope.self, from: Data(json.utf8)).result
        }
        XCTAssertEqual(try result(#"{"result":{"status":"error","error":"daemon on devbox refused triggers.run"}}"#)?.refusal,
                       "daemon on devbox refused triggers.run")
        XCTAssertEqual(try result(#"{"result":{"status":"error"}}"#)?.refusal, "The run did not start.")
        XCTAssertEqual(try result(#"{"result":{"ok":true,"ran":false,"reason":"already-running"}}"#)?.refusal, "It is already running.")
        XCTAssertNil(try result(#"{"result":{"ok":true,"ran":true}}"#)?.refusal)
        XCTAssertNil(try result(#"{"result":{"status":"ok","host":"devbox","ran":true}}"#)?.refusal)
        XCTAssertNil(try result(#"{"result":"queued"}"#)?.refusal, "another shape reads as started")
        XCTAssertNil(try result(#"{"ok":true}"#)?.refusal)
    }

    private func at(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour, minute: minute))!
    }

    private func t(_ date: Date) -> String { RoutineGroups.timeText(date, calendar: calendar) }

    private func cron(_ expr: String, tz: String? = nil) -> RoutineJob.Schedule {
        .init(kind: "cron", expr: expr, tz: tz, everyMs: nil, at: nil)
    }

    private func every(_ ms: Double) -> RoutineJob.Schedule {
        .init(kind: "every", expr: nil, tz: nil, everyMs: ms, at: nil)
    }

    private func timing(_ schedule: RoutineJob.Schedule, next: Date, check: RoutineJob.Check? = nil) -> String {
        RoutineGroups.rowTiming(job("a", schedule: schedule, state: state(nextIn: next.timeIntervalSince(now)), check: check),
                                now: now, calendar: calendar)
    }

    func testRowTimingMinutesAway() {
        XCTAssertEqual(RoutineGroups.rowTiming(job("a", state: state(nextIn: 180)), now: now, calendar: calendar),
                       "Every 5 min · next in 3 min")
        XCTAssertEqual(RoutineGroups.rowTiming(job("a", state: state(nextIn: 20), check: .init(run: "x", host: "h")), now: now, calendar: calendar),
                       "Checks every 5 min · next in <1 min")
        XCTAssertEqual(timing(cron("30 17 * * *"), next: now.addingTimeInterval(1200)),
                       "Every day at \(t(at(4, 17, 30))) · next in 20 min", "a cron keeps its hour even minutes away")
    }

    /// 2026-11-04: a cron that says its hour keeps it, and the next run says only the day.
    func testCronThatNamesItsHourSaysOnlyTheDay() {
        XCTAssertEqual(timing(cron("0 9 * * 1-5"), next: at(5, 9)), "Weekdays at \(t(at(5, 9))) · tomorrow")
        XCTAssertEqual(timing(cron("30 17 * * *"), next: at(4, 17, 30)), "Every day at \(t(at(4, 17, 30))) · today")
        XCTAssertEqual(timing(cron("0 8 * * 1"), next: at(9, 8)), "Mondays at \(t(at(9, 8))) · in 5 days")
        XCTAssertEqual(timing(cron("0 8 * * 4"), next: at(12, 8)), "Thursdays at \(t(at(12, 8))) · on Nov 12")
        XCTAssertEqual(timing(cron("0 9 * * *", tz: "America/Los_Angeles"), next: at(5, 9)),
                       "Every day at \(t(at(5, 9))) · tomorrow", "the phone's own zone is not foreign")
    }

    /// A cadence without an hour (an interval, hourly, a raw expression, another zone's
    /// hour): the next run says its day and hour.
    func testCadenceWithoutAnHourSaysTheNextHour() {
        XCTAssertEqual(timing(every(7_200_000), next: at(4, 12, 9)), "Every 2 hours · next at \(t(at(4, 12, 9)))")
        XCTAssertEqual(timing(cron("15 * * * *"), next: at(4, 11, 15)), "Hourly at :15 · next at \(t(at(4, 11, 15)))")
        XCTAssertEqual(timing(every(21_600_000), next: at(5, 9)), "Every 6 hours · tomorrow at \(t(at(5, 9)))")
        XCTAssertEqual(timing(cron("0 8 * * 1,3"), next: at(9, 8)), "Mon/Wed at \(t(at(9, 8))) · in 5 days")
        XCTAssertEqual(timing(cron("*/30 9-17 * * *"), next: at(9, 9)),
                       "Every 30 min from \(t(at(4, 9))) to \(t(at(4, 17, 30))) · Mon at \(t(at(9, 9)))")
        XCTAssertEqual(timing(cron("0 9 1-7 * 1"), next: at(9, 9)), "At \(t(at(9, 9))) on days 1 to 7 of the month and on Mondays · in 5 days")
        XCTAssertEqual(timing(cron("0 9 L * *"), next: at(9, 9)), "Custom schedule · Mon at \(t(at(9, 9)))")
        XCTAssertEqual(timing(every(86_400_000 * 10), next: at(12, 8)), "Every 240 hours · on Nov 12")
        let utc = timing(cron("0 9 * * *", tz: "UTC"), next: at(5, 1))
        XCTAssertTrue(utc.hasSuffix(" · tomorrow at \(t(at(5, 1)))"), utc)
        XCTAssertTrue(utc.hasPrefix("Every day at "), utc)
        XCTAssertEqual(timing(every(300_000), next: at(4, 12, 9), check: .init(run: "x", host: "h")),
                       "Checks every 5 min · next at \(t(at(4, 12, 9)))")
    }

    /// Quiet rows say why in one word; "ago" and "after 5 failed checks" are the opened row's.
    func testQuietRows() {
        let check = RoutineJob.Check(run: "x", host: "h")
        let paused = job("p", enabled: false, state: state(pausedAgo: 40 * 60))
        XCTAssertEqual(RoutineGroups.rowTiming(paused, now: now, calendar: calendar), "Paused · Every 5 min")
        XCTAssertEqual(RoutineGroups.quietFact(paused, now: now), "Paused 40m ago")
        let off = job("o", enabled: false, schedule: cron("0 8 * * 1"))
        XCTAssertEqual(RoutineGroups.rowTiming(off, now: now, calendar: calendar), "Off · Mondays at \(t(at(9, 8)))")
        XCTAssertEqual(RoutineGroups.quietFact(off, now: now), "Off")
        let pausedTrigger = job("pt", enabled: false, state: state(pausedAgo: 60), check: check)
        XCTAssertEqual(RoutineGroups.rowTiming(pausedTrigger, now: now, calendar: calendar), "Paused · Checks every 5 min")
        let stopped = job("s", enabled: false, state: state(errors: 5), check: check)
        XCTAssertEqual(RoutineGroups.rowTiming(stopped, now: now, calendar: calendar), "Checks every 5 min",
                       "the red flag says Stopped; the line never says it twice")
        XCTAssertEqual(RoutineGroups.healthLabel(stopped), "Stopped")
        XCTAssertEqual(RoutineGroups.quietFact(stopped, now: now), "Stopped after 5 failed checks")
        XCTAssertNil(RoutineGroups.quietFact(job("on"), now: now))
    }

    /// The opened row's "When": the full cadence and the exact next run.
    func testWhenFact() {
        let weekdays = job("w", schedule: cron("0 9 * * 1-5"), state: state(nextIn: at(5, 9).timeIntervalSince(now)))
        XCTAssertEqual(RoutineGroups.whenFact(weekdays, now: now, calendar: calendar),
                       "Weekdays at \(t(at(5, 9)))\nNext run tomorrow at \(t(at(5, 9)))")
        let soon = job("s", schedule: every(7_200_000), state: state(nextIn: at(4, 12, 9).timeIntervalSince(now)))
        XCTAssertEqual(RoutineGroups.whenFact(soon, now: now, calendar: calendar),
                       "Every 2 hours\nNext run today at \(t(at(4, 12, 9)))")
        let monday = job("m", schedule: cron("0 8 * * 1"), state: state(nextIn: at(9, 8).timeIntervalSince(now)))
        XCTAssertEqual(RoutineGroups.whenFact(monday, now: now, calendar: calendar),
                       "Mondays at \(t(at(9, 8)))\nNext run Monday at \(t(at(9, 8)))")
        let far = job("f", schedule: cron("0 8 * * 4"), state: state(nextIn: at(12, 8).timeIntervalSince(now)))
        XCTAssertEqual(RoutineGroups.whenFact(far, now: now, calendar: calendar),
                       "Thursdays at \(t(at(12, 8)))\nNext run Nov 12 at \(t(at(12, 8)))")
        XCTAssertEqual(RoutineGroups.whenFact(job("i", state: state(nextIn: 300)), now: now, calendar: calendar),
                       "Every 5 min\nNext run in 5 min")
        let paused = job("p", enabled: false, state: state(nextIn: 300, pausedAgo: 60))
        XCTAssertEqual(RoutineGroups.whenFact(paused, now: now, calendar: calendar), "Every 5 min", "no next run while paused")
    }

    /// The error names its task by title, and a done task's error says what to do.
    func testErrorTextNamesTheTask() throws {
        var failing = job("r", project: "Home", state: RoutineJob.State(
            nextRunAtMs: nil, lastRunAtMs: nil, lastStatus: "error",
            lastError: "target task t-r is complete; the trigger will not resurrect it", lastDurationMs: nil
        ))
        let text = try XCTUnwrap(RoutineGroups.errorText(failing))
        XCTAssertEqual(text.message, "Its task \"Task r\" is complete, so its last run went nowhere.")
        XCTAssertEqual(text.nextStep, "Point it at an open task with Edit, or turn it off.")
        failing.owner = nil
        XCTAssertEqual(RoutineGroups.errorText(failing)?.message, "Its task is complete, so its last run went nowhere.",
                       "no owner: no id either, plain words")
        let other = RoutineJob(id: "x", name: "x", description: nil, enabled: true, schedule: every(60_000), executor: nil,
                               state: .init(nextRunAtMs: nil, lastRunAtMs: nil, lastStatus: "error", lastError: "exit 2", lastDurationMs: nil))
        XCTAssertEqual(RoutineGroups.errorText(other)?.message, "exit 2")
        XCTAssertNil(RoutineGroups.errorText(other)?.nextStep)
        XCTAssertNil(RoutineGroups.errorText(job("ok")))
    }

    // MARK: - History

    private typealias Entry = RoutineJob.State.AuditEntry

    /// Newest first by each row's own time, each fire once (from fireLog, which has
    /// its newest attempt), the console's auditHistory.
    func testAuditHistoryMergesAndOrders() {
        let ms = now.timeIntervalSince1970 * 1000
        var s = state()
        s.checkLog = [
            Entry(atMs: ms - 60_000, outcome: "quiet"),
            Entry(atMs: ms - 300_000, outcome: "fired", items: 1, seq: 3, epoch: "e", attempts: 1,
                  delivery: .init(status: "retrying")),
            Entry(atMs: ms - 30_000, outcome: "error", error: "exit 1"),
            Entry(atMs: ms - 300_000, outcome: "fired", items: 1, seq: 3, epoch: "e", attempts: 2,
                  delivery: .init(status: "retrying")),
        ]
        s.fireLog = [Entry(atMs: ms - 300_000, outcome: "fired", items: 1, seq: 3, epoch: "e", attempts: 3,
                           delivery: .init(status: "ok", summary: "Release watch"))]
        let rows = RoutineGroups.auditHistory(s)
        XCTAssertEqual(rows.map(\.outcome), ["error", "quiet", "fired"])
        XCTAssertEqual(rows[2].attempts, 3, "the fire is shown from fireLog")
        XCTAssertEqual(RoutineGroups.describeAuditEntry(rows[2]), "fired, 1 new item → Release watch after 3 tries")
        XCTAssertEqual(RoutineGroups.describeAuditEntry(rows[0]), "check error: exit 1")
        XCTAssertEqual(RoutineGroups.describeAuditEntry(rows[1]), "quiet: the script said no")
        XCTAssertTrue(RoutineGroups.auditFailed(rows[0]))
        XCTAssertFalse(RoutineGroups.auditFailed(rows[2]))

        var firesOnly = state()
        firesOnly.fireLog = [Entry(atMs: ms - 10, outcome: "fired", manual: true)]
        XCTAssertEqual(RoutineGroups.auditHistory(firesOnly).map { RoutineGroups.describeAuditEntry($0) }, ["run now"])
        XCTAssertTrue(RoutineGroups.auditHistory(state()).isEmpty)
        XCTAssertTrue(RoutineGroups.auditHistory(nil).isEmpty)
    }

    func testAuditWording() {
        XCTAssertEqual(RoutineGroups.describeAuditEntry(Entry(atMs: 0, outcome: "quiet", reason: "rate-limited")),
                       "held: fire budget used up, it fires on a later check")
        XCTAssertEqual(RoutineGroups.describeAuditEntry(Entry(atMs: 0, outcome: "quiet", reason: "all-seen")),
                       "quiet: nothing new (all items already seen)")
        XCTAssertEqual(RoutineGroups.describeAuditEntry(Entry(atMs: 0, outcome: "fired", items: 4, coalesced: 2)), "2 fires, 4 new items")
        XCTAssertEqual(RoutineGroups.describeAuditEntry(Entry(atMs: 0, outcome: "fired", delivery: .init(status: "retrying"))),
                       "fired → delivery retrying")
        XCTAssertEqual(RoutineGroups.describeAuditEntry(Entry(atMs: 0, outcome: "fired", items: 2, delivery: .init(status: "error", error: "session gone"))),
                       "fired, 2 new items → not delivered: session gone")
        XCTAssertEqual(RoutineGroups.describeAuditEntry(Entry(atMs: 0, outcome: "fired",
                                                             delivery: .init(status: "ok", summary: "Release — <walnut-message x>"))),
                       "fired → Release", "an old envelope summary is cut before its markup")
        XCTAssertEqual(RoutineGroups.describeAuditEntry(Entry(atMs: 0, outcome: "quiet", warnings: ["id"])),
                       "quiet: the script said no · output repaired")
        let check = job("c", check: .init(run: "x", host: "h"))
        XCTAssertEqual(RoutineGroups.historyTitle(check, count: 3), "History (3 recorded checks)")
        XCTAssertEqual(RoutineGroups.historyTitle(check, count: 1), "History (1 recorded check)")
        XCTAssertEqual(RoutineGroups.historyTitle(job("r"), count: 0), "History (0 recorded runs)")
        let ms = now.timeIntervalSince1970 * 1000
        XCTAssertEqual(RoutineGroups.auditClock(ms - 3_600_000, now: now, calendar: calendar), t(at(4, 9)))
        XCTAssertEqual(RoutineGroups.auditClock(ms - 86_400_000, now: now, calendar: calendar), "Nov 3 \(t(at(3, 10)))")
    }

    func testCheckAndLastCheckWording() {
        XCTAssertEqual(RoutineGroups.describeCheck(.init(run: "sh  check.sh\n--all", host: "devbox")), "$ sh check.sh --all @ devbox")
        XCTAssertEqual(RoutineGroups.describeCheck(.init(run: "sh c.sh", host: "__local__")), "$ sh c.sh @ local")
        let ms = now.timeIntervalSince1970 * 1000
        XCTAssertEqual(RoutineGroups.describeLastCheck(.init(atMs: ms - 180_000, outcome: "fired", error: nil, items: 2), now: now),
                       "3m ago · fired, 2 items")
        XCTAssertEqual(RoutineGroups.describeLastCheck(.init(atMs: ms - 120_000, outcome: "quiet", error: nil), now: now), "2m ago · nothing new")
        XCTAssertEqual(RoutineGroups.describeLastCheck(.init(atMs: ms - 120_000, outcome: "quiet", error: nil, reason: "rate-limited"), now: now),
                       "2m ago · held by the fire budget")
        XCTAssertEqual(RoutineGroups.describeLastCheck(.init(atMs: ms, outcome: "error", error: "exit 1"), now: now), "just now · failed: exit 1")
        XCTAssertEqual(RoutineGroups.describeLastCheck(nil, now: now), "Not checked yet")
    }

    // MARK: - What it sends, and the editor's draft

    func testWhatItSends() throws {
        let json = """
        { "jobs": [
          { "id": "a", "name": "a", "enabled": true, "schedule": { "kind": "every", "everyMs": 60000 },
            "executor": { "type": "session", "config": { "target": "t1", "prompt": "  Check the build  " } } },
          { "id": "b", "name": "b", "enabled": true, "schedule": { "kind": "every", "everyMs": 60000 },
            "executor": { "type": "main-agent", "config": { "instructions": "Brief me" } } },
          { "id": "c", "name": "c", "enabled": true, "schedule": { "kind": "every", "everyMs": 60000 },
            "executor": { "type": "legacy", "config": { "message": "Old text" } } },
          { "id": "d", "name": "d", "enabled": true, "schedule": { "kind": "every", "everyMs": 60000 } }
        ] }
        """
        let jobs = try JSONDecoder().decode(RoutinesResponse.self, from: Data(json.utf8)).jobs
        XCTAssertEqual(jobs.map { $0.executor?.sends }, ["Check the build", "Brief me", "Old text", nil])
        XCTAssertEqual(jobs[0].executor?.sendsKey, "prompt")
        XCTAssertEqual(jobs[1].executor?.sendsKey, "instructions")
        XCTAssertEqual(RoutineJob.Executor(type: "session").sendsKey, "prompt")
        XCTAssertEqual(RoutineJob.Executor(type: "claude-code").sendsKey, "instructions")
    }

    func testDraftReadsEachScheduleShape() {
        func draft(_ schedule: RoutineJob.Schedule, check: RoutineJob.Check? = nil) -> RoutineDraft {
            RoutineDraft(job: job("d", schedule: schedule, check: check), calendar: calendar)
        }
        XCTAssertEqual(draft(every(300_000)).repeatKind, .minutes)
        XCTAssertEqual(draft(every(300_000)).interval, 5)
        XCTAssertEqual(draft(every(7_200_000)).repeatKind, .hours)
        XCTAssertEqual(draft(every(7_200_000)).interval, 2)
        XCTAssertEqual(draft(every(5_400_000)).repeatKind, .minutes, "90 minutes is not whole hours")
        let daily = draft(cron("30 17 * * *"))
        XCTAssertEqual([daily.repeatKind.rawValue, "\(daily.hour)", "\(daily.minute)"], ["daily", "17", "30"])
        XCTAssertEqual(draft(cron("0 9 * * 1-5")).repeatKind, .weekdays)
        XCTAssertEqual(draft(cron("0 8 * * 1")).repeatKind, .weekly)
        XCTAssertEqual(draft(cron("0 8 * * 1")).weekday, 1)
        let odd = draft(cron("*/30 9-17 * * *"))
        XCTAssertEqual(odd.repeatKind, .cron, "a cron that fits no shape stays text")
        XCTAssertEqual(odd.cronExpr, "*/30 9-17 * * *")
        XCTAssertTrue(odd.repeatOptions().contains(.cron))
        XCTAssertEqual(draft(cron("0 9 * * *", tz: "UTC")).repeatKind, .cron, "another zone's hour stays text")
        XCTAssertFalse(RoutineDraft.new().repeatOptions().contains(.cron))
        let trigger = draft(every(300_000), check: .init(run: "sh c.sh", host: "h"))
        XCTAssertEqual(trigger.repeatOptions(), [.minutes, .hours], "a trigger polls on an interval")
        XCTAssertEqual(trigger.checkRun, "sh c.sh")
    }

    func testDraftValidation() {
        var draft = RoutineDraft.new()
        XCTAssertEqual(draft.problems, ["Give it a name.", "Say what it sends."])
        draft.name = "Stretch"
        draft.sends = "Stand up."
        XCTAssertTrue(draft.isValid)
        draft.repeatKind = .minutes
        draft.interval = 0
        XCTAssertEqual(draft.problems, ["The interval is at least 1 minute."])
        draft.interval = 1
        XCTAssertTrue(draft.isValid)
        draft.repeatKind = .cron
        draft.cronExpr = "0 9 * *"
        XCTAssertEqual(draft.problems, ["A cron expression has five fields (six or seven with seconds or a year)."])
        draft.cronExpr = "0 0 9 * * * 2027"
        XCTAssertTrue(draft.isValid, "a seven-field cron the server reads is not refused")
        var trigger = RoutineDraft(job: job("t", project: "P", check: .init(run: "sh c.sh", host: "h")), calendar: calendar)
        trigger.sends = "x"
        trigger.checkRun = "  "
        XCTAssertEqual(trigger.problems, ["A trigger needs its check command."])
    }

    func testCreateBody() {
        var draft = RoutineDraft.new()
        draft.name = " Stretch "
        draft.sends = "Stand up and stretch.\n"
        draft.repeatKind = .weekdays
        draft.hour = 15
        draft.minute = 5
        let body = draft.createBody(calendar: calendar)
        XCTAssertEqual(body["name"], .string("Stretch"))
        XCTAssertEqual(body["schedule"], .object(["kind": .string("cron"), "expr": .string("5 15 * * 1-5"),
                                                  "tz": .string("America/Los_Angeles")]))
        XCTAssertEqual(body["executor"], .object(["type": .string("main-agent"),
                                                  "config": .object(["instructions": .string("Stand up and stretch.")])]))
        draft.repeatKind = .hours
        draft.interval = 3
        XCTAssertEqual(draft.createBody(calendar: calendar)["schedule"], .object(["kind": .string("every"), "everyMs": .number(10_800_000)]))
    }

    /// An edit sends the name and only what changed; the executor and the check go back whole.
    func testPatchBodySendsWhatChanged() {
        var original = job("p", schedule: cron("0 9 * * 1-5"), check: .init(run: "sh c.sh", host: "devbox", maxFiresPerDay: 4, cwd: "/w", timeoutSeconds: 30))
        original = RoutineJob(id: original.id, name: "Old", description: nil, enabled: true, schedule: original.schedule,
                              executor: .init(type: "session", config: ["target": .string("t1"), "prompt": .string("Look")]),
                              state: nil, check: original.check, owner: nil)
        let initial = RoutineDraft(job: original, calendar: calendar)
        var draft = initial
        draft.name = "New"
        XCTAssertEqual(draft.patchBody(original: original, initial: initial, calendar: calendar), ["name": .string("New")])
        draft.sends = "Look again"
        draft.hour = 10
        draft.checkRun = "sh d.sh"
        let body = draft.patchBody(original: original, initial: initial, calendar: calendar)
        XCTAssertEqual(body["schedule"], .object(["kind": .string("cron"), "expr": .string("0 10 * * 1-5"),
                                                  "tz": .string("America/Los_Angeles")]))
        XCTAssertEqual(body["executor"], .object(["type": .string("session"),
                                                  "config": .object(["target": .string("t1"), "prompt": .string("Look again")])]))
        XCTAssertEqual(body["check"], .object(["run": .string("sh d.sh"), "host": .string("devbox"), "cwd": .string("/w"),
                                               "timeoutSeconds": .number(30), "maxFiresPerDay": .number(4)]))
    }

    func testOwnerAndTriggerFieldsDecode() throws {
        let json = """
        { "jobs": [
          { "id": "r1", "name": "Watch", "enabled": false,
            "schedule": { "kind": "every", "everyMs": 120000 },
            "executor": { "type": "session", "config": { "target": "t1" } },
            "check": { "run": "sh check.sh", "host": "devbox", "maxFiresPerDay": 12 },
            "state": { "consecutiveErrors": 5, "lastCheck": { "atMs": 1, "outcome": "error", "error": "exit 1" },
                       "checkLog": [ { "atMs": 2, "outcome": "quiet", "items": "two", "future": { "x": 1 } },
                                     { "atMs": 1, "outcome": "fired", "seq": 4, "delivery": { "status": "ok" } } ] },
            "owner": { "taskId": "t1", "title": "Release watch", "project": "Walnut" } },
          { "id": "r2", "name": "Old server row", "enabled": true,
            "schedule": { "kind": "cron", "expr": "0 9 * * *" } }
        ] }
        """
        let jobs = try JSONDecoder().decode(RoutinesResponse.self, from: Data(json.utf8)).jobs
        XCTAssertEqual(jobs[0].owner?.project, "Walnut")
        XCTAssertEqual(jobs[0].check?.maxFiresPerDay, 12)
        XCTAssertTrue(RoutineGroups.isStopped(jobs[0]))
        XCTAssertEqual(jobs[0].state?.checkLog?.count, 2, "an odd field costs only that field")
        XCTAssertNil(jobs[0].state?.checkLog?.first?.items)
        XCTAssertEqual(jobs[0].state?.checkLog?.last?.delivery?.status, "ok")
        // A row that is not even an object costs that list, not the routine or the list of routines.
        let odd = """
        { "jobs": [ { "id": "r3", "name": "Odd", "enabled": true, "schedule": { "kind": "every", "everyMs": 60000 },
                      "state": { "lastRunAtMs": 5, "checkLog": [ null, 3 ], "lastCheck": "soon" } } ] }
        """
        let oddJobs = try JSONDecoder().decode(RoutinesResponse.self, from: Data(odd.utf8)).jobs
        XCTAssertEqual(oddJobs.first?.state?.lastRunAtMs, 5)
        XCTAssertNil(oddJobs.first?.state?.checkLog)
        XCTAssertNil(oddJobs.first?.state?.lastCheck)
        XCTAssertNil(jobs[1].owner)
        XCTAssertEqual(RoutineGroups.groupKey(jobs[1]), RoutineGroups.globalKey)
    }

    // MARK: - Round 3: the Task, a refused action, what Run now said, the facts

    private func session(_ id: String, target: String?, owner: RoutineJob.Owner?, state: RoutineJob.State? = nil,
                         check: RoutineJob.Check? = nil) -> RoutineJob {
        var config: [String: JSONValue] = ["prompt": .string("Look"), "extra": .bool(true)]
        if let target { config["target"] = .string(target) }
        return RoutineJob(id: id, name: id, description: nil, enabled: true, schedule: every(300_000),
                          executor: .init(type: "session", config: config), state: state, check: check, owner: owner)
    }

    /// A session routine's Task: read from config.target, required, and saved by sending
    /// the executor back whole with only the target replaced.
    func testPatchBodySendsTheNewTask() {
        let original = session("r", target: "t-done", owner: .init(taskId: "t-done", title: "Old", project: "Home"))
        let initial = RoutineDraft(job: original, calendar: calendar)
        XCTAssertTrue(initial.canEditTarget)
        XCTAssertEqual(initial.target, "t-done")
        var draft = initial
        XCTAssertEqual(draft.patchBody(original: original, initial: initial, calendar: calendar), ["name": .string("r")],
                       "an untouched task sends no executor")
        draft.target = "t-open"
        let body = draft.patchBody(original: original, initial: initial, calendar: calendar)
        XCTAssertEqual(body["executor"], .object(["type": .string("session"), "config": .object([
            "target": .string("t-open"), "prompt": .string("Look"), "extra": .bool(true),
        ])]), "the executor goes back whole, its target replaced")
        XCTAssertNil(body["schedule"])
        // A new task and new words at once: both, in one executor.
        draft.sends = "Look again"
        XCTAssertEqual(draft.patchBody(original: original, initial: initial, calendar: calendar)["executor"],
                       .object(["type": .string("session"), "config": .object([
                           "target": .string("t-open"), "prompt": .string("Look again"), "extra": .bool(true),
                       ])]))
        draft.target = " "
        XCTAssertTrue(draft.problems.contains("Pick the task it runs in."))
        // No target in its config: the owner's task is the one it runs in.
        XCTAssertEqual(RoutineDraft(job: session("o", target: nil, owner: .init(taskId: "t-o", title: nil, project: nil)), calendar: calendar).target, "t-o")
        // Not a session routine: no Task at all.
        let other = RoutineDraft(job: RoutineJob(id: "m", name: "m", description: nil, enabled: true, schedule: every(60_000),
                                                 executor: .init(type: "main-agent", config: ["instructions": .string("x"), "target": .string("t")]),
                                                 state: nil), calendar: calendar)
        XCTAssertFalse(other.canEditTarget)
        XCTAssertEqual(other.target, "")
        XCTAssertFalse(other.problems.contains("Pick the task it runs in."))
    }

    /// The task search asks what the console asks, every value escaped whole.
    func testTaskSearchQuery() throws {
        XCTAssertEqual(WalnutAPI.routineTaskSearchPath(query: "  "),
                       "/api/tasks?completion=todo,in_progress&sort=updated_desc&fields=list&limit=8")
        XCTAssertEqual(WalnutAPI.routineTaskSearchPath(query: " a+b & c#1 "),
                       "/api/tasks?q=a%2Bb%20%26%20c%231&completion=todo,in_progress&sort=updated_desc&fields=list&limit=8")
        // Non-ASCII search text (test data): "caf\u{00E9}" is escaped, so the URL is valid.
        let accented = WalnutAPI.routineTaskSearchPath(query: "caf\u{00E9}")
        XCTAssertTrue(accented.hasPrefix("/api/tasks?q=caf%C3%A9&"), accented)
        XCTAssertNotNil(URL(string: "http://h" + accented))
        XCTAssertEqual(WalnutAPI.routineTaskLookupPath(id: "mw20-fcd9"), "/api/tasks?ids=mw20-fcd9&fields=list&limit=8")
        let json = #"{"tasks":[{"id":"a","title":"A","project":"Home","phase":"COMPLETE"},{"id":"b"},{"id":"c","title":"C","project":""}],"total":3}"#
        let tasks = try JSONDecoder().decode(RoutineTaskChoices.self, from: Data(json.utf8)).tasks
        XCTAssertEqual(tasks.map(\.id), ["a", "c"], "a row that does not decode costs that row")
        XCTAssertTrue(tasks[0].isComplete)
        XCTAssertEqual(tasks[0].place, "Home")
        XCTAssertEqual(tasks[1].place, "Inbox")
        XCTAssertEqual(try JSONDecoder().decode(RoutineTaskChoices.self, from: Data("{}".utf8)).tasks, [])
    }

    /// After a new task is picked, the old "complete" failure stops asking for Edit.
    func testErrorTextAfterThePersonPickedAnotherTask() throws {
        let failed = RoutineJob.State(nextRunAtMs: nil, lastRunAtMs: nil, lastStatus: "error",
                                      lastError: "target task t-done is complete; the trigger will not resurrect it", lastDurationMs: nil)
        let moved = session("r", target: "t-open", owner: .init(taskId: "t-open", title: "Router firmware", project: "Home"), state: failed)
        let text = try XCTUnwrap(RoutineGroups.errorText(moved))
        XCTAssertEqual(text.message, "Its last run failed: the task it ran in then was complete.")
        XCTAssertEqual(text.nextStep, "It runs in \"Router firmware\" from its next run.")
        let stillThere = session("r", target: "t-done", owner: .init(taskId: "t-done", title: "Old", project: "Home"), state: failed)
        XCTAssertEqual(RoutineGroups.errorText(stillThere)?.message, "Its task \"Old\" is complete, so its last run went nowhere.")
        XCTAssertEqual(RoutineGroups.errorText(stillThere)?.nextStep, "Point it at an open task with Edit, or turn it off.")
        let unnamed = session("r", target: "t-open", owner: nil, state: failed)
        XCTAssertEqual(RoutineGroups.errorText(unnamed)?.nextStep, "It runs in the task you picked from its next run.")
    }

    /// A refused switch or delete names what failed.
    func testActionFailureWords() {
        let paused = job("p", enabled: false, state: state(pausedAgo: 60))
        let off = job("o", enabled: false)
        XCTAssertEqual(RoutineGroups.switchVerb(job("on"), on: false), "pause it")
        XCTAssertEqual(RoutineGroups.switchVerb(paused, on: true), "resume it")
        XCTAssertEqual(RoutineGroups.switchVerb(off, on: true), "turn it on")
        XCTAssertEqual(RoutineGroups.actionFailure("pause it", "busy"), "Could not pause it: busy")
        XCTAssertEqual(RoutineGroups.actionFailure("delete it", "gone"), "Could not delete it: gone")
    }

    /// Run now: "Started" until the routine's stamp moves, then how it went; never a
    /// success beside a fresh failure.
    func testRunNoteFollowsTheRoutine() {
        let ms = now.timeIntervalSince1970 * 1000
        var plain = job("p", project: "Home")
        plain = RoutineJob(id: "p", name: "p", description: nil, enabled: true, schedule: every(300_000),
                           executor: .init(type: "session"),
                           state: .init(nextRunAtMs: nil, lastRunAtMs: ms - 3_600_000, lastStatus: "ok", lastError: nil, lastDurationMs: nil),
                           owner: plain.owner)
        let started = RoutineGroups.started(plain)
        XCTAssertEqual(started.text, "Started")
        XCTAssertTrue(started.ok)
        XCTAssertEqual(RoutineGroups.shownRun(started, plain), started, "nothing moved yet")
        XCTAssertNil(RoutineGroups.settledRun(before: started.before!, plain))
        func ran(_ status: String) -> RoutineJob {
            RoutineJob(id: "p", name: "p", description: nil, enabled: true, schedule: every(300_000), executor: .init(type: "session"),
                       state: .init(nextRunAtMs: nil, lastRunAtMs: ms, lastStatus: status, lastError: status == "error" ? "boom" : nil, lastDurationMs: nil),
                       owner: plain.owner)
        }
        XCTAssertEqual(RoutineGroups.shownRun(started, ran("error")),
                       .init(before: nil, ok: false, text: "It ran and failed: the reason is above."))
        XCTAssertEqual(RoutineGroups.shownRun(started, ran("ok")), .init(before: nil, ok: true, text: "Ran just now"))
        // A trigger: its last check moves, not its last run.
        let check = RoutineJob.Check(run: "x", host: "h")
        var trigger = job("t", state: state(checkOutcome: "quiet"), check: check)
        let checking = RoutineGroups.started(trigger)
        XCTAssertNil(RoutineGroups.settledRun(before: checking.before!, trigger))
        var s = trigger.state!
        s.lastCheck = .init(atMs: ms + 5_000, outcome: "error", error: "exit 1")
        trigger = RoutineJob(id: "t", name: "t", description: nil, enabled: true, schedule: every(300_000), executor: .init(type: "session"),
                             state: s, check: check)
        XCTAssertEqual(RoutineGroups.shownRun(checking, trigger)?.text, "It ran and failed: the reason is above.")
        s.lastCheck = .init(atMs: ms + 6_000, outcome: "quiet", error: nil)
        trigger = RoutineJob(id: "t", name: "t", description: nil, enabled: true, schedule: every(300_000), executor: .init(type: "session"),
                             state: s, check: check)
        XCTAssertEqual(RoutineGroups.shownRun(checking, trigger)?.text, "Checked just now")
        // A refusal or a failed request stays as it was said, its task by title.
        let refused = RoutineGroups.didNotRun("task t-p is complete", plain)
        XCTAssertEqual(refused.text, "Did not run: task \"Task p\" is complete")
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(RoutineGroups.shownRun(refused, ran("ok")), refused)
        XCTAssertNil(RoutineGroups.shownRun(nil, plain))
    }

    /// The opened row's facts in the console's order and words.
    func testFactsOrderAndWords() {
        let ms = now.timeIntervalSince1970 * 1000
        func labels(_ j: RoutineJob) -> [String] { RoutineGroups.facts(j, now: now, calendar: calendar).map(\.label) }
        func value(_ j: RoutineJob, _ label: String) -> String? {
            RoutineGroups.facts(j, now: now, calendar: calendar).first { $0.label == label }?.value
        }
        let check = RoutineJob.Check(run: "sh c.sh", host: "devbox", maxFiresPerDay: 6)
        var stoppedState = state(errors: 5)
        stoppedState.lastCheck = .init(atMs: ms - 360_000, outcome: "error", error: "exit 1")
        let stopped = job("s", project: "P", enabled: false, state: stoppedState, check: check)
        XCTAssertEqual(labels(stopped), ["State", "When", "Runs", "Task", "Check", "Fired"])
        XCTAssertEqual(value(stopped, "State"), "Stopped after 5 failed checks")
        XCTAssertEqual(value(stopped, "Check"), "$ sh c.sh @ devbox\nLast check: 6m ago · failed",
                       "the red box says why: the fact does not say it again")
        XCTAssertEqual(value(stopped, "Fired"), "Never yet · at most 6 a day")
        let never = job("n", project: "P", check: .init(run: "sh c.sh", host: "devbox"))
        XCTAssertEqual(value(never, "Check"), "$ sh c.sh @ devbox\nLast check: not checked yet")
        XCTAssertEqual(labels(job("on", project: "P")), ["When", "Runs", "Task"], "never ran: no Last run")
        let paused = job("p", enabled: false, state: state(pausedAgo: 600))
        XCTAssertEqual(labels(paused), ["State", "When", "Runs"])
        var ranState = state()
        ranState = RoutineJob.State(nextRunAtMs: nil, lastRunAtMs: ms - 7_200_000, lastStatus: "error", lastError: nil, lastDurationMs: 14_200)
        let ran = job("r", project: "P", state: ranState)
        XCTAssertEqual(labels(ran), ["When", "Runs", "Task", "Last run"])
        XCTAssertEqual(value(ran, "Last run"), "2h ago · failed in 14s")
        XCTAssertEqual(value(ran, "Runs"), "In its task's session")
    }

    func testFireTally() {
        let ms = now.timeIntervalSince1970 * 1000
        var s = state()
        XCTAssertEqual(RoutineGroups.describeFireTally(s, now: now), "Never yet")
        s.fireLog = [Entry(atMs: ms - 120_000, outcome: "fired", delivery: .init(status: "ok")),
                     Entry(atMs: ms - 600_000, outcome: "fired", delivery: .init(status: "ok"))]
        XCTAssertEqual(RoutineGroups.describeFireTally(s, now: now), "2×, last 2m ago")
        s.fireCount = 40
        XCTAssertEqual(RoutineGroups.describeFireTally(s, now: now), "40×, last 2m ago", "the server's count over the rows")
        s.fireLog?.insert(Entry(atMs: ms - 10_000, outcome: "fired", delivery: .init(status: "retrying")), at: 0)
        XCTAssertEqual(RoutineGroups.describeFireTally(s, now: now), "40×, last 2m ago, one delivery retrying",
                       "a fire still being delivered is not the latest")
        var only = state()
        only.fireLog = [Entry(atMs: ms, outcome: "fired", delivery: .init(status: "retrying"))]
        XCTAssertEqual(RoutineGroups.describeFireTally(only, now: now), "Not yet, a delivery retrying")
        let json = #"{"nextRunAtMs":1,"fireCount":3,"lastFireSeq":"x"}"#
        let decoded = try? JSONDecoder().decode(RoutineJob.State.self, from: Data(json.utf8))
        XCTAssertEqual(decoded?.fireCount, 3)
        XCTAssertNil(decoded?.lastFireSeq, "an odd counter costs only itself")
    }

    // MARK: - QA round 2: cron words, scrolling, long errors, a nameless send

    /// Ranges and steps in words: the closed row never shows a raw cron.
    func testCronRangesAndSteps() {
        func c(_ expr: String) -> String { RoutineGroups.cadence(cron(expr), calendar: calendar) }
        func h(_ hour: Int) -> String { RoutineGroups.hourText(hour, calendar: calendar) }
        XCTAssertEqual(c("*/15 9-17 * * 1-5"), "Every 15 min from \(t(at(4, 9))) to \(t(at(4, 17, 45))), weekdays",
                       "the console's words: the range ends at its last run")
        XCTAssertEqual(c("30 20 */2 * *"), "Every 2 days at \(t(at(4, 20, 30)))")
        XCTAssertEqual(c("*/10 * * * *"), "Every 10 min")
        XCTAssertEqual(c("0 */2 * * *"), "Every 2 hours at :00")
        XCTAssertEqual(c("15 9-17 * * 1-5"), "Hourly at :15 from \(t(at(4, 9, 15))) to \(t(at(4, 17, 15))), weekdays")
        XCTAssertEqual(c("15 * * * 0,6"), "Hourly at :15, weekends")
        XCTAssertEqual(c("0 8 * * 1-4"), "Mon to Thu at \(t(at(4, 8)))")
        XCTAssertEqual(c("0 8 * * 1,3"), "Mon/Wed at \(t(at(4, 8)))")
        XCTAssertEqual(c("0 8 * * 1-5"), "Weekdays at \(t(at(4, 8)))")
        XCTAssertEqual(c("* 9-17 * * *"), "Every minute from \(t(at(4, 9))) to \(t(at(4, 17, 59)))")
        XCTAssertEqual(c("0 8 * * 1"), "Mondays at \(t(at(4, 8)))")
        XCTAssertEqual(c("*/10 * * * 1"), "Every 10 min on Mondays")
        // Only what words cannot say stays "Custom schedule".
        for raw in ["0 9 L * *", "0 9 * * 1#2", "0 9 1-7/2,15 * *", "61 * * * *", "0 9 * *", "0 9 * * 1/2", "x y z * *"] {
            XCTAssertEqual(c(raw), "Custom schedule", raw)
        }
        // A step cron names no single hour: its next run says the hour.
        XCTAssertFalse(RoutineGroups.namesItsHour(cron("*/15 9-17 * * 1-5"), calendar: calendar))
        XCTAssertTrue(RoutineGroups.namesItsHour(cron("30 20 */2 * *"), calendar: calendar))
        let custom = job("x", schedule: cron("0 9 L * *"))
        XCTAssertEqual(RoutineGroups.whenFact(custom, now: now, calendar: calendar), "Custom: 0 9 L * *", "the opened row shows the expression")
        XCTAssertEqual(RoutineGroups.rowTiming(custom, now: now, calendar: calendar), "Custom schedule")
    }

    /// Opening a row: scroll down only as far as its details need, never past its line;
    /// a line above the band comes back down.
    func testRevealShift() {
        XCTAssertEqual(RoutineGroups.revealShift(lineTop: 300, end: 600, top: 100, bottom: 800), 0, "all in view")
        XCTAssertEqual(RoutineGroups.revealShift(lineTop: 300, end: 900, top: 100, bottom: 800), 100, "just enough")
        XCTAssertEqual(RoutineGroups.revealShift(lineTop: 300, end: 1500, top: 100, bottom: 800), 200, "the line stays at the top")
        XCTAssertEqual(RoutineGroups.revealShift(lineTop: 60, end: 400, top: 100, bottom: 800), -40, "under the bar: back down")
    }

    /// A long error's first line, the rest behind "Show full error"; a failed check gets
    /// the same box.
    func testLongErrorsAndAFailedCheck() throws {
        XCTAssertEqual(RoutineGroups.errorHead("exit 2").head, "exit 2")
        XCTAssertFalse(RoutineGroups.errorHead("exit 2").more)
        let stack = RoutineGroups.errorHead("TypeError: x is undefined\n    at run (a.js:1)\n    at main (b.js:2)")
        XCTAssertEqual(stack.head, "TypeError: x is undefined")
        XCTAssertTrue(stack.more)
        let page = RoutineGroups.errorHead(String(repeating: "<div>", count: 100))
        XCTAssertEqual(page.head.count, 161)
        XCTAssertTrue(page.head.hasSuffix("…"))
        XCTAssertTrue(page.more)
        let check = RoutineJob.Check(run: "x", host: "h")
        var s = state()
        s.lastCheck = .init(atMs: 1, outcome: "error", error: "exit 1: page 503")
        XCTAssertEqual(RoutineGroups.errorText(job("t", state: s, check: check))?.message, "The last check failed: exit 1: page 503")
        XCTAssertEqual(RoutineGroups.errorText(job("t", state: s, check: check))?.nextStep, "Fix the check command with Edit.")
        var stoppedState = s
        stoppedState.consecutiveErrors = 5
        XCTAssertEqual(RoutineGroups.errorText(job("t", enabled: false, state: stoppedState, check: check))?.nextStep,
                       "Fix the check command with Edit, then Resume.")
        XCTAssertTrue(RoutineGroups.boxSaysTheCheck(job("t", state: s, check: check)))
        s.lastCheck = .init(atMs: 1, outcome: "quiet", error: nil)
        XCTAssertNil(RoutineGroups.errorText(job("t", state: s, check: check)))
    }

    // MARK: - QA round 4: any cron in words, health after a retarget, the server's labels

    /// Any five fields in words, field by field; names, "?" and macros read as numbers.
    func testAnyFiveFieldCronInWords() {
        func c(_ expr: String) -> String { RoutineGroups.cadence(cron(expr), calendar: calendar) }
        func h(_ hour: Int) -> String { RoutineGroups.hourText(hour, calendar: calendar) }
        XCTAssertEqual(c("0 9 1-7 * 1"), "At \(t(at(4, 9))) on days 1 to 7 of the month and on Mondays")
        XCTAssertEqual(c("0 9 * * 2,4"), "Tue/Thu at \(t(at(4, 9)))", "the console's own shape first")
        XCTAssertEqual(c("0 9 1 * 2,4"), "At \(t(at(4, 9))) on the 1st and on Tue and Thu")
        XCTAssertEqual(c("*/10 9-17 * 1 *"), "Every 10 min from \(t(at(4, 9))) to \(t(at(4, 17, 50))) in January")
        // A step that does not divide its field is not an interval: its times, or no words.
        XCTAssertEqual(c("*/45 * * * *"), "Hourly at :00 and :45")
        XCTAssertEqual(c("0 */13 * * *"), "At \(t(at(4, 0))) and \(t(at(4, 13)))")
        XCTAssertEqual(c("0 0 1 */5 *"), "At \(t(at(4, 0))) on the 1st in January, June and November")
        XCTAssertEqual(c("*/7 9-17 * 1 *"), "Custom schedule")
        XCTAssertEqual(c("*/7 * * * *"), "Custom schedule")
        // Both day fields written: either runs it, so one that covers every day is every day.
        for raw in ["0 9 ? * mon-fri", "0 9 1 * ?", "0 9 1-31 * 1", "0 9 */1 * 1"] {
            XCTAssertEqual(c(raw), "Custom schedule", raw)
        }
        XCTAssertEqual(c("0 9 1-31 * *"), "At \(t(at(4, 9)))", "one day field alone covering every day is every day")
        XCTAssertEqual(c("0 9-17/2 * * *"), "Every 2 hours at :00 from \(t(at(4, 9))) to \(t(at(4, 17)))")
        XCTAssertEqual(c("0 9-16/2 * * *"), "Every 2 hours at :00 from \(t(at(4, 9))) to \(t(at(4, 15)))")
        XCTAssertEqual(c("5,35 * * * *"), "Hourly at :05 and :35")
        XCTAssertEqual(c("0 9,17 * * *"), "At \(t(at(4, 9))) and \(t(at(4, 17)))")
        XCTAssertEqual(c("30 8 * 3-6 *"), "At \(t(at(4, 8, 30))) from March to June")
        XCTAssertEqual(c("0 0 1 */3 *"), "At \(t(at(4, 0))) on the 1st every 3 months")
        XCTAssertEqual(c("15 * 1 * *"), "Hourly at :15 on the 1st")
        XCTAssertEqual(c("0 9 * * 5-7"), "At \(t(at(4, 9))) on Fri to Sun", "7 is Sunday")
        XCTAssertEqual(c("*/5 9 * * *"), "Every 5 min, in the \(h(9)) hour")
        XCTAssertEqual(c("@daily"), "Every day at \(t(at(4, 0)))")
        XCTAssertEqual(c("@hourly"), "Hourly at :00")
        XCTAssertEqual(c("0 9 * * MON"), "Mondays at \(t(at(4, 9)))")
        XCTAssertEqual(c("0 9 1 JAN *"), "At \(t(at(4, 9))) on the 1st in January")
        XCTAssertEqual(RoutineGroups.cadence(every(3_600_000), calendar: calendar), "Every hour")
        XCTAssertEqual(RoutineGroups.cadence(every(7_200_000), calendar: calendar), "Every 2 hours")
    }

    /// A run that failed into a complete task the routine has left is not failing now:
    /// the dot, the flag and the header's count all say so; the box still explains.
    func testPointedElsewhereIsNoLongerFailing() throws {
        let failed = RoutineJob.State(nextRunAtMs: nil, lastRunAtMs: nil, lastStatus: "error",
                                      lastError: "target task t-done is complete; the trigger will not resurrect it", lastDurationMs: nil)
        let moved = session("r", target: "t-open", owner: .init(taskId: "t-open", title: "Router firmware", project: "Home"), state: failed)
        XCTAssertEqual(RoutineGroups.health(moved), .ok)
        XCTAssertNotNil(RoutineGroups.errorText(moved))
        let stillThere = session("r", target: "t-done", owner: .init(taskId: "t-done", title: "Old", project: "Home"), state: failed)
        XCTAssertEqual(RoutineGroups.health(stillThere), .error)
        XCTAssertEqual(RoutineGroups.groups([moved]).first?.failing, 0)
        XCTAssertEqual(RoutineGroups.groups([stillThere]).first?.failing, 1)
        let other = RoutineJob.State(nextRunAtMs: nil, lastRunAtMs: nil, lastStatus: "error", lastError: "exit 2", lastDurationMs: nil)
        XCTAssertEqual(RoutineGroups.health(session("r", target: "t-open", owner: nil, state: other)), .error, "another failure still fails")
        // A stopped trigger pointed elsewhere still waits for Resume, and says so.
        var stopped = failed
        stopped.consecutiveErrors = 5
        stopped.lastCheck = .init(atMs: 1, outcome: "error", error: "target task t-done is complete")
        let quiet = RoutineJob(id: "q", name: "q", description: nil, enabled: false, schedule: every(300_000),
                               executor: .init(type: "session", config: ["target": .string("t-open")]), state: stopped,
                               check: .init(run: "x", host: "h"), owner: .init(taskId: "t-open", title: "Router firmware", project: "Home"))
        XCTAssertEqual(RoutineGroups.health(quiet), .error, "still stopped")
        XCTAssertEqual(RoutineGroups.errorText(quiet)?.nextStep, "It runs in \"Router firmware\" once you Resume it.")
        // The run's error answered by the retarget, the check failed on its own: the box says the check.
        var checkFailed = failed
        checkFailed.lastCheck = .init(atMs: 1, outcome: "error", error: "exit 1: page 503")
        let both = session("b", target: "t-open", owner: .init(taskId: "t-open", title: "Router firmware", project: "Home"),
                           state: checkFailed, check: .init(run: "x", host: "h"))
        XCTAssertEqual(RoutineGroups.health(both), .error)
        XCTAssertEqual(RoutineGroups.errorText(both)?.message, "The last check failed: exit 1: page 503")
        XCTAssertEqual(RoutineGroups.errorText(both)?.nextStep, "Fix the check command with Edit.")
    }

    /// The opened row's Runs in the server's own words (GET /routines/executors).
    func testExecutorLabelsAreTheServers() {
        func runs(_ type: String, _ config: [String: JSONValue] = [:]) -> String? {
            let j = RoutineJob(id: "x", name: "x", description: nil, enabled: true, schedule: every(60_000),
                               executor: .init(type: type, config: config), state: nil)
            return RoutineGroups.facts(j, now: now, calendar: calendar).first { $0.label == "Runs" }?.value
        }
        XCTAssertEqual(runs("main-agent"), "Home Chat")
        XCTAssertEqual(runs("walnut-agent"), "Walnut Agent")
        XCTAssertEqual(runs("claude-code"), "Claude Code")
        XCTAssertEqual(runs("claude-code", ["host": .string("local")]), "Claude Code")
        XCTAssertEqual(runs("claude-code", ["host": .string("devbox")]), "Claude Code @ devbox")
    }

    /// The row's line in two halves, so the view keeps "next in 7 min" whole.
    func testRowTimingParts() {
        let j = job("i", state: state(nextIn: 420))
        let parts = RoutineGroups.rowTimingParts(j, now: now, calendar: calendar)
        XCTAssertEqual(parts.how, "Every 5 min")
        XCTAssertEqual(parts.next, "next in 7 min")
        XCTAssertEqual(RoutineGroups.rowTiming(j, now: now, calendar: calendar), "Every 5 min · next in 7 min")
        XCTAssertNil(RoutineGroups.rowTimingParts(job("p", enabled: false, state: state(pausedAgo: 60)), now: now, calendar: calendar).next)
    }

    // MARK: - Round 5: the page's count, a fixed failure reads quiet, half a day away

    /// "N routines · N failing" over the groups; nothing failing says only the count.
    func testSummary() {
        let jobs = [job("a", project: "P"), job("b", project: "P", state: state(lastStatus: "error")), job("c")]
        let said = RoutineGroups.summary(RoutineGroups.groups(jobs))
        XCTAssertEqual(said.count, "3 routines")
        XCTAssertEqual(said.failing, "1 failing")
        XCTAssertNil(RoutineGroups.summary(RoutineGroups.groups([job("a")])).failing)
        XCTAssertEqual(RoutineGroups.summary(RoutineGroups.groups([job("a")])).count, "1 routine")
    }

    /// An old failure the routine was pointed away from is a quiet note; one still to fix,
    /// or a stopped trigger that still needs Resume, stays red.
    func testAFixedFailureIsPast() throws {
        let failed = RoutineJob.State(nextRunAtMs: nil, lastRunAtMs: nil, lastStatus: "error",
                                      lastError: "target task t-done is complete; the trigger will not resurrect it", lastDurationMs: nil)
        let moved = session("r", target: "t-open", owner: .init(taskId: "t-open", title: "Router firmware", project: "Home"), state: failed)
        XCTAssertEqual(RoutineGroups.errorText(moved)?.past, true)
        let still = session("r", target: "t-done", owner: .init(taskId: "t-done", title: "Old", project: "Home"), state: failed)
        XCTAssertEqual(RoutineGroups.errorText(still)?.past, false)
        var stoppedState = failed
        stoppedState.consecutiveErrors = 5
        stoppedState.lastCheck = .init(atMs: 1, outcome: "error", error: "target task t-done is complete")
        let stopped = RoutineJob(id: "q", name: "q", description: nil, enabled: false, schedule: every(300_000),
                                 executor: .init(type: "session", config: ["target": .string("t-open")]), state: stoppedState,
                                 check: .init(run: "x", host: "h"), owner: .init(taskId: "t-open", title: "Router firmware", project: "Home"))
        XCTAssertEqual(RoutineGroups.errorText(stopped)?.past, false, "a stopped trigger still needs Resume")
    }

    /// Within half a day the next run says its clock time, not "tomorrow at".
    func testHalfADayAwaySaysTheTime() {
        let late = calendar.date(from: DateComponents(year: 2026, month: 11, day: 4, hour: 23, minute: 30))!
        let next = calendar.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 1, minute: 7))!
        XCTAssertEqual(RoutineGroups.shortNext(next, now: late, namesHour: false, calendar: calendar), "next at \(t(next))")
        let far = calendar.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 13))!
        XCTAssertEqual(RoutineGroups.shortNext(far, now: late, namesHour: false, calendar: calendar), "tomorrow at \(t(far))")
        XCTAssertEqual(RoutineGroups.shortNext(next, now: late, namesHour: true, calendar: calendar), "tomorrow",
                       "a cadence that names its hour says only the day")
    }

    /// The interval choices read as words, not templates.
    func testRepeatLabels() {
        XCTAssertEqual(RoutineDraft.Repeat.minutes.label, "Every few minutes")
        XCTAssertEqual(RoutineDraft.Repeat.hours.label, "Every few hours")
        XCTAssertFalse(RoutineDraft.Repeat.allCases.contains { $0.label.contains(" N ") })
    }

    /// A stored routine that says nothing can still be renamed; a new one must say something.
    func testSendsRequiredOnlyWhenItSaidSomething() {
        var silent = RoutineDraft(job: job("s", project: "P"), calendar: calendar)
        silent.name = "Renamed"
        XCTAssertTrue(silent.isValid, silent.problems.joined())
        let said = RoutineJob(id: "w", name: "w", description: nil, enabled: true, schedule: every(60_000),
                              executor: .init(type: "main-agent", config: ["instructions": .string("Brief me")]), state: nil)
        var cleared = RoutineDraft(job: said, calendar: calendar)
        cleared.sends = ""
        XCTAssertEqual(cleared.problems, ["Say what it sends."])
        XCTAssertTrue(RoutineDraft.new().problems.contains("Say what it sends."))
    }
}
