import Foundation
import XCTest
@testable import Walnut

/// `PinTierPolicy`, the one rule every tier picker, band and chip reads: two built-ins
/// offered (Focus, Satellite), custom and plugin tiers kept, the retired Backlog and Wait
/// shown in Satellite, and a tap on the selected tier unpins. The store half runs the
/// writes against a scripted transport, in the order the server needs them.
@MainActor
final class PinTierPolicyTests: XCTestCase {
    /// A custom tier made on the desktop, and a plugin's (a Virtual Teammate's) tier.
    private let later = FocusTierInfo(id: "ct_later", label: "Later")
    private let teammate = FocusTierInfo(id: "ct_vt0001", label: "Review bot")

    private func task(_ id: String, pinned: Bool = true) -> WalnutTask {
        WalnutTask(
            id: id, title: "Task \(id)", status: "todo", phase: "TODO", priority: "none",
            project: "", dueDate: nil, createdAt: "2026-09-01T00:00:00Z",
            updatedAt: "2026-09-01T00:00:00Z", completedAt: nil, starred: false,
            pinned: pinned, tags: nil, summary: nil
        )
    }

    override func tearDown() async throws {
        DiskCache.remove(key: TasksStore.focusSplitCacheKey)
    }

    // MARK: - What is offered

    func testOnlyFocusAndSatelliteAreOfferedAsBuiltIns() {
        XCTAssertEqual(PinTierPolicy.offeredBuiltins.map(\.id), ["focus", "satellite"])
        XCTAssertEqual(PinTierPolicy.offeredBuiltins.map(\.label), ["Focus", "Satellite"])
        XCTAssertEqual(PinTierPolicy.choices(custom: []).map(\.id), ["focus", "satellite"])
        XCTAssertEqual(PinTierPolicy.defaultTier, "satellite")
    }

    func testCustomAndPluginTiersAreKeptInRegistryOrder() {
        let choices = PinTierPolicy.choices(custom: [later, teammate])
        XCTAssertEqual(choices.map(\.id), ["focus", "satellite", "ct_later", "ct_vt0001"])
        XCTAssertEqual(choices.map(\.label), ["Focus", "Satellite", "Later", "Review bot"])
    }

    /// No registry shape brings Parked back: a retired id, an empty one, a repeat, or a
    /// custom entry reusing a built-in id is left out.
    func testARegistryCannotOfferARetiredEmptyOrRepeatedTier() {
        let registry = [
            FocusTierInfo(id: "wait", label: "Parked"),
            FocusTierInfo(id: "backlog", label: "Backlog"),
            FocusTierInfo(id: "", label: "Nameless"),
            FocusTierInfo(id: "focus", label: "Focus again"),
            later,
            FocusTierInfo(id: "ct_later", label: "Later again"),
        ]
        let choices = PinTierPolicy.choices(custom: registry)
        XCTAssertEqual(choices.map(\.id), ["focus", "satellite", "ct_later"])
        XCTAssertEqual(choices.map(\.label), ["Focus", "Satellite", "Later"])
        XCTAssertFalse(choices.contains { $0.label == "Parked" })
    }

    // MARK: - What is shown

    func testARetiredTierIsShownInSatelliteAndEverythingElseAsStored() {
        XCTAssertEqual(PinTierPolicy.displayTier("wait"), "satellite")
        XCTAssertEqual(PinTierPolicy.displayTier("backlog"), "satellite")
        XCTAssertEqual(PinTierPolicy.displayTier("focus"), "focus")
        XCTAssertEqual(PinTierPolicy.displayTier("satellite"), "satellite")
        XCTAssertEqual(PinTierPolicy.displayTier("ct_later"), "ct_later")
        XCTAssertNil(PinTierPolicy.displayTier(nil), "not pinned (or not known yet) stays nil")
    }

    func testLabelsNeverNameARetiredTierOrARawCustomId() {
        XCTAssertEqual(PinTierPolicy.label(for: "wait", custom: [later]), "Satellite")
        XCTAssertEqual(PinTierPolicy.label(for: "backlog", custom: [later]), "Satellite")
        XCTAssertEqual(PinTierPolicy.label(for: "ct_later", custom: [later]), "Later")
        XCTAssertEqual(PinTierPolicy.label(for: "ct_gone99", custom: [later]), "Satellite",
                       "a custom tier deleted on the desktop reads where the board draws it")
        XCTAssertEqual(PinTierPolicy.label(for: "focus", custom: []), "Focus")
    }

