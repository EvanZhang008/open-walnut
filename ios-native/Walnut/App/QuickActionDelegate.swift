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
///  - **Warm launch** (process alive, backgrounded): UIKit prefers the SCENE
///    delegate here and only falls back to
///    `application(_:performActionFor:completionHandler:)` when no scene
///    delegate implements `windowScene(_:performActionFor:)`.
///
///    **That fallback is gone.** SwiftUI's own internal scene delegate now
///    implements the scene variant (verified in the iOS 26 runtime's SwiftUI
///    binary: `windowScene:performActionForShortcutItem:completionHandler:` is
///    in its method list), so it swallows every warm delivery and the
///    app-level callback below never runs. Measured 2026-08-27: a real
///    long-press → "Voice to Walnut" on an already-running app produced NO
///    `quick action armed` line at all, while the same tap cold worked.
///
///    The fix is `QuickActionSceneDelegate` at the bottom of this file, wired
///    in via `application(_:configurationForConnecting:options:)`: naming our
///    own scene delegate class puts US ahead of SwiftUI's, so the warm
///    delivery reaches the mailbox again. The app-level callback is KEPT as a
///    belt-and-braces path (it still fires on OS versions whose SwiftUI lacks
///    the scene method, and it costs nothing — `handle` is idempotent).
///
///    The `source` field on the armed request is how the field log tells these
///    apart: `scene-perform` = our scene delegate won, `app-perform` = the
///    old application-level path, `scene-connect` = a shortcut that arrived
///    with a brand-new scene.
///  - **DEBUG launch argument** (`-voice-quick-action`): the same code path,
///    reachable from `xcrun simctl launch`. `simctl` cannot synthesize a real
///    Home-screen long-press, so this is how the E2E drives the feature. It is
///    deliberately the SAME `handle()` call, not a parallel implementation.
final class QuickActionDelegate: NSObject, UIApplicationDelegate {
    /// DEBUG-only launch argument that arms the mailbox exactly like a real
    /// shortcut tap. Substring-matched because Maestro/simctl reshape flags
    /// ("-voice-quick-action").
    static let debugLaunchArgument = "voice-quick-action"

    /// One grep for the whole delivery chain: `voice: quick action delivery`.
    ///
    /// This is the D1 instrumentation, and it exists because the layer with the
    /// field report ("the Home-screen shortcut does nothing") was the ONLY layer
    /// that logged nothing at all. A normal launch, a shortcut UIKit dropped, and
    /// a scene delegate that was never installed produced byte-identical logs, so
    /// there was no way to tell a delivery failure from a consumption failure
    /// without a debugger attached to the user's phone.
    ///
    /// Every hook reports, whether or not a shortcut was attached, so the log
    /// says which callbacks the OS actually ran. A cold launch legitimately shows
    /// TWO lines (`did-finish-launching` then `scene-connect`) — collapsing them
    /// would hide the exact difference this is here to expose, since a missing
    /// `scene-connect` line is how "our scene delegate was never installed"
    /// looks.
    static func logDelivery(hook: String, shortcutType: String?, extra: [String: String] = [:]) {
        var meta = extra
        meta["hook"] = hook
        meta["shortcut"] = shortcutType == nil ? "absent" : "present"
        if let shortcutType { meta["type"] = shortcutType }
        AppLog.info("voice", "quick action delivery", meta)
    }

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
            Self.logDelivery(hook: "debug-arg", shortcutType: VoiceQuickAction.shortcutType)
            VoiceQuickAction.shared.handle(shortcutType: VoiceQuickAction.shortcutType, source: "debug-arg")
            return true
        }
        #endif
        let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem
        Self.logDelivery(hook: "did-finish-launching", shortcutType: item?.type)
        let handled = VoiceQuickAction.shared.handle(shortcutType: item?.type, source: "launch")
        // false = "we already dealt with it, don't call performActionFor".
        return !handled
    }

    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        Self.logDelivery(hook: "app-perform", shortcutType: shortcutItem.type)
        let handled = VoiceQuickAction.shared.handle(shortcutType: shortcutItem.type, source: "app-perform")
        completionHandler(handled)
    }

    /// Claim the scene delegate slot for our own class.
    ///
    /// This is the ONLY hook that gets ahead of SwiftUI's internal scene
    /// delegate, and without it warm quick actions are silently dropped (see the
    /// type header). SwiftUI still builds and drives the scene itself — we are
    /// not replacing its hosting, only naming the delegate class UIKit should
    /// message, and our delegate implements nothing but the two shortcut hooks.
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        Self.sceneConfiguration(role: connectingSceneSession.role)
    }

    /// The configuration decision, split out so a unit test can assert it.
    ///
    /// `UISceneSession` has no public initializer and cannot be faked, so a test
    /// calling the UIKit method above would need a live scene. Taking only the
    /// `role` keeps the one thing worth pinning — that we install OUR delegate
    /// class rather than leaving the slot to SwiftUI — reachable from a test.
    static func sceneConfiguration(role: UISceneSession.Role) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: role)
        config.delegateClass = QuickActionSceneDelegate.self
        // Log the class we ACTUALLY installed, read back off the config rather
        // than restated from the line above. If this hook is never called (the
        // app delegate not being adopted at all, which is a whole-feature outage
        // and has happened), the absence of this line is the first symptom — and
        // a `delegateClass` that is not ours means SwiftUI is swallowing warm
        // deliveries again, which is unprovable from behavior alone.
        logDelivery(hook: "scene-configuration", shortcutType: nil, extra: [
            "delegateClass": config.delegateClass.map { NSStringFromClass($0) } ?? "none",
            "role": role.rawValue,
        ])
        return config
    }
}

/// Scene-level shortcut delivery — the warm path on any OS whose SwiftUI
/// implements the scene variant (iOS 26 does).
///
/// Deliberately minimal: it implements the two shortcut hooks and NOTHING else,
/// so SwiftUI keeps full ownership of the window, the root view, and every other
/// scene callback. Both hooks funnel into the same `VoiceQuickAction.handle()`
/// the cold path uses — one mailbox, one set of rules (TTL, supersede, ignore
/// foreign types), no parallel implementation to drift.
final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
    /// A shortcut that arrives WITH the scene connection. Distinct from the cold
    /// `launchOptions` case: the process may already be alive (a prewarm, a
    /// background launch) while this particular scene is new, and then
    /// `didFinishLaunchingWithOptions` has already run without the item.
    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        // Unconditional: this line appearing at all is the proof that OUR scene
        // delegate is the one UIKit is messaging, which is the single fact the
        // warm path depends on and the one no behavioral test could establish.
        QuickActionDelegate.logDelivery(
            hook: "scene-connect", shortcutType: connectionOptions.shortcutItem?.type
        )
        VoiceQuickAction.shared.handle(
            shortcutType: connectionOptions.shortcutItem?.type, source: "scene-connect"
        )
    }

    /// The warm tap: app already running, scene already connected.
    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        QuickActionDelegate.logDelivery(hook: "scene-perform", shortcutType: shortcutItem.type)
        let handled = VoiceQuickAction.shared.handle(
            shortcutType: shortcutItem.type, source: "scene-perform"
        )
        completionHandler(handled)
    }
}
