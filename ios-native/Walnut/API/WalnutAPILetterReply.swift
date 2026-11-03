import Foundation

/// The letter reply box's network seam, so WalnutTests can drive the real send,
/// retry and draft rules in `LetterReplyStore` against a scripted transport.
protocol LetterReplyTransport {
    func replyToLetter(
        id: String, text: String, clientId: String, images: [ImagePayload]
    ) async throws -> LetterActionResult
}

extension WalnutAPI: LetterReplyTransport {
    /// The human's free-text reply, with the phone's id for it.
    ///
    /// `clientId` is what makes Retry safe: the server threads a reply once per id
    /// and answers a repeat from the turn already on record (re-delivering it only
    /// when that record says the delivery failed). A reply whose response was lost
    /// can therefore be sent again without the agent reading it twice. A server
    /// that predates the field ignores it and behaves as before.
    ///
    /// NOT `retrySafe` at the transport level: an older server would thread a
    /// silent automatic retry as a second reply, so retrying stays a visible,
    /// human decision (the Retry under the failed reply). Long timeout for the
    /// same reason as `answerLetter`: the route's deadline is 12s and a cloud
    /// companion adds a relay hop.
    ///
    /// `images` ride inline, as the chat's do (`images: [{data, mediaType}]`); a
    /// server that predates them on this route ignores the field and keeps the words.
    func replyToLetter(
        id: String, text: String, clientId: String, images: [ImagePayload] = []
    ) async throws -> LetterActionResult {
        struct Body: Encodable {
            let text: String
            let clientId: String
            let images: [ImagePayload]?
        }
        return try await send(
            "POST", "/human-inbox/\(escape(id))/human-reply",
            body: Body(text: text, clientId: clientId, images: images.isEmpty ? nil : images),
            timeout: 45
        )
    }
}
