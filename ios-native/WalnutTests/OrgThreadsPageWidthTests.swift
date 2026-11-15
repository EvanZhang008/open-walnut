import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// THE THREADS PAGE'S CONTENT FITS THE SCREEN.
///
/// 2026-11-15, the user asked why the Org page's Threads moved left and right when it should
/// only scroll up and down; his screenshot had every card slid right, its words cut at the edge,
/// on cards with long absolute paths, a task chip and a quoted message. The cause was iOS 26's
/// content pop (`ReadingPageSwipe.swift`, `OrgThreadsSidewaysDragUITests`), not content wider than
/// the screen: on his real threads the page measured 390 pt in a 390 pt window before the fix too.
/// This keeps it that way. It lays the real page out in a phone-sized and a tablet-sized window
/// with long unbroken paths and URLs, a code line, a wide table, a long chip and a long follow-up,
/// and checks the page (its scroll view's content is no wider than the scroll view), each card,
/// the whole summary its Expand shows and the whole conversation (each fits the width it is given,
/// so its words wrap inside it, and a page that ever did scroll sideways has no wider content to show).
@MainActor
final class OrgThreadsPageWidthTests: XCTestCase {
    private static let path = "/Users/someone/.local/state/open-walnut/tasks/51f06886-908d-5ed0-a367-2c2f05e6d7b7/clips/router-dialog-folders-webkit.mp4"
    private static let url = "https://example.com/a/very/long/address/without/any/spaces/" + String(repeating: "segment-", count: 12) + "end"

    /// Paths, a URL, a code line and a table, plus CJK text with no spaces (escaped test data).
    private static var reply: String {
        """
        Shipped: the router settings now open in one dialog in the middle of the screen. \u{5DF2}\u{4E0A}\u{7EBF}\u{FF1A}router \u{8BBE}\u{7F6E}\u{73B0}\u{5728}\u{662F}\u{4E00}\u{4E2A}\u{5C4F}\u{5E55}\u{4E2D}\u{95F4}\u{7684}\u{5355}\u{72EC}\u{5F39}\u{7A97}\u{3002}\u{5728} Apps \u{203A} Mail \u{548C} Org \u{9875}\u{6253}\u{5F00}\u{7684}\u{90FD}\u{662F}\u{8FD9}\u{4E00}\u{4E2A}\u{FF0C}\u{5B58}\u{7684}\u{662F}\u{540C}\u{4E00}\u{4EFD}\u{8BBE}\u{7F6E}\u{3002}

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

    /// What a card shows once opened fits too: the summary whole (its Expand) and the whole
    /// conversation. His screenshot was of an opened summary; a folded card is a preview only.
    func testOpenedSummaryAndConversationFitThePhoneWidth() throws {
        let threads = try threads()
        let tasks = TasksStore()
        let inner: CGFloat = 390 - 32 - 28
        for t in threads {
            let whole = UIHostingController(rootView: LetterMarkdownBody(markdown: t.reply ?? "").markdownBodyFont(.subheadline).environment(tasks))
                .sizeThatFits(in: CGSize(width: inner, height: 100_000))
            XCTAssertLessThanOrEqual(whole.width, inner + 0.5, "thread \(t.id): its whole summary is \(whole.width) pt wide in a \(inner) pt column")
            let conversation = UIHostingController(rootView: OrgThreadConversation(thread: t, shared: [], name: "Growth VP", now: Date()).environment(tasks))
                .sizeThatFits(in: CGSize(width: inner, height: 100_000))
            XCTAssertLessThanOrEqual(conversation.width, inner + 0.5, "thread \(t.id): its conversation is \(conversation.width) pt wide in a \(inner) pt column")
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
