import Foundation
import Observation

/// Push → "open the node this thread waits in". The server buzzes the phone when Main or a VP
/// moves one of the user's Threads to `needs` while he is away from its chat
/// (`src/core/push/thread-push.ts`): alert title = the thread's title, body = its ask, and
/// `data = { type: "org_thread", taskId, threadId, url }`, where `taskId` is the node's task.
///
/// Same mailbox shape as `LetterDeepLink`: a tap can arrive before any SwiftUI view exists (a
/// cold launch from the lock screen) or while another tab is in front, so the callback drops the
/// target here and `MainTabView` hands it to `openThread` once it is on screen.
///
/// An unknown type or a payload missing either id is not ours: the tap just opens the app, as
/// an older build does with this payload.
@Observable
@MainActor
final class ThreadDeepLink {
    static let shared = ThreadDeepLink()

    /// `THREAD_PUSH_TYPE` in src/core/push/thread-push.ts.
    nonisolated static let payloadType = "org_thread"

    /// A tap older than this is dropped, for the reason `LetterDeepLink.requestTTL` gives.
    nonisolated static let requestTTL: TimeInterval = 600

    /// The one source that counts as "the human asked for this thread".
    nonisolated static let tapSource = "tap"

    /// What a thread push names. Ids are checked; the words come from the alert.
    struct Target: Equatable, Sendable {
        let taskId: String
        let threadId: String
        let title: String?
        let ask: String?
    }

    struct Request: Equatable {
        let target: Target
        let requestedAt: Date
        let source: String
    }

    /// Non-nil while a tapped thread waits for the app's tabs. Armed only by a tap.
    private(set) var pending: Request?

    /// A tap launched the app (the scene connected with a thread push's response) but the
    /// notification delegate has not handed it over yet: until then a launch must not put back
    /// another chat (`waitsToOpen`). The delegate's tap can come after the first frame.
    private(set) var launchTapExpectedAt: Date?

    /// How long a launch waits for the tap the scene announced before it gives up on it.
    nonisolated static let launchTapWait: TimeInterval = 6

    private init() {}

    // MARK: - Where a tap goes

    /// THE ONE place a tapped thread push opens: the node's page on its Threads tab, that thread
    /// in view. `OrgNodeLink` brings Chat forward (`MainTabView`), and `ChatView` opens the node's
    /// current session with the page on top, or says the node has no chat yet.
    static func openThread(taskId: String, threadId: String, title: String? = nil, ask: String? = nil, now: Date = Date()) {
        OrgNodeLink.shared.open(taskId: taskId, threadId: threadId, tab: .threads, title: title, ask: ask, now: now)
    }

    /// Hand a fresh pending tap to `openThread`. Called by `MainTabView` when it appears and when
    /// a tap arrives; a stale or empty mailbox does nothing.
    func deliverPending(now: Date = Date()) {
        guard let request = consume(now: now) else { return }
        Self.openThread(taskId: request.target.taskId, threadId: request.target.threadId,
                        title: request.target.title, ask: request.target.ask, now: now)
    }

    // MARK: - Pure routing (the unit-testable core)

    /// `THREAD_ID_RE` in src/core/org/threads-model.ts.
    nonisolated static func isValidThreadId(_ raw: String) -> Bool {
        guard raw.hasPrefix("th-") else { return false }
        let hex = raw.dropFirst(3)
        return (6...32).contains(hex.count) && hex.allSatisfy { "0123456789abcdef".contains($0) }
    }

