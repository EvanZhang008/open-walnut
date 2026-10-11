import XCTest
import SwiftUI
@testable import Walnut

/// The Inbox and Settings lists read through under the navigation bar once scrolled
/// (App Store gate, 2026-10-05): a letter's title showed between "Inbox" and the
/// pinned filter chips, and Settings' section headers under the title at AX5.
/// Cause: the iOS 26 bar draws no background of its own (`toolbarBackground` does
/// nothing there), and the scroll edge effect does not hide what scrolls under it;
/// a hard edge (round r5c) left it blurred but there on the simulator. Fix: the
/// page runs up behind the bar (`barPage`), as the board's pinned card does, with
/// the bar's colour scheme stated. The letter reader carries the same pair.
///
/// Hosts each scroller the way its screen builds it, with red rows, scrolls it well
/// under the bar, and samples the bar's band and the status bar's: any red there is
/// a row reading through. Round r5b: the always-on strip also hid the LARGE titles
/// ("Inbox", "Settings") at rest, because iOS 26 draws a large title inside the band
/// it covers; on a large-title screen the strip now shows only while the bar is
/// collapsed, and the title tests below look for the title's glyphs at rest and
/// after a scroll back to the top.
@MainActor
final class InboxSettingsScrollEdgeTests: XCTestCase {
    private static let rowColor = UIColor(red: 1, green: 0, blue: 0, alpha: 1)

