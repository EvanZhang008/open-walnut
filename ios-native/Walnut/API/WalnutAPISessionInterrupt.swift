import Foundation

/// POST /v1/sessions/:id/interrupt: stops the session's running turn and nothing else.
/// The process stays alive, nothing is sent, and messages queued before it are not
/// delivered by it. `wasRunning` is whether the server's record said a turn was running;
/// false means the stop was a no-op.
struct SessionInterruptResult: Codable, Equatable {
    let status: String
    let sessionId: String
    let wasRunning: Bool
}

extension WalnutAPI {
    /// Stop the running turn (the composer's Stop). 404 not_found for an unknown session,
    /// 503 bridge_offline when the primary cannot be reached through the companion.
    func interruptSession(id: String) async throws -> SessionInterruptResult {
        try await send("POST", "/sessions/\(escape(id))/interrupt", body: nil as [String: String]?, timeout: 20)
    }

    /// `sendSessionMessage` that first stops the running turn (the console's "Interrupt &
    /// send"). The server stops the turn only on the FIRST arrival of a `messageId`, so a
    /// retry under the same id after a lost 202 cannot cut off the turn its own first
    /// send started. `interrupt: false` is the plain send, byte for byte.
    func sendSessionMessage(
        id: String, text: String, images: [ImagePayload], messageId: String?, voice: Bool, interrupt: Bool
    ) async throws -> SessionSendReceipt {
        guard interrupt else {
            return try await sendSessionMessage(id: id, text: text, images: images, messageId: messageId, voice: voice)
        }
        struct Body: Encodable {
            let text: String
            let images: [ImagePayload]?
            let messageId: String?
            let voice: Bool?
            let interrupt: Bool
        }
        struct Accepted: Codable { let messageId: String; let queued: Bool? }
        let validID = messageId.flatMap { SendRetryPolicy.isValidMessageId($0) ? $0 : nil }
        let accepted: Accepted = try await send(
            "POST", "/sessions/\(escape(id))/messages",
            body: Body(text: text, images: images.isEmpty ? nil : images, messageId: validID,
                       voice: voice ? true : nil, interrupt: true),
            timeout: images.isEmpty ? nil : 180,
            // The id makes the POST idempotent, the interrupt included (see above).
            retrySafe: validID != nil
        )
        return SessionSendReceipt(messageId: accepted.messageId, queued: accepted.queued == true)
    }

    /// Send a queued message now (`POST /messages/:id/send-now`). `interrupt: true` stops
    /// the running turn first so the row goes out in a fresh one. 409 not_queued when the
    /// row already went in or was withdrawn, 501 on the cloud companion.
    func sendQueuedNow(messageId: String, interrupt: Bool) async throws {
        struct Body: Encodable { let interrupt: Bool }
        struct Sent: Codable { let sent: Bool }
        let _: Sent = try await send(
            "POST", "/messages/\(escape(messageId))/send-now",
            body: Body(interrupt: interrupt), timeout: 30
        )
    }
}

/// The queue page's own reads and writes, behind a seam so WalnutTests can script them.
protocol SessionQueueTransport {
    func sessionQueue(id: String) async throws -> [SessionQueuedMessage]
    func deleteQueuedMessage(sessionId: String, messageId: String) async throws
    func editQueuedMessage(sessionId: String, messageId: String, text: String) async throws
    func sendQueuedNow(messageId: String, interrupt: Bool) async throws
}

extension WalnutAPI: SessionQueueTransport {}
