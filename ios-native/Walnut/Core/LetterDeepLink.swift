import Foundation
import Observation
import UIKit
import UserNotifications

/// Push → "open THIS letter". The mailbox half of the Human Inbox deep link.
///
/// Same shape as `VoiceQuickAction`, and for the same reason: a notification is
/// delivered at a moment when no SwiftUI view exists yet (a cold launch from the
/// lock screen) or while the app sits on another tab. So delivery drops the id
/// in here, and whichever surface can act on it picks it up when it next
/// appears. Keeping the decision out of the UIKit callbacks also makes the
/// routing rule — the only part with real logic — unit-testable.
///
/// The payload is the ENVELOPE only (`{type, letterId, letterType, kind}` plus
/// the subject/preview in the alert). The document body never rides a push; the
/// reader fetches it from `GET /api/v1/human-inbox/:id`.
@Observable
@MainActor
final class LetterDeepLink {
    static let shared = LetterDeepLink()

    /// `data.type` the server stamps on a letter push (src/core/push-notification.ts).
    nonisolated static let payloadType = "human_inbox_letter"

    /// A deep link older than this is dropped. The dangerous case is a tap that
    /// lands with no consumer (the phone isn't paired yet, so the inbox never
    /// appears): without an expiry it would yank the user into a letter minutes
    /// later, after they had moved on. Generous compared with the voice mailbox
    /// (2 min) because opening a letter is harmless where opening the mic isn't.
    nonisolated static let requestTTL: TimeInterval = 600

    struct Request: Equatable {
        let letterId: String
        let requestedAt: Date
        /// Which delivery path armed it — `tap`, `background`, `launch`.
        /// Field logs need this: which callback fires depends on app state.
        let source: String
    }

    /// Non-nil while a letter waits for the inbox to open it. Armed ONLY by an
    /// explicit tap (see `handle`).
    private(set) var pending: Request?

    /// Bumped by every letter push, tap or not. The inbox watches it and
    /// re-reads the list — that is how a silent/background delivery updates the
    /// badge without hijacking the screen the user is on.
    private(set) var arrivals = 0

    private init() {}

    // MARK: - Pure routing (the unit-testable core)

    /// Letter ids are `lt-<timestamp36>-<rand>` (server: LETTER_ID_RE). A push
    /// is untrusted input that turns into a URL path, so anything else is
    /// refused here rather than sent to the server.
    nonisolated static func isValidLetterId(_ raw: String) -> Bool {
        let parts = raw.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "lt" else { return false }
        let allowed = Set("0123456789abcdefghijklmnopqrstuvwxyz")
        guard (1...12).contains(parts[1].count), (4...12).contains(parts[2].count) else { return false }
        return parts[1].allSatisfy(allowed.contains) && parts[2].allSatisfy(allowed.contains)
    }

    /// The letter id carried by a push payload, or nil when this push is not a
    /// letter (a session result, a cron notification, anything else).
    ///
    /// Three shapes are accepted because the same logical `data` object reaches
    /// iOS differently depending on the sender: flat at the top level, nested
    /// under `data`, or under Expo's `body` key (which can itself be a JSON
    /// string). Reading only one of them is how a deep link silently stops
    /// working after a push-service change.
    nonisolated static func letterId(fromPush userInfo: [AnyHashable: Any]) -> String? {
        for candidate in payloadDictionaries(userInfo) {
            guard let type = candidate["type"] as? String, type == payloadType else { continue }
            guard let id = candidate["letterId"] as? String, isValidLetterId(id) else { continue }
            return id
        }
        return nil
    }

