import XCTest
@testable import Walnut

/// Regression tests for the 2026-08-16 field reports:
///  1. Header stuck on "Idle" while the turn visibly streamed — the store must
///     apply `status` frames from the SSE stream to `processStatus` (the nav
///     subtitle reads it live).
///  2. "Mac unreachable — read-only" pinned on a healthy session — a snapshot
///     frame is proof this store talks to the session's host right now, so a
///     sticky `offline` flag from an earlier bridge-offline must clear.
final class SessionStatusOfflineTests: XCTestCase {

    @MainActor
    private func statusEvent(_ processStatus: String) -> SSEEvent {
        SSEEvent(id: nil, event: "status", data: "{\"processStatus\":\"\(processStatus)\"}")
    }

    // MARK: - status frames drive the header

    @MainActor
    func testStatusFrameFlipsProcessStatusRunningThenIdle() {
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "status-flip"))
        store.processStatus = "idle"

        store.handle(statusEvent("running"))
        XCTAssertEqual(store.processStatus, "running",
                       "a status frame mid-turn must update the header source of truth")

        store.handle(statusEvent("idle"))
        XCTAssertEqual(store.processStatus, "idle",
                       "turn end must flip the header back to Idle")
    }

    @MainActor
    func testTerminalStatusFrameEndsStreamingIndicator() {
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "status-terminal"))
        store.streaming = true
        store.activity = "Thinking"

        store.handle(statusEvent("stopped"))
        XCTAssertEqual(store.processStatus, "stopped")
        XCTAssertFalse(store.streaming, "terminal status must clear the live indicator")
        XCTAssertNil(store.activity)
    }

    // MARK: - snapshot clears a sticky offline flag

    /// The banner now waits out 10 s of continuous absence (SessionStreamStormTests
    /// pins the timers); what this test keeps is the heal: a snapshot is proof.
    @MainActor
    func testSnapshotClearsStaleOfflineFlag() async {
        let clock = ManualStreamClock()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "offline-heal"), clock: clock,
            resumeIDs: SessionStreamResumeIDs(defaults: nil)
        )
        // A bridge-offline that outlasted the grace marked the page unreachable…
        store.handle(SSEEvent(id: nil, event: "bridge-offline", data: "{}"))
        await clock.advance(by: SessionConnectionNotice.unreachableAfter)
        XCTAssertTrue(store.offline)
        XCTAssertTrue(store.canSend, "an outage never locks the composer: sends are banked")

        // …then the stream delivered a snapshot: we ARE talking to the host.
        store.handle(ScriptedSSE.snapshotEvent(megabytes: 0))
        XCTAssertFalse(store.offline,
                       "a delivered snapshot must clear the unreachable banner")
        XCTAssertEqual(store.connectionNotice, .none)
        XCTAssertTrue(store.canSend)
        store.close()
    }

    @MainActor
    func testBridgeOnlineStillClearsOffline() async {
        let clock = ManualStreamClock()
        let store = SessionConversationStore(
            session: ScriptedSSE.session(id: "offline-online"), clock: clock,
            resumeIDs: SessionStreamResumeIDs(defaults: nil)
        )
        store.handle(SSEEvent(id: nil, event: "bridge-offline", data: "{}"))
        await clock.advance(by: SessionConnectionNotice.unreachableAfter)
        XCTAssertTrue(store.offline)
        store.handle(SSEEvent(id: nil, event: "bridge-online", data: "{}"))
        XCTAssertFalse(store.offline)
        XCTAssertFalse(store.bridgeDown)
        store.close()
    }
}
