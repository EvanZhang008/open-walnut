import Foundation

/// Voice mode's two writes (additive, 2026-10): a spoken message into a session,
/// and a spoken first message that launches a Walnut ask.
///
/// `voice: true` is all the phone adds. The server owns what it means (the
/// voice-reply line the CLI receives after the words, src/core/sessions/
/// voice-reply.ts), so its wording can change without an app release, and a
/// server that predates the field ignores it.
extension WalnutAPI {
    /// `sendSessionMessage` with the voice flag. `voice: false` is the plain send,
    /// byte for byte.
    func sendSessionMessage(
        id: String, text: String, images: [ImagePayload], messageId: String?, voice: Bool
    ) async throws -> SessionSendReceipt {
        guard voice else {
            return try await sendSessionMessage(id: id, text: text, images: images, messageId: messageId)
        }
        struct Body: Encodable {
            let text: String
            let images: [ImagePayload]?
            let messageId: String?
            let voice: Bool
        }
        struct Accepted: Codable { let messageId: String; let queued: Bool? }
        let validID = messageId.flatMap { SendRetryPolicy.isValidMessageId($0) ? $0 : nil }
        let accepted: Accepted = try await send(
            "POST", "/sessions/\(escape(id))/messages",
            body: Body(text: text, images: images.isEmpty ? nil : images, messageId: validID, voice: true),
            timeout: images.isEmpty ? nil : 180,
            // Same rule as the plain send: an id makes the POST idempotent.
            retrySafe: validID != nil
        )
        return SessionSendReceipt(messageId: accepted.messageId, queued: accepted.queued == true)
    }

    /// Launch a Walnut ask with a spoken first message (`POST /sessions
    /// { walnutAgent, voice }`). The server files it under the agent's
    /// `Ask <name>` project, exactly as the Mac's Ask Walnut does.
    func launchVoiceAsk(agentID: String, message: String) async throws -> SessionCreated {
        try await send(
            "POST", "/sessions",
            body: Self.voiceAskBody(agentID: agentID, message: message),
            timeout: 60
        )
    }

    struct VoiceAskBody: Encodable, Equatable {
        let walnutAgent: Bool
        let agentId: String?
        let message: String
        let voice: Bool
    }

    /// The wire body. `agentId` is omitted for Walnut itself ("general"), the
    /// server's default, so an older Mac answers the same.
    static func voiceAskBody(agentID: String, message: String) -> VoiceAskBody {
        VoiceAskBody(
            walnutAgent: true,
            agentId: agentID == "general" || agentID.isEmpty ? nil : agentID,
            message: message,
            voice: true
        )
    }
}
