import XCTest
@testable import Walnut

/// Replays of the queue rows the server reported for real sends (2026-11-11 report: a phone
/// send seemed to stay "Queued"), read by the page's queue model one GET at a time. Each
/// case is the sequence of `GET /sessions/:id/queue` answers the server gives for that flow;
/// the bubble's state must end Delivered and then nothing, never stay Queued.
@MainActor
final class SessionQueueReplayTests: XCTestCase {
    final class Replay: SessionQueueTransport, @unchecked Sendable {
        private let lock = NSLock()
        var answer: Result<[SessionQueuedMessage], Error> = .success([])
        func sessionQueue(id: String) async throws -> [SessionQueuedMessage] {
            lock.lock(); defer { lock.unlock() }
            return try answer.get()
        }
        func deleteQueuedMessage(sessionId: String, messageId: String) async throws {}
        func editQueuedMessage(sessionId: String, messageId: String, text: String) async throws {}
        func sendQueuedNow(messageId: String, interrupt: Bool) async throws {}
    }

    private static let id = "qm-mobile-2a0ed3c0f357"

    private func row(status: String, stage: String?, delivered: Bool? = nil) -> SessionQueuedMessage {
        var r = SessionQueuedMessage(id: Self.id, message: "words", status: status, enqueuedAt: "2026-11-11T17:08:00.133Z")
        r.stage = stage
        r.delivered = delivered
        r.sentBy = "person"
        return r
    }

    /// Feed each answer to one read; return the bubble's state after each.
    private func replay(_ answers: [Result<[SessionQueuedMessage], Error>]) async -> [QueuedSend.Status?] {
        let transport = Replay()
        let queue = SessionQueueModel(sessionId: "50ff92ce", api: transport)
        queue.watch(Self.id)
        var states: [QueuedSend.Status?] = []
        for answer in answers {
            transport.answer = answer
            await queue.refresh()
            states.append(queue.sendStates[Self.id])
        }
        return states
    }

    /// Idle session on a remote host: enqueued, delivered by a cold resume, its line read, answered.
    func testIdleSendOnARemoteHostEndsDelivered() async {
        let states = await replay([
            .success([row(status: "pending", stage: "waiting")]),
            .success([row(status: "processing", stage: "waiting")]),
            .success([row(status: "processing", stage: "taken", delivered: true)]),
            .success([]),
        ])
        XCTAssertEqual(states.first, .pending)
        XCTAssertFalse(states.dropFirst().contains(.pending), "after the session took it: never Queued again, got \(states)")
    }

    /// Mid-turn: written into the live CLI at once, taken at its next step, answered.
    func testMidTurnSendEndsDelivered() async {
        let states = await replay([
            .success([row(status: "processing", stage: "written")]),
            .success([row(status: "processing", stage: "taken", delivered: true)]),
            .success([]),
        ])
        XCTAssertFalse(states.contains(.pending), "mid-turn delivery reads Delivered at once, got \(states)")
    }

    /// Mid-turn, the first read before the delivery: Queued, then Delivered.
    func testMidTurnSendReadBeforeDeliveryEndsDelivered() async {
        let states = await replay([
            .success([row(status: "pending", stage: "waiting")]),
            .success([row(status: "processing", stage: "written")]),
            .success([]),
        ])
        XCTAssertEqual(states, [.pending, .delivered, .delivered])
    }

    /// Backgrounded across the answer: reads fail or stop, the row leaves the line meanwhile,
    /// and the first read back in front finds it gone.
    func testBackgroundedAcrossTheAnswerEndsDeliveredOnTheFirstReadBack() async {
        let lost = APIError.server(status: 503, code: "bridge_offline", message: "offline", serverHash: nil, serverContent: nil)
        let states = await replay([
            .success([row(status: "pending", stage: "waiting")]),
            .failure(lost),
            .failure(lost),
            .success([]),
        ])
        XCTAssertEqual(states, [.pending, .pending, .pending, .delivered])
    }

    /// The runner's word wins over a queue file whose status write lagged.
    func testATakenRowStillMarkedPendingIsDelivered() async {
        let states = await replay([.success([row(status: "pending", stage: "taken", delivered: true)])])
        XCTAssertEqual(states, [.delivered])
    }
}
