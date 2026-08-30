import SwiftUI

/// Breathing room for the three transcript PLACEHOLDERS (chat empty state,
/// session empty state, session loading state) that must never make the page
/// taller than the page has room for.
///
/// ## The incident this exists to prevent (P0, main chat, 2026-08-29)
///
/// With the keyboard up in the main chat, `chat.send` measured [358,512][390,544]
/// while the keyboard's own view (predictive/QuickType bar included) started at
/// y=528 — so the lower half of the SEND BUTTON sat under the predictive bar and
/// a tap on it typed a predicted word into the draft instead of sending. Silent
/// draft corruption on the app's primary send path.
///
/// Blame was first put on `ComposerBar.bottomControlRow`'s paddings and on how
/// `ChatView` hosts the composer (`safeAreaInset` vs an in-layout sibling). Both
/// were wrong, and the bounds prove it: across 14 hierarchy dumps the send
/// button's clearance below the keyboard was exactly **-24pt whenever a
/// transcript placeholder was on screen and exactly 0pt whenever it was not** —
/// same composer, same paddings, same keyboard, same `safeAreaInset`. The session
/// composer looked healthy in the refuter's run only because that session had a
/// real transcript, not because it was hosted differently.
///
/// ## Mechanism
///
/// `VStack { banners; messageList }.safeAreaInset(edge: .bottom) { composer }`
/// hands the VStack the keyboard-shrunk height as its PROPOSAL. The placeholders
/// asked for a FIXED `.padding(.vertical, 120)`, so their ideal height (their text
/// plus 240pt of padding) exceeded that proposal. A stack cannot shrink a child
/// that reports a larger ideal size than it was offered: it lays the child out at
/// the larger size, the stack's own reported height grows with it, and the inset
/// composer is placed relative to THAT — so the composer is pushed down by the
/// overflow and lands under the keyboard.
///
/// The push is the overflow, roughly 1:1, and that is arithmetic taken from the
/// broken build's own bounds rather than from a theory about stack alignment: the
/// slot between the nav bar (bottom y=116) and the composer (top y=440) was 324pt,
/// the placeholder's text measured 106pt (glyph top 214 to subheadline bottom 320),
/// so a fixed 120pt padding wanted 346pt and overflowed by 22 — against a MEASURED
/// composer push of 24pt (send bottom 544 + its 8pt padding = 552, keyboard top
/// 528). The 2pt gap between 22 and 24 is the slop in reading text extents off an
/// accessibility dump, which is exactly why the fix removes the overflow entirely
/// instead of trying to subtract a number from it.
///
/// ## The fix, stated as a rule rather than a number
///
/// Padding a placeholder is a PREFERENCE, never a requirement. The height the
/// page was actually offered is read here and the padding is capped so the
/// placeholder always fits: no overflow, so no half-overflow to push the inset,
/// so every composer control stays above the keyboard by construction. On a
/// full-height page nothing changes (the cap is never reached), which is why the
/// generous spacing survives for the case it was designed for.
///
/// Deliberately NOT solved by shrinking the composer's paddings or by teaching the
/// composer keyboard math: the composer was innocent, and a padding constant tuned
/// against one keyboard height breaks on the next one (a floating keyboard, a
/// language with a taller candidate bar, a larger Dynamic Type size).
///
/// ## Round 2 (P2, same day): the estimate was blind to accessibility sizes
///
/// The rule above needs to know how much of the page the COPY needs, and it asked a
/// flat 200pt. At accessibility-XXXL the chat empty state then rendered as "Your
/// Personal…": the allowance under-reported the text by roughly 3x, so the padding
/// happily took the slot the copy needed and the text was squeezed into an ellipsis.
/// Two changes carry the "never ellipsizes, at any content size, keyboard up or
/// down" invariant, because at AX5 with the keyboard up the copy genuinely does not
/// fit any padding choice: the allowance is now `@ScaledMetric` (it tracks the same
/// Dynamic Type curve the text does), and the placeholder is laid out at its own
/// ideal height inside a `ViewThatFits`, which degrades to a SCROLL instead of a
/// truncation when even zero padding is not enough.
///
/// Deliberately NOT a `@State` written from the geometry callback either — that is
/// the non-convergent-layout freeze this app shipped in P0-2 (see
/// `ScrollBottomTracking`'s header). The proxy's height is consumed INSIDE the same
/// layout pass and published nowhere.
struct TimelinePlaceholderInset: ViewModifier {
    /// The spacing the placeholder WANTS above and below its content when the page
    /// has room for it.
    let vertical: CGFloat

