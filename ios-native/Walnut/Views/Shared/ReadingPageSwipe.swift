import SwiftUI
import UIKit

/// No page of the app moves sideways under a drag that starts on its content; Back is the button
/// and the swipe from the screen's left edge.
///
/// iOS 26 pops a navigation page on a rightward drag ANYWHERE on its content
/// (`UINavigationController.interactiveContentPopGestureRecognizer`), not only from the left edge.
/// On a page that scrolls up and down that reads as the page scrolling sideways: a slightly
/// diagonal drag while reading slides the whole page right, cuts its words at the edge and shows
/// the page underneath, and a longer one leaves the page (2026-11-15, the Org page's Threads; the
/// user asked why he could swipe it left and right when it should only scroll up and down).
///
/// The first fix opted pages in one by one (Threads, Brief, a letter), so every page nobody named
/// (a note, a notes folder, a Settings page, a session opened from a letter) kept the drag
/// (2026-11-20: the user asked to find every such page and fix them all). Now one pan on the window holds every
/// navigation stack's content pop in that window, the sheets' included: each content pop waits for
/// this pan to fail (`shouldBeRequiredToFailBy`, asked lazily per attempt, so a stack created
/// later is covered too). The pan begins for any drag that starts away from the left edge, and it
/// lets everything else (a list's scroll, a row's swipe actions, a code block's or a table's own
/// sideways scroll, a tap) go on with it.
///
/// `tests/web/ios-reading-page-swipe-guard.test.ts` keeps the app's root installing it and no
/// screen re-enabling the content pop.
extension View {
    /// Installs the window's pan. The app's root view applies it once.
    func noContentSwipeBack() -> some View {
        background(ContentSwipeBackBlocker().frame(width: 0, height: 0).accessibilityHidden(true))
    }
}

private struct ContentSwipeBackBlocker: UIViewRepresentable {
    func makeUIView(context: Context) -> Anchor { Anchor() }
    func updateUIView(_ uiView: Anchor, context: Context) {}

    /// Puts the pan on its window once that window shows it.
    final class Anchor: UIView {
        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window { ContentPopHold.install(on: window) }
        }
    }
}

/// The window's pan and the rule for when it takes a drag.
final class ContentPopHold: NSObject, UIGestureRecognizerDelegate {
    /// Where the system's own edge swipe starts: a drag from there is left to it.
    static let edgeZone: CGFloat = 24

    private static let shared = ContentPopHold()

    /// One pan per window, whichever views ask.
    static func install(on window: UIWindow) {
        guard !(window.gestureRecognizers ?? []).contains(where: { $0.delegate === shared }) else { return }
        let pan = UIPanGestureRecognizer()
        pan.delegate = shared
        pan.cancelsTouchesInView = false
        pan.delaysTouchesBegan = false
        pan.delaysTouchesEnded = false
        window.addGestureRecognizer(pan)
    }

    /// Any drag that starts away from the left edge: it recognizes alongside everything and
    /// cancels no touch, so taking every one costs nothing, while a check of its angle at the
    /// start would let a slanted drag through to the content pop.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer, let view = pan.view else { return false }
        let start = pan.location(in: view).x - pan.translation(in: view).x
        return start > Self.edgeZone
    }

    /// The touch's navigation stacks are made to wait for this pan before the drag is judged, in
    /// case UIKit does not ask `shouldBeRequiredToFailBy` for a recognizer on another view.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard #available(iOS 26.0, *) else { return true }
        var responder: UIResponder? = touch.view
        while let r = responder {
            if let nav = r as? UINavigationController, let pop = nav.interactiveContentPopGestureRecognizer,
               !Self.held.contains(pop) {
                pop.require(toFail: gestureRecognizer)
                Self.held.add(pop)
            }
            responder = r.next
        }
        return true
    }

    /// Content pops already made to wait, held weakly: each goes with its stack.
    private static let held = NSHashTable<UIGestureRecognizer>.weakObjects()

    /// A navigation stack's content pop waits for this pan; nothing else does.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        Self.isContentPop(other)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }

    /// `other` is the content pop of the navigation controller whose view it sits on.
    static func isContentPop(_ other: UIGestureRecognizer) -> Bool {
        guard #available(iOS 26.0, *) else { return false }
        var responder: UIResponder? = other.view
        while let r = responder {
            if let nav = r as? UINavigationController { return nav.interactiveContentPopGestureRecognizer === other }
            responder = r.next
        }
        return false
    }
}
