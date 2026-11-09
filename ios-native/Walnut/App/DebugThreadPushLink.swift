#if DEBUG
import SwiftUI

/// DEBUG only: a tap on a thread push while the app runs, for the UI tests. A banner cannot be
/// tapped on cue in a test, and the cold-launch argument (`-walnut.debugThreadPush`) only covers
/// a tap that starts the app, so a test opens
/// `walnut://debug-thread-push?task=<taskId>&thread=<threadId>&n=<nonce>` with
/// `XCUIDevice.shared.system.open` instead, and this does what the notification delegate does
/// with a tapped thread push (`NotificationRouter.userNotificationCenter(_:didReceive:)`): the
/// server's payload (`QuickActionDelegate.debugThreadPush`) read by `ThreadDeepLink.target`, then
/// `ThreadDeepLink.shared.arm` with the tap source, at the time it arrives. Everything after that
/// (`MainTabView`, `OrgNodeLink`, `ChatView`, `OrgNodePageLink`, the node's page) is the code a
/// real tap runs. `nonce` makes two taps of one thread two links.
///
/// Compiled out of Release with every use of it (`DebugThreadPushHookGuardTests`).
@MainActor
enum DebugThreadPushLink {
    static let host = "debug-thread-push"

    /// The same link arrives twice while the app runs (the scene delegate and SwiftUI's
    /// `onOpenURL`, as `WorkCardLinkBox` notes): the second is the first.
    private static var last: (url: URL, at: Date)?

    /// True when `url` is this link (taken here, nothing else opens it).
    @discardableResult
    static func open(_ url: URL, now: Date = Date()) -> Bool {
        guard url.scheme == "walnut", url.host == host else { return false }
        if let last, last.url == url, now.timeIntervalSince(last.at) < 2 { return true }
        last = (url, now)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String { items.first { $0.name == name }?.value ?? "" }
        let userInfo = QuickActionDelegate.debugThreadPush("\(value("task")) \(value("thread"))")
        // The notification delegate's two lines for a tapped thread push, as they are there.
        guard let thread = ThreadDeepLink.target(fromPush: userInfo) else { return true }
        ThreadDeepLink.shared.arm(thread, source: ThreadDeepLink.tapSource)
        return true
    }

    /// `-walnut.debugThreadPushLate "<taskId> <threadId>"`: a cold launch from a banner in the
    /// order iOS gives it. The scene connects with the push's response (what
    /// `QuickActionSceneDelegate` reads from `connectionOptions.notificationResponse`), and the
    /// notification delegate's tap comes a moment after the app first became active, so after
    /// the launch restore (`ChatView.restorePlace`) has run.
    static func armAfterFirstFrame(_ raw: String) {
        let userInfo = QuickActionDelegate.debugThreadPush(raw)
        guard let announced = ThreadDeepLink.target(fromPush: userInfo) else { return }
        ThreadDeepLink.shared.expectLaunchTap(announced)
        LaunchGate.shared.whenActive {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                // The notification delegate's two lines for a tapped thread push, as they are there.
                guard let thread = ThreadDeepLink.target(fromPush: userInfo) else { return }
                ThreadDeepLink.shared.arm(thread, source: ThreadDeepLink.tapSource)
            }
        }
    }
}

/// DEBUG only: says in the accessibility tree that a thread card wears its reveal mark, which
/// the UI tests read (`org.thread.revealed.<threadId>`). Draws nothing.
/// Where the Chat tab's last chat swap got to (`OrgChatSwap.Phase`), for a failure hierarchy:
/// `org.swap.phase.<phase>`.
struct DebugSwapPhaseMarker: View {
    let phase: String

    var body: some View {
        Text("Swap")
            .font(.system(size: 1))
            .foregroundStyle(.clear)
            .frame(width: 1, height: 1)
            .allowsHitTesting(false)
            .accessibilityIdentifier("org.swap.phase.\(phase)")
    }
}

struct DebugRevealMarker: View {
    let threadId: String
    /// The outline he sees (`org.thread.highlight.<id>`), not the tests' longer mark.
    var visible = false

    var body: some View {
        Text("Revealed")
            .font(.system(size: 1))
            .foregroundStyle(.clear)
            .frame(width: 1, height: 1)
            .allowsHitTesting(false)
            .accessibilityIdentifier(visible ? "org.thread.highlight.\(threadId)" : "org.thread.revealed.\(threadId)")
    }
}
#endif
