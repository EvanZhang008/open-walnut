import Foundation
import XCTest
@testable import Walnut

/// The demo server orders its writes the way the real server does, so a refetch
/// never moves a row the app has already placed. The bug this pins: a task made
/// in the demo sat at the foot of Satellite (where the app put it), and the next
/// poll moved it to the top, so the reader's next checkbox tap completed a
/// different task. The server appends a new task and pins it at the foot
/// (`pin_order = max + 1`); a completed pin keeps its place; a tier move keeps
/// its pin order; sessions list newest first.
@MainActor
final class DemoOrderTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private let api = WalnutAPI()

    override func setUp() async throws {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.turnScale = 0
        DemoServer.shared.reset()
        DemoURLProtocol.resetLog()
    }

    override func tearDown() async throws {
        // A live TasksStore caches what it saw; leave no demo rows for the next test.
        DiskCache.remove(key: "tasks-pending-created")
        DiskCache.remove(key: "tasks-list")
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        DemoServer.shared.turnScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    /// The Satellite band exactly as the board draws it, done rows included.
    private func satelliteRows(_ store: TasksStore) -> [String] {
        let bands = BoardModel.bands(
            tasks: store.tasks, sessions: store.sessions,
            tierOf: store.taskTiers, tierOrder: store.taskTierOrder,
            customTiers: [], shownDoneTiers: ["satellite"]
        )
        return bands.first { $0.bandId == "satellite" }?.rows.map(\.id) ?? []
    }

    func testTwoNewTasksKeepTheirPlaceThroughAFullRefetch() async throws {
        let store = TasksStore()
        await store.refreshBoard(origin: .pullToRefresh)
        let seeded = satelliteRows(store)
        XCTAssertFalse(seeded.isEmpty, "the sample board has Satellite rows")

        let first = try await store.createTask(title: "Order check one", pin: .tier("satellite"))
        let second = try await store.createTask(title: "Order check two", pin: .tier("satellite"))
        let placed = satelliteRows(store)
        XCTAssertEqual(placed, seeded + [first.id, second.id],
                       "the app puts each new task at the foot of Satellite")

        // Wait out a full refetch: the same bundle the board's poll runs.
        await store.refreshBoard(origin: .pullToRefresh)
        XCTAssertEqual(satelliteRows(store), placed, "a refetch must not move a row the app already placed")
        let refetched = try await api.focusTasks()
        XCTAssertEqual(refetched.satelliteTasks, placed)
        let listed = try await api.tasks().tasks.map(\.id)
        XCTAssertEqual(Array(listed.suffix(2)), [first.id, second.id], "the task list appends, as the server does")

        // Completing the first leaves it where it was (completion does not
        // unpin), so the row under the next tap is still the one the reader sees.
        _ = try await api.updateTask(id: first.id, status: "done")
        await store.refreshBoard(origin: .pullToRefresh)
        XCTAssertEqual(satelliteRows(store), placed, "a completed pin keeps its place")

        // A task made with no pin choice (the new-task sheet's default) also
        // lands at the foot once the board learns its tier.
        let third = try await store.createTask(title: "Order check three")
        await store.refreshBoard(origin: .pullToRefresh)
        XCTAssertEqual(satelliteRows(store), placed + [third.id])
        await store.refreshBoard(origin: .pullToRefresh)
        XCTAssertEqual(satelliteRows(store), placed + [third.id], "and stays there")
    }

    func testPinAndPhaseWritesFollowTheServer() async throws {
        let created = try await api.createTask(title: "Phase check")
        let done = try await api.updateTask(id: created.id, status: "done")
        let stamp = try XCTUnwrap(done.completedAt)
        try await Task.sleep(for: .milliseconds(5))
        let again = try await api.updateTask(id: created.id, status: "done")
        XCTAssertEqual(again.completedAt, stamp, "completing twice keeps the first moment, as applyPhase does")
        let afterDone = try await api.focusTasks()
        XCTAssertEqual(afterDone.satelliteTasks?.last, created.id, "a completed pin stays on the board")

        // Unpinning closes the gap; a completed task cannot be pinned again, and
        // an unpinned task has no tier to move to.
        let pinnedBefore = try await api.focusTasks().pinnedTasks
        let afterUnpin = try await api.unpinTask(id: created.id)
        XCTAssertEqual(afterUnpin, pinnedBefore.filter { $0 != created.id })
        do {
            _ = try await api.pinTask(id: created.id)
            XCTFail("pinning a completed task is refused")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "conflict")
        }
        do {
            _ = try await api.setTaskFocusTier(id: created.id, tier: "focus")
            XCTFail("an unpinned task has no tier")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "bad_request")
        }

        // Reopened and pinned again, it goes to the foot.
        let reopened = try await api.updateTask(id: created.id, status: "todo")
        XCTAssertNil(reopened.completedAt)
        let repinned = try await api.pinTask(id: created.id)
        XCTAssertEqual(repinned.last, created.id)
        // A tier move keeps the pin order: Focus lists it after every older Focus pin.
        let moved = try await api.setTaskFocusTier(id: created.id, tier: "focus")
        XCTAssertEqual(moved.focusTasks?.last, created.id)
        XCTAssertEqual(moved.pinnedTasks, repinned)

        // PATCH takes a phase too, but never with a status.
        let phased = try await patch(created.id, ["phase": "NEED_ACTION"])
        XCTAssertEqual(phased, 200)
        let tasks = try await api.tasks().tasks
        XCTAssertEqual(tasks.first { $0.id == created.id }?.phase, "NEED_ACTION")
        let unknown = try await patch(created.id, ["phase": "DONE"])
        XCTAssertEqual(unknown, 400)
        let both = try await patch(created.id, ["phase": "COMPLETE", "status": "done"])
        XCTAssertEqual(both, 400)
    }

    func testLaunchesAndForksJoinTheBoardFootAndListNewestFirst() async throws {
        let before = try await api.focusTasks().pinnedTasks
        let launched = try await api.createSession(cwd: "/Users/demo/code/pebble", message: "")
        var split = try await api.focusTasks()
        XCTAssertEqual(split.pinnedTasks, before + [launched.taskId], "a launch's task is born pinned at the foot")
        XCTAssertEqual(split.satelliteTasks?.last, launched.taskId)

        let forked = try await api.forkSession(id: "s-crash", message: nil)
        split = try await api.focusTasks()
        XCTAssertEqual(split.pinnedTasks, before + [launched.taskId, forked.taskId])
        XCTAssertEqual(split.focusTasks?.last, forked.taskId, "a fork inherits its source's tier")

        let sessions = try await api.sessions().sessions
        let stamps = sessions.map(\.lastActiveAt)
        XCTAssertEqual(stamps, stamps.sorted(by: >), "sessions list newest first")
        XCTAssertEqual(Set(sessions.prefix(2).map(\.id)), [launched.sessionId, forked.sessionId])
    }

    /// A raw PATCH, for the fields `WalnutAPI.updateTask` never sends.
    private func patch(_ id: String, _ body: [String: String]) async throws -> Int {
        var request = URLRequest(url: DemoMode.baseURL.appendingPathComponent("/api/v1/tasks/\(id)"))
        request.httpMethod = "PATCH"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await URLSession.shared.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode ?? 0
    }
}
