import XCTest

/// Talk to Walnut the way the Action Button runs it, against a real paired server: Walnut in
/// the background, the shortcut run from the Shortcuts app, and the sentence checked in the
/// CEO chat of that server.
///
/// Build 160 recorded from the background and every press on a phone failed ("Audio is in
/// use by another app"), while the tests that ran Talk in front passed. This run opens the
/// real voice session the way a press does (`VoiceRecorder.activateForReplay`, the same
/// activation, and a real microphone recorder held open for the take); only the words come
/// from a recorded file, so nothing is played or spoken aloud on the Mac that runs it. Its
/// runner (`ios-native/tests/ui/run-talk-real-server.sh`) hands it:
///
///  - `WALNUT_UITEST_SERVER` / `WALNUT_UITEST_TOKEN`: a paired server (a test copy of the
///    user's data, never the real one), reachable from the simulator;
///  - `WALNUT_UITEST_REAL_SERVER=1`: the opt-in.
///
/// Without them it is skipped. Screenshots are taken every half second and kept, so the run
/// reads as a clip (the runner stitches them into an MP4).
final class TalkRealServerUITests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private var frame = 0

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard env["WALNUT_UITEST_REAL_SERVER"] == "1" else {
            throw XCTSkip("needs a paired test server (WALNUT_UITEST_REAL_SERVER=1)")
        }
        guard env["WALNUT_UITEST_SERVER"] != nil, env["WALNUT_UITEST_TOKEN"] != nil else {
            throw XCTSkip("needs WALNUT_UITEST_SERVER and WALNUT_UITEST_TOKEN")
        }
    }

    private func shot(_ name: String) {
        frame += 1
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = String(format: "frame-%04d-%@", frame, name)
        a.lifetime = .keepAlways
        add(a)
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    private func labelled(_ app: XCUIApplication, _ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
    }

    /// Screenshots every half second until `done` holds or `seconds` pass.
    private func film(_ name: String, seconds: Double, until done: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            shot(name)
            if done() { return true }
            usleep(500_000)
        }
        shot(name)
        return done()
    }

    private var pairing: [String] {
        get throws {
            // The words of the take: a recorded sentence the take reads as its microphone.
            let audio = try XCTUnwrap(Bundle(for: Self.self).path(forResource: "talk-en", ofType: "caf"))
            return [
                UITestLaunch.serverURLArgument, UITestLaunch.pairedServer(env["WALNUT_UITEST_SERVER"] ?? ""),
                "-walnut.deviceToken", env["WALNUT_UITEST_TOKEN"] ?? "", "-walnut.debug.talkClearOutbox", "YES",
                "-walnut.debug.talkReplayFile", audio,
            ]
        }
    }

    /// After the shortcut's tile was tapped: Walnut comes forward listening, the take ends on
    /// the pause after its sentence, and the words went to the CEO chat.
    private func talk(_ app: XCUIApplication, label: String) {
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15), "the press did not bring Walnut forward")
        let title = element(app, "talk.panel.title")
        let listening = film("\(label)-opening", seconds: 15) { title.exists && title.label == "Listening" }
        XCTAssertTrue(listening, "the Talk screen never listened: \(title.exists ? title.label : "no panel")")
        XCTAssertFalse(labelled(app, "Couldn't start listening").exists, "the microphone was refused")

        // The pause after the recorded sentence ends the take.
        let ended = film("\(label)-take", seconds: 60) {
            title.exists && ["Sent to your CEO", "Not sent", "Waiting to send"].contains(title.label)
        }
        XCTAssertTrue(ended, "the take never ended")
        let words = element(app, "talk.panel.detail")
        XCTAssertEqual(title.label, "Sent to your CEO", "not sent: \(words.exists ? words.label : "")")
        XCTContext.runActivity(named: "WALNUT-SENT \(label): \(words.exists ? words.label : "")") { _ in }
        _ = film("\(label)-after", seconds: 4) { !element(app, "talk.panel").exists }
    }

    /// Walnut in the background, the Shortcuts app's tile: what the Action Button runs.
    @MainActor
    func testThePressOpensWalnutListeningAndReachesTheCEO() throws {
        let app = UITestLaunch.launch(try pairing)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "Walnut never opened")
        shot("plain-walnut-open")
        XCUIDevice.shared.press(.home)
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        shortcuts.launch()
        let tile = labelled(shortcuts, "Talk to Walnut")
        XCTAssertTrue(tile.waitForExistence(timeout: 30), "Talk to Walnut is not in the Shortcuts app")
        shot("plain-shortcuts")
        XCTAssertNotEqual(app.state, .notRunning, "Walnut stopped: the tap would start an unpinned one")
        XCTAssertNotEqual(app.state, .runningForeground, "Walnut is in front before the press")
        tile.tap()
        talk(app, label: "plain")
    }

    /// Right after Walnut's own voice input (the chat's microphone), with Walnut sent away.
    @MainActor
    func testThePressRecordsRightAfterWalnutsOwnVoiceInput() throws {
        let app = UITestLaunch.launch(try pairing)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "Walnut never opened")
        app.tabBars.buttons["Chat"].tap()
        let microphone = element(app, "chat.mic")
        XCTAssertTrue(microphone.waitForExistence(timeout: 30), "no microphone in the chat")
        microphone.tap()
        let stop = element(app, "chat.voiceStop")
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "the chat's voice input did not start")
        _ = film("dictation", seconds: 4) { false }
        stop.tap()
        _ = film("dictation-done", seconds: 30) { microphone.exists && microphone.isHittable }
        XCUIDevice.shared.press(.home)
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        shortcuts.launch()
        let tile = labelled(shortcuts, "Talk to Walnut")
        XCTAssertTrue(tile.waitForExistence(timeout: 30), "Talk to Walnut is not in the Shortcuts app")
        XCTAssertNotEqual(app.state, .notRunning, "Walnut stopped: the tap would start an unpinned one")
        tile.tap()
        talk(app, label: "after-dictation")
    }
}
