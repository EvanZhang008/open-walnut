import UIKit

/// UIKit delegate for the two out-of-band entry points SwiftUI gives no hook
/// for: Home-screen Quick Actions (dropped into `VoiceQuickAction.shared`) and
/// notification routing (`LetterDeepLink`, installed at launch because the
/// responder for a notification TAP must exist before launching finishes).
/// Both are mailbox hand-offs; no product logic lives here.
///
/// A shortcut arrives through THREE different callbacks depending on the app's
/// state, and missing any one of them makes the entry point work "sometimes":
///
///  - **Cold launch** (process not running): the item rides
///    `launchOptions[.shortcutItem]` in `didFinishLaunchingWithOptions`.
///    Per Apple's contract, returning `false` from that method suppresses the
///    later `performActionFor` call — so we handle it here and return `false`
///    to avoid a duplicate delivery. (`VoiceQuickAction.handle` is idempotent
///    anyway; the return value just keeps the log honest.)
///  - **Warm launch** (process alive, backgrounded): UIKit calls
///    `application(_:performActionFor:completionHandler:)` — but only because
///    SwiftUI's own internal scene delegate does NOT implement
///    `windowScene(_:performActionFor:)`. If a future SwiftUI release starts
///    implementing it, this callback goes silent; `VoiceQuickActionTests`
///    can't catch that (it's a UIKit behavior), so the `source` field on the
///    armed request is the field signal — it tells us which path actually fired.
///  - **DEBUG launch argument** (`-voice-quick-action`): the same code path,
///    reachable from `xcrun simctl launch`. `simctl` cannot synthesize a real
///    Home-screen long-press, so this is how the E2E drives the feature. It is
///    deliberately the SAME `handle()` call, not a parallel implementation.
final class QuickActionDelegate: NSObject, UIApplicationDelegate {
    /// DEBUG-only launch argument that arms the mailbox exactly like a real
    /// shortcut tap. Substring-matched because Maestro/simctl reshape flags
    /// ("-voice-quick-action").
    static let debugLaunchArgument = "voice-quick-action"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Route notification taps into the letter mailbox. Must happen here:
        // UNUserNotificationCenter drops a cold-launch tap if its delegate isn't
        // set by the time this method returns.
        LetterDeepLink.installNotificationRouting()
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(where: { $0.contains(Self.debugLaunchArgument) }) {
            VoiceQuickAction.shared.handle(shortcutType: VoiceQuickAction.shortcutType, source: "debug-arg")
            return true
        }
        #endif
        let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem
        let handled = VoiceQuickAction.shared.handle(shortcutType: item?.type, source: "launch")
        // false = "we already dealt with it, don't call performActionFor".
        return !handled
    }

    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let handled = VoiceQuickAction.shared.handle(shortcutType: shortcutItem.type, source: "app-perform")
        completionHandler(handled)
    }
}
