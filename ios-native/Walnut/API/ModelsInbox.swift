import Foundation

// MARK: - Human Inbox models (additive /api/v1/human-inbox)
//
// A letter is a notification whose body is a DOCUMENT: an agent writes subject
// + body once, well, for a human reader. The envelope (who sent it, from which
// task/host) is stamped server-side from the caller's session id, so nothing
// here is agent-controlled except subject/body/preview/actions.
//
// Frozen contract: docs/plan/human-inbox-todo.md → "Letter record (store)".
// Decoding is deliberately lenient (everything past id/subject optional): the
// phone must keep rendering an inbox when a newer server adds fields, and a
// single odd record must never empty the list.

/// WHY the letter exists. `unknown` keeps a future type renderable.
enum LetterKind: Equatable {
    case completion, actionRequired, review, info, unknown

    init(_ raw: String) {
        switch raw {
        case "completion": self = .completion
        case "action_required": self = .actionRequired
        case "review": self = .review
        case "info": self = .info
        default: self = .unknown
        }
    }

    /// Badge text on the envelope row and the reader header.
    var label: String {
        switch self {
        case .completion: return "Completed"
        case .actionRequired: return "Action needed"
        case .review: return "Review"
        case .info: return "Info"
        case .unknown: return "Letter"
        }
    }

    var symbol: String {
        switch self {
        case .completion: return "checkmark.seal"
        case .actionRequired: return "hand.raised"
        case .review: return "doc.text.magnifyingglass"
        case .info: return "info.circle"
        case .unknown: return "envelope"
        }
    }
}

/// One-click decision rendered as a button (action_required letters only).
struct LetterAction: Codable, Identifiable, Equatable {
    let id: String
    let label: String
    let description: String?
}

/// Stamped server-side from the caller's session id — an agent can't forge it.
struct LetterSender: Codable, Equatable {
    let sessionId: String?
    let sessionTitle: String?
    let taskId: String?
    let taskTitle: String?
    let project: String?
    let host: String?
}

/// The human's answer to an action_required letter (epoch-ms `at`).
struct LetterAnswer: Codable, Equatable {
    let actionId: String
    let label: String?
    let freeText: String?
    let at: Double?

