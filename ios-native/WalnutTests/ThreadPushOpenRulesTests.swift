import XCTest
@testable import Walnut

/// The open rules of a thread push that are not the page's (2026-11-08 review, round 1):
///
///  1. The node's chat the phone already holds opens at once, and the read behind it moves to a
///     newer chat only when the node has one and he is still where the open put him
///     (`OrgOpenPlan`).
///  2. A session read by id with no task says whose it is once the open read the task
///     (`WalnutSession.claimed`).
///  3. A tap the scene announced holds the launch restore back for a while, not for ever
///     (`ThreadDeepLink.expectsTap`).
///  4. An offline open says so in its own words, and says what the page shows: the phone's copy
///     of the threads, or only the notification.
///  5. One draft per thread for an unsent Follow up (`OrgThreadFollowUpDraft`), which a late
///     receipt never clears once he wrote more.
///  6. What a navigation does with what is presented over the app (`PresentationLowering.plan`),
///     and what a sheet holding it says.
@MainActor
final class ThreadPushOpenRulesTests: XCTestCase {

    private func session(_ id: String, task: String?, active: String = "2026-11-08T10:00:00Z") -> WalnutSession {
        WalnutSession(
            id: id, title: "Chat \(id)", taskId: task, taskTitle: nil, project: nil, host: "",
            processStatus: "idle", model: nil, mode: nil, startedAt: "2026-11-01T10:00:00Z",
            lastActiveAt: active, messageCount: 2, cwd: nil, pinned: nil, focusTier: nil, description: nil
        )
    }

    // MARK: - 1. What opens at once

    func testTheNodesChatOnScreenOpensAtOnce() {
        let shown = session("s-vp", task: "vp")
        XCTAssertEqual(OrgOpenPlan.localSession(taskId: "vp", shown: shown, knownIds: nil, sessions: [])?.id, "s-vp")
        XCTAssertNil(OrgOpenPlan.localSession(taskId: "vp", shown: session("s-ask", task: "ask"), knownIds: nil, sessions: []),
                     "another task's chat on screen is no chat of the node's")
        XCTAssertNil(OrgOpenPlan.localSession(taskId: "", shown: shown, knownIds: nil, sessions: [shown]))
    }

    func testOtherwiseTheNewestChatThePhoneHoldsForTheNode() {
        let rows = [
            session("s-old", task: "vp", active: "2026-11-01T10:00:00Z"),
            session("s-new", task: "vp", active: "2026-11-08T09:00:00Z"),
            session("s-other", task: "other", active: "2026-11-08T11:00:00Z"),
        ]
        XCTAssertEqual(OrgOpenPlan.localSession(taskId: "vp", shown: nil, knownIds: nil, sessions: rows)?.id, "s-new",
                       "by the rows: the most recently active")
        XCTAssertEqual(OrgOpenPlan.localSession(taskId: "vp", shown: nil, knownIds: ["s-new", "s-old"], sessions: rows)?.id,
                       "s-old", "the node's own list wins, newest last")
        XCTAssertEqual(OrgOpenPlan.localSession(taskId: "vp", shown: nil, knownIds: ["s-gone", "s-new"], sessions: rows)?.id,
                       "s-new")
        XCTAssertNil(OrgOpenPlan.localSession(taskId: "vp2", shown: nil, knownIds: nil, sessions: rows),
                     "nothing held: the open waits on the read")
    }

    func testTheReadBehindMovesOnlyToANewerChatWhileHeIsStillThere() {
        XCTAssertFalse(OrgOpenPlan.follows(current: "s-1", local: "s-1", shown: "s-1"), "the chat on screen is current")
        XCTAssertTrue(OrgOpenPlan.follows(current: "s-2", local: "s-1", shown: "s-1"), "the node moved to a newer chat")
        XCTAssertFalse(OrgOpenPlan.follows(current: "s-2", local: "s-1", shown: "s-ask"),
                       "he picked another chat meanwhile: it stays")
        XCTAssertFalse(OrgOpenPlan.follows(current: nil, local: "s-1", shown: "s-1"))
        XCTAssertTrue(OrgOpenPlan.follows(current: "s-2", local: nil, shown: nil), "nothing opened yet: open it")
    }

    // MARK: - 2. Whose session

    func testASessionWithNoTaskIsClaimedByTheTaskTheOpenRead() {
        let bare = session("s-vp", task: nil)
        let claimed = bare.claimed(byTask: "vp", title: "Growth lead")
        XCTAssertEqual(claimed.taskId, "vp")
        XCTAssertEqual(claimed.taskTitle, "Growth lead")
        XCTAssertEqual(claimed.id, "s-vp")
        let owned = session("s-vp", task: "vp-real")
        XCTAssertEqual(owned.claimed(byTask: "vp", title: nil), owned, "a row that says its task keeps it")
        XCTAssertEqual(bare.claimed(byTask: "", title: nil), bare)
    }

