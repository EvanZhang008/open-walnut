import XCTest
@testable import Walnut

/// The board's two ORDER inputs (the folder tree and the project order) survive a relaunch
/// on disk, and an answer from the server always beats that copy, an empty one included.
///
/// Found by `BoardOrderParityUITests`: a phone that last saw a companion which pushes its
/// folders and project order, then launched against an older one that answers neither,
/// kept drawing the old folders and the old order. The board request answered `[]` while
/// the cold start's cache reads were still running; `[]` equals what a fresh store holds,
/// so nothing changed and nothing was written, and the cache read then adopted the stale
/// copy because the store still looked empty. An EMPTY answer is an answer.
///
/// The real `DiskCache`, like `FocusSplitCacheTests`: what has to be true is a round trip
/// through the file the next launch reads.
@MainActor
final class BoardOrderCacheTests: XCTestCase {

    private static let foldersKey = "task-folders"

    private func clearCache() {
        DiskCache.remove(key: Self.foldersKey)
        DiskCache.remove(key: TasksStore.projectOrderCacheKey)
    }

    override func setUp() async throws { clearCache() }
    override func tearDown() async throws { clearCache() }

    private let staleFolders = [
        TaskFolder(groupId: "g_old", label: "Old folder", memberIds: ["t1", "t2"], project: "acme"),
    ]
    private let staleOrder = ["acme", "", "marina"]

    private func seedStaleCache() async {
        DiskCache.save(staleFolders, key: Self.foldersKey)
        DiskCache.save(staleOrder, key: TasksStore.projectOrderCacheKey)
        // Both writes are queued; a read behind them proves they landed.
        let order = await DiskCache.loadAsync([String].self, key: TasksStore.projectOrderCacheKey)
        XCTAssertEqual(order, staleOrder, "precondition: the stale copy is on disk")
    }

    /// Nothing answered yet: the cache is what the board opens with.
    func testACachedTreeAndOrderOpenTheBoardBeforeTheServerAnswers() async {
        await seedStaleCache()
        let store = TasksStore(transport: MockTaskTransport())
        await store.adoptCachedFoldersAndOrder()
        XCTAssertEqual(store.taskFolders, staleFolders)
        XCTAssertEqual(store.projectOrder, staleOrder)
    }

    /// THE bug: the server answers "no folders, no order" first, then the cache read lands.
    func testAnEmptyAnswerThatLandedFirstIsNotReplacedByTheCache() async {
        await seedStaleCache()
        // MockTaskTransport answers both with the protocol defaults: [] and [].
        let store = TasksStore(transport: MockTaskTransport())
        await store.loadTaskFolders()
        await store.loadProjectOrder()
        await store.adoptCachedFoldersAndOrder()
        XCTAssertEqual(store.taskFolders, [], "the server said there are none")
        XCTAssertEqual(store.projectOrder, [], "the server said there is none")
    }

    /// And the empty answer replaced the file, so the NEXT launch does not open stale either.
    func testAnEmptyAnswerIsWrittenOverTheStaleCopy() async {
        await seedStaleCache()
        let store = TasksStore(transport: MockTaskTransport())
        await store.loadTaskFolders()
        await store.loadProjectOrder()
        let folders = await DiskCache.loadAsync([TaskFolder].self, key: Self.foldersKey)
        let order = await DiskCache.loadAsync([String].self, key: TasksStore.projectOrderCacheKey)
        XCTAssertEqual(folders, [])
        XCTAssertEqual(order, [])
    }
}
