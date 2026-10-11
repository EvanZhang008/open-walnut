import XCTest

final class VoiceHistoryUITests: XCTestCase {
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", id)).firstMatch
    }

    private func tap(_ target: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(target.waitForExistence(timeout: 15))
        XCTAssertTrue(target.isEnabled)
        let frame = target.frame
        XCTAssertFalse(frame.isEmpty)
        XCTAssertTrue(app.windows.firstMatch.frame.contains(CGPoint(x: frame.midX, y: frame.midY)))
        app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
    }

    private func openHistory(_ app: XCUIApplication) {
        let notNow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Not Now"]
        if notNow.exists { notNow.tap() }
        if app.keyboards.firstMatch.exists {
            tap(element(app, "chat.menu"), in: app)
            tap(element(app, "chat.drawer.scrim"), in: app)
        }
        tap(app.tabBars.buttons["Settings"], in: app)
        let history = element(app, "settings.voiceHistory")
        for _ in 0..<8 {
            if history.exists, history.frame.midY > 116,
               history.frame.midY < app.tabBars.firstMatch.frame.minY - 24 { break }
            let window = app.windows.firstMatch
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.7))
                .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.3)))
        }
        tap(history, in: app)
        XCTAssertTrue(element(app, "voiceHistory.list").waitForExistence(timeout: 10))
    }

    private func launchArguments() -> [String] {
        guard let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
              let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"] else {
            XCTFail("An isolated server and test token are required")
            return []
        }
        return [UITestLaunch.serverURLArgument, server.replacingOccurrences(of: "https:/", with: "https://").replacingOccurrences(of: "https:///", with: "https://").replacingOccurrences(of: "http:/", with: "http://").replacingOccurrences(of: "http:///", with: "http://"), "-walnut.deviceToken", token]
    }

    @MainActor
    func testRecordedAudioAndTranscriptAreAvailableFromSettingsAfterRelaunch() throws {
        let app = UITestLaunch.launch(launchArguments())
        continueAfterFailure = false
        addUIInterruptionMonitor(withDescription: "System dictation") { alert in
            guard alert.buttons["Not Now"].exists else { return false }
            alert.buttons["Not Now"].tap()
            return true
        }
        tap(app.tabBars.buttons["Chat"], in: app)
        let microphone = element(app, "chat.mic")
        XCTAssertTrue(microphone.waitForExistence(timeout: 30))
        tap(microphone, in: app)
        let stop = element(app, "chat.voiceStop")
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2)
        tap(stop, in: app)
        XCTAssertTrue(microphone.waitForExistence(timeout: 90), "Transcription did not finish")
        openHistory(app)
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "voiceHistory.recording.")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The take disappeared from history")
        let recordingIdentifier = row.identifier
        tap(row, in: app)
        let transcript = element(app, "voiceHistory.transcript")
        XCTAssertTrue(transcript.waitForExistence(timeout: 15))
        let text = transcript.label
        XCTAssertFalse(text.isEmpty)
        XCTAssertTrue(element(app, "voiceHistory.exportAudio").exists)
        let copy = element(app, "voiceHistory.copy")
        for _ in 0..<35 {
            if copy.exists, copy.frame.midY > 116,
               copy.frame.midY < app.tabBars.firstMatch.frame.minY - 24 { break }
            app.swipeUp()
        }
        XCTAssertGreaterThan(copy.frame.midY, 116)
        XCTAssertLessThan(copy.frame.midY, app.tabBars.firstMatch.frame.minY - 24)
        tap(copy, in: app)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "voice-history-saved"
        shot.lifetime = .keepAlways
        add(shot)
        app.terminate()
        app.launch()
        openHistory(app)
        let restored = element(app, recordingIdentifier)
        XCTAssertTrue(restored.waitForExistence(timeout: 15))
        tap(restored, in: app)
        XCTAssertTrue(element(app, "voiceHistory.transcript").waitForExistence(timeout: 10))
        XCTAssertEqual(element(app, "voiceHistory.transcript").label, text)
        let play = element(app, "voiceHistory.play")
        XCTAssertTrue(play.isHittable)
        tap(play, in: app)
        XCTAssertTrue(play.waitForExistence(timeout: 5))
        let playing = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Stop Playback"), object: play)
        XCTAssertEqual(XCTWaiter.wait(for: [playing], timeout: 5), .completed)
        XCTAssertTrue(element(app, "voiceHistory.exportAudio").exists)
    }
}
