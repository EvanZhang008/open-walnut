import Observation
import XCTest
@testable import Walnut

/// The session page polls its record every 12 s. A poll that brings nothing new must not
/// invalidate the page: a re-render rebuilds the toolbar, which closes an open submenu of
/// the session menu, and the row that then sat under the finger reaching for Rename was
/// Terminate (2026-10-28 iOS gate).
@MainActor
final class SessionDetailPollQuietTests: XCTestCase {

    private func detail(cwd: String?, recap: String?, lastActiveAt: String = "2026-10-28T00:00:00Z") -> SessionDetail {
        var record = SessionDetail.Record(
            claudeSessionId: "s-poll", processStatus: "idle", title: "T", mode: nil, archived: nil
        )
        record.cwd = cwd
        record.recap = recap
        record.lastActiveAt = lastActiveAt
        return SessionDetail(session: record, pendingPermissions: [])
    }

    /// True when reading `read` under observation saw a change during `act`.
    private func changes(_ controller: SessionLifecycleController, read: @escaping () -> Void, act: () async -> Void) async -> Bool {
        var changed = false
        withObservationTracking { read() } onChange: { changed = true }
        await act()
        return changed
    }

    func testAnUnchangedRecordInvalidatesNothing() async {
        var reply = detail(cwd: "/work/repo", recap: "Did a thing.")
        let controller = SessionLifecycleController(sessionId: "s-poll") { _ in reply }
        await controller.refreshDetail()
        XCTAssertTrue(controller.hasLatestUpdate)
        XCTAssertEqual(controller.recordCwd, "/work/repo")

        let changed = await changes(controller, read: {
            _ = controller.detail; _ = controller.hasLatestUpdate; _ = controller.recordCwd
        }, act: { await controller.refreshDetail() })
        XCTAssertFalse(changed, "the same record twice must not invalidate a reader")

        // A record that moved only in time leaves the toolbar's two facts alone.
        reply = detail(cwd: "/work/repo", recap: "Did a thing.", lastActiveAt: "2026-10-28T00:01:00Z")
        let toolbarChanged = await changes(controller, read: {
            _ = controller.hasLatestUpdate; _ = controller.recordCwd
        }, act: { await controller.refreshDetail() })
        XCTAssertFalse(toolbarChanged, "a newer lastActiveAt is not a toolbar change")
        XCTAssertEqual(controller.detail?.session.lastActiveAt, "2026-10-28T00:01:00Z")
    }

    func testTheToolbarFactsFollowARealChange() async {
        var reply = detail(cwd: "  ", recap: nil)
        let controller = SessionLifecycleController(sessionId: "s-poll") { _ in reply }
        await controller.refreshDetail()
        XCTAssertFalse(controller.hasLatestUpdate)
        XCTAssertNil(controller.recordCwd, "a blank folder is no folder")

        reply = detail(cwd: "/work/repo", recap: "Now it has one.")
        let changed = await changes(controller, read: {
            _ = controller.hasLatestUpdate; _ = controller.recordCwd
        }, act: { await controller.refreshDetail() })
        XCTAssertTrue(changed)
        XCTAssertTrue(controller.hasLatestUpdate)
        XCTAssertEqual(controller.recordCwd, "/work/repo")
    }
}
