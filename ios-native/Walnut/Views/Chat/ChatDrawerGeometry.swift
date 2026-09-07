import CoreGraphics

/// Geometry and settle rules for the Chat tab's left-edge drawer.
///
/// Pure math, deliberately: the part of a drawer that cannot be judged from a
/// screenshot is the GESTURE, and every judgement it makes (does this drag
/// belong to the drawer at all, where does a released drag land) is a rule a
/// test can pin without a simulator. The view keeps only the two things that
/// are genuinely stateful — the current fraction and whether a drag is being
/// tracked.
enum ChatDrawerGeometry {
    /// Share of the container the open drawer covers, and the ceiling that keeps
    /// it a drawer rather than a page: the sliver of chat left showing is what
    /// tells the user the conversation is still there behind it.
    static let widthFraction: CGFloat = 0.82
    static let maxWidth: CGFloat = 340
    /// How far from the leading edge a pull may START while the drawer is shut.
    /// Anything further in belongs to the transcript underneath.
    static let edgeZone: CGFloat = 24
    /// A release faster than this decides the direction on its own, whatever
    /// fraction the drawer had reached (points per second).
    static let flickVelocity: CGFloat = 350
    /// How much more sideways than vertical a drag must be before the drawer
    /// claims it. Without a margin here a diagonal flick down the transcript
    /// drags the drawer along with the scroll.
    static let dominance: CGFloat = 1.5
    /// Scrim alpha over the pushed-aside chat when the drawer is fully open.
    static let maxScrimOpacity: Double = 0.34
    /// How far the drawer must be out before the tab bar gets out of its way.
    /// Small, so the bar leaves WITH the drawer rather than after it, but not
    /// zero: the bar must not flicker on a 1pt twitch of a drag (1pt of a 320pt
    /// drawer is 0.003 of the way out).
    static let tabBarHideProgress: Double = 0.06

    static func width(container: CGFloat) -> CGFloat {
        guard container > 0 else { return maxWidth }
        return min(container * widthFraction, maxWidth)
    }

    /// Is this drag the drawer's? A shut drawer answers only to a rightward pull
    /// that began on the leading edge; an open one answers to any leftward drag,
    /// so it can be pushed back from the scrim, from its own rows, or from the
    /// sliver of chat.
    static func tracksDrag(startX: CGFloat, translation: CGSize, isOpen: Bool) -> Bool {
        guard abs(translation.width) > abs(translation.height) * dominance else { return false }
        if isOpen { return translation.width < 0 }
        return startX <= edgeZone && translation.width > 0
    }

    /// Where the drawer sits mid-drag: 0 shut, 1 open, clamped so a drag that
    /// overshoots either end does not rubber-band past it.
    static func progress(from start: Double, translationX: CGFloat, width: CGFloat) -> Double {
        guard width > 0 else { return start }
        return min(1, max(0, start + Double(translationX / width)))
    }

    /// Should the tab bar be out of the way at this fraction? A floating tab bar
    /// sits ON TOP of the tab's content, so while the drawer is out it would
    /// hover over the drawer's own rows and stay undimmed by the scrim. It leaves
    /// as soon as the drawer is meaningfully out, and comes back when the drawer
    /// is all the way in.
    static func tabBarHidden(progress: Double) -> Bool {
        progress > tabBarHideProgress
    }

    /// How much bottom room to hand back to the chat while the tab bar is away.
    ///
    /// Hiding a floating tab bar GROWS the page (its inset is released), and the
    /// composer rides the page's bottom — so without this the composer drops by
    /// the bar's height the moment the drawer starts opening and hops back on
    /// close. The bar's height is the system's business, so it is measured as the
    /// difference between the page now and the tallest the page ever was WITH the
    /// bar, and it collapses to zero on its own the moment the two agree.
    static func tabBarCompensation(pageHeight: CGFloat, tallestWithTabBar: CGFloat) -> CGFloat {
        max(0, pageHeight - tallestWithTabBar)
    }

    /// The remembered "page height with a tab bar", updated per geometry sample.
    ///
    /// A running MAXIMUM, and that is the whole subtlety: the keyboard also
    /// shrinks the page, so a plain "last value seen with the bar" would record a
    /// keyboard-shrunk height, and the next open (which dismisses the keyboard AND
    /// hides the bar) would compensate by the keyboard's height too and shove the
    /// composer up over the transcript. Nothing but the keyboard and the bar
    /// changes this page's height — the app is portrait-only — so the tallest
    /// sample taken with the bar present IS the keyboard-free one.
    static func rememberedHeight(
        tallestWithTabBar: CGFloat, pageHeight: CGFloat, tabBarHidden: Bool
    ) -> CGFloat {
        tabBarHidden ? tallestWithTabBar : max(tallestWithTabBar, pageHeight)
    }

    /// Where a released drag lands.
    static func settlesOpen(progress: Double, velocityX: CGFloat) -> Bool {
        if velocityX > flickVelocity { return true }
        if velocityX < -flickVelocity { return false }
        return progress >= 0.5
    }
}
