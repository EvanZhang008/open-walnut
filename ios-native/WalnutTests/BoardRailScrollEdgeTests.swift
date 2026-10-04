import XCTest
import SwiftUI
@testable import Walnut

/// The pinned band bar kept its card and lost its chips once the board was scrolled
/// (2026-10-04). Cause: SwiftUI stretches the rail's horizontal scroll view up into the
/// top safe area, and iOS 26 gives a scroll view under a bar a top edge pocket sized to
/// that bar. With the large title collapsed the pocket covered the whole visible rail, so
/// the edge effect drew over the chips while the card (outside the scroll view) stayed.
///
/// Hosts the pinned copy the way `TasksView` does: an overlay on a List inside a
/// NavigationStack with a large title, an opaque toolbar and a search drawer.
@MainActor
final class BoardRailScrollEdgeTests: XCTestCase {

    private struct Harness: View {
        let latch: BoardChipsPinLatch
        @State private var text = ""
        var body: some View {
            NavigationStack {
                List {
                    ForEach(0..<200, id: \.self) { Text("Row \($0)") }
                }
                .overlay(alignment: .top) {
                    BoardBandBar(
                        chips: [
                            .init(bandId: nil, label: "All", count: 141),
                            .init(bandId: "focus", label: "Focus", count: 50),
                            .init(bandId: "satellite", label: "Satellite", count: 21),
                            .init(bandId: "wait", label: "Wait", count: 21),
                            .init(bandId: "ct_later", label: "Later", count: 49),
                        ],
                        selected: nil,
                        grouping: .constant(.project), dateFilter: .constant(.all),
                        showDone: .constant(false),
                        onSelect: { _ in }, placement: .pinnedOverlay, pinLatch: latch
                    )
                    .padding(.top, TasksChromeMetrics.pinnedChipsTopInset)
                }
                .navigationTitle("Tasks")
                .toolbarBackground(.visible, for: .navigationBar)
                .searchable(text: $text, placement: .navigationBarDrawer(displayMode: .automatic))
            }
        }
    }

    private func scrollViews(in view: UIView) -> [UIScrollView] {
        var out: [UIScrollView] = []
        if let sv = view as? UIScrollView { out.append(sv) }
        for sub in view.subviews { out.append(contentsOf: scrollViews(in: sub)) }
        return out
    }

    private func settle(_ view: UIView, _ seconds: TimeInterval = 0.1) {
        view.setNeedsLayout(); view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
        view.layoutIfNeeded()
    }

    func testNoScrollEdgeEffectDrawsOverThePinnedChips() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("scroll edge effects are iOS 26+") }
        let latch = BoardChipsPinLatch()
        latch.isPinned = true
        let host = UIHostingController(rootView: Harness(latch: latch))
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        settle(host.view, 0.5)

        let all = scrollViews(in: host.view)
        let list = try XCTUnwrap(all.first { $0 is UICollectionView }, "no board list")
        // The rail: the one horizontal scroller whose content is a single chip row tall.
        let rail = try XCTUnwrap(
            all.first { !($0 is UICollectionView) && $0.contentSize.height > 0
                && $0.contentSize.height < 80 },
            "no chip rail")

        // At rest, just past the pin, and deep in the board (title collapsed).
        for offset in [0.0, 120.0, 600.0] {
            list.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            settle(host.view)
            let railInWindow = rail.convert(rail.bounds, to: nil)
            // The chips draw in the bottom chip-row of the rail's platform frame, however
            // far SwiftUI stretched it into the safe area.
            let strip = CGRect(
                x: railInWindow.minX, y: railInWindow.maxY - rail.contentSize.height,
                width: railInWindow.width, height: rail.contentSize.height)
            // The edge effect lives in a private pocket view inside the scroll view; match
            // by name so the test still reads "nothing drawn over the chips" if the
            // platform renames the effect's other parts.
            let pockets = rail.subviews.filter {
                String(describing: type(of: $0)).contains("Pocket")
                    && !$0.isHidden && $0.alpha > 0.01
            }
            for pocket in pockets {
                let frame = pocket.convert(pocket.bounds, to: nil)
                XCTAssertLessThanOrEqual(
                    frame.intersection(strip).height, 0.5,
                    "offset \(offset): a scroll edge pocket \(frame) covers the chips \(strip)")
            }
        }
    }
}
