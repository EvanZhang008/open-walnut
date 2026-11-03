import Foundation

/// `POST /api/v1/content/ceo`: the server sent the item into the CEO's chat as the person's
/// message. `held`: nothing was sent, the CEO waits on the person's answer first. `noted`: the
/// person's own words led the message; an older server ignores `note` and leaves it out.
struct ContentCeoReply: Decodable, Equatable {
    let taskId: String
    let sessionId: String?
    let started: Bool?
    let held: Bool?
    let testRun: Bool?
    var noted: Bool? = nil
}

/// `POST /api/v1/content/draft`: the words New task fills the draft with (the web's own text).
struct ContentDraftReply: Decodable, Equatable {
    let text: String
}

extension WalnutAPI {
    /// `note` is what the person wrote to the CEO; the server puts it first, the item after it.
    /// `images` are the pictures put with it, inline as the chat sends them (omitted when none).
    func contentCeo(item: ContentItem, note: String, images: [ImagePayload] = []) async throws -> ContentCeoReply {
        struct Body: Encodable { let item: ContentItem; let note: String; let images: [ImagePayload]? }
        // The server may start the CEO's session first; the web waits as long. Pictures add an
        // upload of up to the composer's size budget ahead of that.
        return try await inboxItemRequest(
            "POST", "/content/ceo",
            body: Body(item: item, note: note, images: images.isEmpty ? nil : images), timeout: images.isEmpty ? 30 : 60
        )
    }

    /// `sent` is the phone's own rendering of `item.at`, so the draft reads in the person's time zone.
    func contentDraft(item: ContentItem, sent: String?) async throws -> ContentDraftReply {
        struct Body: Encodable { let item: ContentItem; let sent: String? }
        return try await inboxItemRequest("POST", "/content/draft", body: Body(item: item, sent: sent), timeout: 15)
    }
}
