import XCTest

/// A thread acted on moves every count of its node on the tap, before the server answers
/// (2026-11-19, the user: the red dot outside took about twenty seconds to go; "it should be
/// instant"). The fixture holds the thread write's answer back, so whatever moves while it is held
/// moved on the phone alone: the card, the page's Threads count, the bar under the VP's chat and
/// the VP's row in the drawer's Org list.
///
/// Paired to `ChatPlaceFixtureServer` with `OrgThreadsFixture` (a loopback server this runner
/// hosts: no Walnut, nobody's data). Nothing here sends a message.
final class ThreadInstantUITests: ThreadPushUITestCase {
    override var shotPrefix: String { "I" }

    private func isThreadWrite(_ method: String, _ path: String) -> Bool {
        method == "PATCH" && path.hasPrefix("/api/v1/tasks/\(OrgThreadsFixture.vpTaskID)/threads/")
    }

    private func waitLabel(_ e: XCUIElement, _ seconds: TimeInterval, _ ok: (String) -> Bool) -> Bool {
        poll(seconds) { e.exists && ok(e.label) }
    }

    func testAcknowledgeDropsTheNodesCountEverywhereBeforeTheServerAnswers() throws {
        let total = ids.count
        try openBarPage("open")
        let threads = segment("Threads")
        XCTAssertTrue(waitLabel(threads, 15) { $0 == "Threads \(total)" }, "the page counts \(threads.label)")

        // The server takes the write but does not answer it yet.
        try XCTUnwrap(fixture).holdAnswers(where: isThreadWrite)
        let ack = card(ids[0]).descendants(matching: .any).matching(identifier: "org.thread.ack").firstMatch
        XCTAssertTrue(ack.waitForExistence(timeout: 10), "the first card has no Acknowledge")
        // A card's button under a List row is not always hittable to XCUITest though it is on
        // screen (ThreadPushHoldUITests taps them the same way): into view, then by coordinate.
        bringIntoView(ack)
        let tapped = Date()
        touch(ack)
        XCTAssertTrue(waitLabel(threads, 1.5) { $0 == "Threads \(total - 1)" },
                      "the page still counts \(threads.label) while the write is out")
        print("[evidence] page count moved \(Int(Date().timeIntervalSince(tapped) * 1000)) ms after the tap, write held")
        XCTAssertTrue(card(ids[0]).waitForNonExistence(timeout: 2) || !card(ids[0]).isHittable,
                      "the card is still among the open ones")
        shot("acked-write-held")

        // The bar under the VP's chat, still before any answer.
        back()
        let bar = el("org.bar.threads")
        XCTAssertTrue(bar.waitForExistence(timeout: 10), "Back did not reach the VP chat")
        XCTAssertTrue(waitLabel(bar, 1.5) { $0 == "Threads, \(total - 1)" }, "the chat's bar reads \(bar.label)")
        shot("bar-write-held")

        // The VP's row in the drawer's Org list.
        // A session's chat (the VP's) names its sidebar button chat.session.menu; the root chat chat.menu.
        let menu = app.buttons.matching(NSPredicate(format: "identifier IN %@", ["chat.session.menu", "chat.menu"])).firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "the VP chat has no sidebar button")
        menu.tap()
        let picker = app.segmentedControls["chat.drawer.viewSwitch"]
        if picker.waitForExistence(timeout: 5), picker.buttons["Org"].exists, !picker.buttons["Org"].isSelected {
            picker.buttons["Org"].tap()
        }
        let row = app.buttons["chat.drawer.org.project:growth"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no Growth row in the drawer")
        XCTAssertTrue(waitLabel(row, 1.5) { $0.hasSuffix("\(total - 1) threads") }, "the drawer row reads \(row.label)")
        shot("drawer-write-held")

        fixture?.releaseHeld()
        print("[evidence] every surface read \(total - 1) before the server answered")
    }

    /// The Brief's dot (a rewrite not read on this phone, the web's Brief tab dot) goes the moment
    /// the Brief is opened, on the page's segment and on the bar under the chat alike.
    func testOpeningTheBriefDropsItsDotOnTheBarAtOnce() throws {
        try launchToVPChat("brief")
        let brief = el("org.bar.brief")
        XCTAssertTrue(waitLabel(brief, 15) { $0 == "Brief, new" }, "the bar reads \(brief.label): a Brief not read here wears no dot")
        brief.tap()
        XCTAssertTrue(el("org.brief.text").waitForExistence(timeout: 15), "Brief on the bar opened no letter")
        XCTAssertTrue(waitLabel(segment("Brief"), 5) { $0 == "Brief" }, "the segment still reads \(segment("Brief").label)")
        shot("brief-read")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 10), "Back did not reach the VP chat")
        XCTAssertTrue(waitLabel(brief, 2) { $0 == "Brief" }, "the bar's dot stayed after the Brief was read: \(brief.label)")
        print("[evidence] the Brief dot went on the open, on the segment and the bar")
    }
}
