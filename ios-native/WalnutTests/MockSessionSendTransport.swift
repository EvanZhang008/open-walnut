import Foundation
@testable import Walnut

/// Scripted SessionSendTransport for store-level send/retry tests. Records the
/// EXACT request body of every attempt (text, images, messageId) so the
/// idempotency contract can be asserted, and can be told to fail the next N
/// attempts with a specific error (the bridge_offline ladder).
final class MockSessionSendTransport: SessionSendTransport, @unchecked Sendable {
    struct SendCall: Equatable {
        let sessionId: String
        let text: String
        let imageCount: Int
        /// The idempotency key the store chose for THIS attempt. nil would mean
        /// the store let the server mint one, which breaks dedupe on a retry.
        let messageId: String?
    }

    private let lock = NSLock()
    private(set) var sendCalls: [SendCall] = []

    /// Fail this many upcoming attempts, then succeed. The default (0) succeeds
    /// immediately.
    var failuresRemaining = 0
    /// Error thrown while `failuresRemaining > 0`.
    var failureError: Error = APIError.server(
        status: 503, code: "bridge_offline",
        message: "No live bridge to this session's host",
        serverHash: nil, serverContent: nil
    )
    /// Thrown on EVERY attempt when set (overrides failuresRemaining).
    var permanentError: Error?
    /// Optional suspension so a test can assert mid-flight state.
    var gate: CheckedContinuationGate?

    var transcript = SessionTranscript(
        sessionId: "mock", exportedAt: "2026-08-18T00:00:00Z",
        truncated: false, messages: []
    )

    var sendCallCount: Int {
        lock.lock(); defer { lock.unlock() }
        return sendCalls.count
    }

    /// messageIds seen across every attempt, in order.
    var messageIds: [String?] {
        lock.lock(); defer { lock.unlock() }
        return sendCalls.map(\.messageId)
    }

    func sendSessionMessage(
        id: String, text: String, images: [ImagePayload], messageId: String?
    ) async throws -> String {
        lock.lock()
        sendCalls.append(SendCall(
            sessionId: id, text: text, imageCount: images.count, messageId: messageId
        ))
        let shouldFail = permanentError != nil || failuresRemaining > 0
        if permanentError == nil, failuresRemaining > 0 { failuresRemaining -= 1 }
        let error = permanentError ?? failureError
        lock.unlock()

        if let gate { await gate.wait() }
        if shouldFail { throw error }
        // The server echoes back the id it queued under — the client's own id
        // when it supplied one, which is what makes the retry idempotent.
        return messageId ?? "qm-mobile-serverminted"
    }

    func sessionTranscript(id: String, fresh: Bool) async throws -> SessionTranscript {
        transcript
    }
}
