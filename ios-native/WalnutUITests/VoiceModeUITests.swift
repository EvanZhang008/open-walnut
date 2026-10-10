import XCTest

/// Voice mode as a person drives it, against the in-app demo server: the Chat
/// tab's voice button opens "Talk to Walnut", one take (tap, speak, tap) starts
/// an ask, the page becomes that ask's session with voice mode still on, and the
/// answer is read aloud when its turn ends. Then the keyboard button hands the
/// page back to the composer.
///
/// The app is pinned at the demo address, which is answered inside the app, so
/// nothing here reaches a network. The demo transcribes every take to the same
/// sentence (`DemoFixtures.transcriptionSentence`), so the test does not depend
/// on what the simulator's microphone hears. The microphone permission must be
/// granted beforehand (`xcrun simctl privacy <udid> grant microphone
/// dev.openwalnut.ios`): a permission alert is not part of what this checks.
final class VoiceModeUITests: XCTestCase {
    private static let demoURL = "https://demo.walnut.invalid"
    private static let demoToken = "walnut-demo-token"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier))
            .firstMatch
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Wait until `element`'s label contains one of `fragments`.
    private func waitForLabel(
        _ element: XCUIElement, containing fragments: [String], timeout: TimeInterval
    ) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists {
                let label = element.label
                if fragments.contains(where: { label.contains($0) }) { return label }
            }
            usleep(200_000)
        }
        return nil
    }

    @MainActor
    func testTalkToWalnutLaunchesAnAskAndReadsTheAnswer() throws {
        let app = UITestLaunch.launch([
            UITestLaunch.serverURLArgument, Self.demoURL,
            "-walnut.deviceToken", Self.demoToken,
        ])
        let chatTab = app.tabBars.buttons["Chat"]
        XCTAssertTrue(chatTab.waitForExistence(timeout: 60), "the demo never opened")
        chatTab.tap()

        // An empty composer offers voice mode in the send seat.
        let voiceButton = element(app, "chat.voiceMode")
        XCTAssertTrue(voiceButton.waitForExistence(timeout: 20), "no voice mode button on an empty chat composer")
        voiceButton.tap()

        XCTAssertTrue(element(app, "voiceAsk.page").waitForExistence(timeout: 10), "Talk to Walnut did not open")
        let status = element(app, "voiceMode.status")
        XCTAssertTrue(status.waitForExistence(timeout: 5), "no status line in voice mode")
        XCTAssertTrue(status.label.contains("Tap the mic"), "fresh voice mode says what to do: \(status.label)")
        attach(app, "voice-ask-ready")

        // One take: tap, a moment of talking, tap to send.
        let mic = element(app, "voiceMode.mic")
        mic.tap()
        XCTAssertNotNil(
            waitForLabel(status, containing: ["Listening"], timeout: 10),
            "the mic did not start listening: \(status.label) \(element(app, "voiceMode.notice").exists ? element(app, "voiceMode.notice").label : "")"
        )
        attach(app, "voice-ask-listening")
        sleep(2)
        mic.tap()

        // The launch turns the page into the ask's session, still in voice mode.
        let close = element(app, "voiceAsk.close")
        XCTAssertTrue(
            element(app, "voiceAsk.page").waitForNonExistence(timeout: 30),
            "the take did not launch an ask"
        )
        XCTAssertTrue(close.waitForExistence(timeout: 5), "the launched page has no Close")
        XCTAssertTrue(status.waitForExistence(timeout: 10), "voice mode did not carry over to the session page")
        // The bubble shows what was said, and nothing of the voice-reply line.
        let bubble = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "counter quotes")).firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 15), "the spoken words are not on the page")
        XCTAssertFalse(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Voice reply")).firstMatch.exists,
            "the voice-reply line leaked into the transcript"
        )
        attach(app, "voice-session-working")

        // The answer is read when its turn ends.
        let read = waitForLabel(status, containing: ["Reading the answer"], timeout: 60)
        attach(app, "voice-session-reading")
        XCTAssertNotNil(read, "the answer was never read aloud: \(status.label)")
        // Stop, when the reading is still going (a short answer may already be over).
        let stop = element(app, "voiceMode.stop")
        if stop.exists { stop.tap() }
        XCTAssertNotNil(
            waitForLabel(status, containing: ["Tap the mic and talk"], timeout: 30),
            "the reading never ended: \(status.label)"
        )
        let replay = element(app, "voiceMode.replay")
        XCTAssertTrue(replay.waitForExistence(timeout: 5) && replay.isEnabled, "Replay is not offered after an answer")
        attach(app, "voice-session-after-stop")

        // The keyboard hands the page back to the composer.
        element(app, "voiceMode.exit").tap()
        XCTAssertTrue(element(app, "chat.mic").waitForExistence(timeout: 5), "the composer did not come back")
        XCTAssertFalse(status.exists, "voice mode is still on after leaving it")
        attach(app, "voice-session-composer")

        // Back into voice mode from this session's own composer: what is already on
        // the page is never read again.
        let sessionVoice = element(app, "chat.voiceMode")
        XCTAssertTrue(sessionVoice.waitForExistence(timeout: 5), "no voice mode button on the session composer")
        sessionVoice.tap()
        XCTAssertTrue(status.waitForExistence(timeout: 5), "voice mode did not turn on from the session page")
        sleep(3)
        XCTAssertTrue(status.label.contains("Tap the mic and talk"), "an old answer was read on re-entry: \(status.label)")

        // A second round on the same page is read too.
        mic.tap()
        XCTAssertNotNil(waitForLabel(status, containing: ["Listening"], timeout: 10), "second take did not start")
        sleep(2)
        mic.tap()
        XCTAssertNotNil(
            waitForLabel(status, containing: ["Reading the answer"], timeout: 60),
            "the second answer was never read aloud: \(status.label)"
        )
        attach(app, "voice-session-second-round")
        if stop.exists { stop.tap() }
        close.tap()
    }
}
