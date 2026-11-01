import XCTest
import SwiftUI
@testable import Walnut

/// The pinned band bar kept its card and lost its chips once the board was scrolled
/// (2026-10-04). Cause: with the card flush against the navigation bar, SwiftUI stretched
/// the rail's horizontal scroll view up into the top safe area (168pt for 52pt of chips),
/// and the OS gave it a scroll edge pocket the size of the whole rail, so the edge effect
/// drew over the chips while the card (outside the scroll view) stayed. Hiding the effect
/// fixed iOS 26 and not iOS 27. The rail now stays `railVerticalInset` inside the card, so
/// it cannot stretch and no pocket exists, while the card stays flush, because its page
/// background running up behind the navigation bar is that bar's opaque background.
///
/// Hosts the pinned copy the way `TasksView` does: an overlay on a List inside a
/// NavigationStack with a large title, an opaque toolbar and a search drawer.
@MainActor
final class BoardRailScrollEdgeTests: XCTestCase {

    /// Rows paint this, so any of them showing through the gap above the bar is obvious.
    private static let rowColor = UIColor(red: 1, green: 0, blue: 0, alpha: 1)

    private struct Harness: View {
        let latch: BoardChipsPinLatch
        var typeSize: DynamicTypeSize = .large
        @State private var text = ""
        var body: some View {
            NavigationStack {
                List {
                    ForEach(0..<200, id: \.self) {
                        Text("Row \($0)").listRowBackground(Color(BoardRailScrollEdgeTests.rowColor))
                    }
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
            .environment(\.dynamicTypeSize, typeSize)
            // A parent's vertical bounce policy must not give the chip rail a vertical axis.
            .scrollBounceBehavior(.always, axes: .vertical)
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

    /// The harness in a light window, pinned: iPhone 16 Pro width by default, 440 for the
    /// Pro Max.
    private func host(width: CGFloat = 402, typeSize: DynamicTypeSize = .large) throws -> (UIWindow, UIHostingController<Harness>) {
        let latch = BoardChipsPinLatch()
        latch.isPinned = true
        let host = UIHostingController(rootView: Harness(latch: latch, typeSize: typeSize))
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: width == 440 ? 956 : 874)
        window.overrideUserInterfaceStyle = .light
        window.rootViewController = host
        window.makeKeyAndVisible()
        settle(host.view, 0.5)
        return (window, host)
    }

    func testThePinnedRailNeverReachesUnderTheNavigationBar() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("scroll edge effects are iOS 26+") }
        for width: CGFloat in [402, 440] {
            let (window, host) = try host(width: width)
            defer { window.isHidden = true }

            let all = scrollViews(in: host.view)
            let list = try XCTUnwrap(all.first { $0 is UICollectionView }, "no board list")
            // The rail: the one horizontal scroller whose content is a single chip row tall.
            let rail = try XCTUnwrap(
                all.first { !($0 is UICollectionView) && $0.contentSize.height > 0
                    && $0.contentSize.height < 80 },
                "no chip rail")

            // At rest (large title out), just past the pin, and deep in the board.
            let rest = -list.adjustedContentInset.top
            for offset in [rest, 0.0, 120.0, 600.0] {
                list.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
                settle(host.view)
                let railInWindow = rail.convert(rail.bounds, to: nil)
                // The root cause, measured directly: the rail's platform scroll view is
                // exactly its chip strip and starts inside the card, below the
                // navigation bar. Touching the card's top edge it stretched to the window
                // top (168pt for 52pt of chips, 280pt at rest), which is what put it under
                // the bar's scroll edge treatment.
                let railTop = list.safeAreaInsets.top + TasksChromeMetrics.pinnedChipsTopInset
                    + BoardBandBar.rail.railVerticalInset
                XCTAssertEqual(
                    railInWindow.height, rail.contentSize.height, accuracy: 0.5,
                    "w\(Int(width)) offset \(offset): the rail's scroll view \(railInWindow) is stretched past its chips")
                XCTAssertEqual(
                    railInWindow.minY, railTop, accuracy: 0.5,
                    "w\(Int(width)) offset \(offset): the rail \(railInWindow) does not start at \(railTop)")
                // And so the OS has no edge to mark: no visible scroll edge pocket over the
                // chips, matched by name so a renamed effect part still counts.
                let pockets = rail.subviews.filter {
                    String(describing: type(of: $0)).contains("Pocket")
                        && !$0.isHidden && $0.alpha > 0.01
                }
                for pocket in pockets {
                    let frame = pocket.convert(pocket.bounds, to: nil)
                    XCTAssertLessThanOrEqual(
                        frame.intersection(railInWindow).height, 0.5,
                        "w\(Int(width)) offset \(offset): a scroll edge pocket \(frame) covers the chips \(railInWindow)")
                }
            }
        }
    }

