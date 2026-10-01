import Foundation
import XCTest
@testable import Walnut

/// A tier move keeps the task's `pin_order` on the server (`setFocusTier`), and
/// every band is sorted by it. The optimistic move used to put the row at the
/// FOOT of its new band, so the row jumped as soon as the server answered: the
/// same "a row moves under the reader's finger" class as the demo's new-task bug.
/// The board is read through `BoardModel.bands`, exactly as the screen draws it.
@MainActor
final class TierMovePinOrderTests: XCTestCase {
    /// Pin order f1 s1 f2 s2 f3 s3: Focus and Satellite interleave.
    private let pinned = ["f1", "s1", "f2", "s2", "f3", "s3"]

    private func split(focus: [String], satellite: [String], backlog: [String] = []) -> FocusTierResult {
        FocusTierResult(
            pinnedTasks: pinned, focusTasks: focus, satelliteTasks: satellite,
            backlogTasks: backlog, waitTasks: [], customTierTasks: [:]
        )
    }

    private func task(_ id: String) -> WalnutTask {
        WalnutTask(
            id: id, title: "Task \(id)", status: "todo", phase: "TODO", priority: "none",
            project: "", dueDate: nil, createdAt: "2026-09-01T00:00:00Z",
            updatedAt: "2026-09-01T00:00:00Z", completedAt: nil, starred: false,
            pinned: true, tags: nil, summary: nil
        )
    }

    private func rows(_ store: TasksStore, _ band: String) -> [String] {
        BoardModel.bands(
            tasks: store.tasks, sessions: [], tierOf: store.taskTiers,
            tierOrder: store.taskTierOrder, customTiers: [], shownDoneTiers: [band]
        ).first { $0.bandId == band }?.rows.map(\.id) ?? []
    }

    /// The store, the board as it stood, and a server that will answer `answer`.
    private func board(answer: FocusTierResult) -> (TasksStore, MockTaskTransport, CheckedContinuationGate) {
        let mock = MockTaskTransport()
        mock.tierSplitResult = answer
        let gate = CheckedContinuationGate()
        mock.gate = gate
        let store = TasksStore(transport: mock)
        store.tasks = pinned.map(task)
        store.adoptSplit(split(focus: ["f1", "f2", "f3"], satellite: ["s1", "s2", "s3"]))
        return (store, mock, gate)
    }

    override func tearDown() async throws {
        DiskCache.remove(key: TasksStore.focusSplitCacheKey)
    }

    /// Move, look at the board while the PUT is in flight, let the server answer,
    /// look again: one position, both times.
    private func move(_ id: String, to tier: String, in store: TasksStore, _ mock: MockTaskTransport,
                      _ gate: CheckedContinuationGate) async -> (optimistic: [String], answered: [String]) {
        let request = Task { await store.setTier(taskId: id, tier: tier) }
        while mock.callCount("setTaskFocusTier") == 0 { await Task.yield() }
        let optimistic = rows(store, tier)
        gate.open()
        let error = await request.value
        XCTAssertNil(error)
        return (optimistic, rows(store, tier))
    }

    func testARowMovedIntoTheMiddleOfABandStaysPutWhenTheServerAnswers() async {
        // s2 sits between f2 and f3 in pin order, so that is where Focus lists it.
        let (store, mock, gate) = board(answer: split(focus: ["f1", "f2", "s2", "f3"], satellite: ["s1", "s3"]))
        let seen = await move("s2", to: "focus", in: store, mock, gate)
        XCTAssertEqual(seen.optimistic, ["f1", "f2", "s2", "f3"],
                       "the row lands where the server will put it, not at the foot")
        XCTAssertEqual(seen.answered, seen.optimistic, "the server's answer does not move it")
        XCTAssertEqual(rows(store, "satellite"), ["s1", "s3"], "and its old band closes the gap")
    }

    func testARowMovedToTheTopOfABandStaysPut() async {
        // s1 is pinned before f2 and f3 but after f1.
        let (store, mock, gate) = board(answer: split(focus: ["f1", "s1", "f2", "f3"], satellite: ["s2", "s3"]))
        let seen = await move("s1", to: "focus", in: store, mock, gate)
        XCTAssertEqual(seen.optimistic, ["f1", "s1", "f2", "f3"])
        XCTAssertEqual(seen.answered, seen.optimistic)
    }

