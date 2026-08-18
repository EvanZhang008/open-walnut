import XCTest
@testable import Walnut

/// The calendar-date half of the task edit contract (`start_date`/`end_date`,
/// added to `/api/v1/tasks` in 2026-08). Two things are locked down:
///   1. `TasksStore.applyEdit` — the PURE optimistic projection: setting either
///      date, clearing with "", and the cascade (clearing the start drops the
///      end, mirroring the server, so the optimistic row can't show a block the
///      server just removed).
///   2. The wire args a reschedule actually sends, through the real store
///      against the scripted transport — a PATCH that silently dropped the
///      dates would still "pass" any test that only checked the row.
@MainActor
final class CalendarDateEditTests: XCTestCase {

    private func makeTask(
        _ id: String = "t1", startDate: String? = nil, endDate: String? = nil
    ) -> WalnutTask {
        WalnutTask(
            id: id, title: "block", status: "todo", phase: "TODO",
            priority: "none", project: "", dueDate: nil,
            createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:00Z",
            completedAt: nil, starred: nil, pinned: nil, tags: nil, summary: nil,
            startDate: startDate, endDate: endDate
        )
    }

    // MARK: - applyEdit (pure projection)

    func testApplyEditSetsBothDates() {
        let out = TasksStore.applyEdit(
            .init(startDate: "2030-05-10T09:00:00Z", endDate: "2030-05-10T11:00:00Z"),
            to: makeTask()
        )
        XCTAssertEqual(out.startDate, "2030-05-10T09:00:00Z")
        XCTAssertEqual(out.endDate, "2030-05-10T11:00:00Z")
    }

    func testApplyEditResizesOnlyTheEnd() {
        let out = TasksStore.applyEdit(
            .init(endDate: "2030-05-10T12:00:00Z"),
            to: makeTask(startDate: "2030-05-10T09:00:00Z", endDate: "2030-05-10T10:00:00Z")
        )
        XCTAssertEqual(out.startDate, "2030-05-10T09:00:00Z", "an end-only resize must not move the start")
        XCTAssertEqual(out.endDate, "2030-05-10T12:00:00Z")
    }

    func testApplyEditEmptyStringClearsTheEnd() {
        let out = TasksStore.applyEdit(
            .init(endDate: ""),
            to: makeTask(startDate: "2030-05-10T09:00:00Z", endDate: "2030-05-10T10:00:00Z")
        )
        XCTAssertNil(out.endDate)
        XCTAssertEqual(out.startDate, "2030-05-10T09:00:00Z")
    }

    func testApplyEditClearingStartCascadesTheEnd() {
        let out = TasksStore.applyEdit(
            .init(startDate: ""),
            to: makeTask(startDate: "2030-05-10T09:00:00Z", endDate: "2030-05-10T10:00:00Z")
        )
        XCTAssertNil(out.startDate)
        XCTAssertNil(out.endDate, "the server drops an orphaned end — the optimistic row must agree")
    }

    func testApplyEditLeavesDatesAloneWhenUntouched() {
        let out = TasksStore.applyEdit(.init(title: "renamed"),
            to: makeTask(startDate: "2030-05-10T09:00:00Z", endDate: "2030-05-10T10:00:00Z"))
        XCTAssertEqual(out.startDate, "2030-05-10T09:00:00Z")
        XCTAssertEqual(out.endDate, "2030-05-10T10:00:00Z")
    }

    func testTaskEditWithOnlyDatesIsNotEmpty() {
        XCTAssertFalse(TasksStore.TaskEdit(startDate: "2030-05-10").isEmpty)
        XCTAssertFalse(TasksStore.TaskEdit(endDate: "2030-05-10").isEmpty)
        XCTAssertTrue(TasksStore.TaskEdit().isEmpty)
    }

    // MARK: - Wire args (real store, scripted transport)

    func testRescheduleSendsBothDatesOnTheWire() async throws {
        let mock = MockTaskTransport()
        let store = TasksStore(transport: mock)
        store.tasks = [makeTask()]

        _ = try await store.updateTask(id: "t1", edit: .init(
            startDate: "2030-05-10T09:00:00Z", endDate: "2030-05-10T11:00:00Z"
        ))
        let call = mock.calls.first { $0.name == "updateTask" }
        XCTAssertNotNil(call)
        XCTAssertTrue(call!.args.contains("2030-05-10T09:00:00Z"), "start_date must reach the wire")
        XCTAssertTrue(call!.args.contains("2030-05-10T11:00:00Z"), "end_date must reach the wire")
    }

    func testFailedRescheduleRestoresTheOriginalWindow() async {
        let mock = MockTaskTransport()
        mock.error = APIError.server(
            status: 400, code: "bad_request", message: "end_date must be greater than or equal to start_date",
            serverHash: nil, serverContent: nil
        )
        let store = TasksStore(transport: mock)
        let original = makeTask(startDate: "2030-05-10T09:00:00Z", endDate: "2030-05-10T10:00:00Z")
        store.tasks = [original]

        do {
            _ = try await store.updateTask(id: "t1", edit: .init(endDate: "2030-05-10T08:00:00Z"))
            XCTFail("a backwards window must rethrow")
        } catch { /* expected — the server refuses it */ }
        XCTAssertEqual(store.tasks[0], original, "a refused reschedule must restore the exact original row")
    }
}