    /// The payload plus every nested envelope it might hide the data in.
    nonisolated private static func payloadDictionaries(_ userInfo: [AnyHashable: Any]) -> [[String: Any]] {
        var found: [[String: Any]] = [stringKeyed(userInfo)]
        for key in ["data", "body"] {
            guard let raw = userInfo[key] else { continue }
            if let dict = raw as? [AnyHashable: Any] {
                found.append(stringKeyed(dict))
            } else if let json = raw as? String,
                      let data = json.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                found.append(parsed)
            }
        }
        return found
    }

    nonisolated private static func stringKeyed(_ dict: [AnyHashable: Any]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (key, value) in dict {
            if let key = key as? String { out[key] = value }
        }
        return out
    }

    nonisolated static func isFresh(_ request: Request, now: Date, ttl: TimeInterval = requestTTL) -> Bool {
        let age = now.timeIntervalSince(request.requestedAt)
        // A NEGATIVE age (clock corrected backwards between arming and
        // consuming) is tolerated to the same window, then refused.
        return age >= -ttl && age <= ttl
    }

    // MARK: - Delivery (called from the notification callbacks)

    /// Handle a letter push. Returns whether it was ours.
    ///
    /// A TAP is a user instruction, so it arms the deep link and the app opens
    /// that letter. A silent/background delivery is NOT: opening the app minutes
    /// later would yank the user into a letter they never asked for, so it only
    /// bumps `arrivals` and the inbox refreshes its badge.
    @discardableResult
    func handle(push userInfo: [AnyHashable: Any], source: String, now: Date = Date()) -> Bool {
        guard let letterId = Self.letterId(fromPush: userInfo) else { return false }
        arm(letterId: letterId, source: source, now: now)
        return true
    }

    /// The same routing decision once the id is already extracted. Split out so a
    /// delivery callback that runs off the main actor can parse the payload where
    /// it lands and hop over with nothing but the id.
    func arm(letterId: String, source: String, now: Date = Date()) {
        arrivals += 1
        if source == Self.tapSource {
            pending = Request(letterId: letterId, requestedAt: now, source: source)
        }
        AppLog.info("inbox", "letter push routed", [
            "letterId": letterId, "source": source,
            "opensReader": source == Self.tapSource ? "true" : "false",
        ])
    }

    /// The one source that counts as "the human asked for this letter".
    nonisolated static let tapSource = "tap"

    /// Take the pending request if it is fresh. Clears the mailbox either way —
    /// a stale link must not be retried on the next appear.
    func consume(now: Date = Date()) -> Request? {
        guard let request = pending else { return nil }
        pending = nil
        guard Self.isFresh(request, now: now) else {
            AppLog.info("inbox", "letter deep link expired", [
                "letterId": request.letterId,
                "ageSec": String(Int(now.timeIntervalSince(request.requestedAt))),
            ])
            return nil
        }
        return request
    }

    func clear() { pending = nil }

    // MARK: - Notification plumbing

    /// Route taps on delivered notifications into the mailbox. Called once at
    /// launch (from `QuickActionDelegate`), because the responder for a TAP is
    /// the `UNUserNotificationCenter` delegate and it must be set before the app
    /// finishes launching or a cold-launch tap is dropped.
    ///
    /// This app does not register for APNs yet (no push token is minted on
    /// device), so today nothing calls in — the routing rule and the mailbox are
    /// the halves that need to exist and be proven for the moment it does.
    static func installNotificationRouting() {
        UNUserNotificationCenter.current().delegate = NotificationRouter.shared
    }

    /// Tiny `UNUserNotificationCenterDelegate` that only routes letters.
    /// Everything else falls through to the system default.
    final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {
        static let shared = NotificationRouter()

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse
        ) async {
            // Parse HERE (the routing rule is nonisolated and pure), then hop to
            // the main actor carrying only the id — the payload dictionary is
            // not Sendable and has no business crossing.
            let userInfo = response.notification.request.content.userInfo
            guard let letterId = LetterDeepLink.letterId(fromPush: userInfo) else { return }
            await MainActor.run {
                LetterDeepLink.shared.arm(letterId: letterId, source: LetterDeepLink.tapSource)
            }
        }

        /// Show letter banners even while the app is in the foreground: a letter
        /// arriving while the user reads another screen is exactly the case the
        /// inbox badge alone is too quiet for.
        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            [.banner, .list, .badge]
        }
    }
}

extension QuickActionDelegate {
    /// Background/silent delivery (`content-available`). A TAP does not come
    /// through here — that is the `UNUserNotificationCenter` delegate's job
    /// (see `LetterDeepLink.installNotificationRouting`).
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { @MainActor in
            let handled = LetterDeepLink.shared.handle(push: userInfo, source: "background")
            completionHandler(handled ? .newData : .noData)
        }
    }
}
