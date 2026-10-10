import Foundation

// MARK: - Session send/read transport (mock seam for WalnutTests)
//
// Same pattern (and same reason) as WalnutTaskTransport: SessionConversationStore
// drives its two network calls through this narrow protocol so WalnutTests can
// exercise the REAL send / retry / backoff state machine against a scripted
// transport — asserting the exact request bodies, which is the only way to pin
// the idempotency contract ("a retry reuses the original messageId").
// WalnutAPI is the live implementation; the requirements match its existing
// methods 1:1, so conformance is an empty extension.

/// A 202 from `POST /sessions/:id/messages`.
struct SessionSendReceipt: Equatable {
    let messageId: String
    /// The cloud replica BANKED the send because the host's bridge is down
    /// (`{ messageId, queued: true }`, core/send-queue.ts): accepted durably and
    /// delivered when the bridge returns. It is therefore NOT proof the bridge is
    /// up, which every other 202 is.
    let queued: Bool
}

protocol SessionSendTransport {
    func sendSessionMessage(
        id: String, text: String, images: [ImagePayload], messageId: String?
    ) async throws -> SessionSendReceipt
    /// `rich` has no default in the protocol on purpose: it is a per-CALL-SITE
    /// bandwidth decision (see `WalnutAPI.sessionTranscriptPath`), and a default
    /// either silently spends ~48 KB/min in the degraded poll or silently drops
    /// the tool-input / reasoning fields the timeline needs.
    func sessionTranscript(id: String, fresh: Bool, rich: Bool) async throws -> SessionTranscript
    /// A page of the transcript for the first open and for Load earlier (see
    /// `WalnutAPI.sessionTranscriptPagePath`). Always fresh and rich.
    func sessionTranscriptPage(id: String, before: String?, since: String?,
                               visible: Int) async throws -> SessionTranscript
    /// The same send, spoken: `voice: true` asks the session for an answer made
    /// to be heard (voice mode). See `WalnutAPI.sendSessionMessage(…voice:)`.
    func sendSessionMessage(
        id: String, text: String, images: [ImagePayload], messageId: String?, voice: Bool
    ) async throws -> SessionSendReceipt
}

extension SessionSendTransport {
    /// A transport with no voice channel sends the words plainly.
    func sendSessionMessage(
        id: String, text: String, images: [ImagePayload], messageId: String?, voice: Bool
    ) async throws -> SessionSendReceipt {
        try await sendSessionMessage(id: id, text: text, images: images, messageId: messageId)
    }
}

extension WalnutAPI: SessionSendTransport {}
