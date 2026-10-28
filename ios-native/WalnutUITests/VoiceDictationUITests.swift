import XCTest

/// Walnut's mic beside the free-prose boxes (2026-10-25 ask: every box where a
/// person types a sentence or more gets the composer's mic). These check the mic
/// is there, where a finger expects it, and a full target; they never tap it,
/// because a tap asks for the microphone and records real audio.
final class VoiceDictationUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    private func all(_ identifier: String, in app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier))
    }

    /// The agent's question card (`-askq-harness`, the product card on a
    /// real-shape payload): every free-text answer has its own mic, to its right
    /// on the same line.
    func testEveryAskQuestionAnswerHasAMicBesideIt() {
        let app = UITestLaunch.launch(["-askq-harness"])
        let fields = all("session.askQuestion.other", in: app)
        XCTAssertTrue(fields.firstMatch.waitForExistence(timeout: 30), "the ask card should render")
        let mics = all("voice-mic.ask-question", in: app)
        XCTAssertTrue(mics.firstMatch.waitForExistence(timeout: 5), "the answer box has no mic")
        XCTAssertEqual(mics.count, fields.count, "one mic per free-text answer")

        let field = fields.element(boundBy: 0)
        let mic = mics.element(boundBy: 0)
        XCTAssertTrue(mic.isHittable, "the first answer's mic should be tappable")
        XCTAssertEqual(mic.label, "Voice input")
        XCTAssertGreaterThanOrEqual(mic.frame.minX, field.frame.maxX - 1, "the mic sits right of the field")
        XCTAssertLessThan(mic.frame.minY, field.frame.maxY, "the mic is on the field's line")
        XCTAssertGreaterThan(mic.frame.maxY, field.frame.minY, "the mic is on the field's line")
        XCTAssertGreaterThanOrEqual(mic.frame.width, 44, "the mic is a full finger target")
        XCTAssertGreaterThanOrEqual(mic.frame.height, 44, "the mic is a full finger target")

        // Typing still goes to the field, and the mic stays beside it.
        field.tap()
        field.typeText("Both")
        XCTAssertTrue(mic.waitForExistence(timeout: 5))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "ask-question-mic"
        shot.lifetime = .keepAlways
        add(shot)
    }

    // MARK: - Demo (answered inside the app; its transcription is a fixed sentence)

    /// What the demo's speech-to-text "hears", whatever the take holds.
    static let demoSentence = "Remind me to send the counter quotes to the contractor"

    /// OPT-IN like DemoModeUITests: "Try the demo" saves the demo pairing over
    /// this simulator's. The recording cases also need the simulator's
    /// microphone permission granted to the app (`simctl privacy grant microphone`).
    private func launchDemo() throws -> XCUIApplication {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment[DemoModeUITests.optInVariable] == "1",
            "Try the demo replaces this simulator's pairing; set TEST_RUNNER_\(DemoModeUITests.optInVariable)=1"
        )
        let app = UITestLaunch.launch([UITestLaunch.serverURLArgument, "https://demo.walnut.invalid"])
        let tryDemo = app.buttons["setup.tryDemo"]
        if tryDemo.waitForExistence(timeout: 15) { tryDemo.tap() }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60))
        return app
    }

    private func value(_ element: XCUIElement) -> String { (element.value as? String) ?? "" }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return condition()
    }

    /// Tap the mic, hold a short take, stop it.
    private func speak(_ app: XCUIApplication, box: String) {
        let mic = all("voice-mic.\(box)", in: app).firstMatch
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "no mic in \(box)")
        mic.tap()
        let stop = app.buttons["voice.\(box).voiceStop"]
        let error = all("voice.\(box).voiceError", in: app).firstMatch
        XCTAssertTrue(
            stop.waitForExistence(timeout: 15),
            "no recording row: \(error.exists ? error.label : "(no voice error shown)")"
        )
        XCTAssertTrue(app.buttons["voice.\(box).voiceCancel"].exists, "no cancel on the recording row")
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        stop.tap()
    }

    /// The task description editor: the mic sits under the text, and a take
    /// lands after the words already there with one space, and is not saved.
    /// The offline-grid task: a Focus row the board shows without scrolling or
    /// opening a folder.
    func testTaskDescriptionVoiceAppendsAfterTheText() throws {
        let app = try launchDemo()
        // The board lives in the Tasks drawer.
        app.tabBars.buttons["Tasks"].tap()
        let scrim = all("tasks.drawer.scrim", in: app).firstMatch
        if !scrim.waitForExistence(timeout: 3) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "no board button on the Tasks page")
            menu.tap()
        }
        let row = all("board.row.t-offline", in: app).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "the demo board should list the offline-grid task")
        row.press(forDuration: 1)
        app.buttons["Details, dates & priority"].tap()

        let edit = all("task.editDescription", in: app).firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 10))
        for _ in 0..<12 where !edit.isHittable { app.swipeUp(velocity: .slow) }
        edit.tap()

        let editor = all("task.descriptionEditor", in: app).firstMatch
        let mic = all("voice-mic.task-description", in: app).firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 10), "the description editor should open")
        XCTAssertTrue(mic.waitForExistence(timeout: 5), "the description editor has no mic")
        XCTAssertTrue(mic.isHittable)
        XCTAssertGreaterThanOrEqual(mic.frame.minY, editor.frame.maxY - 1, "the mic sits under the text")
        editor.tap()
        editor.typeText("Typed first")
        let before = value(editor)
        XCTAssertTrue(before.hasSuffix("Typed first"), "the editor reads: \(before)")

        speak(app, box: "task-description")
        XCTAssertTrue(
            waitUntil(timeout: 20) { self.value(editor).hasPrefix(before + " " + Self.demoSentence) },
            "the editor reads: \(value(editor))"
        )
        // Never saved by itself: the sheet is still open with Save to tap.
        XCTAssertTrue(app.buttons["task.descriptionEditor.save"].exists)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "task-description-voice"
        shot.lifetime = .keepAlways
        add(shot)
        app.navigationBars.buttons["Cancel"].tap()
    }

    /// A letter's decision note has its own mic, separate from the reply box:
    /// its words land only in the note, the reply's mic and the choices are off
    /// while it records, and nothing is sent.
    func testDecisionNoteVoiceWritesOnlyIntoTheNote() throws {
        let app = try launchDemo()
        app.tabBars.buttons["Inbox"].tap()
        let row = all("inbox.row.l-merge", in: app).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "the demo inbox should list the merge letter")
        row.tap()

        let note = all("inbox.letter.decisionNote", in: app).firstMatch
        let reply = all("inbox.letter.replyField", in: app).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 20), "the letter should offer a decision note")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        let replyBefore = value(reply)

        let mic = all("voice-mic.letter-decision", in: app).firstMatch
        XCTAssertTrue(mic.waitForExistence(timeout: 5), "the decision note has no mic")
        mic.tap()
        let stop = app.buttons["voice.letter-decision.voiceStop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 15), "no recording row for the decision note")
        XCTAssertFalse(app.buttons["inbox.letter.mic"].isEnabled, "the reply mic must be off while the note records")
        XCTAssertFalse(app.buttons["inbox.letter.action.merge"].isEnabled, "a choice must wait for the spoken note")
        // The note stays on screen while it records, and Stop is where a finger
        // can reach it (it used to replace the note and slide under the bar).
        XCTAssertTrue(note.exists, "the note must stay on screen while it records")
        XCTAssertTrue(stop.isHittable, "Stop must be reachable while the note records")
        let recording = XCTAttachment(screenshot: app.screenshot())
        recording.name = "decision-note-recording"
        recording.lifetime = .keepAlways
        add(recording)
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        stop.tap()

        XCTAssertTrue(
            waitUntil(timeout: 20) { self.value(note).hasPrefix(Self.demoSentence) },
            "the note reads: \(value(note))"
        )
        XCTAssertEqual(value(reply), replyBefore, "the decision take must not reach the reply box")
        XCTAssertTrue(app.buttons["inbox.letter.mic"].isEnabled, "the reply mic is back after the take")
        XCTAssertTrue(app.buttons["inbox.letter.action.merge"].isEnabled, "the choices are back after the take")
        XCTAssertFalse(all("inbox.letter.answered", in: app).firstMatch.exists, "nothing was chosen or sent")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "decision-note-voice"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
