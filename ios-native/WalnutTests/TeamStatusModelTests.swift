import XCTest
@testable import Walnut

/// The phone's team status (TeamStatusModel), the twin of the web Board's Status view
/// (tests/web/board-status-model.test.ts): same states, same order, same counts.
final class TeamStatusModelTests: XCTestCase {
    private static let now = WalnutTask.parseISO("2026-10-26T05:35:00Z")!

    private func task(
        _ id: String, parent: String? = "lead", phase: String = "NEED_ACTION", status: String = "in_progress",
        user: WalnutUserStatus? = nil, completed: String? = nil, updated: String = "2026-10-26T05:00:00Z"
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: "Task \(id)", status: status, phase: phase, priority: "none", project: "Walnut",
            dueDate: nil, createdAt: "2026-10-20T00:00:00Z", updatedAt: updated, completedAt: completed,
            starred: nil, pinned: nil, tags: nil, summary: nil, parentTaskId: parent, userStatus: user
        )
    }

    func testGroupsByTheStoredStatusNotThePhase() {
        let tasks = [
            task("lead", parent: nil, phase: "IN_PROGRESS", user: .init(state: "working")),
            // A turn that ended with nothing for the user is waiting, not needs you.
            task("a", user: .init(state: "waiting", kind: "lead", waitingOn: "Its lead, to read the latest turn")),
            task("b", user: .init(state: "needs", ask: "Approve a real iPhone test?", source: "session")),
            task("c", phase: "WAITING", user: .init(state: "waiting", kind: "stuck", waitingOn: "Nobody")),
            task("d", phase: "TODO", user: .init(state: "waiting", kind: "not-started", waitingOn: "Not started yet")),
            task("e", phase: "COMPLETE", status: "done", completed: "2026-10-25T00:00:00Z"),
            task("old", phase: "COMPLETE", status: "done", completed: "2026-10-01T00:00:00Z"),
            task("other", parent: "someone-else", user: .init(state: "needs", ask: "x")),
        ]
        let b = TeamStatusModel.build(ownerId: "lead", tasks: tasks, now: Self.now)
        XCTAssertEqual(b.counts, TeamStatusCounts(needs: 1, working: 1, waiting: 3, done: 1))
        XCTAssertEqual(b.needs.map(\.id), ["b"])
        // Stuck first, not started last.
        XCTAssertEqual(b.waiting.map(\.id), ["c", "a", "d"])
        XCTAssertEqual(b.stuck, 1)
        XCTAssertEqual(b.notStarted, 1)
        XCTAssertEqual(TeamStatusModel.countsLine(b), "1 Working, 3 Waiting / snoozed (1 with nothing to wake it, 1 not started), 1 Completed in the last 7 days.")
        XCTAssertTrue(b.hasTeam)
    }

    func testFallbackWithoutStoredStatusReadsThePhaseAsAnOlderServerMeantIt() {
        // Same rule as the row dot (BoardModel.needsHuman) and the server's fallbackUserState.
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "NEED_ACTION")), .needs)
        XCTAssertTrue(BoardModel.needsHuman(task("x", phase: "NEED_ACTION")))
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "WAITING")), .waiting)
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "IN_PROGRESS")), .working)
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "COMPLETE", status: "done")), .done)
    }

    func testWaitingLines() {
        XCTAssertEqual(TeamStatusModel.waitingLine(.init(state: "waiting", kind: "task", waitingOn: "A reply from Bun lead")), "Waiting on a reply from Bun lead")
        XCTAssertEqual(TeamStatusModel.waitingLine(.init(state: "waiting", kind: "stuck", waitingOn: "")), "Nothing will wake it.")
        XCTAssertEqual(TeamStatusModel.waitingLine(.init(state: "waiting", kind: "not-started", waitingOn: "Not started yet")), "Not started yet")
        // A time wait with no end keeps its words instead of a bare "Waiting".
        XCTAssertEqual(TeamStatusModel.waitingLine(.init(state: "waiting", kind: "time", waitingOn: "Its next scheduled run")), "Waiting on its next scheduled run")
        XCTAssertEqual(TeamStatusModel.waitingLine(.init(state: "waiting", kind: "time", waitingOn: "")), "Waiting for a set time")
    }

    func testANeedsYouSaysWhenItWasCheckedAndWhenItIsNotVerified() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let iso = { (d: Date) in ISO8601DateFormatter().string(from: d) }
        let fresh = WalnutUserStatus(state: "needs", ask: "Sign in", source: "session", checkedAt: iso(now.addingTimeInterval(-2 * 3600)), checkedBy: "session")
        let line = TeamStatusModel.checkedLine(fresh, now: now)
        XCTAssertEqual(line?.unverified, false)
        XCTAssertTrue(line?.text.hasPrefix("Checked ") == true)
        let old = WalnutUserStatus(state: "needs", ask: "Sign in", source: "session", checkedAt: iso(now.addingTimeInterval(-9 * 3600)), checkedBy: "session", unverified: true)
        XCTAssertEqual(TeamStatusModel.checkedLine(old, now: now)?.unverified, true)
        XCTAssertTrue(TeamStatusModel.checkedLine(old, now: now)?.text.hasPrefix("Not verified") == true)
        // Walnut's own live records (a letter) and an older server's status carry no line.
        XCTAssertNil(TeamStatusModel.checkedLine(.init(state: "needs", ask: "Answer the letter", source: "letter"), now: now))
        XCTAssertNil(TeamStatusModel.checkedLine(.init(state: "needs", ask: "Sign in", source: "session"), now: now))
    }

    func testADoneTaskNeverReadsStuck() {
        // The server keeps a COMPLETE task's last report, so its kind can still say stuck.
        let stuck = WalnutUserStatus(state: "waiting", kind: "stuck")
        XCTAssertTrue(TeamStatusModel.isStuck(task("s", phase: "IN_PROGRESS", user: stuck)))
        XCTAssertFalse(TeamStatusModel.isStuck(task("d", phase: "COMPLETE", status: "done", user: stuck)))
    }

    func testARowsTimeIsItsStatusTimeNotItsLastEdit() {
        let t = task("r", phase: "WAITING", user: .init(state: "waiting", at: "2026-10-26T01:00:00Z"), updated: "2026-10-26T09:00:00Z")
        let row = TeamStatusModel.build(ownerId: "lead", tasks: [task("lead", parent: nil, phase: "IN_PROGRESS"), t]).open.first { $0.task.id == "r" }!
        XCTAssertEqual(TeamStatusModel.rowTime(row), WalnutTask.parseISO("2026-10-26T01:00:00Z"))
    }

    func testAWorkingRowsTimeIsItsTurnStart() {
        var t = task("w", phase: "IN_PROGRESS", user: .init(state: "working", at: "2026-10-26T01:00:00Z"))
        t.liveActivity = WalnutLiveActivity(kind: "tool", since: "2026-10-26T09:05:00Z", turnStartedAt: "2026-10-26T09:00:00Z")
        let row = TeamStatusModel.build(ownerId: "lead", tasks: [task("lead", parent: nil, phase: "IN_PROGRESS"), t]).open.first { $0.task.id == "w" }!
        XCTAssertEqual(TeamStatusModel.rowTime(row), WalnutTask.parseISO("2026-10-26T09:00:00Z"))
    }

    func testTheDetailRowKeepsItsPartialResultAndASettledOneIsNotPartial() throws {
        let json = #"{"id":"p","title":"P","phase":"COMPLETE","result_report":{"at":"2026-10-26T01:00:00Z","not_done":["a","b"]}}"#
        let detail = try JSONDecoder().decode(TaskDetail.self, from: Data(json.utf8))
        let t = WalnutTask(detail: detail)
        XCTAssertEqual(t.resultReport?.notDone, ["a", "b"])
        XCTAssertTrue(t.resultReport?.isPartial == true)
        let settled = #"{"id":"p","title":"P","result_report":{"at":"x","not_done":["a"],"settled":{"at":"y","how":"taken"}}}"#
        let s = try JSONDecoder().decode(TaskDetail.self, from: Data(settled.utf8))
        XCTAssertFalse(WalnutTask(detail: s).resultReport?.isPartial ?? true)
        // What only the list carries survives opening the task.
        var row = t
        row.liveActivity = WalnutLiveActivity(kind: "tool", since: "2026-10-26T09:05:00Z")
        XCTAssertNotNil(WalnutTask(detail: detail).keepingListFields(of: row).liveActivity)
    }

    func testAnAskReadsAsAClauseInTheBrief() {
        XCTAssertEqual(TeamStatusModel.clause("Pick a residency."), "Pick a residency")
        XCTAssertEqual(TeamStatusModel.clause("  Send it by Friday;  "), "Send it by Friday")
        XCTAssertEqual(TeamStatusModel.clause("Approve the plan?"), "Approve the plan?")
        XCTAssertEqual(TeamStatusModel.clause("Pick one\u{3002}"), "Pick one")
        XCTAssertEqual(TeamStatusModel.clause("Then more..."), "Then more...")
    }

    func testDecodesTheProjectionField() throws {
        let json = #"{"id":"t1","title":"T","status":"in_progress","phase":"NEED_ACTION","priority":"none","project":"","user_status":{"state":"needs","ask":"Pick A or B?","source":"letter","at":"2026-10-26T05:00:00Z"}}"#
        let t = try JSONDecoder().decode(WalnutTask.self, from: Data(json.utf8))
        XCTAssertEqual(t.userStatus?.state, "needs")
        XCTAssertEqual(t.userStatus?.ask, "Pick A or B?")
        XCTAssertTrue(BoardModel.needsHuman(t))
        let quiet = try JSONDecoder().decode(WalnutTask.self, from: Data(json.replacingOccurrences(of: #""state":"needs""#, with: #""state":"waiting""#).utf8))
        XCTAssertFalse(BoardModel.needsHuman(quiet))
    }

    @MainActor func testDecodesAPartialResult() throws {
        let json = #"{"id":"t1","title":"T","status":"done","phase":"COMPLETE","priority":"none","project":"","result_report":{"at":"2026-10-28T05:00:00Z","not_done":["iOS not tested","docs"],"result":"Live on the web"}}"#
        let t = try JSONDecoder().decode(WalnutTask.self, from: Data(json.utf8))
        XCTAssertEqual(t.resultReport?.notDone, ["iOS not tested", "docs"])
        XCTAssertEqual(t.resultReport?.result, "Live on the web")
        XCTAssertTrue(t.resultReport?.isPartial ?? false)
        // An older server sends nothing: no Partial.
        let plain = try JSONDecoder().decode(WalnutTask.self, from: Data(#"{"id":"t2","title":"T","status":"done","phase":"COMPLETE","priority":"none","project":""}"#.utf8))
        XCTAssertNil(plain.resultReport)
        XCTAssertFalse(WalnutResultReport(notDone: []).isPartial)
        // A copy of the row keeps it (the pin toggle).
        XCTAssertEqual(TasksStore.withPinned(t, true).resultReport, t.resultReport)
    }

    func testDecodesADueDateAndSaysItInAFewWords() throws {
        let json = #"{"id":"t1","title":"T","status":"in_progress","phase":"TODO","priority":"none","project":"","user_status":{"state":"waiting","kind":"not-started","due":{"at":"2026-10-27","state":"overdue"}}}"#
        let t = try JSONDecoder().decode(WalnutTask.self, from: Data(json.utf8))
        XCTAssertEqual(t.userStatus?.due, WalnutDue(at: "2026-10-27", state: "overdue"))
        var cal = DateComponents(); cal.year = 2026; cal.month = 10; cal.day = 27; cal.hour = 9
        let morning = Calendar.current.date(from: cal)!
        XCTAssertEqual(TeamStatusModel.dueText("2026-10-27", now: morning), "today")
        XCTAssertEqual(TeamStatusModel.dueText("not a date", now: morning), "not a date")
        XCTAssertFalse(TeamStatusModel.dueText("2026-10-30", now: morning).isEmpty)
    }

    // MARK: - Live action (twin of tests/core/live-activity.test.ts)

    func testLiveActivityLineNamesTheToolItsSpanTheTurnAndTheCost() {
        let a = WalnutLiveActivity(
            kind: "tool", tool: "Bash", target: "bun run test:quick", since: "2026-10-26T05:32:00Z",
            turnStartedAt: "2026-10-26T04:54:00Z", lastToolAt: "2026-10-26T05:32:00Z", costUsd: 2.1
        )
        let line = LiveActivityFormat.line(a, now: Self.now)
        XCTAssertEqual(line.text, "Bash: bun run test:quick · 3 min · turn 41 min · $2.10")
        XCTAssertFalse(line.quiet)
    }

    func testLiveActivityLineSaysWhenItWentQuiet() {
        let a = WalnutLiveActivity(
            kind: "thinking", since: "2026-10-26T05:30:00Z",
            turnStartedAt: "2026-10-26T04:40:00Z", lastToolAt: "2026-10-26T05:23:00Z", costUsd: 3.4
        )
        let line = LiveActivityFormat.line(a, now: Self.now)
        XCTAssertTrue(line.quiet)
        XCTAssertEqual(line.text, "No tool call for 12 min · turn 55 min · $3.40")
    }

    func testLiveActivityLineForAnMcpToolAndALongTurn() {
        let a = WalnutLiveActivity(kind: "tool", tool: "mcp__slack__post", since: "2026-10-26T05:34:20Z", turnStartedAt: "2026-10-26T03:30:00Z")
        XCTAssertEqual(LiveActivityFormat.line(a, now: Self.now).text, "slack: post · 40 s · turn 2 h 5 min")
    }
}
