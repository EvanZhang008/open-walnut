import SwiftUI
import XCTest
@testable import Walnut

/// The tap path's page rules after a thread push (2026-11-06 gate):
///
///  1. A request for the node whose page is already up changes that page: its tab comes to
///     Threads and its thread is revealed, once per request time, so a repeated tap of the same
///     thread reveals it again (`OrgNodePageFocusModel`, `OrgThreadRevealModel`).
///  2. The reveal waits for a read that started after the request, opens the fold the thread
///     sits in, and says so when a fresh read no longer has it.
///  3. The card header stacks at accessibility sizes, and a short conversation has one toggle
///     (`OrgThreadCardLayout`).
///  4. A failed open says what happened in words that fit (`OrgOpenNotice`), and its notice
///     counts only the time it can be seen (`OrgOpenNoticeClock`).
final class OrgThreadFocusTests: XCTestCase {
    private static let now = WalnutTask.parseISO("2026-11-04T12:00:00Z")!
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func route(_ tab: OrgNodeTab = .threads, thread: String? = "th-aaaaaa", at: Date?) -> OrgNodeRoute {
        OrgNodeRoute(nodeId: "vp-growth", name: "Growth VP", isMain: false, sessionId: "s-1",
                     tab: tab, threadId: thread, requestedAt: at)
    }

    private func thread(_ id: String, state: String = "needs", extra: String = "", messages: String = "[]") throws -> OrgThread {
        let json = #"{"id":"\#(id)","title":"Title \#(id)","state":"\#(state)","messages":\#(messages),"createdAt":"2026-11-04T09:00:00Z","updatedAt":"2026-11-04T10:00:00Z"\#(extra)}"#
        return try JSONDecoder().decode(OrgThread.self, from: Data(json.utf8))
    }

    // MARK: - 1. A request for the page already shown

    func testThePageOpensOnTheRequestsTabAndThread() {
        let state = OrgNodePageFocusModel.initial(route(at: t0))
        XCTAssertEqual(state.tab, .threads)
        XCTAssertEqual(state.focus, OrgThreadFocus(threadId: "th-aaaaaa", at: t0))
        XCTAssertEqual(state.appliedAt, t0)
        // The bar's own buttons carry no thread and no time.
        let bar = OrgNodePageFocusModel.initial(route(.brief, thread: nil, at: nil))
        XCTAssertEqual(bar.tab, .brief)
        XCTAssertNil(bar.focus)
    }

    /// Scenario 4: he is on Tasks (or Brief) of a node's page; a push for another thread of the
    /// same node brings Threads forward at that thread.
    func testAPushForAnotherThreadOfTheSameNodeSwitchesTabAndThread() throws {
        var state = OrgNodePageFocusModel.initial(route(at: t0))
        state.tab = .tasks // he switched
        let next = try XCTUnwrap(OrgNodePageFocusModel.apply(route(thread: "th-bbbbbb", at: t0 + 30), to: state))
        XCTAssertEqual(next.tab, .threads)
        XCTAssertEqual(next.focus, OrgThreadFocus(threadId: "th-bbbbbb", at: t0 + 30))
        XCTAssertEqual(next.appliedAt, t0 + 30)
    }

    /// The same thread tapped again is a new request: the page owes it a reveal again.
    func testARepeatedTapOfTheSameThreadRevealsItAgain() throws {
        let state = OrgNodePageFocusModel.initial(route(at: t0))
        XCTAssertTrue(OrgThreadRevealModel.owes(state.focus, revealedAt: nil))
        XCTAssertFalse(OrgThreadRevealModel.owes(state.focus, revealedAt: t0), "revealed once")
        let again = try XCTUnwrap(OrgNodePageFocusModel.apply(route(at: t0 + 5), to: state))
        XCTAssertEqual(again.focus?.threadId, "th-aaaaaa")
        XCTAssertTrue(OrgThreadRevealModel.owes(again.focus, revealedAt: t0), "a second tap reveals it again")
    }

    /// The same request handed over again (a re-render), an older one, or a route without a time
    /// changes nothing: the tab he picked stays.
    func testNoNewRequestLeavesThePageAsHeLeftIt() {
        var state = OrgNodePageFocusModel.initial(route(at: t0))
        state.tab = .brief
        XCTAssertNil(OrgNodePageFocusModel.apply(route(at: t0), to: state))
        XCTAssertNil(OrgNodePageFocusModel.apply(route(at: t0 - 10), to: state))
        XCTAssertNil(OrgNodePageFocusModel.apply(route(.tasks, thread: nil, at: nil), to: state))
        XCTAssertFalse(OrgThreadRevealModel.owes(nil, revealedAt: nil), "no thread asked for, nothing owed")
    }

