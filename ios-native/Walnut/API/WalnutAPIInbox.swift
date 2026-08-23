import Foundation

// MARK: - Human Inbox endpoints (additive /api/v1, docs/plan/human-inbox.md)
//
// Letters from agents to the one human who reads them. Additive to the frozen
// v1 contract and identical on both server modes: a cloud REPLICA relays every
// one of these to the primary box (letters live where the daemons are), so the
// phone never needs to know which box it is talking to.
//
// Sending a letter is an AGENT action (`wn tools call human_inbox_send`) and is
// deliberately absent here — the phone only reads, answers, and files.

extension WalnutAPI {
    /// Envelope list (no body content). `archived: true` is the Archived shelf;
    /// the two lists are disjoint, which is why the inbox keeps them apart
    /// instead of filtering one array.
    func letters(archived: Bool = false) async throws -> LetterListResponse {
        try await get("/human-inbox\(archived ? "?archived=1" : "")")
    }

    /// One letter with its body and every rich thread turn inlined.
    /// 404 not_found for an unknown/expired id.
    func letter(id: String) async throws -> Letter {
        let response: LetterResponse = try await get("/human-inbox/\(escape(id))")
        return response.letter
    }

    /// Read state. The LETTER store is canonical here — the notification
    /// envelope in the console feed only mirrors it.
    func setLetterRead(id: String, read: Bool) async throws -> Letter {
        let response: LetterResponse = try await send(
            "POST", "/human-inbox/\(escape(id))/read", body: ["read": read]
        )
        return response.letter
    }

    func setLetterPinned(id: String, pinned: Bool) async throws -> Letter {
        let response: LetterResponse = try await send(
            "POST", "/human-inbox/\(escape(id))/pin", body: ["pinned": pinned]
        )
        return response.letter
    }

    func setLetterArchived(id: String, archived: Bool) async throws -> Letter {
        let response: LetterResponse = try await send(
            "POST", "/human-inbox/\(escape(id))/archive", body: ["archived": archived]
        )
        return response.letter
    }

    /// Click ONE action button. The record is written before delivery is
    /// attempted, so a 200 always means "your answer is on record" and
    /// `delivery` says how far it got toward the agent.
    /// 409 conflict = already answered elsewhere; 400 = unknown actionId.
    /// Long timeout: the server's own route deadline is 12s and a cloud
    /// REPLICA adds a bridge hop on top.
    func answerLetter(id: String, actionId: String, freeText: String? = nil) async throws -> LetterActionResult {
        struct Body: Encodable {
            let actionId: String
            let freeText: String?
        }
        let trimmed = freeText?.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await send(
            "POST", "/human-inbox/\(escape(id))/answer",
            body: Body(actionId: actionId, freeText: (trimmed?.isEmpty ?? true) ? nil : trimmed),
            timeout: 45
        )
    }

    /// Free-text reply from the human — threads under the letter and is
    /// delivered to the origin session. Same write-then-deliver guarantee.
    func replyToLetter(id: String, text: String) async throws -> LetterActionResult {
        try await send(
            "POST", "/human-inbox/\(escape(id))/human-reply",
            body: ["text": text],
            timeout: 45
        )
    }
}
