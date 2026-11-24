import UIKit
import XCTest
@testable import Walnut

/// `user_status.actions` on the phone (server core/action-needed.ts): decoded leniently, each kind
/// answered the way the phone answers it, and the snooze presets.
final class ActionNeededTests: XCTestCase {
    func testDecodesActionsAndWorking() throws {
        let json = #"""
        {"state":"needs","source":"approval","ask":"Push","working":true,"actions":[
          {"kind":"approval","id":"apr-1","summary":"Push commit","proof":true},
          {"kind":"question","id":"req-1","summary":"Which target?","sessionId":"s1","blocking":true,"question":"Which target?","options":[{"id":"0","label":"Staging"},{"id":"1","label":"Local"}]},
          {"kind":"letter","id":"lt-1","summary":"Pick","options":[{"id":"a","label":"A"}],"snoozedUntil":"2026-11-19T21:00:00.000Z"},
          {"kind":"someday","id":"x-1","summary":"A kind this build does not know","extra":{"nested":[1,2]}},
          {"kind":7,"id":["odd"]}
        ]}
        """#
        let s = try JSONDecoder().decode(WalnutUserStatus.self, from: Data(json.utf8))
        XCTAssertEqual(s.working, true)
        XCTAssertEqual(s.actions?.count, 5)
        // An older server's `proof` on an approval is read past: every approval is a tap now.
        XCTAssertEqual(s.actions?[0].kind, "approval")
        XCTAssertEqual(s.actions?[1].options?.map(\.label), ["Staging", "Local"])
        XCTAssertEqual(s.actions?[2].snoozedUntil, "2026-11-19T21:00:00.000Z")
        // An odd item reads as an unknown kind with no words, never a failed task list.
        XCTAssertEqual(s.actions?[4].kind, "")
        XCTAssertEqual(ActionNeededModel.answer(s.actions![4]), .openSession)
    }

    /// An ask shown whole, as the web shows it (2026-11-24: on the phone its question was cut to one
    /// line and its why and Yes/No keys were missing): its why and its shape are read, a yes/no ask has
    /// Yes and No, a one-pick ask its options, and its answer is the web's `Answer to "...": <label>`.
    func testAnAskReadsWholeWithItsKeys() throws {
        let json = #"""
        {"state":"needs","source":"session","ask":"Push the second revision?","actions":[
          {"kind":"ask","id":"ask-1","summary":"Push the second revision? I recommend it.","detail":"Review: https://example.com/r/1234 . Nobody approved the first.","sessionId":"s1","form":{"summary":"Push the second revision? I recommend it.","kind":"yes_no","more":"Review"}},
          {"kind":"ask","id":"ask-2","summary":"Which build?","sessionId":"s1","options":[{"id":"a","label":"Staging","recommended":true},{"id":"b","label":"Local"}],"form":{"kind":"single","summary":"Which build?"}},
          {"kind":"ask","id":"ask-3","summary":"Which ones?","sessionId":"s1","options":[{"id":"a","label":"A"}],"form":{"kind":"multi","summary":"Which ones?"}},
          {"kind":"ask","id":"ask-4","summary":"Anything else?","sessionId":"s1","form":7}
        ]}
        """#
        let a = try XCTUnwrap(JSONDecoder().decode(WalnutUserStatus.self, from: Data(json.utf8)).actions)
        XCTAssertEqual(a[0].detail, "Review: https://example.com/r/1234 . Nobody approved the first.")
        XCTAssertEqual(a[0].formKind, "yes_no")
        XCTAssertEqual(ActionNeededModel.answer(a[0]), .askOptions)
        XCTAssertEqual(ActionNeededModel.askOptions(a[0]).map(\.label), ["Yes", "No"])
        XCTAssertEqual(ActionNeededModel.askOptions(a[1]).map(\.label), ["Staging", "Local"])
        XCTAssertEqual(ActionNeededModel.askOptions(a[1]).first?.recommended, true)
        // Several picks or words only: its box and its session answer it.
        XCTAssertEqual(ActionNeededModel.answer(a[2]), .openSession)
        XCTAssertNil(a[3].formKind, "an odd form reads as none, never a failed list")
        XCTAssertEqual(ActionNeededModel.answer(a[3]), .openSession)
        XCTAssertEqual(ActionNeededModel.answerMessage(summary: a[0].summary, words: "Yes"),
                       #"Answer to "Push the second revision? I recommend it.": Yes"#)
        // It goes back out the way it came in.
        let again = try JSONDecoder().decode(WalnutActionItem.self, from: JSONEncoder().encode(a[0]))
        XCTAssertEqual(again, a[0])
    }

    /// The why folds by its length (never a measured height), a CJK character counting two.
    func testTheWhyFoldsByItsLength() {
        XCTAssertNil(OrgThreadModel.preview("Short why.", budget: ActionNeededModel.detailBudget))
        let long = String(repeating: "\u{8BC4}\u{5BA1}", count: 60) // 120 CJK characters, width 240
        let fold = try? XCTUnwrap(OrgThreadModel.preview(long, budget: ActionNeededModel.detailBudget))
        XCTAssertNotNil(fold)
        XCTAssertLessThanOrEqual(OrgThreadModel.width(fold ?? ""), ActionNeededModel.detailBudget + 2)
    }

    func testAnOlderServerSendsNoActions() throws {
        let s = try JSONDecoder().decode(WalnutUserStatus.self, from: Data(#"{"state":"working"}"#.utf8))
        XCTAssertNil(s.actions)
        XCTAssertNil(s.working)
    }

    func testEachKindHasItsAnswer() {
        XCTAssertEqual(ActionNeededModel.answer(.init(kind: "approval", id: "apr-1", summary: "x")), .approvalSheet)
        XCTAssertEqual(ActionNeededModel.answer(.init(kind: "letter", id: "lt-1", summary: "x", options: [.init(id: "a", label: "A")])), .letterOptions)
        XCTAssertEqual(ActionNeededModel.answer(.init(kind: "letter", id: "lt-2", summary: "x")), .openSession)
        let q = WalnutActionItem(kind: "question", id: "r", summary: "Q?", options: [.init(id: "0", label: "A")])
        XCTAssertEqual(ActionNeededModel.answer(q), .openSession, "no question words to key the answer: opened in its session")
        var keyed = q
        keyed.question = "Q?"
        XCTAssertEqual(ActionNeededModel.answer(keyed), .promptOptions)
        keyed.multi = true
        XCTAssertEqual(ActionNeededModel.answer(keyed), .openSession)
        // An ask with no one-click shape is answered in its box or its session.
        for kind in ["permission", "choice", "ask"] {
            XCTAssertEqual(ActionNeededModel.answer(.init(kind: kind, id: "i", summary: "x")), .openSession)
        }
        XCTAssertEqual(ActionNeededModel.label("approval"), "Approval")
    }

    func testSnoozePresetsStartAnHourAhead() {
        let now = Date(timeIntervalSince1970: 1_795_000_000)
        let p = ActionNeededModel.presets(now: now)
        XCTAssertEqual(p.map(\.id), ["one-hour", "three-hours", "tomorrow", "next-week"])
        XCTAssertEqual(p[0].until.timeIntervalSince(now), 3600, accuracy: 0.5)
        XCTAssertTrue(p.allSatisfy { $0.until > now })
    }

    /// One ask at a time (the web's tests/web/ask-pages.test.ts): an answered page keeps its place
    /// while an ask shown with it is open; a later ask starts afresh.
    func testAnsweredPagesKeepTheirPlace() {
        let a = WalnutActionItem(kind: "letter", id: "a", summary: "Publish?")
        let b = WalnutActionItem(kind: "letter", id: "b", summary: "Which plan?")
        let c = WalnutActionItem(kind: "ask", id: "c", summary: "Which code?")
        let marked = ["a": ActionNeededModel.Answered(item: a, said: "Publish", index: 0, peers: ["b", "c"])]
        XCTAssertEqual(ActionNeededModel.pages([b, c], answered: marked).map(\.id), ["a", "b", "c"])
        XCTAssertEqual(ActionNeededModel.pages([a, b, c], answered: marked).map(\.id), ["a", "b", "c"])
        let mid = ["b": ActionNeededModel.Answered(item: b, said: nil, index: 1, peers: ["a", "c"])]
        XCTAssertEqual(ActionNeededModel.pages([a, c], answered: mid).map(\.id), ["a", "b", "c"])
        let later = WalnutActionItem(kind: "ask", id: "d", summary: "New?")
        XCTAssertEqual(ActionNeededModel.pages([later], answered: marked).map(\.id), ["d"])
        // The same id asked again with new words: open again.
        let reworded = WalnutActionItem(kind: "letter", id: "a", summary: "Publish on Monday?")
        XCTAssertTrue(ActionNeededModel.liveMarks([reworded, b], answered: marked).isEmpty)
        XCTAssertEqual(ActionNeededModel.liveMarks([a, b], answered: marked).keys.sorted(), ["a"])
    }

    func testThePageShownFollowsItsAsk() {
        XCTAssertEqual(ActionNeededModel.pageIndex(["a", "b", "c"], at: nil), 0)
        XCTAssertEqual(ActionNeededModel.pageIndex(["c", "a", "b"], at: (id: "b", index: 1)), 2)
        XCTAssertEqual(ActionNeededModel.pageIndex(["a", "c"], at: (id: "b", index: 1)), 1)
        XCTAssertEqual(ActionNeededModel.pageIndex(["a"], at: (id: "c", index: 2)), 0)
        XCTAssertEqual(ActionNeededModel.placeText(1, of: 3), "Decision 2 of 3")
    }

    /// An option's line of why decodes (the server's AskOption.detail), and an option without one reads none.
    func testAnOptionCarriesItsDetail() throws {
        let json = #"[{"id":"a","label":"Ship","detail":"Tests pass","recommended":true},{"id":"b","label":"Wait"}]"#
        let options = try JSONDecoder().decode([WalnutAskOption].self, from: Data(json.utf8))
        XCTAssertEqual(options[0].detail, "Tests pass")
        XCTAssertEqual(options[0].recommended, true)
        XCTAssertNil(options[1].detail)
    }
}
