import XCTest
@testable import Walnut

/// The session page's header status heals from the session record (2026-10-10 field
/// report: "Ended" on a live session).
///
/// The shape of that report: the Recently opened drawer reopened an Ask Walnut session
/// from the snapshot it saved while the CLI was stopped. The CLI had been resumed since,
/// but the session list never carries an Ask Walnut session, so nothing refreshed the
/// copy. On the cloud companion the session stream attaches with no status and only
/// reports changes, so the page kept "stopped" (the header said Ended) for as long as
/// the CLI stayed idle. The detail read the page already makes on open, and every 12 s,
/// answers with the Mac's record; these tests pin how that answer reaches the header.
@MainActor
final class SessionRecordStatusTests: XCTestCase {

    private func session(_ id: String, status: String) -> WalnutSession {
        WalnutSession(
            id: id, title: "Ask", taskId: nil, taskTitle: nil, project: nil,
            host: "", processStatus: status, model: nil, mode: nil,
            startedAt: "2026-10-09T17:00:00Z", lastActiveAt: "2026-10-09T17:51:00Z",
            messageCount: 0, cwd: nil, pinned: nil, focusTier: nil, description: nil
        )
    }

    private func detail(_ id: String, status: String?, degraded: Bool? = nil) -> SessionDetail {
        SessionDetail(
            session: .init(claudeSessionId: id, processStatus: status, title: nil, mode: nil, archived: nil),
            pendingPermissions: [], degraded: degraded
        )
    }

    private func statusEvent(_ processStatus: String) -> SSEEvent {
        SSEEvent(id: nil, event: "status", data: "{\"processStatus\":\"\(processStatus)\"}")
    }

    /// A controller wired the way the page wires it, answering every read with `reply`.
    private func lifecycle(
        for store: SessionConversationStore, reply: @escaping () throws -> SessionDetail
    ) -> SessionLifecycleController {
        let controller = SessionLifecycleController(sessionId: "under-test") { _ in try reply() }
        controller.statusSink = store
        return controller
    }

    // MARK: - The report

    func testStaleStoppedSnapshotHealsToTheRecordsIdle() async {
        let store = SessionConversationStore(session: session("stale-ended", status: "stopped"))
        XCTAssertEqual(store.statusKind, .stopped, "precondition: the header opens on Ended")
        let controller = lifecycle(for: store) { self.detail("stale-ended", status: "idle") }

        await controller.refreshDetail()

        XCTAssertEqual(store.processStatus, "idle",
                       "the record says the CLI is alive and idle: the header must stop saying Ended")
    }

    func testStaleRunningSnapshotOfADeadSessionHealsToEnded() async {
        let store = SessionConversationStore(session: session("stale-running", status: "running"))
        store.streaming = true
        store.activity = "Thinking"
        let controller = lifecycle(for: store) { self.detail("stale-running", status: "stopped") }

        await controller.refreshDetail()

        XCTAssertEqual(store.processStatus, "stopped")
        XCTAssertFalse(store.streaming, "a session the record calls stopped has no live turn row")
        XCTAssertNil(store.activity)
        XCTAssertNil(store.errorMessage, "a session that ran is not one that died before it started")
    }

    func testRecordErrorIsAdopted() async {
        let store = SessionConversationStore(session: session("rec-error", status: "idle"))
        await lifecycle(for: store) { self.detail("rec-error", status: "error") }.refreshDetail()
        XCTAssertEqual(store.statusKind, .error)
    }

    // MARK: - The stream's word is newer

    func testStatusFrameDuringTheReadWins() async {
        let store = SessionConversationStore(session: session("frame-wins", status: "idle"))
        let started = CheckedContinuationGate()
        let release = CheckedContinuationGate()
        let controller = SessionLifecycleController(sessionId: "frame-wins") { id in
            started.open()
            await release.wait()
            // Read before the turn started on the host, so it still says idle.
            return self.detail(id, status: "idle")
        }
        controller.statusSink = store
        store.processStatus = "stopped"

        let read = Task { await controller.refreshDetail() }
        await started.wait()
        store.handle(statusEvent("running"))
        release.open()
        await read.value

        XCTAssertEqual(store.processStatus, "running",
                       "a status frame that landed while the read was out is newer than the record")
    }

    func testSnapshotDuringTheReadWins() async {
        let store = SessionConversationStore(session: session("snapshot-wins", status: "stopped"))
        let started = CheckedContinuationGate()
        let release = CheckedContinuationGate()
        let controller = SessionLifecycleController(sessionId: "snapshot-wins") { id in
            started.open()
            await release.wait()
            return self.detail(id, status: "stopped")
        }
        controller.statusSink = store

        let read = Task { await controller.refreshDetail() }
        await started.wait()
        // The primary's attach frame carries the record's status itself.
        var snap = ScriptedSSE.Snapshot(blocks: [])
        snap.isStreaming = false
        snap.processStatus = "idle"
        let json = String(data: try! JSONEncoder().encode(snap), encoding: .utf8)!
        store.handle(SSEEvent(id: nil, event: "snapshot", data: json))
        release.open()
        await read.value

        XCTAssertEqual(store.processStatus, "idle")
    }