    /// Never squeeze the placeholder's own text to nothing: below this it keeps a
    /// minimum of breathing room and is allowed to overflow again. The placeholders
    /// sit inside a scrollable container, so at genuinely tiny heights that
    /// degrades to a scroll rather than to a clipped word — and a page that short
    /// has no composer clearance to protect anyway.
    static let minimumVertical: CGFloat = 8

    /// Room reserved for the placeholder's own glyph and text before any padding is
    /// granted, AT THE DEFAULT CONTENT SIZE. A deliberate over-estimate of the
    /// tallest of the three (a 40pt symbol, a headline, and a two-line subheadline):
    /// being generous only makes the padding start shrinking a little sooner, while
    /// being stingy would let the overflow — and the push — return.
    static let baseContentAllowance: CGFloat = 200

    /// The same allowance, SCALED by the reader's Dynamic Type setting.
    ///
    /// The flat 200 underestimated accessibility sizes badly enough to be a defect
    /// (P2, 2026-08-29): at accessibility-XXXL the chat empty state's headline
    /// rendered as "Your Personal…". The mechanism is the padding, not the text: the
    /// allowance said 200pt of the slot was enough for the copy, so the rule handed
    /// the remaining ~124pt of a keyboard-shrunk slot to padding, and the copy (which
    /// needs three times that at AX5) was squeezed and ellipsized.
    ///
    /// `@ScaledMetric` rather than a hand-written table, and relative to `.headline`
    /// because the headline is the line that ellipsized. It tracks the SAME curve the
    /// text does, so the estimate stays honest at every size instead of at one.
    @ScaledMetric(relativeTo: .headline) private var contentAllowance: CGFloat =
        TimelinePlaceholderInset.baseContentAllowance

    /// How much of the page the placeholder can actually use, which is NOT the height
    /// it was proposed whenever the keyboard is up.
    ///
    /// Round 3 (DOCK-c, 2026-08-29). With the keyboard down the composer is a
    /// `safeAreaInset`, so the proposal already stops at the composer and the copy fits
    /// above it — measured at AX5: copy 184-552, composer top 553. With the keyboard UP
    /// the transcript deliberately does NOT re-lay-out (that freeze is what keeps a tall
    /// list from thrashing mid-animation), so the composer FLOATS over it: same copy at
    /// 171-539, composer at 350-500. The bottom two lines were behind the composer, and
    /// because the placeholder still thought it had the whole page it never degraded to
    /// a scroll, so those lines were unreachable rather than merely covered.
    ///
    /// So the visible slot is computed instead of assumed. Both inputs come from
    /// channels that already exist and neither is a geometry publish: the keyboard's
    /// frame from its own notification, and the composer's height from the ONE composer
    /// measurement channel this app has (`FilePreviewDock`, which the dock bar places
    /// itself from). Every unknown fails OPEN to the proposal, i.e. to the pre-round-3
    /// behaviour.
    static func visibleHeight(
        pageHeight: CGFloat, pageBottom: CGFloat, keyboardTop: CGFloat?, composerHeight: CGFloat
    ) -> CGFloat {
        guard let keyboardTop, keyboardTop > 0, keyboardTop < pageBottom else { return pageHeight }
        // The composer rides directly on the keyboard, so its top edge is the real floor.
        let covered = pageBottom - (keyboardTop - max(0, composerHeight))
        return max(0, min(pageHeight, pageHeight - covered))
    }

