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
/// It drives the Shortcuts app and SpringBoard, so the Mac runs it: CI's hosted runner never
/// brought Walnut forward from its tap (runs 42728088538 to 42777473712, iOS 26.5).
/// The app is pinned at a closed local port, so nothing is sent anywhere.
final class TalkShortcutUITests: XCTestCase {
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
        // It goes out by itself, so the screen goes by itself too: no Close to tap.
        XCTAssertFalse(element(app, "talk.panel.close").exists, "Waiting to send asks for a Close it does not need")
        XCTAssertTrue(panel.waitForNonExistence(timeout: 15), "Waiting to send stayed on screen")

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
}
