import XCTest
@testable import Walnut

/// The tier split's disk cache — the board input that was NOT cached.
///
/// What it looked like: the board renders from cache before any request finishes, and
/// the tasks, the sessions and the folder tree were all on disk. The split was not, so
/// an offline launch had `taskTiers` empty, `tierId(for:)` answered nil for every row,
/// and `tierBadge` fell back to the server default. Measured on a real vault with the
/// phone offline: All 96, Satellite 96, and no Focus, Backlog or Wait band at all. The
/// board's ORGANISATION disappeared at the moment the user could least fix it.
///
/// These tests use the real `DiskCache` on purpose. A stubbed cache would assert that
/// the store calls a function; what has to be true is that a value written by one store
/// is READABLE by the next process, which is a round trip through JSON on a file —
/// including that `FocusTierResult`'s snake_case coding keys survive being encoded by us
/// rather than by the server.
@MainActor
final class FocusSplitCacheTests: XCTestCase {

    private func clearCache() {
        DiskCache.remove(key: TasksStore.focusSplitCacheKey)
        DiskCache.remove(key: TasksStore.focusTiersCacheKey)
    }

    override func setUp() async throws {
        clearCache()
    }

    override func tearDown() async throws {
        clearCache()
    }

    private func makeStore() -> (TasksStore, MockTaskTransport) {
        let mock = MockTaskTransport()
        return (TasksStore(transport: mock), mock)
    }

    private var split: FocusTierResult {
        FocusTierResult(
            pinnedTasks: ["t-focus", "t-sat", "t-back", "t-wait", "t-custom"],
            focusTasks: ["t-focus"],
            satelliteTasks: ["t-sat"],
            backlogTasks: ["t-back"],
            waitTasks: ["t-wait"],
            customTierTasks: ["ct_reading": ["t-custom"]]
        )
    }

    // MARK: - The round trip

    func testAdoptingASplitWritesItAndTheNextLaunchReadsItBack() async {
        let (writer, _) = makeStore()
        writer.adoptSplit(split)

        let (reader, _) = makeStore()
        XCTAssertTrue(reader.taskTiers.isEmpty, "a fresh store starts with no split")
        await reader.adoptCachedFocusSplit()

        XCTAssertEqual(reader.taskTiers["t-focus"], "focus")
        XCTAssertEqual(reader.taskTiers["t-back"], "backlog")
        XCTAssertEqual(reader.taskTiers["t-wait"], "wait")
        XCTAssertEqual(
            reader.taskTiers["t-custom"], "ct_reading",
            "a custom tier is the case the snake_case `custom_tier_tasks` key decodes"
        )
    }

    func testTheCachedSplitKeepsPinORDERAndNotJustTheBands() async {
        let ordered = FocusTierResult(
            pinnedTasks: ["c", "a", "b"], focusTasks: ["c", "a", "b"],
            satelliteTasks: [], backlogTasks: [], waitTasks: [], customTierTasks: [:]
        )
        let (writer, _) = makeStore()
        writer.adoptSplit(ordered)

        let (reader, _) = makeStore()
        await reader.adoptCachedFocusSplit()
        XCTAssertEqual(
            reader.taskTierOrder["focus"], ["c", "a", "b"],
            "the order IS the promise that a new pin lands at the foot of its band; a "
                + "cache of the map alone would restore the bands and scramble them"
        )
    }

    func testTheOfflineBoardKeepsItsBandsInsteadOfCollapsingIntoSatellite() async {
        let (writer, _) = makeStore()
        writer.adoptSplit(split)

        // A launch with no network at all: hydrate from disk, ask nothing.
        let (offline, _) = makeStore()
        await offline.adoptCachedFocusSplit()

        let bands = Set(["t-focus", "t-sat", "t-back", "t-wait", "t-custom"].compactMap {
            offline.tierId(for: $0)
        })
        XCTAssertEqual(
            bands, ["focus", "satellite", "backlog", "wait", "ct_reading"],
            "this is the measured incident: without the cache every one of these answered "
                + "nil, so the board drew ONE band"
        )
    }

    // MARK: - Custom tier LABELS are a second cache, and needed for the same reason

    func testCustomTierLabelsAreCachedSoAnOfflineBandIsNotNamedSatellite() async {
        let (writer, mock) = makeStore()
        mock.tierSplitResult = split
        mock.customTiersResult = [FocusTierInfo(id: "ct_reading", label: "Reading")]
        await writer.loadFocusTiers()
        XCTAssertEqual(writer.tierLabel(for: "ct_reading"), "Reading")

        let (offline, _) = makeStore()
        await offline.adoptCachedFocusSplit()
        XCTAssertEqual(
            offline.tierLabel(for: "ct_reading"), "Reading",
            "`tierLabel`'s fallback for an unknown id is \"Satellite\", so a cached split "
                + "without a cached registry would name a custom band after a built-in one"
        )
    }

    // MARK: - What must NOT happen

    func testTheCacheNeverOverwritesAnAnswerThatAlreadyLanded() async {
        let (writer, _) = makeStore()
        writer.adoptSplit(split)

        let (reader, _) = makeStore()
        // The network won the race — which it can, and when it does it is newer by
        // construction. Same guard shape every other adoption in `initialize()` uses.
        reader.adoptSplit(FocusTierResult(
            pinnedTasks: ["fresh"], focusTasks: ["fresh"], satelliteTasks: [],
            backlogTasks: [], waitTasks: [], customTierTasks: [:]
        ))
        await reader.adoptCachedFocusSplit()
        XCTAssertEqual(reader.taskTiers, ["fresh": "focus"], "the cache must not win")
    }

    func testATierMOVESurvivesARelaunch() async {
        let (mover, mock) = makeStore()
        mock.tierSplitResult = FocusTierResult(
            pinnedTasks: ["t-1"], focusTasks: [], satelliteTasks: [],
            backlogTasks: ["t-1"], waitTasks: [], customTierTasks: [:]
        )
        _ = await mover.setTier(taskId: "t-1", tier: "backlog")

        let (next, _) = makeStore()
        await next.adoptCachedFocusSplit()
        XCTAssertEqual(
            next.taskTiers["t-1"], "backlog",
            "`setTier` adopts its response through `adoptSplit` too, which is WHY the "
                + "cache cannot lag a move the user made and then went offline with"
        )
    }

    func testAnUnchangedSplitIsStillWrittenToDisk() async {
        // The write is deliberately NOT guarded on "the split changed", and this is the
        // hole that guard would have: after a disconnect wipes the cache, the poll keeps
        // returning the split the store already holds, so a change-only rule would leave
        // the file missing for as long as nothing moved.
        let (store, _) = makeStore()
        store.adoptSplit(split)
        DiskCache.remove(key: TasksStore.focusSplitCacheKey)
        let wiped = await DiskCache.loadAsync(
            FocusTierResult.self, key: TasksStore.focusSplitCacheKey
        )
        XCTAssertNil(wiped, "precondition: the cache is gone")
        // The same value the store already has — nothing to adopt, everything to re-write.
        store.adoptSplit(split)
        let restored = await DiskCache.loadAsync(
            FocusTierResult.self, key: TasksStore.focusSplitCacheKey
        )
        XCTAssertNotNil(
            restored,
            "an adoption that changes nothing observable must still re-establish the file"
        )
    }
}
