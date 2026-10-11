import SwiftUI
import UIKit

extension View {
    /// Paints `color` behind the navigation bar of a screen whose content scrolls
    /// under it, and behind the status bar and the demo's label band above it.
    ///
    /// The iOS 26 bar draws no background of its own (`toolbarBackground` only
    /// helps iOS 18), and a scroll edge effect, the default or the hard one, did
    /// not keep a scrolled list's lines from reading through it: the App Store
    /// gate (2026-10-05) read letter titles between "Inbox" and its filter chips,
    /// and Settings' section headers under its title at AX5; a hard edge left
    /// them blurred but still there. The board solved the same thing with its
    /// page colour running up behind its bar (the pinned card's background in
    /// `BoardBandBar`), and this is that: a strip of no height flush with the
    /// top of the content, whose `Color` background reaches up through the top
    /// safe area. It sits over the rows and under the bar's title and buttons,
    /// and takes no touches.
    ///
    /// `largeTitle`: the screen shows a large title. On iOS 26 that title is drawn
    /// inside the band the strip covers, so an always-on strip hid "Inbox" and
    /// "Settings" at rest (round r5b). There the strip shows only once the bar is
    /// down to its inline height, which is the only time rows are under it: at
    /// rest and while the title collapses, the rows start below the title. Before
    /// iOS 26 the bar's own background covers what scrolls under it, so a
    /// large-title screen gets no strip there.
    func barPage(_ color: Color, largeTitle: Bool = false) -> some View {
        modifier(BarPage(color: color, largeTitle: largeTitle))
    }
}

/// When a large-title screen's strip shows. `top` is the scroller's top inset,
/// the bottom of the bar: tall at rest (168 pt on a 6.3-inch phone, 189 at AX5),
/// and shrinking with the finger while the title collapses, all the way down to
/// `inline`, the bottom of the bar at its inline height (116 at every text size:
/// the top of the safe area, 62, plus the inline bar, 54).
///
/// The strip waits for `inline` itself. A rule that compared `top` with the
/// smallest inset seen so far showed the strip in the middle of a slow drag
/// (the inset shrinks continuously, so each new value was the smallest yet),
/// where it covered the shrinking title and left an empty bar for half a second
/// (App Store gate, r5b, frame by frame).
enum BarPageRule {
    static func covers(top: CGFloat, inline: CGFloat) -> Bool {
        inline > 0 && top > 0 && top <= inline + 0.5
    }

    /// How long the strip takes to come in: about as long as iOS takes to fade
    /// the inline title in once the bar has collapsed (measured 0.2 s).
    static let fadeIn: TimeInterval = 0.2

    /// The navigation bar's own height with no large title. First read from a
    /// view's body, on the main thread.
    static let inlineBarHeight: CGFloat = {
        let bar = UINavigationBar()
        bar.prefersLargeTitles = false
        return bar.sizeThatFits(CGSize(width: 400, height: 200)).height
    }()
}

private struct BarPage: ViewModifier {
    let color: Color
    let largeTitle: Bool
    @State private var top: CGFloat = 0
    /// Where the bar starts: the top of the window's safe area, as its root
    /// controller has it (the status bar, plus the demo's label band, which is
    /// an `additionalSafeAreaInsets` on that controller).
    @State private var barStart: CGFloat = 0

    @ViewBuilder
    func body(content: Content) -> some View {
        if !largeTitle {
            content.overlay(alignment: .top) { strip }
        } else if #available(iOS 26.0, *) {
            content
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentInsets.top } action: { _, new in
                    top = new
                }
                .background(BarStartProbe { barStart = $0 })
                .overlay(alignment: .top) {
                    let covers = BarPageRule.covers(top: top, inline: inline)
                    // In over the inline title's own fade-in, so the large title fades
                    // out under it instead of vanishing a frame before the inline one
                    // shows (r6, frame by frame). Out at once: the bar is growing back
                    // and the large title is returning.
                    strip.opacity(covers ? 1 : 0)
                        .animation(covers ? .easeInOut(duration: BarPageRule.fadeIn) : nil, value: covers)
                }
        } else {
            content
        }
    }

    private var inline: CGFloat {
        barStart > 0 ? barStart + BarPageRule.inlineBarHeight : 0
    }

    private var strip: some View {
        Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: 0)
            .background(color, ignoresSafeAreaEdges: .top)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// Reports the top of the window's safe area as the window's root controller
/// has it, whenever it changes. Takes no touches and draws nothing.
private struct BarStartProbe: UIViewRepresentable {
    let report: (CGFloat) -> Void

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        view.report = report
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.report = report
        view.measure()
    }

    final class ProbeView: UIView {
        var report: ((CGFloat) -> Void)?
        private var last: CGFloat = -1

        override func didMoveToWindow() {
            super.didMoveToWindow()
            measure()
        }

        override func safeAreaInsetsDidChange() {
            super.safeAreaInsetsDidChange()
            measure()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            measure()
        }

        func measure() {
            guard let root = window?.rootViewController?.view else { return }
            let start = root.safeAreaInsets.top
            guard start != last else { return }
            last = start
            // Never inside SwiftUI's own update.
            let report = report
            DispatchQueue.main.async { report?(start) }
        }
    }
}
