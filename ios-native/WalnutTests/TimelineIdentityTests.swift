import XCTest
import UIKit
@testable import Walnut

/// Row IDENTITY gates for the timeline engine.
///
/// The field bug these exist for: switching between two conversations that have
/// the same number of messages with equal per-row heights left the PREVIOUS
/// conversation's messages rendered under the NEW conversation's title, and only
/// a relaunch recovered. Three facts lined up:
///
///  1. `/api/v1/conversations/:id/messages` numbers messages POSITIONALLY
///     ("m0"…"mN"), so two conversations hand the builder identical ids;
///  2. row ids were "<messageID>#<index>" and history rows are built at
///     revision 0, while row height is a line-count product — so equal-length
///     text produced rows that were equal by every signal the diff compared;
///  3. `TimelineCollectionController.apply` returns on `diff.isEmpty` BEFORE
///     `rows = snapshot.rows`, so both the cells and the data source kept the
///     old content.
///
/// Two independent defences, one test group each: every row id carries its
/// conversation (`TimelineScope`), and every row carries a digest of what it
/// draws (`TimelineRow.contentKey`) so a same-id row with different text is
/// reloaded even inside one conversation (a server-side transcript re-cut can
/// re-point a positional id).
@MainActor
final class TimelineIdentityTests: XCTestCase {

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        MainWork.resetForTesting()
    }

    // MARK: - Fixtures

    /// Two messages under the server's POSITIONAL ids — the shape both
    /// conversations arrive in.
    private func positional(user: String, assistant: String) -> [ChatMessage] {
        [ChatMessage(id: "m0", role: "user", text: user,
                     createdAt: "2026-09-07T01:00:00Z", kind: nil),
         ChatMessage(id: "m1", role: "assistant", text: assistant,
                     createdAt: "2026-09-07T01:00:01Z", kind: nil)]
    }

    private func input(_ messages: [ChatMessage], scope: String,
                       width: CGFloat = 393) -> TimelineInput {
        TimelineInput(messages: messages, streaming: false, liveText: "",
                      liveTextTruncated: false, activity: nil, showLoadEarlier: false,
                      width: width, expandedRowIDs: [], scope: scope)
    }

    private func hostController() -> (UIWindow, TimelineCollectionController) {
        let controller = TimelineCollectionController()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = controller
        window.isHidden = false
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        return (window, controller)
    }

    private func applyFully(_ controller: TimelineCollectionController,
                            _ snapshot: TimelineSnapshot) {
        controller.apply(snapshot)
        for _ in 0..<100 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
            if controller.rows.count == snapshot.rows.count { break }
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        controller.collectionView.layoutIfNeeded()
    }

    /// The text a row actually draws (bubble or assistant prose).
    private func renderedText(_ row: TimelineRow) -> String? {
        switch row.content {
        case .text(let attributed): return attributed.string
        case .userBubble(let text, _, _, _): return text.string
        default: return nil
        }
    }

    private func renderedTexts(_ rows: [TimelineRow]) -> [String] {
        rows.compactMap(renderedText)
    }

    // MARK: - Layer B: a row whose CONTENT changed must reload

    /// The exact signature of the field bug, at diff level: same id, same
    /// revision, same height, DIFFERENT text. Without a content digest this diff
    /// is empty and the controller keeps drawing the old text for ever.
    ///
    /// RED PROOF: dropping `contentKey` from `TimelineDiff.changed` makes this
    /// fail on the first assertion (`diff.isEmpty == true`).
    func testSameIDSameRevisionSameHeightDifferentTextStillReloads() {
        let old = [TimelineRow(id: "conv-p|m0#0", revision: 0,
                               content: .text(NSAttributedString(string: "the first answer")),
                               height: 24)]
        let new = [TimelineRow(id: "conv-p|m0#0", revision: 0,
                               content: .text(NSAttributedString(string: "a second answer")),
                               height: 24)]
        // Premise: every signal the diff used to compare is identical.
        XCTAssertEqual(old[0].id, new[0].id)
        XCTAssertEqual(old[0].revision, new[0].revision)
        XCTAssertEqual(old[0].height, new[0].height)

        let diff = TimelineDiff.compute(old: old, new: new)
        XCTAssertFalse(diff.isEmpty, "a row whose text changed must not diff clean")
        XCTAssertEqual(diff.reloads.map(\.0), [0])
        XCTAssertTrue(diff.deletes.isEmpty)
        XCTAssertTrue(diff.inserts.isEmpty)

        // …and the controller must actually adopt the new rows (the `isEmpty`
        // fast path returns before `rows = snapshot.rows`).
        let (window, controller) = hostController()
        defer { window.isHidden = true; window.rootViewController = nil }
        applyFully(controller, TimelineSnapshot(rows: old, width: 393, generation: 1))
        XCTAssertEqual(renderedTexts(controller.rows), ["the first answer"])
        applyFully(controller, TimelineSnapshot(rows: new, width: 393, generation: 2))
        XCTAssertEqual(renderedTexts(controller.rows), ["a second answer"],
                       "controller kept the previous content for an unchanged id")
    }

    /// Equal content ⇒ equal key (so genuinely identical snapshots stay a
    /// no-op); different content or different KIND ⇒ different key.
    func testContentKeyIsStableForEqualContentAndSplitsOnChange() {
        let a = TimelineRowContent.text(NSAttributedString(string: "same words here"))
        let b = TimelineRowContent.text(NSAttributedString(string: "same words here"))
        XCTAssertEqual(a.contentKey, b.contentKey,
                       "equal content must hash equal, or every diff reloads everything")

        let other = TimelineRowContent.text(NSAttributedString(string: "other words here"))
        XCTAssertNotEqual(a.contentKey, other.contentKey)

        // Same string, different row kind — the reuse bucket rides in the key.
        let chip = TimelineRowContent.chip(icon: "sparkles", text: "same words here")
        XCTAssertNotEqual(a.contentKey, chip.contentKey)

        // Optimistic-bubble flags are content here: the bubble is drawn dimmed /
        // with a failure tint, and the text is unchanged when a send settles.
        let pending = TimelineRowContent.userBubble(
            text: NSAttributedString(string: "hello"), textSize: .zero,
            failed: false, pending: true)
        let settled = TimelineRowContent.userBubble(
            text: NSAttributedString(string: "hello"), textSize: .zero,
            failed: false, pending: false)
        XCTAssertNotEqual(pending.contentKey, settled.contentKey)
    }

    // MARK: - Layer A: row identity is conversation-scoped

    /// Two conversations, identical positional ids, equal-length text (so equal
    /// heights) — the diff must REPLACE every row, not reload none of them.
    func testSwitchingConversationsWithIdenticalPositionalIDsReplacesEveryRow() async {
        let engine = TimelineLayoutActor()
        let p = await engine.buildSnapshot(input(
            positional(user: "alpha question one", assistant: "alpha answer one"),
            scope: "conv-p"))
        let q = await engine.buildSnapshot(input(
            positional(user: "bravo question two", assistant: "bravo answer two"),
            scope: "conv-q"))

        // PREMISE (this is what made the bug invisible): strip the scope and the
        // two conversations' rows are identical by every other signal.
        XCTAssertFalse(p.rows.isEmpty)
        XCTAssertEqual(p.rows.count, q.rows.count)
        XCTAssertEqual(p.rows.map { TimelineScope.stripScope($0.id) },
                       q.rows.map { TimelineScope.stripScope($0.id) },
                       "fixture must reproduce the positional-id collision")
        XCTAssertEqual(p.rows.map(\.height), q.rows.map(\.height),
                       "fixture must reproduce equal row heights")
        XCTAssertEqual(p.rows.map(\.revision), q.rows.map(\.revision))
        for row in p.rows {
            XCTAssertTrue(row.id.hasPrefix("conv-p|"), "row escaped its conversation: \(row.id)")
        }

        let diff = TimelineDiff.compute(old: p.rows, new: q.rows)
        XCTAssertEqual(diff.deletes, Array(0..<p.rows.count),
                       "a conversation switch must delete every old row")
        XCTAssertEqual(diff.inserts.map(\.0), Array(0..<q.rows.count),
                       "a conversation switch must insert every new row")
        XCTAssertTrue(diff.reloads.isEmpty, "nothing to reload — the ids all changed")

        // The SNAPSHOT itself must carry the new conversation's words. The row
        // memo is keyed per message, and its key was the (positional) message id
        // alone — so it answered Q's "m0" with P's rows, and no amount of
        // reloading would have shown the right text.
        XCTAssertEqual(renderedTexts(q.rows), ["bravo question two", "bravo answer two"],
                       "the memo served the previous conversation's rows")

        // End to end through the controller: P on screen, then Q.
        let (window, controller) = hostController()
        defer { window.isHidden = true; window.rootViewController = nil }
        applyFully(controller, p)
        XCTAssertEqual(renderedTexts(controller.rows), ["alpha question one", "alpha answer one"])
        applyFully(controller, q)
        XCTAssertEqual(controller.rows.map(\.id), q.rows.map(\.id))
        XCTAssertEqual(renderedTexts(controller.rows), ["bravo question two", "bravo answer two"],
                       "the previous conversation survived the switch")
    }

    /// The other direction of the same guarantee: the no-op fast path (and the
    /// actor's coalescing) exist for performance and must survive. Same
    /// conversation, same messages, built twice ⇒ nothing to do.
    func testRebuildOfTheSameConversationIsStillANoOp() async {
        let engine = TimelineLayoutActor()
        let messages = positional(user: "alpha question one", assistant: "alpha answer one")
        let first = await engine.buildSnapshot(input(messages, scope: "conv-p"))
        let second = await engine.buildSnapshot(input(messages, scope: "conv-p"))
        XCTAssertEqual(first.rows.map(\.id), second.rows.map(\.id))
        XCTAssertTrue(TimelineDiff.compute(old: first.rows, new: second.rows).isEmpty,
                      "an unchanged conversation must diff to nothing")
    }

    /// A live turn belongs to ONE conversation too: an unscoped "live-tail#0"
    /// would diff clean against the previous conversation's live tail.
    func testLiveRowsCarryTheConversationScope() async {
        let engine = TimelineLayoutActor()
        var live = input([], scope: "conv-p")
        live.streaming = true
        live.liveText = "streaming this answer now"
        live.liveTextTruncated = true
        let snapshot = await engine.buildSnapshot(live)
        XCTAssertFalse(snapshot.rows.isEmpty)
        for row in snapshot.rows {
            XCTAssertTrue(row.id.hasPrefix("conv-p|"), "live row escaped its conversation: \(row.id)")
        }
        XCTAssertTrue(snapshot.rows.contains { TimelineScope.stripScope($0.id) == "live-truncated" })
        XCTAssertTrue(snapshot.rows.contains { TimelineScope.stripScope($0.id) == "live-activity" })
    }

    /// Scoping must not break the row-id → message-id mapping every row ACTION
    /// goes through (retry / discard / copy): a scoped id that still carried its
    /// prefix would never match a store message and the retry would no-op.
    func testMessageIDSurvivesScoping() {
        XCTAssertEqual(TimelineRow.messageID(fromRowID: "conv-8a613f0b|m3#2"), "m3")
        XCTAssertEqual(TimelineRow.messageID(fromRowID: "draft|local-abc#0"), "local-abc")
        // Unscoped ids (direct builder use) keep working unchanged.
        XCTAssertEqual(TimelineRow.messageID(fromRowID: "m3#2"), "m3")
        XCTAssertEqual(TimelineRow.messageID(fromRowID: "load-earlier"), "load-earlier")
    }

    /// A draft (New chat) has no conversation id — it must still get a STABLE
    /// token, or a draft's own rows would never diff against themselves.
    func testDraftScopeIsStable() {
        XCTAssertEqual(TimelineScope.sanitize(nil), TimelineScope.draft)
        XCTAssertEqual(TimelineScope.sanitize(""), TimelineScope.draft)
        XCTAssertEqual(TimelineScope.sanitize("conv-1"), "conv-1")
        // A scope may never contain the separator, or the message id could not
        // be recovered from a row id.
        XCTAssertFalse(TimelineScope.sanitize("we|ird").contains(TimelineScope.separator))
    }
}
