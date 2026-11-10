import XCTest

/// Talk to Walnut when the words cannot go out, end to end through real taps:
///  - the Shortcuts app lists "Talk to Walnut" with no setup, and a tap with Walnut in the
///    background that iOS will not let record from behind (`talkRefuseFromBehind`, the way a
///    phone refused build 160) brings Walnut forward already listening (a recorded file
///    stands in for the microphone, through the real audio session);
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

    /// The labels an app shows, in order, for a failure message.
    private static func labels(_ app: XCUIApplication) -> String {
        let tree = app.debugDescription
        guard let pattern = try? NSRegularExpression(pattern: "label: '([^']+)'") else { return "" }
        let found = pattern.matches(in: tree, range: NSRange(tree.startIndex..., in: tree)).compactMap { match in
            Range(match.range(at: 1), in: tree).map { String(tree[$0]) }
        }
        return found.prefix(40).joined(separator: " / ")
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
            "-walnut.debug.talkRefuseFromBehind", "YES",
        ])
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "Walnut never opened")

        // The Shortcuts app lists it under Walnut, with nothing to set up. Its tap
        // runs the intent in the Walnut process launched above, pinned to the
        // discard port.
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        shortcuts.launch()
        let tile = labelled(shortcuts, "Talk to Walnut")
        // A fresh install's shortcuts reach the Shortcuts app once iOS has indexed them:
        // open it again once before calling them missing.
        if !tile.waitForExistence(timeout: 30) {
            shortcuts.terminate()
            shortcuts.launch()
        }
        XCTAssertTrue(tile.waitForExistence(timeout: 60), "Talk to Walnut is not in the Shortcuts app")
        shot("1-shortcuts-lists-it")
        XCTAssertNotEqual(app.state, .notRunning, "Walnut stopped: the tap would start an unpinned one")
        XCTAssertNotEqual(app.state, .runningForeground, "Walnut is in front before the press: the test would not show it coming forward")
        tile.tap()

        // Refused from behind, the press brings Walnut forward, already listening, on its own screen.
        // When it does not, the failure says what was on screen instead (a prompt, an error, a
        // detail page): CI's job log keeps the message even when no screenshot is uploaded.
        guard app.wait(for: .runningForeground, timeout: 10) else {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let seen = "Shortcuts: \(Self.labels(shortcuts)) | SpringBoard: \(Self.labels(springboard))"
            let text = XCTAttachment(string: shortcuts.debugDescription + "\n\n" + springboard.debugDescription)
            text.name = "not-forward-hierarchy"
            text.lifetime = .keepAlways
            add(text)
            XCTFail("the shortcut did not bring Walnut forward (Walnut is \(app.state.rawValue)); on screen: \(seen)")
            return
        }
        let panel = element(app, "talk.panel")
        XCTAssertTrue(panel.waitForExistence(timeout: 10), "Walnut came forward without the Talk screen")
        let title = element(app, "talk.panel.title")
        let listening = expectation(for: NSPredicate(format: "label == 'Listening'"), evaluatedWith: title)
        XCTAssertEqual(XCTWaiter().wait(for: [listening], timeout: 10), .completed, "the Talk screen never listened: \(title.label)")
        XCTAssertFalse(labelled(app, "Couldn't start listening").exists, "the microphone was refused")
        XCTAssertTrue(element(app, "talk.panel.send").exists, "listening without a Send button")
        XCTAssertTrue(element(app, "talk.panel.cancel").exists, "listening without a Cancel button")
        shot("2-listening")

        // A pause never sends by itself: the take listens on until the person sends. A tap
        // anywhere on the Talk screen (here its title, no button) sends it once the recorded
        // words have played; the server is unreachable, so it waits to send and says so.
        sleep(6)
        XCTAssertEqual(title.label, "Listening", "the take ended by itself on the pause")
        title.tap()
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
        // The take runs on past the words until the tap sends it, so it is a little longer
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
