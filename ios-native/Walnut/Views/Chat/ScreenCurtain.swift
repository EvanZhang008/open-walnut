import UIKit

/// A still picture of the app window, over everything, while one chat replaces another on the Chat
/// tab with its node page (`ChatView.presentOnRequest`). The swap takes the old page down, puts the
/// next chat in its place and pushes its page, all without animation, but each is its own frame:
/// he saw the old VP's chat for a moment between the two pages (2026-11-08 review, round 3). Under
/// the picture he sees the old page until the new one is up, then the new one.
///
/// It never outstays `maxSeconds`, takes no part in accessibility (the views under it are what is
/// there), and swallows taps while it is up, so none lands on a chat that is on its way out.
@MainActor
enum ScreenCurtain {
    static let maxSeconds: Double = 2.5

    private static weak var shown: UIView?
    private static var token: UUID?

    static var isUp: Bool { shown != nil }

    /// Freeze what is on screen now. A curtain already up stays as it is.
    static func cover() {
        guard shown == nil, let window = PresentationLowering.appWindow(),
              let picture = window.snapshotView(afterScreenUpdates: false) else { return }
        picture.frame = window.bounds
        picture.isUserInteractionEnabled = true
        picture.isAccessibilityElement = false
        picture.accessibilityElementsHidden = true
        window.addSubview(picture)
        shown = picture
        let mine = UUID()
        token = mine
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(maxSeconds))
            if token == mine { lift() }
        }
    }

    /// Show the screen again, a frame after the new page has drawn.
    static func lift() {
        token = nil
        guard let picture = shown else { return }
        shown = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { picture.removeFromSuperview() }
    }
}