    /// A task id becomes a URL path segment, so only the characters ids are made of pass.
    nonisolated static func isValidTaskId(_ raw: String) -> Bool {
        (1...64).contains(raw.count) && raw.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_"
        }
    }

    /// The thread a push names, or nil when it is not a thread push (a letter, an approval, an
    /// unknown type) or misses either id. Reads the same three shapes `LetterDeepLink` does.
    nonisolated static func target(fromPush userInfo: [AnyHashable: Any]) -> Target? {
        for candidate in LetterDeepLink.payloadDictionaries(userInfo) {
            guard let type = candidate["type"] as? String, type == payloadType else { continue }
            guard let taskId = candidate["taskId"] as? String, isValidTaskId(taskId),
                  let threadId = candidate["threadId"] as? String, isValidThreadId(threadId) else { continue }
            let alert = alertText(userInfo)
            return Target(taskId: taskId, threadId: threadId, title: alert.title, ask: alert.body)
        }
        return nil
    }

    /// The alert's title and body: `aps.alert` is a dictionary, or a bare string body.
    nonisolated static func alertText(_ userInfo: [AnyHashable: Any]) -> (title: String?, body: String?) {
        guard let aps = userInfo["aps"] as? [AnyHashable: Any] else { return (nil, nil) }
        if let body = aps["alert"] as? String { return (nil, nonEmpty(body)) }
        guard let alert = aps["alert"] as? [AnyHashable: Any] else { return (nil, nil) }
        return (nonEmpty(alert["title"] as? String), nonEmpty(alert["body"] as? String))
    }

    nonisolated private static func nonEmpty(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    nonisolated static func isFresh(_ request: Request, now: Date, ttl: TimeInterval = requestTTL) -> Bool {
        let age = now.timeIntervalSince(request.requestedAt)
        return age >= -ttl && age <= ttl
    }

    // MARK: - Delivery

    /// Handle a push. Returns whether it was a thread push.
    @discardableResult
    func handle(push userInfo: [AnyHashable: Any], source: String, now: Date = Date()) -> Bool {
        guard let target = Self.target(fromPush: userInfo) else { return false }
        arm(target, source: source, now: now)
        return true
    }

    /// Only a tap opens anything: a background delivery is no instruction. A second tap
    /// replaces the first, so one tap is one open.
    func arm(_ target: Target, source: String, now: Date = Date()) {
        if source == Self.tapSource {
            pending = Request(target: target, requestedAt: now, source: source)
            launchTapExpectedAt = nil
        }
        AppLog.info("org", "thread push routed", [
            "taskId": target.taskId, "threadId": target.threadId, "source": source,
            "opens": source == Self.tapSource ? "true" : "false",
        ])
    }

    /// Take the pending tap if it is fresh. Clears the mailbox either way.
    func consume(now: Date = Date()) -> Request? {
        guard let request = pending else { return nil }
        pending = nil
        guard Self.isFresh(request, now: now) else {
            AppLog.info("org", "thread deep link expired", [
                "threadId": request.target.threadId,
                "ageSec": String(Int(now.timeIntervalSince(request.requestedAt))),
            ])
            return nil
        }
        return request
    }

    /// A fresh tap still waits to become an open, or the scene said a tap launched it and the tap
    /// is not here yet: a launch must not put back another chat over it. Reads only; `consume`
    /// still decides.
    func waitsToOpen(now: Date = Date()) -> Bool {
        if let request = pending, Self.isFresh(request, now: now) { return true }
        return Self.expectsTap(since: launchTapExpectedAt, now: now)
    }

    nonisolated static func expectsTap(since: Date?, now: Date, wait: TimeInterval = launchTapWait) -> Bool {
        guard let since else { return false }
        let age = now.timeIntervalSince(since)
        return age >= 0 && age < wait
    }

    /// The scene connected with a notification response that is a thread push
    /// (`UIScene.ConnectionOptions.notificationResponse`): its tap reaches `arm` through the
    /// notification delegate, which may run after the first frame.
    func expectLaunchTap(_ target: Target, now: Date = Date()) {
        guard pending == nil else { return }
        launchTapExpectedAt = now
        AppLog.info("org", "thread push launched the app", ["taskId": target.taskId, "threadId": target.threadId])
    }

    func clear() {
        pending = nil
        launchTapExpectedAt = nil
    }
}
