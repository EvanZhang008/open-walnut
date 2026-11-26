import UIKit

/// Keeps a focused text view that sits inside a page's scroll view above the keyboard.
///
/// SwiftUI scrolls its own focused `TextField` into view, but not a `UITextView` it hosts: a thread
/// card's Follow up box tapped low on the page stayed under the keyboard, and grew under it as the user
/// typed (2026-11-26, CI on iOS 26.5: ThreadFollowUpVoiceUITests found the box's field at y 679 to
/// 954 behind a keyboard from y 540). The box sat in a sheet that rose with the keyboard until
/// bb0a87a737 put it on the card.
///
/// A text view calls `track()` once it exists and `reveal(_:)` when it takes the focus, when the
/// keyboard comes up or changes its frame, and when it grows while focused. Nothing moves when the
/// view already shows: a box in a bar under the page, or one high enough, stays where it is.
/// `tests/web/ios-keyboard-reveal-guard.test.ts` fails on a hosted text view that does neither.
@MainActor
enum KeyboardReveal {
    /// The space kept between the view's bottom and the keyboard's top.
    static let margin: CGFloat = 12

    /// The keyboard's frame in screen coordinates while it is up; nil while it is down.
    private(set) static var keyboard: CGRect?
    private static var tracking = false

    /// Follows the keyboard's frame, once for the whole app.
    static func track() {
        guard !tracking else { return }
        tracking = true
        let center = NotificationCenter.default
        for name in [UIResponder.keyboardDidShowNotification, UIResponder.keyboardDidChangeFrameNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { note in
                let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
                MainActor.assumeIsolated {
                    keyboard = frame
                    revealFirstResponder()
                }
            }
        }
        center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { keyboard = nil }
        }
    }

    /// How far a page must move up so a view ending at `bottom` clears a cover starting at
    /// `coverTop` by `margin`: 0 when it already does. Never more than the page has left to show
    /// (`room`), so it never scrolls past its end.
    nonisolated static func lift(bottom: CGFloat, coverTop: CGFloat, margin: CGFloat, room: CGFloat) -> CGFloat {
        let needed = bottom + margin - coverTop
        guard needed > 0 else { return 0 }
        return max(0, min(needed, room))
    }

    /// Moves `view`'s nearest page scroller so the view's bottom clears the keyboard, when it is the
    /// focused view and the keyboard covers it.
    static func reveal(_ view: UIView) {
        guard view.isFirstResponder, let window = view.window, let screenFrame = keyboard,
              let scroller = pageScroller(of: view) else { return }
        // `from: nil`: the notification's screen frame read in the window's base coordinates.
        let cover = window.convert(screenFrame, from: nil)
        guard cover.height > 0, cover.minY < window.bounds.maxY else { return }
        // What the scroller shows ends at its own bottom inset too (a tab bar, the keyboard's safe area).
        let shownEnd = scroller.convert(scroller.bounds, to: window).maxY - scroller.adjustedContentInset.bottom
        let coverTop = min(cover.minY, shownEnd)
        let bottom = view.convert(view.bounds, to: window).maxY
        let end = scroller.contentSize.height + scroller.adjustedContentInset.bottom - scroller.bounds.height
        let distance = lift(bottom: bottom, coverTop: coverTop, margin: margin, room: end - scroller.contentOffset.y)
        guard distance > 0 else { return }
        scroller.setContentOffset(CGPoint(x: scroller.contentOffset.x, y: scroller.contentOffset.y + distance), animated: true)
    }

    /// The nearest ancestor that scrolls the page up and down: never a text view (its own text scroller).
    private static func pageScroller(of view: UIView) -> UIScrollView? {
        var next = view.superview
        while let v = next {
            if let s = v as? UIScrollView, !(s is UITextView), s.isScrollEnabled { return s }
            next = v.superview
        }
        return nil
    }

    private static func revealFirstResponder() {
        for scene in UIApplication.shared.connectedScenes {
            for window in (scene as? UIWindowScene)?.windows ?? [] where window.isKeyWindow {
                if let focused = firstResponder(in: window), focused is KeyboardRevealing { reveal(focused) }
            }
        }
    }

    private static func firstResponder(in view: UIView) -> UIView? {
        if view.isFirstResponder { return view }
        for sub in view.subviews { if let found = firstResponder(in: sub) { return found } }
        return nil
    }
}

/// A text view that keeps itself above the keyboard when the keyboard comes up or moves (`KeyboardReveal`).
@MainActor
protocol KeyboardRevealing: UIView {}