    func testTheSelectedTierIsTheBandTheTaskIsDrawnIn() {
        let offered = PinTierPolicy.choices(custom: [later])
        XCTAssertNil(PinTierPolicy.selected(pinned: false, stored: nil, offered: offered))
        XCTAssertNil(PinTierPolicy.selected(pinned: false, stored: "focus", offered: offered),
                     "an unpinned task has no selected tier")
        XCTAssertEqual(PinTierPolicy.selected(pinned: true, stored: nil, offered: offered), "satellite")
        XCTAssertEqual(PinTierPolicy.selected(pinned: true, stored: "wait", offered: offered), "satellite")
        XCTAssertEqual(PinTierPolicy.selected(pinned: true, stored: "backlog", offered: offered), "satellite")
        XCTAssertEqual(PinTierPolicy.selected(pinned: true, stored: "ct_gone99", offered: offered), "satellite")
        XCTAssertEqual(PinTierPolicy.selected(pinned: true, stored: "ct_later", offered: offered), "ct_later")
        XCTAssertEqual(PinTierPolicy.selected(pinned: true, stored: "focus", offered: offered), "focus")
    }

    /// A task the tier map names is pinned even while its own flag lags the split.
    func testATaskInTheTierMapIsSelectedEvenBeforeItsPinnedFlagCatchesUp() {
        let offered = PinTierPolicy.choices(custom: [])
        let lagging = task("t1", pinned: false)
        XCTAssertEqual(PinTierPolicy.selected(task: lagging, tierOf: ["t1": "focus"], offered: offered), "focus")
        XCTAssertNil(PinTierPolicy.selected(task: lagging, tierOf: [:], offered: offered))
        XCTAssertEqual(PinTierPolicy.selected(task: task("t2"), tierOf: [:], offered: offered), "satellite")
    }

    // MARK: - What a tap writes

    func testATapOnTheSelectedTierUnpins() {
        XCTAssertEqual(PinTierPolicy.writes(picking: "focus", selected: "focus"), [.unpin])
        XCTAssertEqual(PinTierPolicy.writes(picking: "satellite", selected: "satellite"), [.unpin])
        XCTAssertEqual(PinTierPolicy.writes(picking: "ct_later", selected: "ct_later"), [.unpin])
    }

    func testATapOnAnotherTierMovesWithoutTouchingThePin() {
        XCTAssertEqual(PinTierPolicy.writes(picking: "focus", selected: "satellite"), [.setTier("focus")])
        XCTAssertEqual(PinTierPolicy.writes(picking: "ct_later", selected: "focus"), [.setTier("ct_later")])
        XCTAssertEqual(PinTierPolicy.writes(picking: "satellite", selected: "ct_later"), [.setTier("satellite")])
    }

    /// The tier PUT refuses an unpinned task, so a pin goes first; a fresh pin already
    /// lands in Satellite, so that one is the pin alone.
    func testATapOnAnUnpinnedTaskPinsIntoThatTier() {
        XCTAssertEqual(PinTierPolicy.writes(picking: "satellite", selected: nil), [.pin])
        XCTAssertEqual(PinTierPolicy.writes(picking: "focus", selected: nil), [.pin, .setTier("focus")])
        XCTAssertEqual(PinTierPolicy.writes(picking: "ct_later", selected: nil), [.pin, .setTier("ct_later")])
    }

    func testNoPickEverWritesARetiredTier() {
        let offered = PinTierPolicy.choices(custom: [later])
        for selected in [nil] + offered.map { Optional($0.id) } {
            for choice in offered {
                for write in PinTierPolicy.writes(picking: choice.id, selected: selected) {
                    if case .setTier(let tier) = write {
                        XCTAssertFalse(PinTierPolicy.isRetired(tier), "picking \(choice.id) from \(selected ?? "nil")")
                    }
                }
            }
        }
    }

    func testTheMenuSaysWhatATapDoes() {
        XCTAssertEqual(PinTierPolicy.menuTitle(pinned: true), "Move to Tier")
        XCTAssertEqual(PinTierPolicy.menuTitle(pinned: false), "Pin")
    }