    /// The whole rule, as a pure function so `TimelinePlaceholderInsetTests` can
    /// drive the REAL decision with no window, no keyboard and no running app.
    ///
    /// `availableHeight` is what the page offered. Half of any excess is what
    /// reaches the composer, so the padding budget is half the height left over
    /// after the text's allowance — that is the largest padding which cannot
    /// overflow.
    ///
    /// The allowance is never allowed BELOW the shipped over-estimate: `@ScaledMetric`
    /// also scales DOWN (at xSmall it returns ~180), and shrinking the estimate would
    /// grant more padding than the size the number was validated at, for no benefit.
    static func padding(
        vertical: CGFloat, availableHeight: CGFloat, contentAllowance: CGFloat
    ) -> CGFloat {
        let allowance = max(baseContentAllowance, contentAllowance)
        let budget = max(0, (availableHeight - allowance) / 2)
        return max(minimumVertical, min(vertical, budget))
    }

    /// The keyboard's top edge in screen coordinates, or nil when it is down.
    ///
    /// Taken from the keyboard's OWN notification, which is a legal source: it is an
    /// event, not a layout read, so writing it to `@State` cannot start the
    /// non-convergent layout loop that publishing a `GeometryProxy` does (see
    /// `ScrollBottomTracking`'s header). The dock bar takes its keyboard cue from the
    /// same two notifications.
    @State private var keyboardTop: CGFloat?

    /// The one composer-measurement channel this app has. OPTIONAL on purpose: previews
    /// and the test harness render placeholders with no dock in the environment, and a
    /// missing dock has to mean "assume the whole proposal is mine", i.e. the behaviour
    /// this file shipped before round 3.
    @Environment(FilePreviewDock.self) private var dock: FilePreviewDock?

    private var composerHeight: CGFloat {
        if case .measured(let height) = dock?.composerClearance { return height }
        return 0
    }

