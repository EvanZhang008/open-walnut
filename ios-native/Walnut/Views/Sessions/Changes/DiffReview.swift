import Foundation
import Observation

/// One line comment waiting in the review: on a line or a run of lines of one file.
struct DiffReviewComment: Codable, Equatable, Identifiable {
    let id: String
    let filePath: String
    let relPath: String
    /// The comparison it was left on (`DiffCompare.cacheKey`): its cards show only there.
    let compareKey: String
    /// `DiffLine.key` of every commented line, so the range stays tinted.
    let lineKeys: [String]
    /// "src/x.ts:L10" or "src/x.ts:L10-L14".
    let loc: String
    /// The commented lines' text, joined by newlines.
    let code: String
    var comment: String
    let createdAt: Date
    /// The comparison itself, so the review can open the diff the comment was
    /// left on (absent on comments saved before it was kept).
    var compare: DiffCompare? = nil
    /// The message id of a send that carries it and is not delivered yet (its bubble
    /// waits in the conversation for a retry): the comment stays here, not sent
    /// again, until the agent has it.
    var heldBy: String? = nil

    /// The card sits under the last commented line.
    var anchorKey: String { lineKeys.last ?? "" }
}

/// The text a review sends to the agent. Character for character what the web
/// Changed tab sends for the same comments (web/src/components/sessions/diffPrefill.ts:
/// buildCommentMessage and buildReviewMessage), so the agent reads one format
/// whichever device the review came from.
enum DiffReviewMessage {
    /// `path:L15`, `path:L15-L20`, or the bare path when no line has a number.
    static func loc(relPath: String, lines: [DiffLine]) -> String {
        guard let first = lines.first?.displayNumber, first > 0 else { return relPath }
        let last = lines.last?.displayNumber ?? first
        if lines.count > 1, last > 0, last != first { return "\(relPath):L\(first)-L\(last)" }
        return "\(relPath):L\(first)"
    }

    /// The commented lines as the message quotes them.
    static func code(_ lines: [DiffLine]) -> String {
        lines.map(\.text).joined(separator: "\n")
    }

    /// One comment, sent now.
    static func comment(loc: String, code: String, comment: String) -> String {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        let quoted: String
        if trimmed.isEmpty {
            quoted = ""
        } else if trimmed.contains("\n") {
            quoted = "\n```\n\(trimmed)\n```\n"
        } else {
            quoted = " `\(trimmed)`"
        }
        return "Re: \(loc)\(quoted)\n\n\(comment)"
    }

    /// The whole review as one message: a single comment reads exactly as `comment`
    /// would; several become a numbered list under a count.
    static func review(_ comments: [DiffReviewComment]) -> String {
        guard !comments.isEmpty else { return "" }
        if comments.count == 1, let only = comments.first {
            return comment(loc: only.loc, code: only.code, comment: only.comment)
        }
        let blocks = comments.enumerated().map { index, c -> String in
            let trimmed = c.code.trimmingCharacters(in: .whitespacesAndNewlines)
            let quoted: String
            if trimmed.isEmpty {
                quoted = ""
            } else if trimmed.contains("\n") {
                quoted = "\n```\n\(trimmed)\n```"
            } else {
                quoted = " `\(trimmed)`"
            }
            return "\(index + 1). Re: \(c.loc)\(quoted)\n\(c.comment)"
        }
        return "Code review \u{2014} \(comments.count) comments:\n\n\(blocks.joined(separator: "\n\n"))"
    }
}

/// What became of a review's send.
enum ReviewSendResult: Equatable {
    /// The server has it.
    case delivered
    /// A bubble in the conversation holds it and retries; nothing is on disk.
    case held(messageID: String)
    /// Nothing holds it.
    case notSent
}

/// Where a held send stands later.
enum HeldSendState: String, Codable, Equatable {
    case delivered, waiting, notSent
    /// This phone cannot tell (its bubble went with an app that ended, and the
    /// transcript on hand does not show it): the person decides.
    case unknown
}

/// The session's send as the review uses it, and the way to ask after a held one.
struct ReviewSender {
    let send: @MainActor (String) async -> ReviewSendResult
    let state: @MainActor (String) -> HeldSendState
}

/// A session's review: the comments waiting to be sent, kept on this phone until
/// they go (or are removed). Durable, not a cache: these are words the person wrote.
@MainActor
@Observable
final class DiffReview {
    let sessionId: String
    private(set) var comments: [DiffReviewComment]

    static func storeKey(_ sessionId: String) -> String { "diff-review.\(sessionId)" }

    init(sessionId: String) {
        self.sessionId = sessionId
        comments = DurableStore.load([DiffReviewComment].self, key: Self.storeKey(sessionId)) ?? []
    }