    // MARK: - 2. The reveal

    func testTheRevealWaitsForAReadThatStartedAfterTheRequest() throws {
        let focus = OrgThreadFocus(threadId: "th-aaaaaa", at: t0)
        let threads = [try thread("th-aaaaaa")]
        let sections = OrgThreadModel.sections(threads, now: Self.now)
        XCTAssertEqual(OrgThreadRevealModel.outcome(focus, threads: nil, sections: .init(), lastRead: nil), .wait)
        XCTAssertEqual(OrgThreadRevealModel.outcome(
            focus, threads: threads, sections: sections, lastRead: .init(startedAt: t0 - 1, failed: false)), .wait,
            "a read from before the push may not hold a thread that just moved to needs")
        XCTAssertEqual(OrgThreadRevealModel.outcome(
            focus, threads: threads, sections: sections, lastRead: .init(startedAt: t0, failed: false)), .show(nil))
    }

    func testTheRevealOpensTheFoldTheThreadSitsIn() throws {
        let threads = [
            try thread("th-000001"),
            try thread("th-000002", state: "working"),
            try thread("th-000003", state: "answered",
                       extra: #","snoozed":{"until":"2026-11-06T09:00:00Z","at":"2026-11-04T11:00:00Z"}"#),
            try thread("th-000004", extra: #","closed":{"how":"acked","at":"2026-11-04T11:00:00Z","by":"human"}"#),
        ]
        let sections = OrgThreadModel.sections(threads, now: Self.now)
        let read = OrgThreadRevealModel.Read(startedAt: t0, failed: false)
        func outcome(_ id: String) -> OrgThreadRevealModel.Outcome {
            OrgThreadRevealModel.outcome(.init(threadId: id, at: t0), threads: threads, sections: sections, lastRead: read)
        }
        XCTAssertEqual(outcome("th-000001"), .show(nil))
        XCTAssertEqual(outcome("th-000002"), .show(.inProgress))
        XCTAssertEqual(outcome("th-000003"), .show(.snoozed))
        XCTAssertEqual(outcome("th-000004"), .show(.closed))
        XCTAssertEqual(outcome("th-999999"), .probe, "a thread the list does not hold is read by its id first")
        XCTAssertEqual(OrgThreadRevealModel.outcome(
            .init(threadId: "th-999999", at: t0), threads: threads, sections: sections, lastRead: read,
            probe: .init(startedAt: t0, result: .notFound)), .missing, "the server has no such thread: it says so")
    }

    /// Absence from the list proves nothing: it holds only the newest closed threads, and its
    /// closed half may not have been read at all. Only the server's answer for the one thread,
    /// asked since the request, says it is gone (2026-11-08 review).
    func testOnlyAReadByIdSaysAThreadIsGone() throws {
        let threads = [try thread("th-000001")]
        let sections = OrgThreadModel.sections(threads, now: Self.now)
        let read = OrgThreadRevealModel.Read(startedAt: t0, failed: false)
        let focus = OrgThreadFocus(threadId: "th-0000c0", at: t0)
        func outcome(_ probe: OrgThreadRevealModel.Probe?) -> OrgThreadRevealModel.Outcome {
            OrgThreadRevealModel.outcome(focus, threads: threads, sections: sections, lastRead: read, probe: probe)
        }
        XCTAssertEqual(outcome(nil), .probe)
        XCTAssertEqual(outcome(.init(startedAt: t0 - 5, result: .notFound)), .probe,
                       "an answer from before the request is asked again")
        XCTAssertEqual(outcome(.init(startedAt: t0, result: .notFound)), .missing)
        XCTAssertEqual(outcome(.init(startedAt: t0, result: .failed)), .unchecked, "a failed check claims nothing")
        XCTAssertEqual(outcome(.init(startedAt: t0, result: .found)), .wait, "found: the list holds it on the next render")
        // Found, it joins the list: a closed one shows in the closed fold.
        let old = try thread("th-0000c0", extra: #","closed":{"how":"acked","at":"2026-10-20T11:00:00Z","by":"human"}"#)
        let merged = OrgThreadsStore.merged(threads, keeping: [old.id: old])
        XCTAssertEqual(merged.map(\.id), ["th-000001", "th-0000c0"])
        XCTAssertEqual(OrgThreadRevealModel.outcome(
            focus, threads: merged, sections: OrgThreadModel.sections(merged, now: Self.now), lastRead: read,
            probe: .init(startedAt: t0, result: .found)), .show(.closed))
        // The list's own copy wins over the one read by id.
        let listed = try thread("th-0000c0", state: "answered")
        XCTAssertEqual(OrgThreadsStore.merged([listed], keeping: [old.id: old]).map(\.state), ["answered"])
        // While it is being read, the page holds its cards, as for a list read.
        XCTAssertTrue(OrgThreadRevealModel.hidesCards(
            owes: true, outcome: .probe, lastReadFailed: false, scrolling: false, cardsShown: false, waitedTooLong: false))
        XCTAssertFalse(OrgThreadRevealModel.hidesCards(
            owes: true, outcome: .unchecked, lastReadFailed: false, scrolling: false, cardsShown: false, waitedTooLong: false))
    }

    /// A failed read proves nothing: a known thread still shows, an unknown one waits (the page's
    /// own error line says the read failed) rather than claiming it is gone.
    func testAFailedReadNeverClaimsTheThreadIsGone() throws {
        let threads = [try thread("th-aaaaaa")]
        let sections = OrgThreadModel.sections(threads, now: Self.now)
        let failed = OrgThreadRevealModel.Read(startedAt: t0 + 1, failed: true)
        XCTAssertEqual(OrgThreadRevealModel.outcome(.init(threadId: "th-aaaaaa", at: t0), threads: threads,
                                                    sections: sections, lastRead: failed), .show(nil))
        XCTAssertEqual(OrgThreadRevealModel.outcome(.init(threadId: "th-bbbbbb", at: t0), threads: threads,
                                                    sections: sections, lastRead: failed), .wait)
        XCTAssertEqual(OrgThreadRevealModel.missingText, "That thread is gone.")
    }

    /// The fold a thread is revealed in is the one the list draws it in, by the server's rule
    /// (`shown`, the one the header counts by) where the read carries it.
    func testTheRevealFollowsTheServersRuleForTheList() throws {
        let threads = [
            try thread("th-000001", state: "working", extra: #","shown":true"#),
            try thread("th-000002", state: "needs", extra: #","shown":false"#),
        ]
        let sections = OrgThreadModel.sections(threads, now: Self.now)
        let read = OrgThreadRevealModel.Read(startedAt: t0, failed: false)
        func outcome(_ id: String) -> OrgThreadRevealModel.Outcome {
            OrgThreadRevealModel.outcome(.init(threadId: id, at: t0), threads: threads, sections: sections, lastRead: read)
        }
        XCTAssertEqual(outcome("th-000001"), .show(nil), "the server shows it: a card")
        XCTAssertEqual(outcome("th-000002"), .show(.inProgress), "the server does not: the fold it is listed in")
    }

    /// A read that answered with none of the threads the counts say are his (a copy that holds
    /// no threads) proves no more than a failed one: the reveal waits, the page shows its retry at
    /// once, and nothing says the thread is gone.
    func testAReadThatBroughtNoneOfHisThreadsNeverClaimsTheThreadIsGone() throws {
        let empty: [OrgThread] = []
        let sections = OrgThreadModel.sections(empty, now: Self.now)
        let read = OrgThreadRevealModel.Read(startedAt: t0 + 1, failed: false)
        let none = OrgThreadRevealModel.broughtNone(threads: empty, sections: sections, serverCount: 4, nodeCount: nil)
        XCTAssertTrue(none)
        XCTAssertTrue(OrgThreadRevealModel.broughtNone(threads: empty, sections: sections, serverCount: nil, nodeCount: 2),
                      "an older server: the node's own count")
        XCTAssertFalse(OrgThreadRevealModel.broughtNone(threads: nil, sections: sections, serverCount: 4, nodeCount: nil),
                       "no read yet is the loading state, not this one")
        XCTAssertFalse(OrgThreadRevealModel.broughtNone(threads: empty, sections: sections, serverCount: 0, nodeCount: 3),
                       "the read's own count wins: none for him")
        XCTAssertEqual(OrgThreadRevealModel.outcome(.init(threadId: "th-aaaaaa", at: t0), threads: empty, sections: sections,
                                                    lastRead: read, broughtNone: none), .wait)
        XCTAssertEqual(OrgThreadRevealModel.outcome(.init(threadId: "th-aaaaaa", at: t0), threads: empty, sections: sections,
                                                    lastRead: read, broughtNone: false), .probe,
                       "a read that brought all of them: the thread is asked for by its id")
        // The view passes it as a failed read, so the retry shows at once instead of the hold.
        XCTAssertFalse(OrgThreadRevealModel.hidesCards(
            owes: true, outcome: .wait, lastReadFailed: none, scrolling: false, cardsShown: false, waitedTooLong: false))
    }

    // MARK: - 3. The card's layout

    func testTheHeaderStacksAtAccessibilitySizesOnly() {
        for size in [DynamicTypeSize.accessibility1, .accessibility2, .accessibility3, .accessibility4, .accessibility5] {
            XCTAssertTrue(OrgThreadCardLayout.headerStacks(size), "\(size)")
        }
        for size in [DynamicTypeSize.small, .large, .xLarge, .xxxLarge] {
            XCTAssertFalse(OrgThreadCardLayout.headerStacks(size), "\(size): one row while it fits")
        }
    }

    func testTheHeaderMetaLineReadsAsOneSentence() {
        XCTAssertEqual(OrgThreadCardLayout.metaLine(timeAgo: "18m ago", openedBy: "Growth VP"), "18m ago \u{00B7} Opened by Growth VP")
        XCTAssertEqual(OrgThreadCardLayout.metaLine(timeAgo: "18m ago", openedBy: nil), "18m ago")
        XCTAssertEqual(OrgThreadCardLayout.metaLine(timeAgo: "", openedBy: "CEO"), "Opened by CEO")
        XCTAssertEqual(OrgThreadCardLayout.metaLine(timeAgo: "", openedBy: nil), "")
    }

    /// One toggle for a short conversation; a second at its end only when it runs long.
    func testOnlyALongConversationClosesFromItsEnd() throws {
        func msg(_ i: Int, _ text: String = "Short") -> String {
            #"{"id":"m\#(i)","at":"2026-11-04T09:0\#(i):00Z","text":"\#(text)","via":"chat","answer":{"text":"Ok \#(i)","at":"2026-11-04T09:0\#(i):30Z"}}"#
        }
        XCTAssertFalse(OrgThreadCardLayout.closesFromEnd(try thread("th-000001", messages: "[\(msg(1))]")))
        XCTAssertFalse(OrgThreadCardLayout.closesFromEnd(try thread("th-000001", messages: "[\(msg(1)),\(msg(2))]")))
        XCTAssertTrue(OrgThreadCardLayout.closesFromEnd(try thread("th-000001", messages: "[\(msg(1)),\(msg(2)),\(msg(3))]")))
        let long = String(repeating: "word ", count: 200)
        XCTAssertTrue(OrgThreadCardLayout.closesFromEnd(try thread("th-000001", messages: "[\(msg(1, long))]")))
    }

    /// From XXXL up the action buttons stack, one a row; below it they share a row while their
    /// labels fit whole. Every label keeps to one line and shrinks a little before it would break
    /// inside a word ("Ac-kno-wle-dge" at XXXL, 2026-11-06 gate).
    func testActionLabelsNeverBreakInsideAWord() {
        for size in [DynamicTypeSize.xxxLarge, .accessibility1, .accessibility2, .accessibility3, .accessibility4, .accessibility5] {
            XCTAssertTrue(OrgThreadCardLayout.actionsStack(size), "\(size): one button a row")
        }
        for size in [DynamicTypeSize.xSmall, .small, .medium, .large, .xLarge, .xxLarge] {
            XCTAssertFalse(OrgThreadCardLayout.actionsStack(size), "\(size): a row while it fits")
        }
        XCTAssertEqual(OrgThreadCardLayout.actionLabelLines, 1, "a label on one line never breaks a word")
        XCTAssertGreaterThanOrEqual(OrgThreadCardLayout.actionLabelMinScale, 0.75, "it shrinks a little, it stays readable")
        XCTAssertLessThan(OrgThreadCardLayout.actionLabelMinScale, 1)
    }

    private let iosRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()

    /// The revealed card's tint is drawn behind its text and buttons: a tint laid over them made
    /// the card read as disabled for 2.5 s (2026-11-06 gate). Over the card goes the outline only.
    func testTheRevealTintSitsBehindTheCard() throws {
        let code = try String(contentsOf: iosRoot.appendingPathComponent("Walnut/Views/Org/OrgThreadsView.swift"), encoding: .utf8)
        let overlays = code.components(separatedBy: ".overlay {").dropFirst()
        for block in overlays {
            let body = block.components(separatedBy: "\n        }\n").first ?? block
            guard body.contains("if highlighted") else { continue }
            XCTAssertFalse(body.contains(".fill("), "the highlight's overlay fills the card over its content")
        }
        XCTAssertTrue(code.contains("OrgThreadRevealModel.highlightTint"), "the tint is drawn (behind the content)")
    }

    /// The error notice's close button takes a full 44 pt square.
    func testTheNoticeCloseButtonIsBigEnoughToTap() {
        XCTAssertGreaterThanOrEqual(OrgOpenNotice.closeSide, 44)
    }

    // MARK: - Holding the cards for an arrival

    func testAViewOpenedForAThreadHoldsItsCardsUntilItCanShowIt() {
        // Waiting for the fresh read, nothing shown yet: hidden, so it never shows other cards and then jumps.
        XCTAssertTrue(OrgThreadRevealModel.hidesCards(
            owes: true, outcome: .wait, lastReadFailed: false, scrolling: false, cardsShown: false, waitedTooLong: false))
        // The jump under way: still hidden until it is made.
        XCTAssertTrue(OrgThreadRevealModel.hidesCards(
            owes: false, outcome: .show(nil), lastReadFailed: false, scrolling: true, cardsShown: false, waitedTooLong: false))
        // Made: shown.
        XCTAssertFalse(OrgThreadRevealModel.hidesCards(
            owes: false, outcome: .show(nil), lastReadFailed: false, scrolling: false, cardsShown: false, waitedTooLong: false))
    }

    func testTheHoldNeverHidesWhatHeAlreadySawOrWaitsForever() {
        XCTAssertFalse(OrgThreadRevealModel.hidesCards(
            owes: true, outcome: .wait, lastReadFailed: false, scrolling: false, cardsShown: true, waitedTooLong: false),
            "cards in sight stay; the page scrolls to the thread in view")
        XCTAssertFalse(OrgThreadRevealModel.hidesCards(
            owes: true, outcome: .wait, lastReadFailed: true, scrolling: false, cardsShown: false, waitedTooLong: false),
            "a failed read shows the page and its error line")
        XCTAssertFalse(OrgThreadRevealModel.hidesCards(
            owes: true, outcome: .wait, lastReadFailed: false, scrolling: false, cardsShown: false, waitedTooLong: true),
            "never longer than holdSeconds")
        XCTAssertFalse(OrgThreadRevealModel.hidesCards(
            owes: false, outcome: nil, lastReadFailed: false, scrolling: false, cardsShown: false, waitedTooLong: false),
            "a page opened from the bar asks for no thread and shows at once")
        XCTAssertLessThanOrEqual(OrgThreadRevealModel.holdSeconds, 3)
    }

    /// The jump bar keeps the page's rule (it stays while the page lists any thread, the last card
    /// for him gone included) and fades only during the hold, in its place, then comes back.
    func testTheJumpBarFadesOnlyDuringTheHoldThenFollowsThePageRule() throws {
        let closed = try thread("th-000031", state: "answered", extra: #","closed":{"how":"acked","at":"2026-11-04T10:00:00Z","by":"human"}"#)
        let working = try thread("th-000032", state: "working")
        let noCards = OrgThreadModel.sections([closed, working], now: Self.now)
        XCTAssertTrue(noCards.open.isEmpty)
        // No card for him, but threads below: held during the hold (space kept), shown after it.
        XCTAssertEqual(OrgThreadRevealModel.jumpBar(threadsRead: true, sections: noCards, broughtNone: false, hides: true), .held)
        XCTAssertEqual(OrgThreadRevealModel.jumpBar(threadsRead: true, sections: noCards, broughtNone: false, hides: false), .shown)
        let cards = OrgThreadModel.sections([try thread("th-000033", state: "needs")], now: Self.now)
        XCTAssertEqual(OrgThreadRevealModel.jumpBar(threadsRead: true, sections: cards, broughtNone: false, hides: true), .held)
        XCTAssertEqual(OrgThreadRevealModel.jumpBar(threadsRead: true, sections: cards, broughtNone: false, hides: false), .shown)
        // Not read yet, nothing listed, or a read that brought none of his threads: no bar at all.
        XCTAssertEqual(OrgThreadRevealModel.jumpBar(threadsRead: false, sections: cards, broughtNone: false, hides: true), .none)
        XCTAssertEqual(OrgThreadRevealModel.jumpBar(threadsRead: true, sections: OrgThreadModel.Sections(), broughtNone: false, hides: false), .none)
        XCTAssertEqual(OrgThreadRevealModel.jumpBar(threadsRead: true, sections: noCards, broughtNone: true, hides: false), .none)
        // The page draws its bar from this rule.
        let code = try String(contentsOf: iosRoot.appendingPathComponent("Walnut/Views/Org/OrgThreadsView.swift"), encoding: .utf8)
        XCTAssertTrue(code.contains("OrgThreadRevealModel.jumpBar("), "the view reads the bar from the rule")
        XCTAssertFalse(code.contains("!sections.open.isEmpty {"), "the bar no longer goes with the last card")
    }

    /// A reveal's jump counts as landed only with the card in the upper part of the viewport, or
    /// still where it was when the list cannot bring it higher; a list laid out again under the
    /// jump (its top back, the card thousands of points down) is jumped again.
    func testARevealJumpsAgainUntilTheCardIsInView() throws {
        typealias M = OrgThreadRevealModel
        let at = { (top: CGFloat) in M.CardTop(id: "th-1", top: top) }
        XCTAssertTrue(M.landed(at(24), threadId: "th-1", viewport: 710), "at the top, under the jump bar")
        XCTAssertFalse(M.landed(at(3835), threadId: "th-1", viewport: 710), "the list laid out again at its top")
        XCTAssertFalse(M.landed(at(24), threadId: "th-2", viewport: 710), "another card's place says nothing")
        XCTAssertFalse(M.landed(nil, threadId: "th-1", viewport: 710), "no report yet")
        XCTAssertFalse(M.landed(at(24), threadId: "th-1", viewport: 0), "no viewport yet")
        XCTAssertFalse(M.landed(at(-400), threadId: "th-1", viewport: 710), "scrolled past it")
        // Low in a short list: landed once a jump left it where it was, never under the tab bar.
        XCTAssertFalse(M.landed(at(520), threadId: "th-1", viewport: 710))
        XCTAssertTrue(M.landed(at(520), threadId: "th-1", viewport: 710, previous: at(520)))
        XCTAssertFalse(M.landed(at(650), threadId: "th-1", viewport: 710, previous: at(650)))
        XCTAssertFalse(M.landed(at(3835), threadId: "th-1", viewport: 710, previous: at(3835)))

        let code = try String(contentsOf: iosRoot.appendingPathComponent("Walnut/Views/Org/OrgThreadsView.swift"), encoding: .utf8)
        XCTAssertTrue(code.contains("land(focus, instant: instant, proxy: proxy)"), "every reveal checks its jump")
        XCTAssertTrue(code.contains("OrgThreadRevealModel.landed("), "with this rule")
        XCTAssertTrue(code.contains("endLanding()"), "and his own scroll or jump ends the check")
    }

    // MARK: - 4. A failed open

    func testAFailedOpenSaysWhatHappened() {
        let gone = APIError.server(status: 404, code: "not_found", message: "No task found matching ID prefix \"zz\"", serverHash: nil, serverContent: nil)
        XCTAssertEqual(OrgOpenNotice.failure("the chat", gone), "That chat is no longer available.",
                       "a task that is gone is not a network problem")
        XCTAssertEqual(ChatView.orgFailure("the chat", gone), "That chat is no longer available.")
        let companion = APIError.server(status: 501, code: "not_here", message: "x", serverHash: nil, serverContent: nil)
        XCTAssertEqual(OrgOpenNotice.failure("Design", companion), "Design can be started only while your Mac is online.")
        let offline = APIError.network(underlying: URLError(.notConnectedToInternet))
        XCTAssertTrue(OrgOpenNotice.failure("Design", offline).hasPrefix("Couldn't reach Design: "))
    }

    /// The notice stays until it was in view for `visibleFor`: time under a sheet (an approval)
    /// or in the background does not count.
    func testTheNoticeCountsOnlyTimeInView() {
        var clock = OrgOpenNoticeClock()
        for _ in 0..<60 { XCTAssertFalse(clock.tick(0.5, visible: false), "under a sheet it waits") }
        for _ in 0..<15 { XCTAssertFalse(clock.tick(0.5, visible: true)) }
        XCTAssertTrue(clock.tick(0.5, visible: true), "8 s in view, then it goes")
        XCTAssertEqual(OrgOpenNoticeClock.visibleFor, 8)
    }
}