    // MARK: - 3. A tap the scene announced

    func testAnAnnouncedTapHoldsTheRestoreForAWhileOnly() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertFalse(ThreadDeepLink.expectsTap(since: nil, now: t0))
        XCTAssertTrue(ThreadDeepLink.expectsTap(since: t0, now: t0 + 1))
        XCTAssertTrue(ThreadDeepLink.expectsTap(since: t0, now: t0 + ThreadDeepLink.launchTapWait - 0.1))
        XCTAssertFalse(ThreadDeepLink.expectsTap(since: t0, now: t0 + ThreadDeepLink.launchTapWait),
                       "a tap that never came lets the last place come back")
    }

    func testTheMailboxSaysATapIsComingUntilItArrives() {
        let link = ThreadDeepLink.shared
        link.clear()
        defer { link.clear() }
        let target = ThreadDeepLink.Target(taskId: "vp", threadId: "th-abcdef", title: nil, ask: nil)
        XCTAssertFalse(link.waitsToOpen())
        link.expectLaunchTap(target)
        XCTAssertTrue(link.waitsToOpen(), "announced by the scene, not here yet")
        link.arm(target, source: ThreadDeepLink.tapSource)
        XCTAssertNil(link.launchTapExpectedAt, "the tap that came ends the wait for it")
        XCTAssertTrue(link.waitsToOpen())
        _ = link.consume()
        XCTAssertFalse(link.waitsToOpen())
    }

    // MARK: - 4. The notice

    func testTheNoticeSaysWhatThePageShows() {
        XCTAssertTrue(OrgOpenNotice.offline("Growth VP", cached: true).contains("as the phone last saw it"))
        let bare = OrgOpenNotice.unreachable("Growth VP", cached: false)
        XCTAssertTrue(bare.hasPrefix("Couldn't reach Walnut."))
        XCTAssertTrue(bare.contains("what the notification said"), "no copy: the notification's words are what shows")
        XCTAssertFalse(bare.contains("last saw"), "never claims a copy it does not have")
    }

    func testAnOfflineOpenSaysItIsOffline() {
        let text = OrgOpenNotice.offline("Growth VP")
        XCTAssertTrue(text.hasPrefix("You're offline."))
        XCTAssertTrue(text.contains("Growth VP"))
        XCTAssertEqual(OrgOpenNotice(text: text, kind: .offline).kind, .offline)
        XCTAssertEqual(OrgOpenNotice(text: "x").kind, .failure, "a notice is a failure unless it says otherwise")
    }

    // MARK: - 5. The Follow up draft

    func testOneFollowUpDraftPerThreadKeptUntilSent() {
        let a = OrgThreadFollowUpDraft.key(nodeId: "vp", threadId: "th-000001")
        let b = OrgThreadFollowUpDraft.key(nodeId: "vp", threadId: "th-000002")
        let c = OrgThreadFollowUpDraft.key(nodeId: "vp2", threadId: "th-000001")
        XCTAssertEqual(Set([a, b, c]).count, 3, "one draft per node and thread")
        XCTAssertTrue(a.hasPrefix(OrgThreadFollowUpDraft.prefix))
        let drafts = ComposerDrafts.shared
        defer { drafts.clear(a) }
        XCTAssertFalse(OrgThreadFollowUpDraft.exists(a))
        drafts.setDraft("   ", key: a)
        XCTAssertFalse(OrgThreadFollowUpDraft.exists(a), "blank words are no draft")
        drafts.setDraft("Checking in", key: a)
        XCTAssertTrue(OrgThreadFollowUpDraft.exists(a))
        XCTAssertFalse(OrgThreadFollowUpDraft.exists(b))
        drafts.clear(a)
        XCTAssertFalse(OrgThreadFollowUpDraft.exists(a), "sent: gone")
    }

    func testALateReceiptKeepsNewerWords() {
        let pic = UUID()
        XCTAssertTrue(OrgThreadFollowUpDraft.sentIsStillTheDraft(sent: "Yes", sentPictures: [pic], draft: "Yes", draftPictures: [pic]))
        XCTAssertFalse(OrgThreadFollowUpDraft.sentIsStillTheDraft(sent: "Yes", sentPictures: [], draft: "Yes, and also", draftPictures: []),
                       "he wrote more while it was on its way")
        XCTAssertFalse(OrgThreadFollowUpDraft.sentIsStillTheDraft(sent: "Yes", sentPictures: [], draft: "Yes", draftPictures: [pic]),
                       "a picture added since")
    }

    // MARK: - 6. What is over the app

    func testANavigationClosesWhatIsOverTheAppButNeverUnsavedWork() {
        XCTAssertEqual(PresentationLowering.plan(over: []), .show)
        XCTAssertEqual(PresentationLowering.plan(over: [false]), .closeFirst)
        XCTAssertEqual(PresentationLowering.plan(over: [false, false]), .closeFirst, "a sheet over a sheet")
        XCTAssertEqual(PresentationLowering.plan(over: [false, true]), .keep, "unsaved work anywhere in the chain")
        XCTAssertEqual(PresentationLowering.plan(over: [], closing: true), .wait)
        XCTAssertEqual(WorkCardLinkBox.plan(over: [false]), PresentationLowering.plan(over: [false]),
                       "the work card link and a push read one rule")
    }

    /// What the gate closed has left the screen before the request goes out: a page pushed while
    /// a sheet slid away was laid out again once it had gone, its list back at the top. And a chat
    /// replacing another chat with its page up waits for that page to leave the stack first.
    func testARequestGoesOutOnceWhatItClosedHasLeft() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let link = try String(contentsOf: root.appendingPathComponent("Walnut/Core/OrgNodeLink.swift"), encoding: .utf8)
        let go = try XCTUnwrap(link.range(of: "private func go(").map { link[$0.lowerBound...].prefix(900) })
        let wait = try XCTUnwrap(go.range(of: "awaitLowered(request"), "a closing sheet is waited for")
        let publish = try XCTUnwrap(go.range(of: "pending = request"))
        XCTAssertLessThan(wait.lowerBound, publish.lowerBound, "before the request is published")
        XCTAssertTrue(go.contains("plan != .show, !settled"), "unless nothing was over the app")
        XCTAssertGreaterThanOrEqual(OrgNodeLink.lowerWait, 3, "the wait ends on the sheet gone; the clock is a last resort")
        XCTAssertLessThan(OrgNodeLink.lowerWait, OrgNodeLink.requestTTL, "and shorter than a tap lives")
        let lowered = try XCTUnwrap(link.range(of: "private func awaitLowered(").map { link[$0.lowerBound...].prefix(1800) })
        XCTAssertTrue(lowered.contains("self.relandOnceClear(request)"), "a request past the last resort lands again once the sheet is gone")

        let chat = try String(contentsOf: root.appendingPathComponent("Walnut/Views/Chat/ChatView.swift"), encoding: .utf8)
        let present = try XCTUnwrap(chat.range(of: "private func presentOnRequest(").map { chat[$0.lowerBound...].prefix(1800) })
        let lower = try XCTUnwrap(present.range(of: "pages.lower(shown.id)"), "the chat on screen takes its page down")
        let swap = try XCTUnwrap(present.range(of: "withTransaction(instant) { openedAskSession = session }"))
        XCTAssertLessThan(lower.lowerBound, swap.lowerBound)
        XCTAssertTrue(present[lower.upperBound..<swap.lowerBound].contains("return"), "and the swap waits for it to leave")
        XCTAssertTrue(chat.contains("!pages.has(shown.id) { swapNow() }"), "which its leaving starts")
    }

    func testAPageAskedDownLeavesTheRegistryClean() throws {
        let pages = OrgPagesOnScreen.shared
        pages.appeared("s-test-a")
        pages.lower("s-test-a")
        XCTAssertEqual(pages.lowering, "s-test-a")
        XCTAssertTrue(pages.has("s-test-a"))
        pages.left("s-test-a")
        XCTAssertNil(pages.lowering, "the page that left is no longer asked down")
        XCTAssertFalse(pages.has("s-test-a"))
        XCTAssertTrue(pages.tookDown("s-test-a"), "its host reads the page's leaving as asked for, not his Back")
        XCTAssertFalse(pages.tookDown("s-test-a"), "once")

        // A page that leaves without being asked is his Back.
        pages.appeared("s-test-b")
        pages.left("s-test-b")
        XCTAssertFalse(pages.tookDown("s-test-b"))

        // The page itself goes down when asked: it is on screen, its chat is not.
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let page = try String(contentsOf: root.appendingPathComponent("Walnut/Views/Org/OrgNodePage.swift"), encoding: .utf8)
        XCTAssertTrue(page.contains(".onChange(of: pages.lowering, initial: true)"), "the page watches for the ask")
        XCTAssertTrue(page.contains("withTransaction(instant) { dismiss() }"), "and dismisses itself at once")
    }

    func testAHeldSheetSaysWhatWaits() {
        XCTAssertEqual(NavigationHeldLine.text("Approve the launch post"),
                       "\u{201C}Approve the launch post\u{201D} opens when you save or close this.")
        XCTAssertTrue(NavigationHeldLine.text(nil).contains("save or close"))
        XCTAssertEqual(NavigationHeldLine.text("Approve the launch post", until: .answered),
                       "\u{201C}Approve the launch post\u{201D} opens when you answer or close this.",
                       "a decision he owes is answered, not saved")
    }
}