    func body(content: Content) -> some View {
        GeometryReader { proxy in
            // `ViewThatFits`, not an unconditional `ScrollView`: this placeholder is
            // painted in a `ZStack` OVER the transcript, so a scroll view that is
            // always present would swallow the list's own gestures (pull-to-refresh)
            // even in the ordinary case where nothing needs scrolling. The first
            // candidate is the plain, gesture-transparent placeholder and it wins
            // whenever the copy fits; the scrollable one is the degrade path.
            //
            // Why a degrade path is needed at all, and why capping the padding was not
            // enough: at accessibility sizes the copy alone can be taller than a
            // keyboard-shrunk slot (measured at AX5: ~430pt of text and symbol in a
            // 324pt slot). No padding rule can make that fit, and the alternatives are
            // ellipsis (the defect), clipping, or scrolling. Scrolling is the only one
            // where every word stays reachable, and it is what this file's header has
            // claimed all along, so this makes the claim true.
            //
            // HIT TESTING IS PART OF THE RULE, not decoration (DOCK-c, 2026-08-29
            // refutation). Two halves had to be true and only one was: the callers now
            // paint this placeholder ABOVE the hosted transcript (it used to be the
            // FIRST layer of the `ZStack`, i.e. underneath a `UICollectionView` that
            // covers the whole area, so the degrade path could never receive a touch
            // and the copy at AX5 was unreadable no matter how correct the scroll view
            // was) — and being on top must not cost the transcript its gestures. So
            // the candidate that fits is explicitly gesture-transparent and the
            // SCROLLING candidate is not: interactivity follows the same condition the
            // scroll view does, which is exactly when the user needs it.
            let slot = Self.visibleHeight(
                pageHeight: proxy.size.height,
                pageBottom: proxy.frame(in: .global).maxY,
                keyboardTop: keyboardTop,
                composerHeight: composerHeight
            )
            ViewThatFits(in: .vertical) {
                laidOut(content, availableHeight: slot)
                    .allowsHitTesting(false)
                ScrollView(.vertical) {
                    laidOut(content, availableHeight: slot)
                }
                .scrollIndicators(.hidden)
            }
            // The slot is what `ViewThatFits` gets PROPOSED, and that is the whole point
            // of computing it. `ViewThatFits` picks a candidate by comparing each one's
            // ideal size against its own proposal, so while the proposal was the full
            // page the fitting candidate always won with the keyboard up (368pt of copy
            // "fits" 674pt of page) even though the composer floated over its bottom
            // third. Proposing the visible slot instead is what lets the degrade path
            // trigger exactly when part of the copy would otherwise be unreachable, and
            // it also keeps the scroll view's gesture area off the composer.
            //
            // Safe against the P0 at the top of this file: the `GeometryReader` above
            // still reports the page's proposal to its parent whatever this frame does,
            // so the placeholder cannot make the page taller and cannot push the inset
            // composer down. With the keyboard down `slot == proxy.size.height`, so this
            // is a no-op on the path that was already correct.
            .frame(width: proxy.size.width, height: slot, alignment: .top)
        }
        .onReceive(NotificationCenter.default.publisher(
            for: UIResponder.keyboardWillShowNotification)) { note in
            let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
            keyboardTop = frame?.minY
        }
        .onReceive(NotificationCenter.default.publisher(
            for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardTop = nil
        }
    }

    /// The placeholder at a given page height: capped padding, centred, and (the part
    /// that carries the never-ellipsize invariant) laid out at its own IDEAL height
    /// vertically. `fixedSize` is what stops SwiftUI from resolving a too-short
    /// proposal by truncating the text; the height it asks for is then absorbed by the
    /// `GeometryReader` above (which reports the proposal it was handed, never its
    /// child's ideal), so the overflow that pushed the composer under the keyboard in
    /// the P0 above still cannot come back.
    private func laidOut(_ content: Content, availableHeight: CGFloat) -> some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, Self.padding(vertical: vertical,
                                             availableHeight: availableHeight,
                                             contentAllowance: contentAllowance))
            .frame(maxWidth: .infinity, minHeight: availableHeight, alignment: .center)
    }
}

extension View {
    /// Placeholder spacing that yields to the page's real height. See
    /// `TimelinePlaceholderInset` for the incident and the mechanism.
    func timelinePlaceholderInset(vertical: CGFloat) -> some View {
        modifier(TimelinePlaceholderInset(vertical: vertical))
    }
}

/// The hosting-side half of the same guarantee: content above a `safeAreaInset`
/// composer is laid out at EXACTLY the height the page offered, so nothing inside
/// it can push the composer down.
///
/// The placeholder fix above removes the one overflow this app actually shipped.
/// This modifier is why the composer is now keyboard-safe by CONSTRUCTION rather
/// than by every future sibling remembering the rule: banners, error rows and the
/// permission cards are all siblings in the same stack, any of them can grow (a
/// long error, an `AskUserQuestion` card with several options, a large Dynamic
/// Type size), and each one would otherwise be another way to slide the send
/// button under the keyboard.
///
/// `GeometryReader` reports the proposal it was handed, and pinning the content to
/// `proxy.size` makes the stack's reported height equal to that proposal whatever
/// its children ask for. Alignment is `.top` so growth spills downward behind the
/// composer (recoverable: the transcript scrolls) instead of being centered, which
/// is what turned an overflow into a symmetric push in the first place.
///
/// Same discipline as above: the proxy is read and consumed inside one layout
/// pass, and nothing is published from it.
struct KeyboardSafeComposerContent: ViewModifier {
    func body(content: Content) -> some View {
        GeometryReader { proxy in
            content.frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
        }
    }
}

extension View {
    /// Pin this content to the height the page offered, so a `safeAreaInset`
    /// composer below it can never be pushed under the keyboard.
    func keyboardSafeComposerContent() -> some View {
        modifier(KeyboardSafeComposerContent())
    }
}
