import SwiftUI
import UIKit

/// A pushed page of agent-written text where a sideways drag is reading, not Back.
///
/// iOS 26 pops a navigation page on a rightward drag ANYWHERE on its content
/// (`UINavigationController.interactiveContentPopGestureRecognizer`), not only from the screen's
/// left edge. On the Org page's Threads that read as the page scrolling sideways: a slightly
/// diagonal drag while reading slid the whole page right, cut its words at the edge and showed
/// the chat underneath, and a longer one left the page (2026-11-15, the user asked why he could
/// swipe it left and right when it should only scroll up and down; reproduced on the simulator by a drag from a quarter of the way in).
///
/// Here the content pop must wait for a pan of the page's own to fail; that pan begins only for a
/// rightward, mostly sideways drag that starts away from the left edge, and it lets everything
/// else (the list's scroll, a code block's or a table's own sideways scroll, a tap) go on with it.
/// So the page scrolls only up and down; Back is the button and the swipe from the left edge,
/// which stay as they are. Failure requirements are the use UIKit documents for that recognizer.
///
/// `tests/web/ios-reading-page-swipe-guard.test.ts` lists every page of agent text and fails on
/// one nobody classified.
extension View {
    func noContentSwipeBack() -> some View {
        background(ContentSwipeBackBlocker().frame(width: 0, height: 0).accessibilityHidden(true))
    }
}

private struct ContentSwipeBackBlocker: UIViewRepresentable {
    func makeUIView(context: Context) -> Anchor { Anchor() }
    func updateUIView(_ uiView: Anchor, context: Context) {}
    static func dismantleUIView(_ uiView: Anchor, coordinator: ()) { uiView.detach() }

    /// Finds the page's own view controller once it is on screen and puts the pan on its view.
    final class Anchor: UIView {
        private let pan = UIPanGestureRecognizer()
        private let rule = SidewaysRule()
        private weak var host: UIView?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            pan.delegate = rule
            pan.cancelsTouchesInView = false
            pan.delaysTouchesBegan = false
            pan.delaysTouchesEnded = false
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil, host == nil, let page = pageController() else { return }
            page.view.addGestureRecognizer(pan)
            host = page.view
            if #available(iOS 26.0, *) {
                page.navigationController?.interactiveContentPopGestureRecognizer?.require(toFail: pan)
            }
        }

        func detach() {
            host?.removeGestureRecognizer(pan)
            host = nil
        }

        /// The view controller the navigation stack holds for this page.
        private func pageController() -> UIViewController? {
            var responder: UIResponder? = self
            while let next = responder?.next {
                if let vc = next as? UIViewController, vc.parent is UINavigationController { return vc }
                responder = next
            }
            return nil
        }
    }
}

/// When the page's pan takes a drag: rightward, mostly sideways, started away from the left edge.
private final class SidewaysRule: NSObject, UIGestureRecognizerDelegate {
    /// Where the system's own edge swipe starts: a drag from there is left to it.
    static let edgeZone: CGFloat = 24
    /// How much more sideways than up or down a drag must be to be taken.
    static let dominance: CGFloat = 1.2

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer, let view = pan.view else { return false }
        let v = pan.velocity(in: view)
        let start = pan.location(in: view).x - pan.translation(in: view).x
        return start > Self.edgeZone && v.x > 0 && abs(v.x) > abs(v.y) * Self.dominance
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}