    func testTheHorizontalRailHasNoVerticalBounceOrScrollRange() throws {
        let sizes: [DynamicTypeSize] = [.large, .xxLarge, .accessibility5]
        for (width, typeSize) in [CGFloat(320), 402, 440].flatMap({ width in
            sizes.map { (width, $0) }
        }) {
            let (window, host) = try host(width: width, typeSize: typeSize)
            defer { window.isHidden = true }
            let rail = try XCTUnwrap(scrollViews(in: host.view).first {
                !($0 is UICollectionView) && $0.contentSize.height > 0
                    && $0.contentSize.height < 80
            })
            let list = try XCTUnwrap(scrollViews(in: host.view).first { $0 is UICollectionView })
            for offset in [-list.adjustedContentInset.top, 0, 120, 600] {
                list.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
                settle(host.view)
                print("[rail] width=\(width) type=\(typeSize) listY=\(offset) bounds=\(rail.bounds) content=\(rail.contentSize) insets=\(rail.adjustedContentInset) offset=\(rail.contentOffset) bounceY=\(rail.alwaysBounceVertical)")
                XCTAssertFalse(rail.alwaysBounceVertical, "a horizontal chip rail must not bounce vertically")
                XCTAssertLessThanOrEqual(
                    rail.contentSize.height + rail.adjustedContentInset.top
                        + rail.adjustedContentInset.bottom,
                    rail.bounds.height + 0.5,
                    "a horizontal chip rail must not have vertical travel"
                )
                XCTAssertEqual(rail.contentOffset.y, -rail.adjustedContentInset.top, accuracy: 0.5)
                XCTAssertGreaterThan(rail.contentSize.width, rail.bounds.width)
            }
        }
    }

    /// The other half of the fix: the CARD stays flush, because the pinned copy's page
    /// background running up behind the navigation bar is the only opaque thing there
    /// (the iOS 26 bar draws no background of its own). A 1pt gap under the bar, tried
    /// first, stopped the stretch too and let the rows read through the bar.
    func testThePinnedBarsPageCoversTheNavigationBar() throws {
        let (window, host) = try host()
        defer { window.isHidden = true }
        let list = try XCTUnwrap(scrollViews(in: host.view).first { $0 is UICollectionView })
        list.setContentOffset(CGPoint(x: 0, y: 600), animated: false)
        // The page behind the bar is drawn as the bar collapses: read the samples again until
        // they all show the page or 3 s pass, never once after a fixed wait (2026-11-01: the
        // same check in InboxSettingsScrollEdgeTests read a row before a loaded runner drew it).
        func offPage(barTop: CGFloat) throws -> [String] {
            let size = window.bounds.size
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 3
            format.opaque = true
            let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                host.view.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: true)
            }
            let cg = try XCTUnwrap(image.cgImage)
            let (w, h) = (cg.width, cg.height)
            var bytes = [UInt8](repeating: 0, count: w * h * 4)
            let ctx = try XCTUnwrap(CGContext(
                data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            func pixel(_ x: CGFloat, _ y: CGFloat) -> (Int, Int, Int) {
                let px = Int(x * 3), py = Int(y * 3)
                let i = (py * w + px) * 4
                return (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
            }
            var page = (r: CGFloat(0), g: CGFloat(0), b: CGFloat(0), a: CGFloat(0))
            BoardBandCard.pageColor.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
                .getRed(&page.r, green: &page.g, blue: &page.b, alpha: &page.a)
            let expected = (Int(page.r * 255), Int(page.g * 255), Int(page.b * 255))

            // Rows are red and the List is scrolled well under the bar, so any sample that is
            // not the page colour is a row reading through. Under the bar: between the inline
            // title and the pinned card, where the List's own top edge effect stops short of
            // the bar's bottom. Beside the card: its side margins, level with the chips.
            var samples: [(x: CGFloat, y: CGFloat)] = [(8, barTop + 26), (394, barTop + 26)]
            for y in [barTop - 8, barTop - 2] {
                for x: CGFloat in [8, 100, 300, 394] { samples.append((x, y)) }
            }
            return samples.compactMap { at -> String? in
                let got = pixel(at.x, at.y)
                let same = abs(got.0 - expected.0) <= 3 && abs(got.1 - expected.1) <= 3 && abs(got.2 - expected.2) <= 3
                return same ? nil : "pixel at (\(at.x), \(at.y)) is \(got), expected the page \(expected)"
            }
        }
        settle(host.view, 0.3)
        let deadline = Date().addingTimeInterval(3)
        var wrong = try offPage(barTop: list.safeAreaInsets.top)
        while !wrong.isEmpty && Date() < deadline {
            settle(host.view)
            wrong = try offPage(barTop: list.safeAreaInsets.top)
        }
        XCTAssertEqual(wrong, [], "a row reads through the navigation bar")
    }
}