    func comments(onFile filePath: String, compareKey: String) -> [DiffReviewComment] {
        comments.filter { $0.filePath == filePath && $0.compareKey == compareKey }
    }

    /// Comments on a file in one comparison: what its diff shows as cards.
    func count(onFile filePath: String, compareKey: String) -> Int {
        comments.reduce(0) { $0 + ($1.filePath == filePath && $1.compareKey == compareKey ? 1 : 0) }
    }

    @discardableResult
    func add(file: SessionChangedFile, compare: DiffCompare, lines: [DiffLine], comment: String,
             heldBy: String? = nil) -> DiffReviewComment {
        let made = DiffReviewComment(
            id: UUID().uuidString, filePath: file.filePath, relPath: file.relPath, compareKey: compare.cacheKey,
            lineKeys: lines.map(\.key), loc: DiffReviewMessage.loc(relPath: file.relPath, lines: lines),
            code: DiffReviewMessage.code(lines), comment: comment, createdAt: Date(), compare: compare,
            heldBy: heldBy)
        comments.append(made)
        persist()
        return made
    }

    func edit(_ id: String, comment: String) {
        guard let i = comments.firstIndex(where: { $0.id == id }), comments[i].comment != comment else { return }
        comments[i].comment = comment
        // New words are a new comment to send: the held message has the old ones.
        comments[i].heldBy = nil
        persist()
    }

    /// The comments the next Send carries: every one no held message has.
    var unsent: [DiffReviewComment] { comments.filter { $0.heldBy == nil } }

    func remove(_ id: String) {
        comments.removeAll { $0.id == id }
        persist()
    }

    /// A send of the review is out. Kept here, not on the sheet: a sheet closed
    /// and opened again mid-send must not send the same comments twice.
    private(set) var sending = false

    /// Sends every unsent comment as one message. Delivered, the ones it carried
    /// leave; held by a bubble that retries, they stay, marked, until it is
    /// delivered (`reconcile`). Nil when a send is already out or nothing is unsent.
    func sendAll(using send: @MainActor (String) async -> ReviewSendResult) async -> ReviewSendResult? {
        let batch = unsent
        guard !batch.isEmpty, !sending else { return nil }
        sending = true
        defer { sending = false }
        let result = await send(DiffReviewMessage.review(batch))
        switch result {
        case .delivered: removeSent(batch)
        case .held(let id): hold(batch, by: id)
        case .notSent: break
        }
        return result
    }

    /// Marks the comments a held message carries (as sent: an edit since stays unsent).
    func hold(_ batch: [DiffReviewComment], by messageID: String) {
        let sent = Dictionary(batch.map { ($0.id, $0.comment) }, uniquingKeysWith: { a, _ in a })
        for i in comments.indices where sent[comments[i].id] == comments[i].comment {
            comments[i].heldBy = messageID
        }
        persist()
    }

    /// Settles held comments: the agent has their message, so they go; no bubble
    /// holds it any more, so they can be sent again; else they keep waiting.
    func reconcile(_ state: @MainActor (String) -> HeldSendState) {
        let held = Set(comments.compactMap(\.heldBy))
        guard !held.isEmpty else { return }
        var changed = false
        for id in held {
            switch state(id) {
            case .waiting, .unknown: continue
            case .delivered: comments.removeAll { $0.heldBy == id }
            case .notSent:
                for i in comments.indices where comments[i].heldBy == id { comments[i].heldBy = nil }
            }
            changed = true
        }
        if changed { persist() }
    }

    /// Undo a removal: the comment goes back where it stood.
    func restore(_ comment: DiffReviewComment, at index: Int) {
        guard !comments.contains(where: { $0.id == comment.id }) else { return }
        comments.insert(comment, at: min(max(0, index), comments.count))
        persist()
    }

    /// The person's call on held comments this phone cannot settle: they become
    /// unsent, for the next Send.
    func release(_ messageIDs: Set<String>) {
        for i in comments.indices where comments[i].heldBy.map(messageIDs.contains) == true { comments[i].heldBy = nil }
        persist()
    }

    /// The comments a send carried leave the review; one added, or edited, since stays.
    func removeSent(_ batch: [DiffReviewComment]) {
        let sent = Dictionary(batch.map { ($0.id, $0.comment) }, uniquingKeysWith: { a, _ in a })
        comments.removeAll { sent[$0.id] == $0.comment }
        persist()
    }

    func discardAll() {
        comments.removeAll()
        persist()
    }

    private func persist() {
        if comments.isEmpty {
            DurableStore.remove(key: Self.storeKey(sessionId))
        } else {
            DurableStore.save(comments, key: Self.storeKey(sessionId))
        }
    }
}
