import XCTest

/// Hands-free voice mode (the voice_conversation experiment) as a person drives it,
/// against the in-app demo server: one tap and it listens, the words show as they are
/// heard, a pause sends them, the answer is read, and it listens again on its own. The
/// microphone is a recorded take (`-walnut.debug.talkReplayFile`), so no permission is
/// asked. Its own class so the CI shard plan can place it apart from push-to-talk.
final class VoiceModeHandsFreeUITests: VoiceModeUITestBase {
    /// Hands-free (the user, 2026-11-23: "once I tap voice mode I don't need any tap"):
    /// Talk to Walnut opens listening, the words show in the box as they are heard, a
    /// pause sends them, the answer is read, and it listens again on its own. The take
    /// is a recorded sentence played as the microphone (`talkReplayFile`), and the
    /// demo transcribes it to its fixed sentence.
    @MainActor
    func testHandsFreeListensSendsOnAPauseReadsAndListensAgain() throws {
        let audio = try XCTUnwrap(Bundle(for: Self.self).path(forResource: "talk-en", ofType: "caf"))
        let app = UITestLaunch.launch([
            UITestLaunch.serverURLArgument, Self.demoURL,
            "-walnut.deviceToken", Self.demoToken,
            "-walnut.debug.demoExperiments", "voice_conversation,chat_glass_edges",
            "-walnut.debug.talkReplayFile", audio,
        ])
        let chatTab = app.tab(.chat)
        XCTAssertTrue(chatTab.waitForExistence(timeout: 60), "the demo never opened")
        chatTab.tap()
        let voiceButton = element(app, "chat.voiceMode")
        XCTAssertTrue(voiceButton.waitForExistence(timeout: 20), "no voice mode button on an empty chat composer")
        // The chat reads the server's switches when it appears.
        sleep(2)
        voiceButton.tap()

        // One tap: it is listening, nothing else to press.
        let status = element(app, "voiceMode.status")
        XCTAssertNotNil(waitForLabel(status, containing: ["Listening"], timeout: 15),
                        "voice mode did not start listening on its own: \(status.label)")
        let words = element(app, "voiceMode.liveWords")
        XCTAssertTrue(words.waitForExistence(timeout: 5), "no box for the words while it listens")
        XCTAssertNotNil(waitForLabel(words, containing: ["Remind me"], timeout: 20),
                        "the words heard did not show in the box: \(words.label)")
        attach(app, "hands-free-live-words")

        // The pause sends it: the ask launches and becomes its session page.
        XCTAssertTrue(element(app, "voiceAsk.page").waitForNonExistence(timeout: 40), "the pause did not send the take")
        let bubble = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "counter quotes")).firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 15), "the spoken words are not on the page")
        XCTAssertNotNil(waitForLabel(status, containing: ["Reading the answer"], timeout: 60),
                        "the answer was never read aloud: \(status.label)")
        attach(app, "hands-free-reading")

        // Read to its end, it listens again with no tap, and the next pause sends again.
        XCTAssertNotNil(waitForLabel(status, containing: ["Listening"], timeout: 60),
                        "it did not listen again after the answer: \(status.label)")
        attach(app, "hands-free-listening-again")
        // The first bubble scrolls out of the tree by now, so the second round is read
        // from the status line: the pause sends, then the new answer is read.
        XCTAssertNotNil(waitForLabel(status, containing: ["Sending", "Working"], timeout: 40),
                        "the second take was not sent on its own: \(status.label)")
        XCTAssertNotNil(waitForLabel(status, containing: ["Reading the answer"], timeout: 60),
                        "the second answer was never read aloud: \(status.label)")
        attach(app, "hands-free-second-round")

        // The keyboard leaves voice mode; nothing listens after that.
        element(app, "voiceMode.exit").tap()
        XCTAssertTrue(element(app, "chat.mic").waitForExistence(timeout: 10), "the composer did not come back")
        XCTAssertTrue(element(app, "composer.glass").exists, "the composer is not on glass with the experiment on")
        attach(app, "hands-free-glass-composer")
        element(app, "voiceAsk.close").tap()
    }
}
