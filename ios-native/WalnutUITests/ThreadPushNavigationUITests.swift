import XCTest

/// A thread push against his own moves and the network (2026-11-08 review, round 2):
///
///  - X: a slow push read on its way, and he goes Back from the VP's page, or to another tab:
///    nothing opens over where he went once the read lands.
///  - Y: offline after he left the VP's page: a push opens it on the phone's copy of its threads,
///    with the thread, says so, and the page reads again once Walnut is back.
///  - Z: a push for another VP while a sheet is up over the first VP's page (a task's session, a
///    Follow up): it lands on the other VP's thread with no frame of the chat list on the way,
///    and Back goes to that VP's chat.
final class ThreadPushNavigationUITests: ThreadPushUITestCase {

    override var shotPrefix: String { "N" }

    private let slowThread = "th-5e5e5e5e"

    // MARK: - X. His moves end a slow push

    func testXBackFromThePageAndATabSwitchEndASlowPush() throws {
        try openBarPage("X")
        push(slowThread, task: OrgThreadsFixture.slowTaskID)
        let opening = el("chat.orgOpening")
        XCTAssertTrue(opening.waitForExistence(timeout: 4), "X: nothing says the chat is on its way")
        shot("X-opening")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 10), "X: Back did not reach the VP's chat")
        XCTAssertTrue(opening.waitForNonExistence(timeout: 3), "X: the open still says it is on its way after Back")
        Thread.sleep(forTimeInterval: OrgThreadsFixture.slowSeconds + 2)
        shot("X-after-back")
        XCTAssertFalse(titled(OrgThreadsFixture.slowTitle).exists, "X: the slow push opened over the chat he went Back to")
        XCTAssertFalse(el("org.node.page").exists, "X: a page opened over the chat he went Back to")

        // The same push, and he goes to Inbox and back.
        push(slowThread, task: OrgThreadsFixture.slowTaskID)
        XCTAssertTrue(opening.waitForExistence(timeout: 4), "X: nothing says the second open is on its way")
        app.tabBars.buttons["Inbox"].tap()
        Thread.sleep(forTimeInterval: 1)
        app.tabBars.buttons["Chat"].tap()
        XCTAssertTrue(opening.waitForNonExistence(timeout: 3), "X: the open still says it is on its way after a tab switch")
        Thread.sleep(forTimeInterval: OrgThreadsFixture.slowSeconds + 2)
        shot("X-after-tab")
        XCTAssertFalse(titled(OrgThreadsFixture.slowTitle).exists, "X: the slow push opened after he went to another tab")
        XCTAssertTrue(el("org.bar.threads").exists, "X: he is not on the VP's chat he left")
    }

    // MARK: - Y. Offline after he left the page

    func testYOfflinePushShowsThePhonesCopyThenReadsAgainOnline() throws {
        try openBarPage("Y")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 10))
        fixture?.setReachable(false)
        push(ids[7])
        expectRevealed(ids[7], "Y-offline")
        XCTAssertTrue(cardTitle(ids[0]).exists || card(ids[0]).exists, "Y: the page shows none of the threads the phone holds")
        let notice = el("chat.orgOpenNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 20), "Y: nothing says the page is the phone's copy")
        let copy = notice.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] 'last saw'")).firstMatch
        XCTAssertTrue(copy.exists, "Y: the notice does not say the page is as the phone last saw it")
        let error = el("org.threads.error")
        XCTAssertTrue(error.waitForExistence(timeout: 20), "Y: the page does not say its read failed")
        XCTAssertTrue((error.label).contains("as the phone last saw them"), "Y: the page's line: \(error.label)")
        shot("Y-copy")

        // Walnut is back: a pull reads again, and the page is current.
        fixture?.setReachable(true)
        let list = el("org.threads")
        for _ in 0..<3 where error.exists {
            list.swipeDown()
            _ = error.waitForNonExistence(timeout: 8)
        }
        XCTAssertFalse(error.exists, "Y: the page still says it is the phone's copy once Walnut is back")
        XCTAssertTrue(card(ids[7]).exists, "Y: the pushed thread left the page")
        shot("Y-online")
    }

    // MARK: - Z. Another VP over a sheet on the first one's page

    /// Watches for the chat list's own bar (`chat.menu`) until `threadId`'s mark shows.
    private func watchForTheChatList(until threadId: String, _ step: String) -> Bool {
        let menu = el("chat.menu")
        let mark = el("org.thread.revealed.\(threadId)")
        var sawList = false
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline, !mark.exists {
            if menu.exists { sawList = true }
        }
        if sawList { shot("\(step)-chat-list-showed") }
        return sawList
    }

    func testZAnotherVPOverASheetLandsStraightOnItsThread() throws {
        // A task's session over Growth VP's page, then Design VP's thread.
        try openBarPage("Z")
        segment("Tasks").tap()
        let row = el("org.tasks.row")
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the Tasks view lists no work")
        XCTAssertTrue(poll(5) { inView(row) })
        touch(row)
        XCTAssertTrue(el("task.open.done").waitForExistence(timeout: 20), "the task's session did not open")
        push(ids2[3], task: vp2)
        XCTAssertFalse(watchForTheChatList(until: ids2[3], "Z-task"), "Z: the chat list showed between the two VPs' pages")
        expectRevealed(ids2[3], "Z-task")
        XCTAssertTrue(titled(OrgThreadsFixture.vp2Name).waitForExistence(timeout: 5), "Z: not Design VP's page")
        XCTAssertFalse(el("task.open.done").exists, "Z: the task's session stayed up")

        // A Follow up over Design VP's page, then Growth VP's thread.
        let follow = card(ids2[0]).buttons["org.thread.followUp"]
        let list = el("org.threads")
        for _ in 0..<8 where !inView(cardTitle(ids2[0])) { list.swipeDown() }
        XCTAssertTrue(follow.waitForExistence(timeout: 10))
        bringIntoView(follow)
        touch(follow)
        let input = el("org.thread.followUp.input")
        XCTAssertTrue(input.waitForExistence(timeout: 10), "Z: Follow up opened no composer")
        push(ids[4])
        XCTAssertFalse(watchForTheChatList(until: ids[4], "Z-follow-up"), "Z: the chat list showed between the two VPs' pages")
        expectRevealed(ids[4], "Z-follow-up")
        XCTAssertTrue(titled(OrgThreadsFixture.vpName).waitForExistence(timeout: 5), "Z: not Growth VP's page")
        XCTAssertFalse(input.exists, "Z: the Follow up stayed up")

        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 10), "Z: Back did not reach a VP's chat")
        XCTAssertTrue(titled("Growth").waitForExistence(timeout: 5), "Z: Back did not reach Growth VP's chat")
        XCTAssertFalse(el("chat.menu").exists, "Z: Back went past the VP's chat to the chat list")
    }
}
