import Foundation

// MARK: - An Org node's Threads and Brief (`/api/v1/tasks/:id/threads`, `/api/v1/tasks/:id/brief`)
//
// The user's own requests to Main or a VP, one thread per subject (server
// `src/core/org/threads-model.ts`, routes `src/web/routes/org-threads-v1.ts`), and the node's
// letter to him (`src/web/routes/brief-v1.ts`). The phone reads both and acts on a thread the way
// the web Org page does (Acknowledge, Snooze, Pin, Reopen); a Follow up is a session send that
// names the thread (`threadId`, additive).

/// One message he sent the node, with the node's chat answer under it once its turn ended.
struct OrgThreadMessage: Decodable, Equatable, Identifiable {
    struct Answer: Decodable, Equatable {
        let text: String
        let at: String
        var about: [String]? = nil
    }

    let id: String
    let at: String
    let text: String
    var images: [String]? = nil
    /// chat | follow-up | letter | import | split
    var via: String? = nil
    /// The letter a `letter` message answered.
    var about: String? = nil
    var answer: Answer? = nil
}

struct OrgThread: Decodable, Equatable, Identifiable {
    struct Closed: Decodable, Equatable { let how: String; let at: String; let by: String }
    struct Known: Decodable, Equatable { let through: String }
    struct Opener: Decodable, Equatable {
        let text: String
        let at: String
        let from: String
        var ref: String? = nil
    }
    struct Snoozed: Decodable, Equatable { let until: String; let at: String }
    struct Pinned: Decodable, Equatable { let at: String; var by: String? = nil }

    let id: String
    let title: String
    var ask: String? = nil
    /// new | working | needs | answered | pending
    let state: String
    /// The node's summary, latest first (markdown, may hold `<task-ref>` tags).
    var reply: String? = nil
    var tasks: [String]? = nil
    let messages: [OrgThreadMessage]
    /// The closed thread this one asks again about.
    var follows: String? = nil
    let createdAt: String
    let updatedAt: String
    var closed: Closed? = nil
    var known: Known? = nil
    var opener: Opener? = nil
    var snoozed: Snoozed? = nil
    var pinned: Pinned? = nil
}

struct OrgThreadsReply: Decodable {
    let threads: [OrgThread]
}

/// A thread write the phone makes: one field at a time, as the web's buttons do.
enum OrgThreadEdit: Equatable {
    case acknowledge
    case reopen
    /// An ISO time; "" takes the snooze off.
    case snooze(String)
    case pin(Bool)

    var body: [String: AnyEncodable] {
        switch self {
        case .acknowledge: return ["close": AnyEncodable("acked")]
        case .reopen: return ["reopen": AnyEncodable(true)]
        case .snooze(let until): return ["snooze": AnyEncodable(until)]
        case .pin(let on): return ["pin": AnyEncodable(on)]
        }
    }
}

/// A value of any Encodable type, so one dictionary body can mix strings and booleans.
struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) { encodeValue = value.encode }
    func encode(to encoder: Encoder) throws { try encodeValue(encoder) }
}

/// `GET /tasks/:id/brief`: the letter and how current it is. `sections` and `rules` are for the
/// node itself and are not decoded.
struct OrgBriefReply: Decodable {
    struct Letter: Decodable, Equatable { let text: String; let at: String }
    struct Fresh: Decodable, Equatable {
        struct Moved: Decodable, Equatable {
            let id: String
            let state: String
            let words: String
        }
        let writtenAt: String
        let moved: [Moved]
        let finished: [String]
        let newAsks: [String]
        let stale: Bool
        /// The head's words after "Written …": "3 lines moved since · 1 finished".
        var words: String? = nil
    }

    let brief: Letter?
    let fresh: Fresh?

    private enum CodingKeys: String, CodingKey { case brief, fresh }
}

extension WalnutAPI {
    /// Every thread of the node, open first (the server's order), closed ones of the week after.
    func orgThreads(taskId: String) async throws -> [OrgThread] {
        let reply: OrgThreadsReply = try await get("/tasks/\(escape(taskId))/threads")
        return reply.threads
    }

    func editOrgThread(taskId: String, threadId: String, _ edit: OrgThreadEdit) async throws {
        struct Ack: Decodable {}
        let _: Ack = try await send("PATCH", "/tasks/\(escape(taskId))/threads/\(escape(threadId))", body: edit.body)
    }

    func orgBrief(taskId: String) async throws -> OrgBriefReply {
        try await get("/tasks/\(escape(taskId))/brief")
    }

    /// A Follow up: the words go into the node's chat, filed under `threadId` (an older server
    /// ignores the field and files them as it would any message).
    /// Pictures ride the same send the chat composer uses.
    func sendThreadFollowUp(sessionId: String, threadId: String, text: String, images: [ImagePayload] = [], messageId: String) async throws -> SessionSendReceipt {
        struct Body: Encodable { let text: String; let images: [ImagePayload]?; let messageId: String; let threadId: String }
        struct Accepted: Decodable { let messageId: String; let queued: Bool? }
        let accepted: Accepted = try await send(
            "POST", "/sessions/\(escape(sessionId))/messages",
            body: Body(text: text, images: images.isEmpty ? nil : images, messageId: messageId, threadId: threadId),
            timeout: images.isEmpty ? nil : 180,
            retrySafe: true
        )
        return SessionSendReceipt(messageId: accepted.messageId, queued: accepted.queued == true)
    }
}
