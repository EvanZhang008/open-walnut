import XCTest

/// Round 3 reviewer (Claude) probes. Copy into WalnutUITests/ and run with
/// -only-testing:WalnutUITests/ThreadPushR3ClaudeReviewUITests
///
///  - AA: Growth VP's page is up on the Chat tab, he is on Inbox, and a push for Design VP comes.
///    With Chat out of sight, Growth VP's page has had onDisappear, so `OrgPagesOnScreen` no
///    longer lists it and `ChatView.presentOnRequest` may take the plain path (swap the chat under
///    a page that is still in the stack), the v11 failure. Expect Design VP's page with its thread.
///  - AB: the offline notice never keeps the navigation bar's buttons from him. Since 2026-11-20
///    it is a passing card at the top of the screen (`NoticeCenter`, the one notice system), over
///    the bar while it shows, so a swipe up takes it away and Back and the view switch are free.
final class ThreadPushR3ClaudeReviewUITests: ThreadPushUITestCase {

    override var shotPrefix: String { "C3" }

    func testAAAnotherVPsPushFromAnotherTabWhileOneVPsPageIsUp() throws {
        try openBarPage("AA")
        app.tab(.inbox).tap()
        Thread.sleep(forTimeInterval: 1.5)
        shot("AA-inbox")
        push(ids2[2], task: vp2)
        expectRevealed(ids2[2], "AA-to-vp2")
        XCTAssertTrue(titled(OrgThreadsFixture.vp2Name).waitForExistence(timeout: 5), "AA: the page is not Design VP's")
        XCTAssertFalse(card(ids[0]).exists, "AA: Growth VP's threads are on screen")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 10), "AA: Back did not land on a VP chat")
        XCTAssertTrue(titled("Design").waitForExistence(timeout: 5), "AA: Back did not land on Design VP's chat")
        shot("AA-back")
    }

    func testABNoticesLeaveTheBarButtonsUncovered() throws {
        // Offline notice over the page (as S).
        try openBarPage("AB")
        fixture?.stop()
        let list = el("org.threads")
        for _ in 0..<3 {
            list.swipeDown()
            Thread.sleep(forTimeInterval: 2)
        }
        push(ids[8])
        expectRevealed(ids[8], "AB-offline")
        let notice = el("chat.orgOpenNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 5))
        let backButton = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(backButton.exists)
        shot("AB-notice")
        notice.swipeUp()
        XCTAssertTrue(notice.waitForNonExistence(timeout: 3), "AB: a swipe up does not take the notice away")
        XCTAssertTrue(backButton.isHittable, "AB: Back \(backButton.frame) is still covered")
        XCTAssertTrue(tabs.isHittable, "AB: the view switch \(tabs.frame) is still covered")
    }
}
