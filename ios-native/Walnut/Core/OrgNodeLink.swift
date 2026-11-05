import Foundation
import Observation

/// Opens an Org node's page from anywhere: a thread push, a link. Same shape as
/// `ContentActionLink`: the caller drops the request here, `MainTabView` brings Chat forward, and
/// `ChatView` opens the node's chat with its page (Threads, scrolled to the thread) on top.
@Observable
@MainActor
final class OrgNodeLink {
    static let shared = OrgNodeLink()

    /// A request older than this is dropped: a tab that never came forward must not jump minutes
    /// after the tap.
    nonisolated static let requestTTL: TimeInterval = 120

    struct Request: Equatable {
        /// The node's task (the CEO's or a VP's).
        let taskId: String
        let tab: OrgNodeTab
        let threadId: String?
        let requestedAt: Date
    }

    private(set) var pending: Request?

    private init() {}

    /// Open the node `taskId` on `tab` (Threads by default), its thread `threadId` in view.
    func open(taskId: String, threadId: String? = nil, tab: OrgNodeTab = .threads, now: Date = Date()) {
        guard !taskId.isEmpty else { return }
        pending = Request(taskId: taskId, tab: tab, threadId: threadId, requestedAt: now)
        AppLog.info("org", "node page requested", ["taskId": taskId, "threadId": threadId ?? "", "tab": tab.rawValue])
    }

    func consume(now: Date = Date()) -> Request? {
        guard let request = pending else { return nil }
        pending = nil
        return ContentActionLink.isFresh(request.requestedAt, now: now, ttl: Self.requestTTL) ? request : nil
    }
}

/// What a node's chat opens on top of itself as it appears (a push asked for a thread).
struct OrgNodePageOpen: Equatable, Hashable {
    let tab: OrgNodeTab
    let threadId: String?
    /// The request's time: a second push for the same thread is a new request, not the same one.
    var at = Date()
}
