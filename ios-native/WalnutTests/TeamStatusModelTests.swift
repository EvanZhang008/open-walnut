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
        XCTAssertEqual(TeamStatusModel.countsLine(b), "1 working, 3 waiting (1 stuck, 1 not started), 1 done in the last 7 days.")
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
        XCTAssertEqual(TeamStatusModel.waitingLine(.init(state: "waiting", kind: "stuck", waitingOn: "")), "Stuck. Nothing will wake it.")
        XCTAssertEqual(TeamStatusModel.waitingLine(.init(state: "waiting", kind: "not-started", waitingOn: "Not started yet")), "Not started yet")
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
}
