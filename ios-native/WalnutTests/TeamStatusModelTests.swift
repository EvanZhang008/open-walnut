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
        // Not started is its own category, never part of Waiting (the web's countsLine, 2026-11-09).
        XCTAssertEqual(TeamStatusModel.countsLine(b), "1 Working, 2 Waiting / snoozed (1 with nothing to wake it), 1 Not started, 1 Completed in the last 7 days.")
        XCTAssertEqual(TeamStatusChip.waiting.rows(b).map(\.id), ["c", "a"])
        XCTAssertEqual(TeamStatusChip.notStarted.rows(b).map(\.id), ["d"])
        XCTAssertEqual(TeamStatusChip.allCases.map { $0.count(b) }, [1, 1, 2, 1, 1])
        XCTAssertTrue(b.hasTeam)
        // On the leader's own page its own row is left out, and its team still shows.
        let mine = TeamStatusModel.build(ownerId: "lead", tasks: tasks, includeOwner: false, now: Self.now)
        XCTAssertFalse(mine.open.contains { $0.id == "lead" })
        XCTAssertEqual(mine.open.count + 1, b.open.count)
        XCTAssertTrue(mine.hasTeam)
        XCTAssertFalse(TeamStatusModel.build(ownerId: "lead", tasks: [tasks[0]], includeOwner: false, now: Self.now).hasTeam)
    }

    func testFallbackWithoutStoredStatusReadsThePhaseAsAnOlderServerMeantIt() {
        // Same rule as the row dot (BoardModel.needsHuman) and the server's fallbackUserState.
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "NEED_ACTION")), .needs)
        XCTAssertTrue(BoardModel.needsHuman(task("x", phase: "NEED_ACTION")))
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "WAITING")), .waiting)
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "IN_PROGRESS")), .working)
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "COMPLETE", status: "done")), .done)
    }

    // MARK: - To read is Needs you (2026-11-02, folded 2026-11-03)

    @MainActor func testFourGroupsInOrderWithTheirWordsAndNoToRead() {
        // `read` is still decoded, but never a group of its own: no chip, no words, no count.
        XCTAssertEqual(UserState.groups, [.needs, .working, .waiting, .done])
        XCTAssertFalse(UserState.groups.contains(.read))
        XCTAssertEqual(UserState.groups.map(\.label), ["Needs you", "Working", "Waiting / snoozed", "Completed"])
        XCTAssertEqual(UserState.read.shown, .needs)
        XCTAssertEqual(UserState.read.label, "Needs you")
        XCTAssertFalse(UserState.allCases.map(\.label).contains("To read"))
        // The chips: the four groups with Not started after Waiting, and no To read.
        XCTAssertEqual(TeamStatusChip.allCases.map(\.label), ["Needs you", "Working", "Waiting / snoozed", "Not started", "Completed"])
    }

    func testToReadFromTheServerAndFromAnOlderOneIsNeedsYou() {
        let words = "The result is ready"
        // This server: state "read".
        let now = task("r", phase: "WAITING", user: .init(state: "read", waitingOn: words, toRead: "result"))
        XCTAssertEqual(TeamStatusModel.userState(now.userStatus), .read)
        XCTAssertEqual(TeamStatusModel.state(of: now), .needs)
        XCTAssertTrue(TeamStatusModel.isToRead(now.userStatus))
        // A server from before the To read state: "waiting" with toRead set.
        let legacy = task("l", phase: "WAITING", user: .init(state: "waiting", waitingOn: words, toRead: "result"))
        XCTAssertEqual(TeamStatusModel.userState(legacy.userStatus), .read)
        XCTAssertEqual(TeamStatusModel.state(of: legacy), .needs)
        // A snoozed status stays Waiting whatever it holds.
        let snoozed = task("s", user: .init(state: "waiting", snoozed: .init(until: "2026-11-05"), toRead: "result"))
        XCTAssertEqual(TeamStatusModel.state(of: snoozed), .waiting)
        XCTAssertFalse(TeamStatusModel.isToRead(snoozed.userStatus))
        XCTAssertFalse(BoardModel.needsHuman(snoozed))
        // An empty toRead is no To read.
        XCTAssertEqual(TeamStatusModel.state(of: task("e", user: .init(state: "waiting", toRead: " "))), .waiting)
        // The needs mark, whatever the phase: it is in Needs you.
        XCTAssertTrue(BoardModel.needsHuman(now))
        XCTAssertTrue(BoardModel.needsHuman(legacy))
    }

    /// The third line of a Needs you row: its category word, then the ask, else what there is
    /// to read (the server's words, else by kind), else nothing.
    func testTheNeedLine() {
        typealias L = TeamStatusModel.NeedLine
        // A real ask: its text, a decision by default.
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "needs", ask: "Approve the deploy?", source: "session")),
                       L(category: .decide, text: "Approve the deploy?"))
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "needs", ask: "Approve the deploy?", source: "session"))?.line,
                       "Decide: Approve the deploy?")
        // A needs with no words at all: no line is invented, whatever its category.
        XCTAssertNil(TeamStatusModel.needLine(.init(state: "needs")))
        XCTAssertNil(TeamStatusModel.needLine(.init(state: "needs", ask: "  ", category: "review")))
        XCTAssertNil(TeamStatusModel.needLine(nil))
        // To read with the server's words: those words, for each kind.
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "read", waitingOn: "The result is ready", toRead: "result"))?.line,
                       "Can close: The result is ready")
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "read", waitingOn: "It answered your question", toRead: "answer"))?.line,
                       "Take a look: It answered your question")
        let turnWords = "Its turn ended without asking you anything: Deployed build 42 to prod."
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "read", waitingOn: turnWords, toRead: "turn")),
                       L(category: .look, text: turnWords))
        // An older server's "waiting" with toRead reads the same.
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "waiting", waitingOn: "It answered your question", toRead: "answer"))?.line,
                       "Take a look: It answered your question")
        // To read with no words: by kind, never "take a look" twice.
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "read", toRead: "result"))?.line, "Can close: The result is ready")
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "read", waitingOn: " ", toRead: "answer"))?.line, "Take a look: It answered your question")
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "read", toRead: "turn"))?.line, "Take a look: Its turn ended without asking you anything")
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "waiting", toRead: "result"))?.line, "Can close: The result is ready")
        for kind in ["result", "answer", "turn"] {
            let text = TeamStatusModel.needLine(.init(state: "read", toRead: kind))?.text ?? ""
            XCTAssertFalse(text.lowercased().contains("take a look"), kind)
            XCTAssertFalse(text.hasPrefix("Waiting"), kind)
        }
        // To read naming no kind and no words: nothing.
        XCTAssertNil(TeamStatusModel.needLine(.init(state: "read")))
        // A waiting row's words are never a need line, nor a snoozed To read's.
        XCTAssertNil(TeamStatusModel.needLine(.init(state: "waiting", kind: "task", waitingOn: "Another task")))
        XCTAssertNil(TeamStatusModel.needLine(.init(state: "waiting", waitingOn: "The result is ready", snoozed: .init(until: "2026-11-05"), toRead: "result")))
    }

    /// The four categories as the server names them, and what an older server's status (no
    /// `category`) reads as.
    func testNeedCategories() {
        XCTAssertEqual(NeedCategory.allCases, [.look, .decide, .review, .close])
        XCTAssertEqual(NeedCategory.allCases.map(\.label), ["Take a look", "Decide", "Review", "Can close"])
        // The server's word wins, on a needs and on a To read alike.
        for c in NeedCategory.allCases {
            XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "needs", ask: "x", source: "session", category: c.rawValue)), c)
            XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "read", toRead: "turn", category: c.rawValue)), c)
            XCTAssertEqual(TeamStatusModel.needLine(.init(state: "needs", ask: "Look at the PR", category: c.rawValue))?.line,
                           "\(c.label): Look at the PR")
        }
        XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "needs", ask: "x", category: " Review ")), .review)
        // No category (an older server), or one this build does not know: derived.
        XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "read", toRead: "result")), .close)
        XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "waiting", toRead: "result")), .close)
        XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "read", toRead: "answer")), .look)
        XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "read", toRead: "turn")), .look)
        XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "needs", ask: "Build failed", source: "error")), .look)
        XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "needs", ask: "Allow Bash?", source: "prompt")), .decide)
        XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "needs", ask: "Pick one", source: "session")), .decide)
        XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "needs", ask: "Pick one", category: "later-kind")), .decide)
        XCTAssertEqual(TeamStatusModel.needCategory(.init(state: "read", toRead: "result", category: "later-kind")), .close)
        XCTAssertEqual(TeamStatusModel.needLine(.init(state: "needs", ask: "Build failed", source: "error"))?.line, "Take a look: Build failed")
    }

    func testDecodesCategoryAndAnOlderServerWithout() throws {
        let json = #"{"id":"t1","title":"T","status":"in_progress","phase":"NEED_ACTION","priority":"none","project":"","user_status":{"state":"needs","ask":"Look over the diff","source":"session","category":"review"}}"#
        let t = try JSONDecoder().decode(WalnutTask.self, from: Data(json.utf8))
        XCTAssertEqual(t.userStatus?.category, "review")
        XCTAssertEqual(TeamStatusModel.needLine(t.userStatus)?.line, "Review: Look over the diff")
        let old = try JSONDecoder().decode(WalnutTask.self, from: Data(json.replacingOccurrences(of: #","category":"review""#, with: "").utf8))
        XCTAssertNil(old.userStatus?.category)
        XCTAssertEqual(TeamStatusModel.needLine(old.userStatus)?.line, "Decide: Look over the diff")
    }

    func testAnUnknownStateFallsBackToThePhase() {
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "NEED_ACTION", user: .init(state: "later-kind"))), .needs)
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "IN_PROGRESS", user: .init(state: "later-kind"))), .working)
        XCTAssertEqual(TeamStatusModel.state(of: task("x", phase: "WAITING", user: .init(state: "later-kind"))), .waiting)
        XCTAssertNil(TeamStatusModel.userState(.init(state: "later-kind")))
        XCTAssertTrue(BoardModel.needsHuman(task("x", phase: "NEED_ACTION", user: .init(state: "later-kind"))))
    }

    func testToReadIsCountedAndSortedUnderNeedsYou() {
        let tasks = [
            task("lead", parent: nil, phase: "IN_PROGRESS", user: .init(state: "working")),
            task("n", user: .init(state: "needs", ask: "Pick one", source: "session")),
            task("r1", user: .init(state: "read", waitingOn: "The result is ready", at: "2026-10-26T01:00:00Z", toRead: "result")),
            task("r2", user: .init(state: "waiting", waitingOn: "It answered your question", at: "2026-10-26T04:00:00Z", toRead: "answer")),
            task("w", phase: "WAITING", user: .init(state: "waiting", kind: "task", waitingOn: "Another task")),
            task("z", phase: "WAITING", user: .init(state: "waiting", kind: "time", snoozed: .init(until: "2026-11-05"), toRead: "result")),
            task("c", phase: "IN_PROGRESS", user: .init(state: "working", carriesOn: "process")),
            task("d", phase: "COMPLETE", status: "done", completed: "2026-10-25T00:00:00Z"),
        ]
        let b = TeamStatusModel.build(ownerId: "lead", tasks: tasks, now: Self.now)
        XCTAssertEqual(b.counts, TeamStatusCounts(needs: 3, working: 2, waiting: 2, done: 1))
        XCTAssertEqual(UserState.groups.map { b.counts[$0] }, [3, 2, 2, 1])
        XCTAssertEqual(b.counts[.read], b.counts.needs)
        // One Needs you group, latest status time first, To read rows among the others.
        XCTAssertEqual(b.needs.map(\.id), ["n", "r2", "r1"])
        XCTAssertEqual(b.rows(.read).map(\.id), b.needs.map(\.id))
        XCTAssertEqual(b.needs.map(\.state), [.needs, .needs, .needs])
        XCTAssertEqual(b.needs.map(\.isToRead), [false, true, true])
        XCTAssertEqual(b.open.map(\.id).prefix(3), ["n", "r2", "r1"])
        XCTAssertEqual(Set(b.waiting.map(\.id)), ["w", "z"])
        XCTAssertEqual(Set(b.working.map(\.id)), ["lead", "c"])
        // The counts line names no To read: those tasks are Needs you.
        XCTAssertEqual(TeamStatusModel.countsLine(b), "2 Working, 2 Waiting / snoozed, 1 Completed in the last 7 days.")
        XCTAssertFalse(TeamStatusModel.countsLine(b).contains("To read"))
        // Each row's third line.
        XCTAssertEqual(b.needs.map { TeamStatusModel.needLine($0.status)?.line },
                       ["Decide: Pick one", "Take a look: It answered your question", "Can close: The result is ready"])
    }


    func testDecodesToReadCarriesOnAndSnoozed() throws {
        let json = #"{"id":"t1","title":"T","status":"in_progress","phase":"NEED_ACTION","priority":"none","project":"","user_status":{"state":"read","toRead":"turn","waitingOn":"Its turn ended without asking you anything","carriesOn":"watch","snoozed":{"until":"2026-11-05","ask":"Approve"}}}"#
        let t = try JSONDecoder().decode(WalnutTask.self, from: Data(json.utf8))
        XCTAssertEqual(t.userStatus?.toRead, "turn")
        XCTAssertEqual(t.userStatus?.carriesOn, "watch")
        XCTAssertEqual(t.userStatus?.snoozed, WalnutSnooze(until: "2026-11-05", ask: "Approve"))
        // A snooze shape this build does not know still reads as snoozed, never a failed list.
        let odd = json.replacingOccurrences(of: #"{"until":"2026-11-05","ask":"Approve"}"#, with: #"{"until":5}"#)
        let o = try JSONDecoder().decode(WalnutTask.self, from: Data(odd.utf8))
        XCTAssertNotNil(o.userStatus?.snoozed)
        // An older server sends none of them.
        let old = try JSONDecoder().decode(WalnutTask.self, from: Data(#"{"id":"t2","title":"T","status":"in_progress","phase":"TODO","priority":"none","project":"","user_status":{"state":"working"}}"#.utf8))
        XCTAssertNil(old.userStatus?.toRead)
        XCTAssertNil(old.userStatus?.carriesOn)
        XCTAssertNil(old.userStatus?.snoozed)
    }

    func testOrgCountsReadToReadAndStayAbsentFromAnOlderServer() throws {
        let now = try JSONDecoder().decode(OrgCountsWire.self, from: Data(#"{"open":5,"running":1,"needsYou":1,"toRead":2,"waiting":1}"#.utf8))
        XCTAssertEqual(now.read, 2)
        let alias = try JSONDecoder().decode(OrgCountsWire.self, from: Data(#"{"open":5,"running":1,"needsYou":1,"read":3,"waiting":1}"#.utf8))
        XCTAssertEqual(alias.read, 3)
        let old = try JSONDecoder().decode(OrgCountsWire.self, from: Data(#"{"open":5,"running":1,"needsYou":1,"waiting":3}"#.utf8))
        XCTAssertNil(old.toRead)
        XCTAssertEqual(old.read, 0)
        XCTAssertNil((old + old).toRead)
        XCTAssertEqual((now + old).toRead, 2)
        XCTAssertEqual((now + alias).read, 5)
        XCTAssertEqual((now + old).open, 10)
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
        // A Board choice is stamped when it was written; one with no time was never checked.
        let choice = WalnutUserStatus(state: "needs", ask: "When?", source: "choice", checkedAt: iso(now.addingTimeInterval(-3600)))
        XCTAssertEqual(TeamStatusModel.checkedLine(choice, now: now)?.unverified, false)
        XCTAssertEqual(TeamStatusModel.checkedLine(.init(state: "needs", ask: "When?", source: "choice", unverified: true), now: now)?.text,
                       "Not verified: no check recorded, may be done already")
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

    /// A not started task that is snoozed sleeps under Waiting / snoozed; Not started counts only
    /// the ones nobody started and nobody put aside (the web's `isNotStartedStatus`).
    func testASnoozedTaskNobodyStartedIsWaitingNotNotStarted() {
        var snoozed = WalnutUserStatus(state: "waiting", kind: "not-started", waitingOn: "Not started yet")
        snoozed.snoozed = WalnutSnooze(until: "2026-11-20")
        let tasks = [
            task("lead", parent: nil, phase: "IN_PROGRESS", user: .init(state: "working")),
            task("ns", phase: "TODO", user: .init(state: "waiting", kind: "not-started", waitingOn: "Not started yet")),
            task("zz", phase: "TODO", user: snoozed),
        ]
        let b = TeamStatusModel.build(ownerId: "lead", tasks: tasks, now: Self.now)
        XCTAssertEqual(b.notStartedRows.map(\.id), ["ns"])
        XCTAssertEqual(b.waitingRows.map(\.id), ["zz"])
        XCTAssertEqual(TeamStatusModel.countsLine(b), "1 Working, 1 Waiting / snoozed, 1 Not started, 0 Completed in the last 7 days.")
        // A filter an older build kept still reads.
        XCTAssertEqual(TeamStatusChip(rawValue: "waiting"), .waiting)
        XCTAssertEqual(TeamStatusChip(rawValue: "notstarted"), .notStarted)
    }
}
