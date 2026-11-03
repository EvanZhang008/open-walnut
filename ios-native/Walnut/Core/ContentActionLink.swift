import Foundation
import Observation

/// One piece of content (an email item today) as Walnut's two content actions read it: Talk to
/// CEO hands it to the main agent, New task opens a draft with it. The same shape the web sends
/// (`packages/plugin-api/src/content-actions.ts`); the server cleans and caps every field.
struct ContentItem: Encodable, Equatable {
    var source: String
    var title: String
    var summary: String?
    var text: String?
    var from: String?
    var at: String?
    var whereText: String?
    var open: String?
    var url: String?
    enum CodingKeys: String, CodingKey { case source, title, summary, text, from, at, whereText = "where", open, url }
}

extension InboxEmailItem {
    /// The server's own placeholder summary (`EMAIL_SUMMARY_UNAVAILABLE`), never handed on.
    static let summaryUnavailable = "Email summary unavailable"

    /// A query value encoded the way the web's URLSearchParams reads it back: `+` and `&` are
    /// escaped (URLComponents leaves `+` as is, which the server reads as a space).
    static func queryValue(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? raw
    }

    /// This email as content, the way the web's `itemContent` builds it, or nil when the item is
    /// unavailable (the web shows no content actions then either).
    var contentItem: ContentItem? {
        guard unavailableReason == nil else { return nil }
        let name = Self.safe(display?.sender?.name ?? "").trimmingCharacters(in: .whitespaces)
        let address = Self.safe(display?.sender?.address ?? "").trimmingCharacters(in: .whitespaces)
        let from = name.isEmpty ? address : (address.isEmpty ? name : "\(name) <\(address)>")
        let named = Self.safe(display?.accountLabel ?? "").trimmingCharacters(in: .whitespaces)
        let label = named.isEmpty ? Self.safe(display?.accountHint ?? "").trimmingCharacters(in: .whitespaces) : named
        var open: String?
        if let source, source.isValid {
            open = "/mail?account=\(Self.queryValue(source.account))&message=\(Self.queryValue(source.message))"
        }
        return ContentItem(
            source: "Mail",
            title: subject.isEmpty ? "(no subject)" : subject,
            summary: summary.isEmpty || summary == Self.summaryUnavailable ? nil : summary,
            from: from.isEmpty ? nil : from,
            at: display?.sentAt,
            whereText: label.isEmpty ? nil : label,
            open: open
        )
    }
}

/// The two content actions reach screens on other tabs: Talk to CEO's "Open chat" opens the CEO's
/// session on the Chat tab, New task opens the new-session draft on the Tasks tab. Same shape as
/// `LetterDeepLink`: the card drops the request here, `MainTabView` brings the tab forward, and
/// the tab that can act on it takes it when it sees it.
@Observable
@MainActor
final class ContentActionLink {
    static let shared = ContentActionLink()

    /// A request older than this is dropped: a tab that never came forward must not jump to a
    /// chat or a draft minutes after the tap.
    nonisolated static let requestTTL: TimeInterval = 120

    /// The key the new-session draft's composer keeps its words under (`NewSessionChatView`).
    nonisolated static let newSessionDraftKey = "draft:new-session"

    struct ChatRequest: Equatable {
        /// nil: the answer never came back, so the CEO's task is looked up (`POST /org/main`).
        let taskId: String?
        let sessionId: String?
        let requestedAt: Date
    }

    struct DraftRequest: Equatable {
        let text: String
        let requestedAt: Date
    }

    /// "Open chat" after Talk to CEO: the Chat tab opens this session.
    private(set) var chat: ChatRequest?
    /// New task: the Tasks tab adds `text` to the draft and opens it.
    private(set) var draft: DraftRequest?

    private init() {}

    func openChat(taskId: String?, sessionId: String?, now: Date = Date()) {
        chat = ChatRequest(taskId: taskId, sessionId: sessionId, requestedAt: now)
        AppLog.info("content", "open ceo chat requested", ["taskId": taskId ?? "", "sessionId": sessionId ?? ""])
    }

    func openDraft(text: String, now: Date = Date()) {
        draft = DraftRequest(text: text, requestedAt: now)
        AppLog.info("content", "new task draft requested", ["chars": String(text.count)])
    }

    func consumeChat(now: Date = Date()) -> ChatRequest? {
        guard let request = chat else { return nil }
        chat = nil
        return Self.isFresh(request.requestedAt, now: now) ? request : nil
    }

    func consumeDraft(now: Date = Date()) -> DraftRequest? {
        guard let request = draft else { return nil }
        draft = nil
        return Self.isFresh(request.requestedAt, now: now) ? request : nil
    }

    nonisolated static func isFresh(_ at: Date, now: Date, ttl: TimeInterval = requestTTL) -> Bool {
        let age = now.timeIntervalSince(at)
        return age >= -ttl && age <= ttl
    }

    /// The draft after New task adds `adding`: words the person already typed stay first and are
    /// never replaced; the same item added twice is not added again.
    nonisolated static func merged(existing: String, adding: String) -> String {
        let added = adding.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !added.isEmpty else { return existing }
        let kept = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        if kept.isEmpty { return adding }
        if existing.contains(added) { return existing }
        return kept + "\n\n" + adding
    }
}
