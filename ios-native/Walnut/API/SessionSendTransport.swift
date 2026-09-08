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

protocol SessionSendTransport {
    func sendSessionMessage(
        id: String, text: String, images: [ImagePayload], messageId: String?
    ) async throws -> String
    /// `rich` has no default in the protocol on purpose: it is a per-CALL-SITE
    /// bandwidth decision (see `WalnutAPI.sessionTranscriptPath`), and a default
    /// either silently spends ~48 KB/min in the degraded poll or silently drops
    /// the tool-input / reasoning fields the timeline needs.
    func sessionTranscript(id: String, fresh: Bool, rich: Bool) async throws -> SessionTranscript
}

extension WalnutAPI: SessionSendTransport {}
