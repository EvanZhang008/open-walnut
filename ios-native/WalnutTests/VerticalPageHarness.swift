import XCTest
import SwiftUI
import UIKit
import WebKit
@testable import Walnut

/// How `VerticalPagesWidthTests` lays a real page out and judges its width.
///
/// A page is hosted in a phone-sized window through `UIHostingController`, given the stores the
/// app's root gives every tab, and settled (the run loop turned and the layout forced for about
/// 1.5 s, so reads that fail fast and the cards that land after them are in). Then:
///  - every page scroller (a `UIScrollView` as wide as the window and at least 200 pt tall) must
///    hold content no wider than itself: wider content is what a sideways drag scrolls to.
///    Narrower or short scroll views (a code block, a table, a chip row) scroll sideways on purpose;
///  - a SwiftUI view measured with `sizeThatFits` at a width must come back no wider than it;
///  - a timeline (`UICollectionView` chat) always reports its bounds as its content width, so its
///    visible cells' views are checked instead: none may reach past the collection view's sides.
@MainActor
enum VerticalPageHarness {
    static let widths: [CGFloat] = [375, 402, 440]
    static let height: CGFloat = 874

    /// The stores the app's root hands every tab (`WalnutApp`), so a page finds what it reads.
    @MainActor struct Stores {
        var tasks = TasksStore(transport: MockTaskTransport())
        var inbox = InboxStore(transport: MockInboxTransport([]))
        var notes = NotesStore()
        var connection = ConnectionStore()
        var chat = ChatStore()
    }

    static func provided<V: View>(_ view: V, _ s: Stores) -> some View {
        view
            .environment(s.tasks)
            .environment(s.inbox)
            .environment(s.notes)
            .environment(s.connection)
            .environment(s.chat)
    }

    /// One page on screen at `width`; `close` takes it down again.
    @MainActor final class Hosted {
        let window: UIWindow
        let host: UIViewController
        init(window: UIWindow, host: UIViewController) { self.window = window; self.host = host }
        func close() {
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    /// The window joins the test app's own scene, as a page's window does on a phone. A window with
    /// no scene never becomes key, and on CI's iOS 26.6 runtime SwiftUI drew no state change into it:
    /// the note page read its saved copy within 0.2 s yet showed its spinner 10 s later ("key false,
    /// scene false" in run 45758431154), while the fleet's 26.2 drew it. Since bd9d2d8d44 hosted the
    /// pages in a bare `UIWindow(frame:)`.
    static func host<V: View>(_ view: V, width: CGFloat, settle seconds: TimeInterval = 1.5,
                              file: StaticString = #filePath, line: UInt = #line) -> Hosted {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        XCTAssertNotNil(scene, "the test app has no window scene to put the page in", file: file, line: line)
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
        window.frame = CGRect(x: 0, y: 0, width: width, height: height)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        settle(host, seconds: seconds)
        return Hosted(window: window, host: host)
    }

    static func settle(_ host: UIViewController, seconds: TimeInterval = 1.5) {
        let steps = max(1, Int(seconds / 0.1))
        for _ in 0..<steps {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            host.view.layoutIfNeeded()
        }
    }

    static func scrollViews(_ v: UIView) -> [UIScrollView] {
        ((v as? UIScrollView).map { [$0] } ?? []) + v.subviews.flatMap(scrollViews)
    }

    /// The page's own scrollers: as wide as the window and tall.
    static func pageScrollers(_ hosted: Hosted) -> [UIScrollView] {
        let width = hosted.window.bounds.width
        return scrollViews(hosted.window).filter { !$0.isHidden && abs($0.bounds.width - width) <= 1 && $0.bounds.height >= 200 }
    }

    /// Every scroll view in the window, for a failure that finds no page scroller: what it is, where
    /// it sits in the window, its content and whether it is hidden (a CI-only miss is read from this).
    static func describeScrollViews(_ hosted: Hosted) -> String {
        let all = scrollViews(hosted.window)
        guard !all.isEmpty else { return "no scroll view at all" }
        return all.map { s in
            let f = s.convert(s.bounds, to: hosted.window)
            return "\(type(of: s)) at x \(Int(f.minX)) y \(Int(f.minY)) \(Int(f.width))x\(Int(f.height)), content \(Int(s.contentSize.width))x\(Int(s.contentSize.height))\(s.isHidden ? ", hidden" : "")"
        }.joined(separator: "; ")
    }

    /// What the window holds when it has no scroll view: whether the page is in it at all, a
    /// spinner or an empty state in its place, and the accessibility ids it shows.
    static func describeTree(_ hosted: Hosted) -> String {
        var classes: [String: Int] = [:]
        var ids: [String] = []
        func walk(_ v: UIView) {
            classes[String(describing: type(of: v)), default: 0] += 1
            if let id = v.accessibilityIdentifier, !id.isEmpty { ids.append(id) }
            v.subviews.forEach(walk)
        }
        walk(hosted.window)
        let notable = classes.filter { $0.key.contains("Activity") || $0.key.contains("Text") || $0.key.contains("Hosting") }
        return "page in window \(hosted.host.view.window === hosted.window), key \(hosted.window.isKeyWindow), "
            + "scene \(hosted.window.windowScene != nil), \(classes.values.reduce(0, +)) views, "
            + "notable \(notable.sorted { $0.key < $1.key }.map { "\($0.key) x\($0.value)" }), ids \(ids.prefix(12))"
    }

    /// Each page scroller's content is no wider than the scroller.
    ///
    /// A page draws its scroller once its first read lands (a note: after its server read fails
    /// and its saved copy is read). On a loaded runner that can trail the fixed settle, so the run
    /// loop keeps turning, up to `drawnWithin`, until a page scroller is there.
    static func assertPageFits(_ page: String, _ hosted: Hosted, drawnWithin limit: TimeInterval = 8,
                               file: StaticString = #filePath, line: UInt = #line) {
        let width = hosted.window.bounds.width
        let started = Date()
        var pages = pageScrollers(hosted)
        while pages.isEmpty, Date().timeIntervalSince(started) < limit {
            settle(hosted.host, seconds: 0.1)
            pages = pageScrollers(hosted)
        }
        if !pages.isEmpty, Date().timeIntervalSince(started) > 0.05 {
            print("[evidence] \(page) at \(width) pt drew its page scroller \(String(format: "%.1f", Date().timeIntervalSince(started))) s after the settle")
        }
        XCTAssertFalse(pages.isEmpty, "\(page) at \(width) pt: no page-wide scroll view found among \(describeScrollViews(hosted)) "
                       + "within \(Int(limit)) s after the settle; \(describeTree(hosted))",
                       file: file, line: line)
        for s in pages {
            XCTAssertLessThanOrEqual(
                s.contentSize.width, s.bounds.width + 0.5,
                "\(page) at \(width) pt: its \(type(of: s)) holds content \(s.contentSize.width) pt wide in \(s.bounds.width) pt: it scrolls sideways",
                file: file, line: line)
        }
    }

    /// A SwiftUI view measured at `width` comes back no wider than it.
    static func assertFits<V: View>(_ what: String, _ view: V, width: CGFloat, file: StaticString = #filePath, line: UInt = #line) {
        let size = UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: 100_000))
        XCTAssertLessThanOrEqual(size.width, width + 0.5, "\(what): \(size.width) pt wide in a \(width) pt column",
                                 file: file, line: line)
    }

