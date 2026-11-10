import Foundation

// MARK: - An Org node's Threads and Brief (`/api/v1/tasks/:id/threads`, `/api/v1/tasks/:id/brief`)
//
// The user's own requests to Main or a VP, one thread per subject (server
// `src/core/org/threads-model.ts`, routes `src/web/routes/org-threads-v1.ts`), and the node's
// letter to him (`src/web/routes/brief-v1.ts`). The phone reads both and acts on a thread the way
// the web Org page does (Acknowledge, Snooze, Pin, Reopen); a Follow up is a session send that
// names the thread (`threadId`, additive).

/// One message he sent the node, with the node's chat answer under it once its turn ended.
struct OrgThreadMessage: Codable, Equatable, Identifiable {
    struct Answer: Codable, Equatable {
        let text: String
        let at: String
        var about: [String]? = nil
        /// The server cut `text` to the read's `answer_max` (additive): the whole answer is in the chat.
        var clipped: Bool? = nil
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
    /// Its answer is one reply that also sits under another thread's message (additive,
    /// 2026-11-06), judged by the server over every thread.
    var shared: Bool? = nil
}

struct OrgThread: Codable, Equatable, Identifiable {
    struct Closed: Codable, Equatable { let how: String; let at: String; let by: String }
    struct Known: Codable, Equatable { let through: String }
    struct Opener: Codable, Equatable {
        let text: String
        let at: String
        let from: String
        var ref: String? = nil
    }
    struct Snoozed: Codable, Equatable { let until: String; let at: String }
    struct Pinned: Codable, Equatable { let at: String; var by: String? = nil }

    let id: String
    let title: String
    var ask: String? = nil
    /// new | working | needs | answered | pending
    var state: String
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
    /// His view shows it (additive, 2026-11-06): the server's rule over ALL the node's threads,
    /// the one `user_status.threads` counts by, so this list and the header's count agree. Absent
    /// from an older server: the phone judges it itself (`OrgThreadModel.shownToHim`).
    var shown: Bool? = nil
}

/// What one read of a node's threads brought: the threads, and how many his view shows by the
/// server's count of the same moment (nil from an older server).
struct OrgThreadsRead: Equatable {
    let threads: [OrgThread]
    let shownCount: Int?
    /// All the node's closed threads (the read brings only the newest).
    var closedCount: Int? = nil
}

struct OrgThreadsReply: Decodable {
    let threads: [OrgThread]
    var closed_count: Int? = nil
    var shown_count: Int? = nil
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
    /// The node's open threads, then the newest closed ones (the server's order).
    ///
    /// Two small reads, never the whole file: every thread with every answer measured 1.08 MB for
    /// one VP, past what the companion carries back from the Mac (256 KB), so the companion
    /// answered from its own copy, which holds no threads, and the page read "No open threads"
    /// under a header counting four (2026-11-06). Answers come cut (`answer_max`); the closed list
    /// is the newest `closedLimit`. An older server ignores `closed`, `limit` and `answer_max`, and
    /// its whole list is filtered here.
    func orgThreads(taskId: String, closedLimit: Int = 30) async throws -> OrgThreadsRead {
        let base = "/tasks/\(escape(taskId))/threads"
        let open: OrgThreadsReply = try await get("\(base)?open=1&answer_max=\(Self.threadAnswerMax)")
        let openOnes = open.threads.filter { $0.closed == nil }
        guard (open.closed_count ?? 1) > 0 else { return OrgThreadsRead(threads: openOnes, shownCount: open.shown_count, closedCount: open.closed_count) }
        // The closed list is a fold below: when it cannot be read, the open ones still show.
        guard let closed: OrgThreadsReply = try? await get(
            "\(base)?closed=1&limit=\(closedLimit)&answer_max=\(Self.closedThreadAnswerMax)") else {
            return OrgThreadsRead(threads: openOnes, shownCount: open.shown_count, closedCount: open.closed_count)
        }
        return OrgThreadsRead(threads: openOnes + closed.threads.filter { $0.closed != nil }.prefix(closedLimit),
                              shownCount: open.shown_count, closedCount: open.closed_count)
    }

    /// One thread whole (`GET /tasks/:id/threads/:thread`): its Conversation after a cut list read.
    func orgThread(taskId: String, threadId: String) async throws -> OrgThread {
        struct Reply: Decodable { let thread: OrgThread }
        let reply: Reply = try await get("/tasks/\(escape(taskId))/threads/\(escape(threadId))")
        return reply.thread
    }

    /// How much of each answer he already reacted to a list read carries: a preview (the card
    /// shows only the ones he has not reacted to, which come whole). Measured on a VP's real
    /// threads: 36 open about 100 KB, the newest 30 closed about 110 KB, under the 256 KB the
    /// companion carries back.
    static let threadAnswerMax = 200
    static let closedThreadAnswerMax = 120

    func editOrgThread(taskId: String, threadId: String, _ edit: OrgThreadEdit) async throws {
        struct Ack: Decodable {}
        let _: Ack = try await send("PATCH", "/tasks/\(escape(taskId))/threads/\(escape(threadId))", body: edit.body)
    }

    /// Before a Follow up goes out: the message with `messageId` is his reply in this thread. The
    /// companion's relay of the words cannot carry the thread, so the Mac hears it here first
    /// (`PUT /tasks/:id/threads/:thread/follow-ups/:messageId`, additive 2026-11-10). Short: a Mac
    /// that does not answer costs his send at most this, and the words go anyway.
    func announceThreadFollowUp(taskId: String, threadId: String, messageId: String) async throws {
        struct Ack: Decodable {}
        let _: Ack = try await send(
            "PUT", "/tasks/\(escape(taskId))/threads/\(escape(threadId))/follow-ups/\(escape(messageId))",
            body: [String: AnyEncodable](), timeout: 3)
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
