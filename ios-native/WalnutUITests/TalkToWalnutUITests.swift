import XCTest

/// Talk to Walnut when the words cannot go out, end to end through real taps:
///  - the Shortcuts app lists "Talk to Walnut" with no setup, and a tap with Walnut in the
///    background brings Walnut forward already listening (iOS starts no recording in the
///    background; a recorded file stands in for the microphone, through the real audio session);
///  - the server is unreachable, so the take is kept and the panel says so;
///  - Settings, Action Button shows it first, then the setup; its list has the reason, its
///    length, playback, Send Now and Delete.
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

    @MainActor
    func testATakeTheServerNeverGotIsKeptAndOfferedWithItsLengthAndPlayback() throws {
        let audio = try XCTUnwrap(Bundle(for: Self.self).path(forResource: "talk-en", ofType: "caf"))
        let app = UITestLaunch.launch([
            UITestLaunch.serverURLArgument, "http://127.0.0.1:9", "-walnut.deviceToken", "talk-ui-test",
            "-walnut.debug.talkReplayFile", audio, "-walnut.debug.talkClearOutbox", "YES",
        ])
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "Walnut never opened")

        // The Shortcuts app lists it under Walnut, with nothing to set up. Its tap
        // runs the intent in the Walnut process launched above, pinned to the
        // discard port.
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        shortcuts.launch()
        let tile = labelled(shortcuts, "Talk to Walnut")
        XCTAssertTrue(tile.waitForExistence(timeout: 30), "Talk to Walnut is not in the Shortcuts app")
        shot("1-shortcuts-lists-it")
        XCTAssertNotEqual(app.state, .notRunning, "Walnut stopped: the tap would start an unpinned one")
        XCTAssertNotEqual(app.state, .runningForeground, "Walnut is in front before the press: the test would not show it coming forward")
        tile.tap()

        // The press brings Walnut forward, already listening, on its own screen.
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "the shortcut did not bring Walnut forward")
        let panel = element(app, "talk.panel")
        XCTAssertTrue(panel.waitForExistence(timeout: 10), "Walnut came forward without the Talk screen")
        let title = element(app, "talk.panel.title")
        let listening = expectation(for: NSPredicate(format: "label == 'Listening'"), evaluatedWith: title)
        XCTAssertEqual(XCTWaiter().wait(for: [listening], timeout: 10), .completed, "the Talk screen never listened: \(title.label)")
        XCTAssertFalse(labelled(app, "Couldn't start listening").exists, "the microphone was refused")
        XCTAssertTrue(element(app, "talk.panel.send").exists, "listening without a Send button")
        XCTAssertTrue(element(app, "talk.panel.cancel").exists, "listening without a Cancel button")
        shot("2-listening")

        // The pause ends it; the server is unreachable, so it waits to send and the panel says so.
        let waiting = expectation(for: NSPredicate(format: "label == 'Waiting to send'"), evaluatedWith: title)
        XCTAssertEqual(XCTWaiter().wait(for: [waiting], timeout: 40), .completed, "the take did not end as waiting to send: \(title.label)")
        XCTAssertTrue(labelled(app, "by itself the next time").exists, "the panel does not say the take goes out later")
        shot("3-not-sent")
        element(app, "talk.panel.close").tap()
        XCTAssertTrue(panel.waitForNonExistence(timeout: 5), "Close left the Talk screen")

        // Settings, Action Button: the waiting take comes first, then what it
        // does, the steps, and the other ways.
        app.tabBars.buttons["Settings"].tap()
        let row = element(app, "settings.talkToWalnut")
        for _ in 0..<6 where !row.isHittable { app.swipeUp() }
        row.tap()
        let open = element(app, "talk.unsentOpen")
        XCTAssertTrue(open.waitForExistence(timeout: 10), "Settings does not offer the waiting take")
        XCTAssertTrue(labelled(app, "Waiting to Send").exists, "the waiting take is not called Waiting to Send")
        XCTAssertTrue(element(app, "talk.try").exists)
        XCTAssertFalse(element(app, "talk.unsent.row").exists, "Settings lists the takes inline")
        shot("5-settings-top")
        app.swipeUp()
        sleep(1)
        shot("6-settings-steps")
        app.swipeDown()
        app.swipeDown()

        // The list: the reason once, the recording's length, playback.
        open.tap()
        XCTAssertTrue(element(app, "talk.unsentSheet").waitForExistence(timeout: 5) || labelled(app, "Waiting to Send").exists)
        XCTAssertTrue(labelled(app, "Walnut server unavailable").waitForExistence(timeout: 5), "the reason does not name the server")
        XCTAssertTrue(labelled(app, "tries again each time you open it").exists, "the list does not say when it goes out")
        // The take runs on past the words until the pause ends it, so it is a little longer
        // than the 4 s file.
        let length = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^Recording \u{00B7} [0-9]+ s$")).firstMatch
        XCTAssertTrue(length.exists, "the recording's length is missing")
        shot("3-waiting-sheet")
        let play = element(app, "talk.unsent.play")
        XCTAssertTrue(play.exists, "no playback for the recording")
        play.tap()
        sleep(1)
        shot("4-playing")
        play.tap()

        // Send Now that fails again says it was tried, not just the same reason.
        let sendNow = element(app, "talk.unsent.resend")
        XCTAssertEqual(sendNow.label, "Send Now", "a waiting take offers Send Now")
        sendNow.tap()
        XCTAssertTrue(element(app, "talk.unsent.triedAgain").waitForExistence(timeout: 30), "a failed Send Now changed nothing on screen")
        shot("4a-tried-again")

        // Delete, from the list Settings opens, leaves nothing behind.
        // Follow the first row by its length and time: the list draws rows
        // lazily, so a count stays level as the next row scrolls in.
        let stamp = element(app, "talk.unsent.when")
        let delete = element(app, "talk.unsent.delete")
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        XCTAssertTrue(stamp.exists)
        let first = stamp.label
        let same = app.staticTexts.matching(NSPredicate(format: "label == %@", first))
        let before = same.count
        delete.tap()
        // Delete asks first: the take never reached the CEO chat.
        let confirm = app.buttons["Delete Recording"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "Delete did not ask first")
        shot("7a-delete-asks")
        confirm.tap()
        let fewer = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == %d", before - 1), object: same)
        XCTAssertEqual(XCTWaiter().wait(for: [fewer], timeout: 8), .completed, "Delete left the row")
        shot("7-after-delete")
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
