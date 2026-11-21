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

    /// The card's keys and option rows (2026-11-21, "2 is good"): a full touch target, the words
    /// box's height, 8pt corners, and white words on the blue main key at 4.5:1 or more.
    func testTheButtonFamilyIsReadableAndTappable() {
        XCTAssertGreaterThanOrEqual(AskCardKeys.height, 44)
        XCTAssertEqual(AskCardKeys.corner, 8)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let fill = Theme.askAccentColor.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            XCTAssertTrue(fill.getRed(&r, green: &g, blue: &b, alpha: &a))
            func channel(_ v: CGFloat) -> Double { let v = Double(v); return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
            let lum = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
            let ratio = 1.05 / (lum + 0.05)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "white on the blue key is \(ratio):1 in \(style == .dark ? "dark" : "light")")
        }
    }
}
