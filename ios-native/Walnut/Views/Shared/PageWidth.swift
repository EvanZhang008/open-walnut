import SwiftUI

/// The content of a page that scrolls up and down: exactly as wide as the page.
///
/// A vertical `ScrollView` sizes its content by the content's own frame, and a frame a few
/// points wider than the screen (anything inside that will not go narrower than its words:
/// a row of fixed-size labels, a pill, a measured table pass) made the WHOLE page scroll
/// sideways: on the Org page's Threads every card slid right under a drag, its words cut at
/// the edge (2026-11-15, the user: "它不就是上下的一个滑动吗"). With the content's frame the
/// page's own width the page scrolls only up and down; text still wraps inside it, and a block
/// that is meant to scroll sideways (a code block, a wide table) keeps its own horizontal scroll.
///
/// Every vertical page that shows agent-written text uses it
/// (`tests/web/ios-page-width-guard.test.ts` fails on one that does not).
extension View {
    func pageWidth() -> some View {
        containerRelativeFrame(.horizontal, alignment: .leading)
    }
}