    // MARK: - The split as shown

    func testTheDisplayMapFoldsRetiredTiersIntoSatellite() {
        let shown = PinTierPolicy.displayMap(["a": "focus", "b": "backlog", "c": "wait", "d": "ct_later", "e": "satellite"])
        XCTAssertEqual(shown, ["a": "focus", "b": "satellite", "c": "satellite", "d": "ct_later", "e": "satellite"])
    }

    func testTheDisplayOrderPutsOldShelvedTasksAmongSatelliteInPinOrder() {
        let order = PinTierPolicy.displayOrder(
            ["focus": ["f1"], "satellite": ["s1", "s2"], "backlog": ["b1"], "wait": ["w1"], "ct_later": ["l1"]],
            pinnedOrder: ["w1", "f1", "s1", "b1", "l1", "s2"]
        )
        XCTAssertEqual(order["satellite"], ["w1", "s1", "b1", "s2"])
        XCTAssertEqual(order["focus"], ["f1"])
        XCTAssertEqual(order["ct_later"], ["l1"], "a custom tier keeps its own band")
        XCTAssertNil(order["backlog"])
        XCTAssertNil(order["wait"])
    }

    // MARK: - An old task stored in Backlog or Wait

    /// A task an older client (or a plugin) parked stays on the board, in Satellite,
    /// checked as Satellite, with no band or chip of its own; its stored tier is untouched.
    func testAnOldWaitOrBacklogTaskStaysVisibleInSatellite() {
        let store = TasksStore(transport: MockTaskTransport())
        store.tasks = ["f1", "w1", "b1", "l1"].map { task($0) }
        store.customTiers = [later]
        store.adoptSplit(FocusTierResult(
            pinnedTasks: ["f1", "w1", "b1", "l1"], focusTasks: ["f1"], satelliteTasks: [],
            backlogTasks: ["b1"], waitTasks: ["w1"], customTierTasks: ["ct_later": ["l1"]]
        ))

        XCTAssertEqual(store.tierId(for: "w1"), "satellite")
        XCTAssertEqual(store.tierId(for: "b1"), "satellite")
        XCTAssertEqual(store.tierId(for: "l1"), "ct_later")
        XCTAssertEqual(store.tierBadge(for: store.tasks[1]), "Satellite")
        XCTAssertEqual(store.selectedTier(for: store.tasks[1]), "satellite")
        XCTAssertEqual(store.allTierChoices.map(\.id), ["focus", "satellite", "ct_later"])

        let bands = BoardModel.bands(
            tasks: store.tasks, sessions: [], tierOf: store.taskTiers,
            tierOrder: store.taskTierOrder, customTiers: store.customTiers
        )
        XCTAssertEqual(bands.map(\.bandId), ["focus", "satellite", "ct_later"])
        XCTAssertEqual(bands.first { $0.bandId == "satellite" }?.rows.map(\.id), ["w1", "b1"])
    }

    // MARK: - The store runs the writes in order

    private func calls(_ mock: MockTaskTransport) -> [String] {
        mock.calls.map(\.name).filter { ["pinTask", "unpinTask", "setTaskFocusTier"].contains($0) }
    }

    func testPickingFocusForAnUnpinnedTaskPinsThenSetsTheTier() async {
        let mock = MockTaskTransport()
        mock.tierSplitResult = FocusTierResult(
            pinnedTasks: ["t1"], focusTasks: ["t1"], satelliteTasks: [],
            backlogTasks: [], waitTasks: [], customTierTasks: [:]
        )
        let store = TasksStore(transport: mock)
        store.tasks = [task("t1", pinned: false)]
        var heard: [Bool] = []

        let failure = await store.pickTier("focus", for: store.tasks[0]) { heard.append($0) }

        XCTAssertNil(failure)
        XCTAssertEqual(calls(mock), ["pinTask", "setTaskFocusTier"])
        XCTAssertEqual(mock.lastCall("setTaskFocusTier")?.args, ["t1", "focus"])
        XCTAssertEqual(heard, [true])
        XCTAssertEqual(store.tierId(for: "t1"), "focus")
    }

