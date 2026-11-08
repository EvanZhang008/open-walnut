import Foundation

/// Where Talk to Walnut's words go: the CEO's (Main's) chat, as the person's own
/// message, exactly as if they had typed it there (Walnut files it in the CEO's
/// Threads the same way).
protocol TalkSending {
    /// `beforeStart` runs (and is awaited) before a request that carries no message
    /// id: the start of the CEO chat with these words.
    func send(text: String, messageId: String, beforeStart: @escaping @Sendable () async -> Void) async throws
}

/// The four calls the CEO chat send needs, a seam for the unit tests.
protocol TalkMainTransport {
    func orgMain() async throws -> String
    func talkCurrentSession(taskId: String) async throws -> String?
    func talkSend(sessionId: String, text: String, messageId: String) async throws
    func talkLaunch(taskId: String, message: String) async throws
}

extension WalnutAPI: TalkMainTransport {
    func talkCurrentSession(taskId: String) async throws -> String? {
        try await taskDetail(id: taskId).currentSessionId
    }

    func talkSend(sessionId: String, text: String, messageId: String) async throws {
        _ = try await sendSessionMessage(id: sessionId, text: text, images: [], messageId: messageId)
    }

    func talkLaunch(taskId: String, message: String) async throws {
        _ = try await launchAsk(taskId: taskId, message: message)
    }
}

/// The CEO chat over the paired server, the way the Chat tab opens it: Main's
/// task (made on first use), its current session, else a start of that session
/// with these words as its first message.
struct TalkMainSender: TalkSending {
    var transport: () -> TalkMainTransport = { WalnutAPI() }
    var isPaired: () -> Bool = { AppConfig.isConfigured }

    func send(text: String, messageId: String, beforeStart: @escaping @Sendable () async -> Void = {}) async throws {
        guard isPaired() else { throw APIError.notConfigured }
        let api = transport()
        let taskId = try await api.orgMain()
        if try await sendToCurrentSession(api, taskId: taskId, text: text, messageId: messageId) { return }
        await beforeStart()
        // The start carries no message id (the server takes none there), so a
        // start whose answer was lost may still have delivered the words: say so
        // rather than offer a resend as if nothing arrived.
        do {
            try await api.talkLaunch(taskId: taskId, message: text)
        } catch APIError.network, APIError.cancelled {
            throw TalkSendError.startOutcomeUnknown
        }
    }

    private func sendToCurrentSession(
        _ api: TalkMainTransport, taskId: String, text: String, messageId: String
    ) async throws -> Bool {
        guard let sessionId = try await api.talkCurrentSession(taskId: taskId), !sessionId.isEmpty else { return false }
        try await api.talkSend(sessionId: sessionId, text: text, messageId: messageId)
        return true
    }

    /// The sentence a failed send shows, said so the person knows what to do.
    static func reason(for error: Error) -> String {
        switch error {
        case let talk as TalkSendError:
            return talk.localizedDescription
        case APIError.notConfigured:
            return "This iPhone isn't connected to a Walnut server. Open Walnut to pair it."
        case APIError.unauthorized:
            return "Your Walnut server did not accept this iPhone. Open Walnut to check its connection."
        case APIError.server(let status, _, let message, _, _) where status == 501:
            return message.isEmpty ? "The CEO can start only while your Mac is online." : message
        case APIError.server(_, _, let message, _, _) where !message.isEmpty:
            return message
        case APIError.network:
            return TalkReason.serverUnavailable
        default:
            return error.localizedDescription
        }
    }
}

enum TalkSendError: LocalizedError {
    case startOutcomeUnknown

    var errorDescription: String? {
        switch self {
        case .startOutcomeUnknown:
            return "The connection dropped while the CEO chat was starting, so this may have arrived. Check the CEO chat before you resend."
        }
    }
}