    func testAReadThatStartsAfterAFrameStillCounts() async {
        // Two polls: the first heals the header, a frame moves it, and the second poll
        // (started after that frame) is the newest word again.
        let store = SessionConversationStore(session: session("second-poll", status: "stopped"))
        var answer = "idle"
        let controller = lifecycle(for: store) { self.detail("second-poll", status: answer) }

        await controller.refreshDetail()
        XCTAssertEqual(store.processStatus, "idle")

        store.handle(statusEvent("running"))
        XCTAssertEqual(store.processStatus, "running")

        answer = "stopped"
        await controller.refreshDetail()
        XCTAssertEqual(store.processStatus, "stopped",
                       "a read that began after the last frame reflects the host as it is now")
    }

    // MARK: - Answers that say nothing, or cannot be trusted here

    func testEmptyMissingOrUnknownRecordStatusChangesNothing() async {
        for status in [nil, "", "starting"] as [String?] {
            let store = SessionConversationStore(session: session("no-word", status: "stopped"))
            await lifecycle(for: store) { self.detail("no-word", status: status) }.refreshDetail()
            XCTAssertEqual(store.processStatus, "stopped", "status \(String(describing: status))")
        }
    }

    func testAFailedReadChangesNothing() async {
        let store = SessionConversationStore(session: session("read-fails", status: "stopped"))
        let controller = lifecycle(for: store) {
            throw APIError.server(status: 503, code: "bridge_offline", message: "down",
                                  serverHash: nil, serverContent: nil)
        }
        await controller.refreshDetail()
        XCTAssertEqual(store.processStatus, "stopped")
        XCTAssertNil(controller.errorMessage, "the poll never banners a failure")
    }

    func testDegradedReplyCorrectsLivenessOnly() async {
        // Alive both ways: the degraded row cannot tell running from idle.
        let running = SessionConversationStore(session: session("deg-alive", status: "running"))
        await lifecycle(for: running) { self.detail("deg-alive", status: "idle", degraded: true) }.refreshDetail()
        XCTAssertEqual(running.processStatus, "running")

        // Dead on the page, alive on the host: correct it.
        let stale = SessionConversationStore(session: session("deg-revive", status: "stopped"))
        await lifecycle(for: stale) { self.detail("deg-revive", status: "idle", degraded: true) }.refreshDetail()
        XCTAssertEqual(stale.processStatus, "idle")

        // Alive on the page, dead on the host: correct it too.
        let gone = SessionConversationStore(session: session("deg-dead", status: "idle"))
        await lifecycle(for: gone) { self.detail("deg-dead", status: "stopped", degraded: true) }.refreshDetail()
        XCTAssertEqual(gone.processStatus, "stopped")
    }

    func testAJustLaunchedSessionKeepsItsStartingRow() async {
        let id = "launch-\(UUID().uuidString)"
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(
            session: session(id, status: "idle"), transport: transport,
            resumeIDs: SessionStreamResumeIDs(defaults: nil)
        )
        SessionLaunchContext.stash(sessionId: id, message: "first message")
        await store.open()
        XCTAssertTrue(store.streaming, "precondition: the Starting-session row is up")

        // Before the CLI is up the record can still read stopped.
        await lifecycle(for: store) { self.detail(id, status: "stopped") }.refreshDetail()

        XCTAssertEqual(store.processStatus, "idle")
        XCTAssertTrue(store.streaming, "the pre-spawn record must not end the Starting-session row")
        XCTAssertNil(store.errorMessage, "nor raise the died-before-start banner")
        store.close()
    }

    func testNoSinkReadsAsBefore() async {
        let controller = SessionLifecycleController(sessionId: "no-sink") { id in
            self.detail(id, status: "idle")
        }
        await controller.refreshDetail()
        XCTAssertEqual(controller.detail?.session.processStatus, "idle")
    }

    // MARK: - Wire

    func testDetailDecodesTheDegradedFlag() throws {
        let full = #"{"session":{"claudeSessionId":"a","process_status":"running"},"pendingPermissions":[]}"#
        let degraded = #"{"session":{"claudeSessionId":"a","process_status":"idle"},"pendingPermissions":[],"degraded":true,"degradedReason":"primary_offline"}"#
        let plain = try JSONDecoder().decode(SessionDetail.self, from: Data(full.utf8))
        XCTAssertNil(plain.degraded)
        XCTAssertEqual(plain.session.processStatus, "running")
        let partial = try JSONDecoder().decode(SessionDetail.self, from: Data(degraded.utf8))
        XCTAssertEqual(partial.degraded, true)
    }
}
