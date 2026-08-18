import Foundation
import Observation

/// Home-screen Quick Action → "start recording NOW, send the transcript to the
/// main agent". The fastest path from pocket to Personal AI: long-press the app
/// icon, pick "Voice to Walnut", talk, tap stop. No tab hunting, no draft
/// review, no intent picker — the agent reads the sentence and decides whether
/// it's a search, a note, a task, or a chat.
///
/// This type is only the MAILBOX. It holds "a quick action asked for a
/// recording" until the chat composer is on screen and can act on it, which
/// keeps the decision out of the UIKit delegates (untestable) and out of view
/// `@State` (as durable as a view's identity — the ComposerDrafts lesson).
///
/// Why a mailbox at all: a shortcut is delivered at two very different moments.
/// Cold launch hands it to `didFinishLaunchingWithOptions` / the scene's
/// connection options — long BEFORE any SwiftUI view exists. A warm launch
/// delivers it to the scene delegate while the app may be sitting on another
/// tab. Both funnel here; the composer picks it up whenever it next appears.
@Observable
@MainActor
final class VoiceQuickAction {
    static let shared = VoiceQuickAction()

    /// `UIApplicationShortcutItemType` declared in Info.plist. Kept in sync by
    /// `VoiceQuickActionTests.testInfoPlistDeclaresTheVoiceShortcut` — a typo on
    /// either side silently disables the whole entry point, with no crash and no
    /// log to notice it by.
    static let shortcutType = "dev.openwalnut.ios.voice"

    /// A request older than this never opens the mic.
    ///
    /// The dangerous case is a quick action that lands with no consumer: the
    /// phone isn't paired yet, so the composer never appears. Without an expiry
    /// that request sits in memory and fires the mic the moment chat finally
    /// renders — which could be minutes later, after the user moved on. Two
    /// minutes is far longer than the cold-launch → first-composer path (a
    /// second or two, even on a cold, loaded device) and far shorter than "I
    /// forgot I pressed that".
    static let requestTTL: TimeInterval = 120

    struct Request: Equatable {
        let id: UUID
        let requestedAt: Date
        /// Which delivery path armed it — `launch`, `scene-connect`,
        /// `scene-perform`, `app-perform`, `debug-arg`. Field logs need this:
        /// which UIKit callback actually fires for a quick action differs
        /// between cold and warm launch, and this is how we find out.
        let source: String
    }

    /// Non-nil while a quick action waits for the chat composer to pick it up.
    private(set) var pending: Request?

    /// True while the LIVE take was started by a quick action, i.e. its
    /// transcript goes straight to the agent instead of into the draft. Owned
    /// here (not by the composer view) so a keyboard-driven identity churn
    /// mid-recording can't quietly downgrade an auto-send take to a draft one.
    var autoSendArmed = false

    private init() {}

    // MARK: - Pure routing (the unit-testable core)

    /// Is this shortcut type ours? Anything else (a future shortcut, a stale
    /// type from an older install still on the Home screen) is ignored.
    static func isVoiceShortcut(_ type: String?) -> Bool {
        type == shortcutType
    }

    /// TTL check. A NEGATIVE age (the clock moved backwards between arming and
    /// consuming — timezone/NTP correction) is tolerated up to the same
    /// window; beyond that the timestamp is not trustworthy and the safe answer
    /// is "don't open the microphone".
    static func isFresh(_ request: Request, now: Date, ttl: TimeInterval = requestTTL) -> Bool {
        let age = now.timeIntervalSince(request.requestedAt)
        return age >= -ttl && age <= ttl
    }

    // MARK: - Delivery (called from the UIKit delegates)

    /// Arm the mailbox if `type` is the voice shortcut. Returns whether it was
    /// handled — the scene delegate's completion handler wants exactly that.
    @discardableResult
    func handle(shortcutType type: String?, source: String, now: Date = Date()) -> Bool {
        guard Self.isVoiceShortcut(type) else {
            if let type {
                AppLog.info("voice", "ignored unknown quick action", ["type": type, "source": source])
            }
            return false
        }
        pending = Request(id: UUID(), requestedAt: now, source: source)
        AppLog.info("voice", "quick action armed", ["source": source])
        return true
    }

    // MARK: - Consumption (called from the composer)

    /// Take the pending request, if there is a fresh one. Clears the mailbox
    /// either way: a stale request must not be retried on the next appear.
    func consume(now: Date = Date()) -> Request? {
        guard let request = pending else { return nil }
        pending = nil
        guard Self.isFresh(request, now: now) else {
            AppLog.info("voice", "quick action expired", [
                "source": request.source,
                "ageSec": String(Int(now.timeIntervalSince(request.requestedAt))),
            ])
            return nil
        }
        return request
    }

    /// Drop everything — a cancelled take, a take stopped without transcribing,
    /// a failed transcription, a mic that wouldn't open. Also disarms auto-send
    /// so a LATER manual retry of that preserved audio lands in the draft for
    /// review rather than sending itself. (An unpaired app needs no call here:
    /// no composer ever consumes the request and the TTL retires it.)
    func clear(reason: String) {
        if pending != nil || autoSendArmed {
            AppLog.info("voice", "quick action cleared", ["reason": reason])
        }
        pending = nil
        autoSendArmed = false
    }

    /// Check-and-clear used at the delivery point: one transcript can only ever
    /// be auto-sent once, and whatever happens next (success or failure) the
    /// arming is spent.
    func takeAutoSend() -> Bool {
        guard autoSendArmed else { return false }
        autoSendArmed = false
        return true
    }
}
