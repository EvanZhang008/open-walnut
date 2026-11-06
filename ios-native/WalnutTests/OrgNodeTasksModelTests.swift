import XCTest
@testable import Walnut

/// An Org node's Tasks view (OrgNodeTasksModel) and where a tapped task goes (TaskOpenModel).
final class OrgNodeTasksModelTests: XCTestCase {
    private static let now = WalnutTask.parseISO("2026-11-04T12:00:00Z")!

    private func task(
        _ id: String, project: String = "Walnut", phase: String = "IN_PROGRESS", status: String = "in_progress",
        user: WalnutUserStatus? = nil, completed: String? = nil, pinned: Bool? = nil, role: String? = nil, watched: String? = nil
    ) -> WalnutTask {
        var t = WalnutTask(
            id: id, title: "Task \(id)", status: status, phase: phase, priority: "none", project: project,
            dueDate: nil, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-04T10:00:00Z", completedAt: completed,
            starred: nil, pinned: pinned, tags: nil, summary: nil, parentTaskId: nil, userStatus: user
        )
        t.orgRole = role
        t.watchedAt = watched
        return t
    }

    private func tree() throws -> OrgTreeWire {
        let json = #"""
        {"main":{"id":"ceo","title":"Main","phase":"IN_PROGRESS"},
         "projects":[
          {"project":"Walnut","lead":{"id":"vp","title":"Walnut lead","phase":"IN_PROGRESS"},"counts":{"open":3,"running":1,"needsYou":1,"waiting":1},
           "teams":[{"id":"a","workers":[{"id":"a1"}]},{"id":"b"},{"id":"vp"}]},
          {"project":"Garden","lead":{"id":"vp2","title":"Garden lead","phase":"IN_PROGRESS"},"counts":{"open":1,"running":0,"needsYou":0,"waiting":1},
           "teams":[{"id":"g"}]},
          {"project":"Docs","vp":"Walnut","counts":{"open":1,"running":0,"needsYou":0,"waiting":1},"teams":[{"id":"doc"}]}],
         "counts":{"open":4,"running":1,"needsYou":1,"waiting":2}}
        """#
        return try JSONDecoder().decode(OrgTreeWire.self, from: Data(json.utf8))
    }

    func testAVpsWorkIsItsTeamsAndAWeekOfFinishedWork() throws {
        let all = [
            task("vp", role: "lead"), task("a"), task("a1"), task("b", user: .init(state: "needs", ask: "Pick one")),
            task("g", project: "Garden"), task("doc", project: "Docs"),
            task("doneRecent", phase: "COMPLETE", status: "done", completed: "2026-11-03T00:00:00Z"),
            task("doneOld", phase: "COMPLETE", status: "done", completed: "2026-10-01T00:00:00Z"),
            task("stray"),
        ]
        let mine = OrgNodeTasksModel.tasks(nodeId: "vp", isMain: false, tree: try tree(), all: all, now: Self.now)
        // Its own project's teams and the project it leads for another (Docs), never Garden's.
        XCTAssertEqual(Set(mine.map(\.id)), ["a", "a1", "b", "doc", "doneRecent"])
        // Main's is every project's, never a VP's own chat.
        let main = OrgNodeTasksModel.tasks(nodeId: "ceo", isMain: true, tree: try tree(), all: all, now: Self.now)
        XCTAssertEqual(Set(main.map(\.id)), ["a", "a1", "b", "g", "doc", "doneRecent"])
    }

    func testStatusSectionsFollowTheHomeOrderAndAWatchedTaskIsInWatchingOnly() {
        let rows = [
            task("w", user: .init(state: "working"), watched: "2026-11-04T09:00:00Z"),
            task("n", user: .init(state: "needs", ask: "Approve?")),
            task("r", user: .init(state: "working")),
            task("z", phase: "WAITING", user: .init(state: "waiting", kind: "time")),
            task("d", phase: "COMPLETE", status: "done", completed: "2026-11-04T01:00:00Z"),
        ]
        let s = OrgNodeTasksModel.statusSections(rows)
        XCTAssertEqual(s.map(\.id), ["watching", "needs", "working", "waiting", "done"])
        XCTAssertEqual(s.first?.rows.map(\.id), ["w"])
        XCTAssertEqual(s.map(\.openByDefault), [true, true, true, false, false])
    }

    func testPinGroupsFollowTheTierOrderThenNotPinned() {
        let rows = [
            task("f", pinned: true), task("s", pinned: true), task("u"),
            task("d", phase: "COMPLETE", status: "done", completed: "2026-11-04T01:00:00Z", pinned: true),
        ]
        let tiers = [(id: "focus", label: "Focus"), (id: "satellite", label: "Satellite")]
        let s = OrgNodeTasksModel.pinSections(rows, tiers: tiers) { $0.id == "f" ? "focus" : "satellite" }
        XCTAssertEqual(s.map(\.title), ["Focus", "Satellite", "Not pinned"])
        XCTAssertEqual(s.map { $0.rows.map(\.id) }, [["f"], ["s"], ["u"]])
        XCTAssertEqual(s.map(\.openByDefault), [true, false, false])
        // No Focus group: the first one opens.
        let noFocus = OrgNodeTasksModel.pinSections(rows, tiers: tiers) { _ in "satellite" }
        XCTAssertEqual(noFocus.map(\.openByDefault), [true, false])
    }

    func testARowsLineIsWhatItNeedsOrDoesNeverAPhase() {
        XCTAssertEqual(OrgNodeTasksModel.line(task("n", user: .init(state: "needs", ask: "Approve the deploy?"))), "Decide: Approve the deploy?")
        XCTAssertEqual(OrgNodeTasksModel.line(task("r", user: .init(state: "working", now: "Building the app"))), "Building the app")
        XCTAssertNil(OrgNodeTasksModel.line(task("d", phase: "COMPLETE", status: "done", completed: "2026-11-04T01:00:00Z")))
        // The placeholder of a turn whose report is still coming is never shown.
        var transient = WalnutUserStatus(state: "waiting", kind: "other", waitingOn: "Its report on the turn that just ended")
        transient.transient = true
        XCTAssertNil(OrgNodeTasksModel.line(task("t", user: transient)))
    }

    // MARK: - Where a tapped task goes

    private func session(_ id: String, task: String?, active: String) -> WalnutSession {
        WalnutSession(
            id: id, title: "S \(id)", taskId: task, taskTitle: nil, project: nil, host: "",
            processStatus: "idle", model: nil, mode: nil, startedAt: active, lastActiveAt: active,
            messageCount: 1, cwd: nil, pinned: nil, focusTier: nil, description: nil)
    }

    func testATaskWithAListedSessionOpensItsNewest() {
        let sessions = [session("old", task: "t", active: "2026-11-04T08:00:00Z"), session("new", task: "t", active: "2026-11-04T09:00:00Z"), session("x", task: "other", active: "2026-11-04T10:00:00Z")]
        XCTAssertEqual(TaskOpenModel.firstStep(taskId: "t", sessions: sessions), .session(sessions[1]))
        XCTAssertEqual(TaskOpenModel.firstStep(taskId: "none", sessions: sessions), .lookUp)
    }
}
