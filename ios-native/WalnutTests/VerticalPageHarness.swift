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

    static func host<V: View>(_ view: V, width: CGFloat, settle seconds: TimeInterval = 1.5) -> Hosted {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: height))
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

    /// Each page scroller's content is no wider than the scroller.
    static func assertPageFits(_ page: String, _ hosted: Hosted, file: StaticString = #filePath, line: UInt = #line) {
        let width = hosted.window.bounds.width
        let pages = pageScrollers(hosted)
        XCTAssertFalse(pages.isEmpty, "\(page) at \(width) pt: no page-wide scroll view found among \(describeScrollViews(hosted))",
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
