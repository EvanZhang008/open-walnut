import XCTest
@testable import Walnut

/// NL quick-add state machine (TasksStore quick-add plumbing): placeholder
/// insert/swap, pending-overlay registration, parse-backfill adoption, and
/// the race guards (user-touched rows and SSE-delivered duplicates must never
/// be clobbered or doubled). Pure local-state ops — no network.
@MainActor
final class QuickAddTests: XCTestCase {

    private func makeTask(
        id: String, title: String, updatedAt: String = "2026-08-09T10:00:00Z",
        status: String = "todo", pinned: Bool? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: title, status: status, phase: "TODO",
            priority: "none", project: "", dueDate: nil,
            createdAt: "2026-08-09T10:00:00Z", updatedAt: updatedAt,
            completedAt: nil, starred: nil, pinned: pinned, tags: nil, summary: nil
        )
    }

    // MARK: - Placeholder lifecycle

    func testPlaceholderInsertsInstantlyAndSwapsForServerRow() {
        let store = TasksStore()
        store.insertPlaceholder(makeTask(id: "quickadd-abc", title: "buy milk tomorrow"))
        XCTAssertEqual(store.tasks.first?.id, "quickadd-abc")

        let created = makeTask(id: "t-server-1", title: "buy milk tomorrow")
        store.adoptCreated(created, replacingPlaceholder: "quickadd-abc")
        XCTAssertEqual(store.tasks.map(\.id), ["t-server-1"])
        // Registered as a pending overlay (REPLICA refreshes keep it).
        XCTAssertTrue(store.pendingCreatedIds.contains("t-server-1"))
        // Locate-me signal fired.
        XCTAssertEqual(store.lastCreatedTaskId, "t-server-1")
    }

    func testPlaceholderRemovedOnCreateFailure() {
        let store = TasksStore()
        store.insertPlaceholder(makeTask(id: "quickadd-x", title: "doomed"))
        store.removePlaceholder(id: "quickadd-x")
        XCTAssertTrue(store.tasks.isEmpty)
    }

    /// The SSE feed can deliver the created row BEFORE the POST response
    /// resolves — the placeholder must be dropped, never a duplicate row.
    func testAdoptCreatedDedupesWhenFeedBeatThePost() {
        let store = TasksStore()
        store.insertPlaceholder(makeTask(id: "quickadd-y", title: "call mom"))
        let created = makeTask(id: "t-2", title: "call mom")
        store._applyFeedMutationsForTesting([.taskUpsert(created)])
        XCTAssertEqual(store.tasks.count, 2) // placeholder + feed row

        store.adoptCreated(created, replacingPlaceholder: "quickadd-y")
        XCTAssertEqual(store.tasks.filter { $0.id == "t-2" }.count, 1)
        XCTAssertFalse(store.tasks.contains { $0.id == "quickadd-y" })
    }

    // MARK: - Pending overlay upgrade

    /// A REPLICA refresh re-merges the overlay — after the parse backfill it
    /// must carry the UPGRADED row, not the raw-title original.
    func testRefreshPendingCreatedUpgradesOverlay() {
        let store = TasksStore()
        let created = makeTask(id: "t-3", title: "raw text friday")
        store.adoptCreated(created, replacingPlaceholder: nil)

        let upgraded = makeTask(id: "t-3", title: "Raw text", updatedAt: "2026-08-09T10:00:05Z")
        store.adoptBackfilled(upgraded)
        // Server list WITHOUT t-3 (projection lag): the merged overlay row
        // must be the upgraded one.
        let merged = store._mergePendingForTesting(into: [makeTask(id: "other", title: "other")])
        XCTAssertEqual(merged.first(where: { $0.id == "t-3" })?.title, "Raw text")
    }

    // MARK: - Race guards

    func testBackfillSkippedAfterUserEdit() {
        let store = TasksStore()
        let created = makeTask(id: "t-4", title: "pay rent tmrw")
        store.adoptCreated(created, replacingPlaceholder: nil)

        // User marks it done before the parse lands.
        store.noteUserTouched("t-4")
        XCTAssertTrue(store.isUserTouched("t-4"))

        let upgraded = makeTask(id: "t-4", title: "Pay rent", updatedAt: "2026-08-09T10:00:09Z")
        store.adoptBackfilled(upgraded)
        XCTAssertEqual(store.tasks.first(where: { $0.id == "t-4" })?.title, "pay rent tmrw")
    }

    func testAdoptBackfilledAppliesWhenUntouched() {
        let store = TasksStore()
        let created = makeTask(id: "t-5", title: "ship report friday 3pm")
        store.adoptCreated(created, replacingPlaceholder: nil)

        let upgraded = makeTask(id: "t-5", title: "Ship report", updatedAt: "2026-08-09T10:00:03Z")
        store.adoptBackfilled(upgraded)
        XCTAssertEqual(store.tasks.first(where: { $0.id == "t-5" })?.title, "Ship report")
    }

    /// A feed DELETE mid-parse clears both the row and the overlay — the
    /// deleted-task-resurrection path (pendingCreated TTL is 30 min).
    func testFeedDeleteClearsOverlaySoBackfillCannotResurrect() {
        let store = TasksStore()
        let created = makeTask(id: "t-6", title: "obsolete")
        store.adoptCreated(created, replacingPlaceholder: nil)
        store._applyFeedMutationsForTesting([.taskDelete(id: "t-6")])
        XCTAssertFalse(store.pendingCreatedIds.contains("t-6"))
        XCTAssertFalse(store.tasks.contains { $0.id == "t-6" })

        // Late backfill: no row, no overlay → adoption is a no-op.
        store.adoptBackfilled(makeTask(id: "t-6", title: "Obsolete", updatedAt: "2026-08-09T10:01:00Z"))
        XCTAssertFalse(store.tasks.contains { $0.id == "t-6" })
    }

    /// updateTask / batch ops mark rows user-touched (the guard the async
    /// backfill checks). Guard the wiring, not just the flag primitive.
    func testUserMutationsMarkTouched() async {
        let store = TasksStore()
        // updateTask on an id NOT in the list throws (no network in tests),
        // but must have marked the id touched BEFORE the request.
        _ = try? await store.updateTask(id: "t-7", edit: .init(status: "done"))
        XCTAssertTrue(store.isUserTouched("t-7"))

        _ = await store.batchSetDone(["t-8"], done: true)
        XCTAssertTrue(store.isUserTouched("t-8"))
        _ = await store.batchDelete(["t-9"])
        XCTAssertTrue(store.isUserTouched("t-9"))
    }
}