    // MARK: - Timeline

    struct Overflow {
        var over: CGFloat = 0
        var describe = ""
    }

    /// The farthest any visible cell's view reaches past the collection view's left or right side,
    /// in its own coordinates. A horizontal scroll view (a code block, a table) and a web view are
    /// checked as a whole, never their insides, which scroll sideways on purpose.
    static func widestOverflow(in cv: UICollectionView) -> Overflow {
        var worst = Overflow()
        let edges = cv.bounds
        func walk(_ view: UIView, row: String) {
            for sub in view.subviews {
                guard !sub.isHidden, sub.alpha > 0.01, sub.bounds.width > 0.5, sub.bounds.height > 0.5 else { continue }
                let frame = cv.convert(sub.bounds, from: sub)
                let over = max(frame.maxX - edges.maxX, edges.minX - frame.minX)
                if over > worst.over {
                    worst = Overflow(over: over, describe: "\(type(of: sub)) in row \(row) spans x \(Int(frame.minX))..\(Int(frame.maxX)) of \(Int(edges.minX))..\(Int(edges.maxX))")
                }
                if sub is UIScrollView || sub is WKWebView { continue }
                walk(sub, row: row)
            }
        }
        for cell in cv.visibleCells {
            let row = cv.indexPath(for: cell).map { "\($0.item)" } ?? "?"
            walk(cell, row: row)
        }
        return worst
    }

    /// Walks the whole timeline a screen at a time and returns its widest overflow.
    static func widestOverflowScrolling(_ cv: UICollectionView) -> Overflow {
        var worst = Overflow()
        var offset = -cv.adjustedContentInset.top
        var screens = 0
        while offset < cv.contentSize.height, screens < 200 {
            cv.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            cv.layoutIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            let o = widestOverflow(in: cv)
            if o.over > worst.over { worst = o }
            offset += max(100, cv.bounds.height * 0.8)
            screens += 1
        }
        return worst
    }
}