    var date: Date? { at.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// One turn of the letter's conversation. `body` rides only on GET /:id (the
/// list omits every body); `bodyFile` present with no `body` means the rich
/// turn exists on disk but wasn't inlined.
struct LetterThreadEntry: Codable, Equatable, Identifiable {
    let from: String
    let text: String?
    let bodyFormat: String?
    let bodyFile: String?
    let at: Double?
    let body: String?

    /// Stable within one letter: the store appends turns and never reorders.
    var id: String { "\(from)|\(at ?? 0)|\(bodyFile ?? "")" }

    var isHuman: Bool { from == "human" }
    var date: Date? { at.map { Date(timeIntervalSince1970: $0 / 1000) } }
    var isHTMLBody: Bool { bodyFormat == "html" }
}

/// A letter. The SAME type decodes both the envelope (list) and the detail
/// (GET /:id) — detail simply fills `body` and the thread bodies, so a row can
/// hand what it already has to the reader while the full read lands.
struct Letter: Codable, Identifiable, Equatable {
    let id: String
    let subject: String
    let type: String
    let bodyFormat: String?
    let textPreview: String?
    let sender: LetterSender?
    let createdAt: Double?
    /// Human state. `var` so the store can flip it optimistically; the server
    /// response is still adopted as truth right after.
    var read: Bool?
    var pinned: Bool?
    var archived: Bool?
    let actions: [LetterAction]?
    let answered: LetterAnswer?
    let thread: [LetterThreadEntry]?
    let taskRefs: [String]?
    /// Detail only: the body content read off disk.
    let body: String?
    /// Detail only: the body file is gone, `body` holds the server's note.
    let bodyMissing: Bool?

    var kind: LetterKind { LetterKind(type) }
    var isRead: Bool { read ?? false }
    var isPinned: Bool { pinned ?? false }
    var isArchived: Bool { archived ?? false }
    var isHTMLBody: Bool { bodyFormat == "html" }
    var createdDate: Date? { createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    var threadEntries: [LetterThreadEntry] { thread ?? [] }

    /// An action_required letter nobody has answered yet — a real to-do.
    var isAwaitingDecision: Bool {
        kind == .actionRequired && answered == nil && !isArchived
    }

    /// Buttons to render. Empty unless the letter still wants a decision.
    var openActions: [LetterAction] {
        guard isAwaitingDecision else { return [] }
        return actions ?? []
    }

    // MARK: - Envelope formatting (pure — unit-tested)

    /// Row/push preview: one line, whitespace collapsed, bounded. The server
    /// already caps `textPreview` at 300 chars, so this is about SHAPE (a
    /// markdown-derived preview arrives with newlines and runs of spaces).
    var previewLine: String {
        Self.oneLine(textPreview ?? "")
    }

    /// Who sent it, as the row's first line: the session's own title when it
    /// has one, else an honest stand-in. An `external` sender is a
    /// hand-started agent with no tracked session.
    var senderName: String {
        if let title = sender?.sessionTitle, !Self.oneLine(title).isEmpty {
            return Self.oneLine(title)
        }
        let sid = sender?.sessionId ?? ""
        if sid.isEmpty || sid == "external" { return "External agent" }
        return "Session \(sid.prefix(8))"
    }

    /// Which box it came from, in the words the rest of the app uses.
    var hostLabel: String {
        let host = sender?.host ?? ""
        if host.isEmpty || host == "local" || host == "__local__" { return "Mac" }
        return host
    }

    var taskTitle: String? {
        guard let title = sender?.taskTitle, !Self.oneLine(title).isEmpty else { return nil }
        return Self.oneLine(title)
    }

    /// Collapse every run of whitespace (newlines included) into one space and
    /// trim. `Letter.previewCap` bounds the result with a real ellipsis.
    static func oneLine(_ raw: String, limit: Int = previewCap) -> String {
        let collapsed = raw
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard collapsed.count > limit, limit > 0 else { return collapsed }
        return String(collapsed.prefix(limit)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// Envelope preview budget — the server's own cap (letters/types.ts).
    static let previewCap = 300

    /// Inbox order: pinned first, then newest. Same comparator the console uses,
    /// so the two surfaces agree even though the server also pre-sorts.
    static func isOrderedBefore(_ a: Letter, _ b: Letter) -> Bool {
        if a.isPinned != b.isPinned { return a.isPinned }
        return (a.createdAt ?? 0) > (b.createdAt ?? 0)
    }

    // MARK: - Body clipping for the phone

    /// Longest body the phone renders inline. A letter is meant to be one phone
    /// screen; a 200KB body (the server's cap) is a report that belongs behind
    /// a link, and parsing it into markdown blocks on a phone is a freeze.
    /// Clipping is ANNOUNCED (`bodyWasClipped`) — a silently truncated document
    /// is worse than a short one plus a note.
    static let phoneBodyCap = 60_000

    /// The body to render, clipped at `phoneBodyCap` characters.
    var displayBody: String {
        let raw = body ?? ""
        guard raw.count > Self.phoneBodyCap else { return raw }
        return String(raw.prefix(Self.phoneBodyCap))
    }

    var bodyWasClipped: Bool { (body ?? "").count > Self.phoneBodyCap }
}

/// GET /api/v1/human-inbox[?archived=1] → { letters, unreadCount }.
struct LetterListResponse: Codable {
    let letters: [Letter]
    /// Unread NON-archived letters, per the store. The store derives its own
    /// count from the rows it holds, so this is only a cross-check.
    let unreadCount: Int?
}

/// GET /api/v1/human-inbox/:id and the read/pin/archive toggles → { letter }.
struct LetterResponse: Codable {
    let letter: Letter
}

/// How far a human answer/reply got toward the origin session.
///
/// `skipped` is NOT a failure: an `external` sender has no session to answer,
/// and the thread entry is written either way. `deferred` isn't one either —
/// the origin session is parked on a permission prompt, so the answer waits in
/// its queue instead of auto-denying that prompt.
struct LetterDelivery: Codable, Equatable {
    let status: String?
    let reason: String?
    let sessionId: String?
    let messageId: String?

    /// One short line for the reader. Mirrors the console's `deliveryText()`.
    var humanText: String {
        switch status {
        case "queued", "delivered":
            return "Sent to the agent"
        case "deferred":
            return "Queued — the agent is waiting on a permission prompt, so your answer reaches it when that prompt is resolved"
        case "skipped":
            return reason == "origin_session_gone"
                ? "Saved — the sending session is gone, so nothing was delivered"
                : "Saved — this letter has no origin session to answer"
        case "failed":
            return "Saved, but delivery to the agent failed"
        default:
            return "Saved"
        }
    }

    var isProblem: Bool { status == "failed" }
}

/// POST answer / human-reply → { letter, delivery }. The letter is the SAME
/// body-inlined detail GET /:id returns, so the reader adopts it wholesale.
struct LetterActionResult: Codable {
    let letter: Letter?
    let delivery: LetterDelivery?
}