    func testTheNewestPinStillLandsAtTheFoot() async {
        let (store, mock, gate) = board(answer: split(focus: ["f1", "f2", "f3", "s3"], satellite: ["s1", "s2"]))
        let seen = await move("s3", to: "focus", in: store, mock, gate)
        XCTAssertEqual(seen.optimistic, ["f1", "f2", "f3", "s3"])
        XCTAssertEqual(seen.answered, seen.optimistic)
    }

    func testAMoveIntoAnEmptyBandAndBack() async {
        let (store, mock, gate) = board(answer: split(focus: ["f1", "f3"], satellite: ["s1", "s2", "s3"], backlog: ["f2"]))
        let seen = await move("f2", to: "backlog", in: store, mock, gate)
        XCTAssertEqual(seen.optimistic, ["f2"])
        XCTAssertEqual(seen.answered, ["f2"])
        XCTAssertEqual(rows(store, "focus"), ["f1", "f3"])
    }

    /// A task pinned since the last split has no place in it yet: it is the newest
    /// pin (`pin_order = max + 1`), so it sorts after everything the split listed.
    func testAPinTheSplitHasNotListedSortsLast() {
        XCTAssertEqual(TasksStore.inPinOrder(["new", "f3", "f1"], pinnedOrder: pinned), ["f1", "f3", "new"])
        XCTAssertEqual(TasksStore.inPinOrder(["n2", "n1"], pinnedOrder: pinned), ["n2", "n1"],
                       "unlisted ids keep the order they were given")
        XCTAssertEqual(TasksStore.inPinOrder([], pinnedOrder: pinned), [])
    }

    func testAFailedMoveRestoresTheBoard() async {
        let mock = MockTaskTransport()
        mock.errorsByEndpoint["setTaskFocusTier"] = APIError.badResponse
        let store = TasksStore(transport: mock)
        store.tasks = pinned.map(task)
        store.adoptSplit(split(focus: ["f1", "f2", "f3"], satellite: ["s1", "s2", "s3"]))
        let error = await store.setTier(taskId: "s2", tier: "focus")
        XCTAssertNotNil(error)
        XCTAssertEqual(rows(store, "focus"), ["f1", "f2", "f3"])
        XCTAssertEqual(rows(store, "satellite"), ["s1", "s2", "s3"])
    }

    /// Against the demo server, which follows the real server's rule: the answer
    /// to a tier move is the same order the board already shows.
    func testTheDemoServerAgrees() async throws {
        let savedURL = AppConfig.processServerURLOverride
        let savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.reset()
        defer {
            DemoServer.shared.reset()
            DemoServer.shared.latencyScale = 1
            AppConfig.processServerURLOverride = savedURL
            AppConfig.processTokenOverride = savedToken
            DiskCache.remove(key: "tasks-list")
            DiskCache.remove(key: "tasks-pending-created")
        }
        let store = TasksStore()
        await store.refreshBoard(origin: .pullToRefresh)
        // "Localize the settings screen" is a Satellite pin made before the last
        // Focus pin ("Get three quotes for the kitchen counter").
        let before = store.taskTierOrder["focus"] ?? []
        XCTAssertEqual(before.last, "t-quotes")
        let request = Task { await store.setTier(taskId: "t-l10n", tier: "focus") }
        // The optimistic write happens before the request goes out.
        while store.taskTiers["t-l10n"] != "focus" { await Task.yield() }
        let optimistic = store.taskTierOrder["focus"] ?? []
        let error = await request.value
        XCTAssertNil(error)
        let answered = store.taskTierOrder["focus"] ?? []
        XCTAssertEqual(answered, Array(before.dropLast()) + ["t-l10n", "t-quotes"])
        XCTAssertEqual(optimistic, answered, "the answer does not move the row")
        await store.refreshBoard(origin: .pullToRefresh)
        XCTAssertEqual(store.taskTierOrder["focus"], answered, "and neither does a refetch")
    }
}
