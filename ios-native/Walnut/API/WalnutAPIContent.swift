import Foundation

/// `POST /api/v1/content/ceo`: the server sent the item into the CEO's chat as the person's
/// message. `held`: nothing was sent, the CEO waits on the person's answer first.
struct ContentCeoReply: Decodable, Equatable {
    let taskId: String
    let sessionId: String?
    let started: Bool?
    let held: Bool?
    let testRun: Bool?
}

/// `POST /api/v1/content/draft`: the words New task fills the draft with (the web's own text).
struct ContentDraftReply: Decodable, Equatable {
    let text: String
}

extension WalnutAPI {
    func contentCeo(item: ContentItem) async throws -> ContentCeoReply {
        struct Body: Encodable { let item: ContentItem }
        // The server may start the CEO's session first; the web waits as long.
        return try await inboxItemRequest("POST", "/content/ceo", body: Body(item: item), timeout: 30)
    }

    /// `sent` is the phone's own rendering of `item.at`, so the draft reads in the person's time zone.
    func contentDraft(item: ContentItem, sent: String?) async throws -> ContentDraftReply {
        struct Body: Encodable { let item: ContentItem; let sent: String? }
        return try await inboxItemRequest("POST", "/content/draft", body: Body(item: item, sent: sent), timeout: 15)
    }
}