    func testPickingSatelliteForAnUnpinnedTaskIsThePinAlone() async {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        store.tasks = [task("t1", pinned: false)]

        let failure = await store.pickTier("satellite", for: store.tasks[0])

        XCTAssertNil(failure)
        XCTAssertEqual(calls(mock), ["pinTask"])
        XCTAssertEqual(store.tierId(for: "t1"), "satellite")
    }

    func testReTappingTheSelectedTierUnpinsAndWritesNoTier() async {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        store.tasks = [task("t1")]
        store.adoptSplit(FocusTierResult(
            pinnedTasks: ["t1"], focusTasks: ["t1"], satelliteTasks: [],
            backlogTasks: [], waitTasks: [], customTierTasks: [:]
        ))
        var heard: [Bool] = []

        let failure = await store.pickTier("focus", for: store.tasks[0]) { heard.append($0) }

        XCTAssertNil(failure)
        XCTAssertEqual(calls(mock), ["unpinTask"])
        XCTAssertEqual(heard, [false])
        XCTAssertNil(store.tierId(for: "t1"))
        XCTAssertEqual(store.tasks[0].pinned, false)
    }

    /// Moving an old Wait task to Focus is one tier write with the tier the user picked;
    /// nothing rewrites a stored retired tier unless someone picks another.
    func testMovingAnOldWaitTaskToFocusIsOneTierWrite() async {
        let mock = MockTaskTransport()
        mock.tierSplitResult = FocusTierResult(
            pinnedTasks: ["w1"], focusTasks: ["w1"], satelliteTasks: [],
            backlogTasks: [], waitTasks: [], customTierTasks: [:]
        )
        let store = TasksStore(transport: mock)
        store.tasks = [task("w1")]
        store.adoptSplit(FocusTierResult(
            pinnedTasks: ["w1"], focusTasks: [], satelliteTasks: [],
            backlogTasks: [], waitTasks: ["w1"], customTierTasks: [:]
        ))

        let failure = await store.pickTier("focus", for: store.tasks[0])

        XCTAssertNil(failure)
        XCTAssertEqual(calls(mock), ["setTaskFocusTier"])
        XCTAssertEqual(mock.lastCall("setTaskFocusTier")?.args, ["w1", "focus"])
    }

    func testAFailedTierAfterANewPinReportsTheRealPartialResult() async {
        let mock = MockTaskTransport()
        mock.errorsByEndpoint["setTaskFocusTier"] = APIError.server(
            status: 400, code: "bad_request", message: "tier must be one of the registered tiers",
            serverHash: nil, serverContent: nil
        )
        let store = TasksStore(transport: mock)
        store.tasks = [task("t1", pinned: false)]
        let failure = await store.pickTier("ct_gone", for: store.tasks[0])
        XCTAssertTrue(failure?.hasPrefix("Pinned in Satellite") == true)
        XCTAssertFalse(failure?.contains("Pin the task first") == true)
        XCTAssertEqual(store.tasks[0].pinned, true)
        XCTAssertEqual(store.tierId(for: "t1"), "satellite")
        XCTAssertEqual(calls(mock), ["pinTask", "setTaskFocusTier"])
        mock.errorsByEndpoint.removeValue(forKey: "setTaskFocusTier")
        mock.tierSplitResult = FocusTierResult(
            pinnedTasks: ["t1"], focusTasks: ["t1"], satelliteTasks: [],
            backlogTasks: [], waitTasks: [], customTierTasks: [:]
        )
        let retry = await store.pickTier("focus", for: store.tasks[0])
        XCTAssertNil(retry)
        XCTAssertEqual(store.tierId(for: "t1"), "focus")
    }

    func testAFailedPinStopsBeforeTheTierWrite() async {
        let mock = MockTaskTransport()
        mock.errorsByEndpoint["pinTask"] = APIError.badResponse
        let store = TasksStore(transport: mock)
        store.tasks = [task("t1", pinned: false)]
        var heard: [Bool] = []

        let failure = await store.pickTier("ct_later", for: store.tasks[0]) { heard.append($0) }

        XCTAssertNotNil(failure)
        XCTAssertEqual(calls(mock), ["pinTask"], "a tier PUT after a failed pin would fail for the wrong reason")
        XCTAssertEqual(heard, [], "no pin change went through")
        XCTAssertNil(store.tierId(for: "t1"), "the optimistic pin is rolled back")
        XCTAssertEqual(store.tasks[0].pinned, false)
    }
}
