import XCTest

/// Talk to Walnut inside Walnut, with no server: Settings, Action Button offers Dictate to
/// Clipboard and keeps a dictation it could not copy, and the unsent rows stack at the
/// largest text sizes. The press from the Shortcuts app is `TalkShortcutUITests`.
///
/// The app is pinned at a closed local port, so nothing is sent anywhere.
final class TalkToWalnutUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    private func labelled(_ app: XCUIApplication, _ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    /// The Action Button page offers Dictate to Clipboard with a try of its own; one the
    /// server never transcribed waits in the list with Copy, never Send, and is not copied
    /// or sent by itself.
    @MainActor
    func testTheSetupOffersDictationAndKeepsOneItCouldNotCopy() throws {
        let audio = try XCTUnwrap(Bundle(for: Self.self).path(forResource: "talk-en", ofType: "caf"))
        let app = UITestLaunch.launch([
            UITestLaunch.serverURLArgument, "http://127.0.0.1:9", "-walnut.deviceToken", "talk-ui-test",
            "-walnut.debug.talkReplayFile", audio, "-walnut.debug.talkClearOutbox", "YES",
        ])
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "Walnut never opened")
        app.tabBars.buttons["Settings"].tap()
        let row = element(app, "settings.talkToWalnut")
        for _ in 0..<6 where !row.isHittable { app.swipeUp() }
        row.tap()
        let intro = element(app, "talk.dictate.intro")
        let tryIt = element(app, "talk.dictate.try")
        for _ in 0..<4 where !tryIt.isHittable { app.swipeUp() }
        XCTAssertTrue(intro.exists, "the page does not explain Dictate to Clipboard")
        XCTAssertTrue(labelled(app, "Dictate to Clipboard").exists)
        XCTAssertTrue(labelled(app, "or **Dictate to Clipboard**").exists || labelled(app, "or Dictate to Clipboard").exists,
                      "the steps do not offer it for the Action Button")
        shot("d1-offered")
        tryIt.tap()
        let copy = element(app, "talk.dictate.copy")
        XCTAssertTrue(copy.waitForExistence(timeout: 15), "Try Dictation did not start listening")
        XCTAssertFalse(element(app, "talk.send").exists, "the dictation offers Send")
        XCTAssertFalse(element(app, "talk.try").isEnabled, "the other try starts a second take")
        shot("d2-listening")
        sleep(6)
        copy.tap()
        // The server is unreachable: the recording is kept to copy.
        let open = element(app, "talk.unsentOpen")
        for _ in 0..<8 where !open.exists { app.swipeDown() }
        XCTAssertTrue(open.waitForExistence(timeout: 40), "the dictation that was not copied is not kept")
        XCTAssertTrue(labelled(app, "Not Copied").exists, "the kept dictation is not called Not Copied")
        shot("d3-not-copied")
        for _ in 0..<8 where !open.isHittable { app.swipeDown() }
        open.tap()
        let resend = element(app, "talk.unsent.resend")
        XCTAssertTrue(resend.waitForExistence(timeout: 10))
        XCTAssertEqual(resend.label, "Copy", "a kept dictation offers Send")
        XCTAssertTrue(labelled(app, "Tap Copy").exists, "the list does not say how it goes on")
        shot("d4-list")
        resend.tap()
        XCTAssertTrue(element(app, "talk.unsent.triedAgain").waitForExistence(timeout: 30), "a failed Copy changed nothing on screen")
        shot("d5-tried-again")
        // Delete it: a take that needs the person opens its list on the next launch.
        element(app, "talk.unsent.delete").tap()
        let confirm = app.buttons["Delete Recording"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "Delete did not ask first")
        XCTAssertTrue(labelled(app, "never copied").exists, "Delete does not say it was never copied")
        confirm.tap()
        XCTAssertTrue(open.waitForNonExistence(timeout: 10) || !element(app, "talk.unsent.row").exists, "Delete left the dictation")
    }

    /// At the largest text sizes each Not Sent row stacks its reason and buttons,
    /// so no word breaks letter by letter.
    @MainActor
    func testTheUnsentRowStacksAtAccessibilityTextSizes() throws {
        let audio = try XCTUnwrap(Bundle(for: Self.self).path(forResource: "talk-en", ofType: "caf"))
        let app = UITestLaunch.launch([
            UITestLaunch.serverURLArgument, "http://127.0.0.1:9", "-walnut.deviceToken", "talk-ui-test",
            "-walnut.debug.talkReplayFile", audio,
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
        ])
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "Walnut never opened")
        // A waiting take never pops a sheet: open the list from Settings,
        // making a take there first when none is kept (the server is unreachable).
        app.tabBars.buttons["Settings"].tap()
        let row = element(app, "settings.talkToWalnut")
        for _ in 0..<12 where !row.isHittable { app.swipeUp() }
        row.tap()
        let open = element(app, "talk.unsentOpen")
        if !open.waitForExistence(timeout: 3) {
            // At this size Try It Now sits below the intro: the list draws it once scrolled to.
            let tryIt = element(app, "talk.try")
            for _ in 0..<8 where !tryIt.isHittable { app.swipeUp() }
            tryIt.tap()
            // It listens until the person sends (a pause never does), once the words have played.
            let send = element(app, "talk.send")
            XCTAssertTrue(send.waitForExistence(timeout: 15), "Try It Now did not start listening")
            sleep(6)
            send.tap()
            // The kept take's row comes first: back to the top for it.
            for _ in 0..<8 where !open.isHittable { app.swipeDown() }
        }
        XCTAssertTrue(open.waitForExistence(timeout: 40), "the failed take was not kept")
        for _ in 0..<8 where !open.isHittable { app.swipeDown() }
        open.tap()
        let resend = element(app, "talk.unsent.resend")
        let delete = element(app, "talk.unsent.delete")
        XCTAssertTrue(resend.waitForExistence(timeout: 10))
        shot("ax-unsent-row")
        let width = app.windows.firstMatch.frame.width
        XCTAssertGreaterThan(resend.frame.width, width * 0.6, "Resend is squeezed beside the reason")
        XCTAssertGreaterThan(delete.frame.width, width * 0.6, "Delete is squeezed beside the reason")
        XCTAssertGreaterThanOrEqual(delete.frame.minY, resend.frame.maxY - 1, "stacked, Resend comes first")
        // The reason (on the row, or once in the header when every row shares it)
        // wraps instead of ending in "…": at this size it needs two lines or more.
        let reason = labelled(app, "Walnut server unavailable")
        XCTAssertTrue(reason.exists, "the reason is not shown")
        XCTAssertGreaterThan(reason.frame.height, 60, "the reason is cut to one line")
    }
}
