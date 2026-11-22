import XCTest
@testable import Walnut

/// The focus space through the real stores: `TasksStore`'s derived slices follow the scope and
/// come back whole when it ends (while `tasks` itself stays whole), and `FocusSpacesStore` reads,
/// enters, leaves and ends the focus, and asks nothing with the experiment off.
@MainActor
final class FocusSpacesStoreTests: XCTestCase {

    // MARK: - Fixtures

    private func task(
        _ id: String, project: String = "", parent: String? = nil,
        status: String = "todo", pinned: Bool? = nil, orgRole: String? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: id, status: status, phase: "TODO", priority: "none",
            project: project, dueDate: nil, createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: pinned, tags: nil, summary: nil, parentTaskId: parent, orgRole: orgRole
        )
    }

    private var board: [WalnutTask] {
        [
            task("w1", project: "Walnut"),
            task("w1-sub", project: "Home", parent: "w1", status: "in_progress"),
            task("w-done", project: "walnut", status: "done"),
            task("h1", project: "Home"),
            task("h2", project: "Home", status: "in_progress"),
            task("h-done", project: "Home", status: "done"),
            task("vp", project: "Org", orgRole: "lead"),
        ]
    }

    private func ids(_ rows: [WalnutTask]) -> Set<String> { Set(rows.map(\.id)) }

    private func listing(_ active: ActiveFocusSpace?) -> FocusSpacesListing {
        FocusSpacesListing(
            spaces: [FocusSpace(id: "fs-1", name: "Deep work", projects: ["Walnut"]),
                     FocusSpace(id: "fs-2", name: "Home", projects: ["Home"])],
            active: active
        )
    }

    private func walnutFocus(until: Date? = nil) -> ActiveFocusSpace {
        ActiveFocusSpace(spaceId: "fs-1", name: "Deep work", scope: FocusSpaceScope(projects: ["Walnut"]),
                         since: 0, until: until.map { $0.timeIntervalSince1970 * 1000 })
    }

    /// Counts calls and hands back a scripted answer.
    private final class Script {
        var fetches = 0
        var listing = FocusSpacesListing()
        var fetchError: Error?
        var enterError: Error?
        var leaveError: Error?
        var entered: [(String, Date?)] = []
        var leaves = 0
        var clock = Date(timeIntervalSince1970: 1_763_700_000)
        var onFetch: (() -> Void)?
    }

    private func makeStore(_ script: Script, experimentOn: Bool = true) -> FocusSpacesStore {
        FocusSpacesStore(
            fetch: {
                script.fetches += 1
                script.onFetch?()
                if let error = script.fetchError { throw error }
                return script.listing
            },
            enter: { id, until in
                script.entered.append((id, until))
                if let error = script.enterError { throw error }
                return ActiveFocusSpace(spaceId: id, name: "Deep work", scope: FocusSpaceScope(projects: ["Walnut"]),
                                        since: script.clock.timeIntervalSince1970 * 1000,
                                        until: until.map { $0.timeIntervalSince1970 * 1000 })
            },
            leave: {
                script.leaves += 1
                if let error = script.leaveError { throw error }
            },
            experimentOn: { experimentOn },
            now: { script.clock }
        )
    }

    // MARK: - TasksStore: the slices follow the scope

    func testTheSlicesFollowTheScopeAndComeBackWholeWhenItEnds() {
        let store = TasksStore()
        store._applyFeedMutationsForTesting([.snapshot(tasks: board, sessions: [])])
        let wholeOpen = ids(store.tasks(for: .allOpen))
        XCTAssertEqual(wholeOpen, ["w1", "w1-sub", "h1", "h2", "vp"])
        XCTAssertEqual(store.focusSpaceOutsideCount, 0, "no focus, nothing waits outside")
        let genBefore = store.boardInputsGen

        store.focusSpaceScope = FocusSpaceScope(projects: ["walnut"])
        XCTAssertEqual(ids(store.tasks(for: .allOpen)), ["w1", "w1-sub"], "the subtask rides its parent in")
        XCTAssertEqual(ids(store.tasks(for: .inProgress)), ["w1-sub"])
        XCTAssertEqual(ids(store.tasks(for: .done)), ["w-done"])
        XCTAssertEqual(ids(store.focusedTasks), ["w1", "w1-sub", "w-done"])
        XCTAssertEqual(store.tasks.count, board.count, "the store's own list stays whole")
        XCTAssertEqual(store.focusSpaceOutsideCount, 2, "h1 and h2: open, outside, not an org node")
        XCTAssertNotEqual(store.boardInputsGen, genBefore, "the board memo sees the focus change")
        XCTAssertTrue(store.isInFocusSpace("w1-sub"))
        XCTAssertFalse(store.isInFocusSpace("h1"))

        // A row that arrives inside shows at once; one outside only adds to what waits.
        store._applyFeedMutationsForTesting([.taskUpsert(task("w2", project: "Walnut")),
                                             .taskUpsert(task("h3", project: "Home"))])
        XCTAssertEqual(ids(store.tasks(for: .allOpen)), ["w1", "w1-sub", "w2"])
        XCTAssertEqual(store.focusSpaceOutsideCount, 3)

        store.focusSpaceScope = nil
        XCTAssertEqual(ids(store.tasks(for: .allOpen)), wholeOpen.union(["w2", "h3"]))
        XCTAssertEqual(store.focusedTasks.count, store.tasks.count)
        XCTAssertEqual(store.focusSpaceOutsideCount, 0)
        XCTAssertTrue(store.isInFocusSpace("h1"), "with no focus everything is inside")
    }

    func testTheBoardCountInAFocusIsItsPinnedTasksInside() {
        let store = TasksStore()
        store._applyFeedMutationsForTesting([.snapshot(tasks: [
            task("w1", project: "Walnut", pinned: true),
            task("h1", project: "Home", pinned: true),
            task("w2", project: "Walnut"),
        ], sessions: [])])
        XCTAssertEqual(store.count(for: .sessions), 2)
        store.focusSpaceScope = FocusSpaceScope(projects: ["Walnut"])
        XCTAssertEqual(store.count(for: .sessions), 1)
        store.taskTiers = ["w1": "focus", "h1": "satellite"]
        XCTAssertEqual(store.count(for: .sessions), 1)
    }

    /// 2026-11-22 UI gate: in a focus the board gained rows. The board gives a pinned session
    /// whose task it was not handed a row of its own, so every left-out task with a pinned session
    /// came back as a session row. The board is fed the focus's sessions too.
    func testTheBoardInAFocusShowsNoSessionRowOfATaskOutsideIt() {
        let store = TasksStore()
        let pinned = [task("w1", project: "Walnut", pinned: true), task("h1", project: "Home", pinned: true)]
        let sessions = [session("s-w1", taskId: "w1"), session("s-h1", taskId: "h1"), session("s-none", taskId: nil)]
        store._applyFeedMutationsForTesting([.snapshot(tasks: pinned, sessions: sessions)])
        store.focusSpaceScope = FocusSpaceScope(projects: ["Walnut"])
        XCTAssertEqual(store.focusedSessions.map(\.id), ["s-w1"])

        let board = BoardModel.assemble(
            tasks: store.focusedTasks, sessions: store.focusedSessions, tierOf: [:], tierOrder: [:],
            customTiers: [], query: "", grouping: .tier
        )
        XCTAssertEqual(Set(board.bands.flatMap { $0.rows.map(\.id) }), ["w1"], "h1 never comes back as a session row")

        store.focusSpaceScope = nil
        XCTAssertEqual(store.focusedSessions.count, sessions.count, "no focus: every session")
    }

    private func session(_ id: String, taskId: String?) -> WalnutSession {
        WalnutSession(
            id: id, title: "s-\(id)", taskId: taskId, taskTitle: "t", project: nil,
            host: "", processStatus: "idle", model: nil, mode: nil,
            startedAt: "2026-11-22T00:00:00Z", lastActiveAt: "2026-11-22T00:00:00Z",
            messageCount: 1, cwd: nil, pinned: true, focusTier: nil, description: nil
        )
    }

    // MARK: - FocusSpacesStore

    func testWithTheExperimentOffNothingIsAskedAndNothingNarrowed() async {
        let script = Script()
        script.listing = listing(walnutFocus())
        let tasks = TasksStore()
        let store = makeStore(script, experimentOn: false)
        store.attach(tasks: tasks)
        await store.refresh()
        XCTAssertEqual(script.fetches, 0, "no request to the focus routes")
        XCTAssertFalse(store.isAvailable)
        XCTAssertNil(store.active)
        XCTAssertNil(tasks.focusSpaceScope)
    }

    func testAReadHandsTheScopeToTheLists() async {
        let script = Script()
        script.listing = listing(walnutFocus())
        let tasks = TasksStore()
        let store = makeStore(script)
        store.attach(tasks: tasks)
        await store.refresh()
        XCTAssertTrue(store.isAvailable)
        XCTAssertEqual(store.spaces.map(\.id), ["fs-1", "fs-2"])
        XCTAssertEqual(store.active?.name, "Deep work")
        XCTAssertEqual(tasks.focusSpaceScope, FocusSpaceScope(projects: ["Walnut"]))
    }

    func testTheServerSayingExperimentOffClearsEverything() async {
        let script = Script()
        script.listing = listing(walnutFocus())
        let tasks = TasksStore()
        let store = makeStore(script)
        store.attach(tasks: tasks)
        await store.refresh()
        XCTAssertNotNil(tasks.focusSpaceScope)

        script.fetchError = APIError.server(status: 404, code: "experiment_off", message: "Experiment is off",
                                            serverHash: nil, serverContent: nil)
        await store.refresh()
        XCTAssertFalse(store.isAvailable)
        XCTAssertNil(store.active)
        XCTAssertEqual(store.spaces, [])
        XCTAssertNil(tasks.focusSpaceScope)
    }

    func testAFailedReadKeepsWhatIsShown() async {
        let script = Script()
        script.listing = listing(walnutFocus())
        let tasks = TasksStore()
        let store = makeStore(script)
        store.attach(tasks: tasks)
        await store.refresh()
        script.fetchError = APIError.network(underlying: URLError(.notConnectedToInternet))
        await store.refresh()
        XCTAssertEqual(store.active?.spaceId, "fs-1", "offline is not the focus ending")
        XCTAssertNotNil(tasks.focusSpaceScope)
    }

    func testAFocusThatHasEndedReadsAsNone() async {
        let script = Script()
        script.listing = listing(walnutFocus(until: script.clock.addingTimeInterval(-60)))
        let tasks = TasksStore()
        let store = makeStore(script)
        store.attach(tasks: tasks)
        await store.refresh()
        XCTAssertNil(store.active)
        XCTAssertNil(tasks.focusSpaceScope)
    }

    func testTheFocusEndsOnThePhoneWhenItsTimeComes() async {
        let script = Script()
        script.listing = listing(walnutFocus(until: script.clock.addingTimeInterval(3600)))
        let tasks = TasksStore()
        let store = makeStore(script)
        store.attach(tasks: tasks)
        await store.refresh()
        XCTAssertNotNil(store.active)

        // Not yet due: nothing changes.
        store._expireIfDueForTesting()
        XCTAssertNotNil(store.active)

        // Past its end: the lists come back whole at once, before any read answers.
        script.listing = listing(nil)
        script.clock = script.clock.addingTimeInterval(3601)
        store._expireIfDueForTesting()
        XCTAssertNil(store.active)
        XCTAssertNil(tasks.focusSpaceScope)
    }

    func testEnteringTakesTheServersAnswer() async {
        let script = Script()
        script.listing = listing(nil)
        let tasks = TasksStore()
        let store = makeStore(script)
        store.attach(tasks: tasks)
        await store.refresh()
        XCTAssertNil(store.active)

        let until = FocusSpaceLength.oneHour.until(from: script.clock)
        await store.enter(spaceId: "fs-1", until: until)
        XCTAssertEqual(script.entered.first?.0, "fs-1")
        XCTAssertEqual(script.entered.first?.1, until)
        XCTAssertEqual(store.active?.spaceId, "fs-1")
        XCTAssertEqual(tasks.focusSpaceScope, FocusSpaceScope(projects: ["Walnut"]))
    }

    func testARefusedEnterShowsTheServersWords() async {
        let script = Script()
        script.enterError = APIError.server(status: 501, code: "not_supported_cloud",
                                            message: "Not supported on the cloud companion",
                                            serverHash: nil, serverContent: nil)
        let tasks = TasksStore()
        let store = makeStore(script)
        store.attach(tasks: tasks)
        await store.enter(spaceId: "fs-1", until: nil)
        XCTAssertNil(store.active)
        XCTAssertNil(tasks.focusSpaceScope)
        XCTAssertEqual(tasks.transientError, "Focus not entered: Not supported on the cloud companion")
    }

    func testLeavingShowsAtOnceAndARefusalPutsItBack() async {
        let script = Script()
        script.listing = listing(walnutFocus())
        let tasks = TasksStore()
        let store = makeStore(script)
        store.attach(tasks: tasks)
        await store.refresh()

        await store.leave()
        XCTAssertEqual(script.leaves, 1)
        XCTAssertNil(store.active)
        XCTAssertNil(tasks.focusSpaceScope)

        await store.refresh()
        script.leaveError = APIError.server(status: 501, code: "not_supported_cloud", message: "Not here",
                                            serverHash: nil, serverContent: nil)
        await store.leave()
        XCTAssertEqual(store.active?.spaceId, "fs-1", "a refused leave puts the focus back")
        XCTAssertNotNil(tasks.focusSpaceScope)
        XCTAssertEqual(tasks.transientError, "Focus not left: Not here")
    }

    func testTheFeedsFocusChangedFrameReadsAgain() async {
        let script = Script()
        script.listing = listing(nil)
        let tasks = TasksStore()
        let store = makeStore(script)
        store.attach(tasks: tasks)
        await store.refresh()
        XCTAssertEqual(script.fetches, 1)

        let read = expectation(description: "a read after focus-changed")
        read.assertForOverFulfill = false
        script.listing = listing(walnutFocus())
        script.onFetch = { read.fulfill() }
        // Two frames in one batch: one read.
        tasks._applyFeedMutationsForTesting([.focusChanged, .focusChanged])
        await fulfillment(of: [read], timeout: 2)
        script.onFetch = nil
        await store.refresh() // joins or follows the read the frame started
        XCTAssertEqual(store.active?.spaceId, "fs-1")
        XCTAssertEqual(tasks.focusSpaceScope, FocusSpaceScope(projects: ["Walnut"]))
    }
}
