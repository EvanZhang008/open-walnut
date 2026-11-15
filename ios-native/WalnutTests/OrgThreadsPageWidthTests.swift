import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// THE THREADS PAGE SCROLLS UP AND DOWN, NEVER SIDEWAYS.
///
/// 2026-11-15, the user on the Org page's Threads: "为什么 ... 我可以左右滑 ... 它不就是上下的一个
/// 滑动吗". His screenshot had every card slid right under a drag, its words cut at the right edge;
/// the cards held long absolute paths of video files, a task chip and a quoted message. A vertical
/// ScrollView scrolls sideways as soon as its content's frame is wider than the screen, so this
/// lays the real page out in a phone-sized and a tablet-sized window with the content that showed it
/// (unbroken paths and URLs, a code line, a wide table, a long chip, a long follow-up) and checks
/// both the page (its scroll view's content is no wider than the scroll view) and each card (it fits
/// the width it is given, so its words wrap inside it rather than running past the edge).
@MainActor
final class OrgThreadsPageWidthTests: XCTestCase {
    private static let path = "/Users/someone/.local/state/open-walnut/tasks/51f06886-908d-5ed0-a367-2c2f05e6d7b7/clips/router-dialog-folders-webkit.mp4"
    private static let url = "https://example.com/a/very/long/address/without/any/spaces/" + String(repeating: "segment-", count: 12) + "end"

    private static var reply: String {
        """
        Shipped: the router settings now open in one dialog in the middle of the screen. 已上线：router 设置现在是一个屏幕中间的单独弹窗。在 Apps › Mail 和 Org 页打开的都是这一个，存的是同一份设置。

        - Open the dialog, the folders load, tick two, save, open again: \(path)
        - A failed read and Try again: \(path.replacingOccurrences(of: "folders", with: "error-retry"))
        - \(url)
        - \(String(repeating: "x", count: 160))

        ```
        walnut tools call task_send '{"in_reply_to":"rq-7a39ea3b2791","title":"\(String(repeating: "long ", count: 30))"}'
        ```

        | Video | Path | Note |
        |---|---|---|
        | folders | \(path) | \(String(repeating: "wide ", count: 20)) |
        """
    }

    private func threads() throws -> [OrgThread] {
        func at(_ m: Double) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(-m * 60)) }
        let thread: [String: Any] = [
            "id": "th-7e0000a1", "title": "Router settings: one dialog, folders load by themselves (shipped) " + Self.path,
            "state": "answered", "reply": Self.reply, "tasks": ["51f06886-908d-5ed0-a367-2c2f05e6d7b7"],
            "createdAt": at(90), "updatedAt": at(5),
            "messages": [[
                "id": "tm-0000000001", "at": at(30), "via": "follow-up",
                "text": "the folders should load by themselves bro " + Self.path + " " + String(repeating: "y", count: 120),
                "answer": ["text": "Handed back to <task-ref id=\"51f06886-908d-5ed0-a367-2c2f05e6d7b7\"/>. Two changes:\n\n- **Folders**: " + Self.path + "\n- " + Self.url, "at": at(29)],
            ]],
        ]
        let data = try JSONSerialization.data(withJSONObject: [thread, thread.merging(["id": "th-7e0000a2", "state": "needs"]) { $1 }])
        return try JSONDecoder().decode([OrgThread].self, from: data)
    }

    private func scrollViews(_ v: UIView) -> [UIScrollView] {
        ((v as? UIScrollView).map { [$0] } ?? []) + v.subviews.flatMap(scrollViews)
    }

    private func settle(_ host: UIViewController) {
        for _ in 0..<15 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            host.view.layoutIfNeeded()
        }
    }

    func testThreadsPageNeverScrollsSideways() throws {
        let threads = try threads()
        let tasks = TasksStore()
        for width in [390.0, 1024.0] {
            let store = OrgThreadsStore(taskId: "task-fixture-vp", threads: threads, cache: nil,
                                        read: { throw URLError(.notConnectedToInternet) })
            let page = OrgThreadsView(store: store, name: "Growth VP", sessionId: "sess-fixture-vp", cover: .constant(nil))
                .environment(tasks)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 844))
            let host = UIHostingController(rootView: page)
            window.rootViewController = host
            window.makeKeyAndVisible()
            settle(host)
            // The page's own list: the scroll view as wide as the window (a code block or a table
            // inside scrolls sideways on purpose, and is narrower).
            let pages = scrollViews(host.view).filter { abs($0.bounds.width - width) < 1 }
            XCTAssertFalse(pages.isEmpty, "no page-wide scroll view found at \(width) pt")
            for s in pages {
                XCTAssertLessThanOrEqual(s.contentSize.width, s.bounds.width + 0.5,
                                         "at \(width) pt the Threads page is \(s.contentSize.width) pt wide: it scrolls sideways")
            }
            window.isHidden = true
        }
    }

    /// Each card fits the width it is given, with its words wrapped inside it: the page staying
    /// put must not come from cutting off a card that is wider than the page.
    func testEachCardFitsThePhoneWidth() throws {
        let threads = try threads()
        let tasks = TasksStore()
        let inner: CGFloat = 390 - 32
        for t in threads {
            let card = OrgThreadCard(thread: t, all: threads, shared: [], name: "Growth VP", now: Date(), snoozed: false,
                                     busy: false, canFollowUp: true, onEdit: { _ in }, onOpenTask: { _ in }, onFollowUpOpen: {})
            let host = UIHostingController(rootView: card.environment(tasks))
            let size = host.sizeThatFits(in: CGSize(width: inner, height: 100_000))
            XCTAssertLessThanOrEqual(size.width, inner + 0.5, "card \(t.id) is \(size.width) pt wide in a \(inner) pt column")
        }
    }
}