    /// The inbox list's shape: a plain List whose one section pins a chip row.
    private struct InboxHarness: View {
        let page: Bool
        var body: some View {
            NavigationStack {
                List {
                    Section {
                        ForEach(0..<120, id: \.self) {
                            Text("Letter \($0)").listRowBackground(Color(InboxSettingsScrollEdgeTests.rowColor))
                        }
                    } header: {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack { ForEach(["All", "Unread", "Action needed", "Report"], id: \.self) { Text($0) } }
                        }
                    }
                }
                .listStyle(.plain)
                .modifier(PageBehindBar(on: page, color: Color(uiColor: .systemBackground), largeTitle: true))
                .navigationTitle("Inbox")
                .toolbarBackground(.visible, for: .navigationBar)
            }
        }
    }

    /// The Settings list's shape: an inset grouped List of headed sections.
    private struct SettingsHarness: View {
        let page: Bool
        var body: some View {
            NavigationStack {
                List {
                    ForEach(0..<12, id: \.self) { section in
                        Section("Section \(section)") {
                            ForEach(0..<4, id: \.self) {
                                Text("Row \($0)").listRowBackground(Color(InboxSettingsScrollEdgeTests.rowColor))
                            }
                        }
                    }
                }
                .navigationTitle("Settings")
                .modifier(PageBehindBar(on: page, color: Color(uiColor: .systemGroupedBackground), largeTitle: true))
            }
        }
    }

    /// The letter reader's shape: a ScrollView under an inline title.
    private struct LetterHarness: View {
        let page: Bool
        var body: some View {
            NavigationStack {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(0..<80, id: \.self) { _ in
                            Color(InboxSettingsScrollEdgeTests.rowColor).frame(height: 40)
                        }
                    }
                }
                .navigationTitle("Answered")
                .navigationBarTitleDisplayMode(.inline)
                .modifier(PageBehindBar(on: page, color: Color(uiColor: .systemBackground)))
            }
        }
    }

    /// `barPage` or nothing, so one harness also shows what the screen did before.
    private struct PageBehindBar: ViewModifier {
        let on: Bool
        let color: Color
        var largeTitle = false
        @ViewBuilder
        func body(content: Content) -> some View {
            if on { content.barPage(color, largeTitle: largeTitle) } else { content }
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

    /// The reddest pixel behind the navigation and status bar after scrolling 600 pt: how much of a row
    /// reads through (0 = none).
    private func redThroughBar<V: View>(_ root: V, dark: Bool) throws -> (red: Int, sample: String) {
        let host = UIHostingController(rootView: root)
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.overrideUserInterfaceStyle = dark ? .dark : .light
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        settle(host.view, 0.5)
        // The vertical scroller: the List's collection view, or the reader's scroll view.
        let list = try XCTUnwrap(
            scrollViews(in: host.view).first { $0.contentSize.height > 1_000 }, "no scroller")
        list.setContentOffset(CGPoint(x: 0, y: 600), animated: false)
        settle(host.view, 0.3)
        let barTop = list.safeAreaInsets.top

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
        var worst = 0
        var sample = ""
        // The bar's band (its bottom edge, its middle) and the status bar's.
        for y in [barTop - 8, barTop - 5, barTop - 2, barTop - 22, 30] {
            for x: CGFloat in [30, 120, 200, 300, 372] {
                let i = (Int(y * 3) * w + Int(x * 3)) * 4
                let (r, g, b) = (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
                // How far red stands above the other two: a grey, white or black
                // surface scores 0, a row reading through scores high.
                let redness = r - max(g, b)
                if redness >= worst { worst = redness; sample = "(\(x), \(y)) = (\(r), \(g), \(b))" }
            }
        }
        return (worst, sample)
    }

    func testNoLetterReadsThroughTheInboxBar() throws {
        for dark in [false, true] {
            let got = try redThroughBar(InboxHarness(page: true), dark: dark)
            XCTAssertLessThanOrEqual(got.red, 12, "dark=\(dark): a row reads through the Inbox bar at \(got.sample)")
            // What the screen showed without the page, for the record.
            let before = try redThroughBar(InboxHarness(page: false), dark: dark)
            print("SCROLLEDGE inbox dark=\(dark) page=\(got.red) \(got.sample) none=\(before.red) \(before.sample)")
        }
    }

    func testNoSectionReadsThroughTheSettingsBar() throws {
        for dark in [false, true] {
            for ax5 in [false, true] {
                let size: DynamicTypeSize = ax5 ? .accessibility5 : .large
                let got = try redThroughBar(SettingsHarness(page: true).dynamicTypeSize(size), dark: dark)
                XCTAssertLessThanOrEqual(got.red, 12, "dark=\(dark) ax5=\(ax5): a row reads through the Settings bar at \(got.sample)")
                let before = try redThroughBar(SettingsHarness(page: false).dynamicTypeSize(size), dark: dark)
                print("SCROLLEDGE settings dark=\(dark) ax5=\(ax5) page=\(got.red) \(got.sample) none=\(before.red) \(before.sample)")
            }
        }
    }

    func testNoLineReadsThroughTheLetterReadersBar() throws {
        for dark in [false, true] {
            let got = try redThroughBar(LetterHarness(page: true), dark: dark)
            XCTAssertLessThanOrEqual(got.red, 12, "dark=\(dark): the letter reads through its bar at \(got.sample)")
            let before = try redThroughBar(LetterHarness(page: false), dark: dark)
            print("SCROLLEDGE letter dark=\(dark) page=\(got.red) \(got.sample) none=\(before.red) \(before.sample)")
        }
    }

    // MARK: - The large titles show

    /// Pixels in the large title's band that stand out from the page (the title's
    /// glyphs), at rest, after scrolling 600 pt, and after scrolling back. A
    /// programmatic scroll back does not always grow the bar back to its tall
    /// height, so what shows then is compared with the same screen without the page.
    private func titleInk<V: View>(_ root: V, dark: Bool) throws -> (rest: Int, scrolled: Int, back: Int, band: String) {
        let host = UIHostingController(rootView: root)
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.overrideUserInterfaceStyle = dark ? .dark : .light
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        settle(host.view, 0.5)
        let list = try XCTUnwrap(
            scrollViews(in: host.view).first { $0.contentSize.height > 1_000 }, "no scroller")
        // The large title's band: below the inline bar, above the content at rest.
        let restTop = list.adjustedContentInset.top
        let inlineBottom = window.safeAreaInsets.top + UINavigationBar().sizeThatFits(CGSize(width: 402, height: 200)).height
        func ink() throws -> Int {
            let size = window.bounds.size
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 2
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
            func lum(_ x: Int, _ y: Int) -> Int {
                let i = (y * w + x) * 4
                return (Int(bytes[i]) * 299 + Int(bytes[i + 1]) * 587 + Int(bytes[i + 2]) * 114) / 1000
            }
            // The page's own colour, at the band's trailing end where no title is.
            let y0 = Int(inlineBottom * 2), y1 = Int(restTop * 2)
            let page = lum(w - 8, (y0 + y1) / 2)
            var count = 0
            for y in y0..<y1 { for x in 0..<(w / 2) where abs(lum(x, y) - page) > 100 { count += 1 } }
            return count
        }
        let rest = try ink()
        let top = list.adjustedContentInset.top
        list.setContentOffset(CGPoint(x: 0, y: 600 - top), animated: false)
        settle(host.view, 0.3)
        let scrolled = try ink()
        // Back to the top: twice, as the bar grows back to its tall height on the way.
        for _ in 0..<2 {
            list.setContentOffset(CGPoint(x: 0, y: -list.adjustedContentInset.top), animated: false)
            settle(host.view, 0.4)
        }
        return (rest, scrolled, try ink(), "\(inlineBottom)..\(restTop)")
    }

    func testTheInboxTitleShowsAtRestAndAfterAScrollBack() throws {
        for dark in [false, true] {
            let got = try titleInk(InboxHarness(page: true), dark: dark)
            let plain = try titleInk(InboxHarness(page: false), dark: dark)
            print("SCROLLEDGE inbox title dark=\(dark) band=\(got.band) rest=\(got.rest) scrolled=\(got.scrolled) back=\(got.back) none=\(plain.rest)/\(plain.back)")
            XCTAssertGreaterThan(plain.rest, 200, "dark=\(dark): the probe finds no title even without the page")
            XCTAssertGreaterThan(got.rest, plain.rest / 2, "dark=\(dark): the page hides \"Inbox\" at rest")
            // After a scroll back: whatever the screen without the page shows there.
            XCTAssertGreaterThanOrEqual(got.back, plain.back / 2, "dark=\(dark): the page hides the band after a scroll back")
        }
    }

    func testTheSettingsTitleShowsAtRestAndAfterAScrollBack() throws {
        for dark in [false, true] {
            for ax5 in [false, true] {
                let size: DynamicTypeSize = ax5 ? .accessibility5 : .large
                let got = try titleInk(SettingsHarness(page: true).dynamicTypeSize(size), dark: dark)
                let plain = try titleInk(SettingsHarness(page: false).dynamicTypeSize(size), dark: dark)
                print("SCROLLEDGE settings title dark=\(dark) ax5=\(ax5) band=\(got.band) rest=\(got.rest) scrolled=\(got.scrolled) back=\(got.back) none=\(plain.rest)/\(plain.back)")
                XCTAssertGreaterThan(plain.rest, 200, "dark=\(dark) ax5=\(ax5): no title found even without the page")
                XCTAssertGreaterThan(got.rest, plain.rest / 2, "dark=\(dark) ax5=\(ax5): the page hides \"Settings\" at rest")
                XCTAssertGreaterThanOrEqual(got.back, plain.back / 2, "dark=\(dark) ax5=\(ax5): the page hides the band after a scroll back")
            }
        }
    }

    func testTheStripShowsOnlyOnceTheBarHasCollapsed() {
        // Nothing measured yet: no strip.
        XCTAssertFalse(BarPageRule.covers(top: 0, inline: 0))
        XCTAssertFalse(BarPageRule.covers(top: 116, inline: 0))
        // The tall bar at rest, at the default size and at AX5: no strip.
        XCTAssertFalse(BarPageRule.covers(top: 168, inline: 116))
        XCTAssertFalse(BarPageRule.covers(top: 189, inline: 116))
        // A slow drag that stopped halfway through the collapse (r5b gate: the old
        // rule took the smallest inset seen, 150 here, against the tallest, 168,
        // and covered the shrinking title): no strip.
        XCTAssertFalse(BarPageRule.covers(top: 150, inline: 116))
        // Down to the inline bar: the strip.
        XCTAssertTrue(BarPageRule.covers(top: 116, inline: 116))
        // In the demo the label's band moves the bar down by 24: same rule.
        XCTAssertFalse(BarPageRule.covers(top: 150, inline: 140))
        XCTAssertTrue(BarPageRule.covers(top: 140, inline: 140))
        // A slow drag, half a point at a time from the tall bar to the inline one,
        // and back: the strip shows only within half a point of the inline height.
        let down = stride(from: 189.0, through: 116.0, by: -0.5).map { CGFloat($0) }
        let shown = (down + down.reversed()).filter { BarPageRule.covers(top: $0, inline: 116) }
        XCTAssertEqual(shown, [116.5, 116, 116, 116.5])
    }

    /// The inline bar this rule waits for, measured as the app measures it: the
    /// top of the safe area plus a bar with no large title (116 on this phone).
    func testTheInlineBarBottomIsTheSafeAreaPlusTheInlineBar() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let start = try XCTUnwrap(window.rootViewController?.view.safeAreaInsets.top)
        print("SCROLLEDGE inline bar start=\(start) bar=\(BarPageRule.inlineBarHeight)")
        XCTAssertEqual(BarPageRule.inlineBarHeight, 54, accuracy: 0.5, "the inline bar is no longer 54 pt on iOS 26")
        XCTAssertGreaterThan(start, 0)
    }

    /// The real screens carry the pair: the page behind the bar and a stated bar scheme.
    func testTheThreeScreensCarryThePageBehindTheBarAndTheBarScheme() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        for file in ["Views/Inbox/InboxView.swift", "Views/Settings/SettingsView.swift", "Views/Inbox/LetterReaderView.swift",
                     // Gate r4, F8: the Places and Apple Health pages too.
                     "Views/Settings/PlacesView.swift", "Views/Settings/AppleHealthView.swift"] {
            let source = try String(contentsOf: root.appendingPathComponent("Walnut/\(file)"), encoding: .utf8)
            XCTAssertTrue(source.contains(".barPage(Color(uiColor: ."), "\(file) lost the page behind its bar")
            XCTAssertTrue(source.contains(".toolbarColorScheme(colorScheme, for: .navigationBar)"), "\(file) lost its bar scheme")
            // A large-title screen's strip must wait for the bar to collapse, or it hides the title.
            let large = !source.contains(".navigationBarTitleDisplayMode(.inline)")
            XCTAssertEqual(source.contains("largeTitle: true)"), large, "\(file): largeTitle must match the title it shows")
        }
    }
}
