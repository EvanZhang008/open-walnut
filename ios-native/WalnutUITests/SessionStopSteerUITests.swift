import XCTest

/// Stop, "Interrupt & send" and the queue strip on a coding session's page, as a finger
/// drives them, against the demo server (answered inside the app, no network).
///
/// The demo's `Rebuild the search index` session is mid-turn from the first frame and its
/// turn runs until it is stopped or steered, so every case has a turn to act on without a
/// race. OPT-IN like the other demo tests: "Try the demo" saves the demo pairing over the
/// simulator's, so the run must say the app's data may be erased:
/// `TEST_RUNNER_WALNUT_UITEST_MAY_ERASE_APP_DATA=1 xcodebuild test ...`
final class SessionStopSteerUITests: XCTestCase {
    private static let demoURL = "https://demo.walnut.invalid"
    private static let optInVariable = "WALNUT_UITEST_MAY_ERASE_APP_DATA"

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment[Self.optInVariable] == "1",
            "The demo pairing replaces this simulator's; set TEST_RUNNER_\(Self.optInVariable)=1 to run it"
        )
    }

    // MARK: - Finding things

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier))
            .firstMatch
    }

    private func elements(_ app: XCUIApplication, beginningWith prefix: String) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
    }

    private func text(_ app: XCUIApplication, containing fragment: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", fragment))
            .firstMatch
    }

    // MARK: - Getting to the session

    /// The demo opened with the tab bar up, then the long-running session from a search hit.
    private func openLongSession() -> XCUIApplication {
        let app = UITestLaunch.launch([UITestLaunch.serverURLArgument, Self.demoURL])
        let tryDemo = app.buttons["setup.tryDemo"]
        if tryDemo.waitForExistence(timeout: 15) { tryDemo.tap() }
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "the demo never opened")
        let tasks = app.tabBars.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 20))
        let scrim = element(app, "tasks.drawer.scrim")
        // A tap on the tab bar right after the app opened can be lost: tap until the Tasks page answers.
        for _ in 0..<4 {
            tasks.tap()
            if scrim.waitForExistence(timeout: 3) || app.buttons["tasks.menu"].waitForExistence(timeout: 3) { break }
        }
        if !scrim.exists {
            app.buttons["tasks.menu"].tap()
            XCTAssertTrue(scrim.waitForExistence(timeout: 10), "the board drawer did not open")
        }
        let search = app.searchFields["Search tasks & sessions"]
        XCTAssertTrue(search.waitForExistence(timeout: 30), "no search on the board")
        search.tap()
        search.typeText("Rebuild the search")
        let hit = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Rebuild the search index")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 20), "no hit for the long session")
        hit.tap()
        XCTAssertTrue(app.buttons["session.menu"].waitForExistence(timeout: 20), "the hit opened no session")
        XCTAssertTrue(element(app, "chat.stop").waitForExistence(timeout: 20), "the turn is not running: no Stop")
        return app
    }

    private func type(_ words: String, in app: XCUIApplication) {
        let composer = element(app, "chat.composer")
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "no composer")
        composer.tap()
        composer.typeText(words)
    }

    /// Stop, tapped until the page says it is stopping: a Stop pressed in the instant after a
    /// send is ignored on purpose (the second tap of a double tap), so one more tap follows.
    private func tapStop(_ app: XCUIApplication) {
        let stop = element(app, "chat.stop")
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "no Stop to tap")
        for _ in 0..<4 {
            stop.tap()
            // Messages waiting in line: Stop asks first, because a Stop sets them aside.
            let confirm = app.alerts.buttons["Stop"]
            if confirm.waitForExistence(timeout: 1.5) { confirm.tap() }
            // Counted, never read: the button can vanish between a look at it and a read of its label.
            let anyStop = app.descendants(matching: .any).matching(identifier: "chat.stop")
            let stopping = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier == 'chat.stop' AND label == 'Stopping'"))
            let deadline = Date().addingTimeInterval(2)
            while Date() < deadline {
                if anyStop.count == 0 || stopping.count > 0 { return }
                usleep(100_000)
            }
        }
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    // MARK: - Stop

    func testStopEndsTheTurnAndKeepsTheSession() throws {
        let app = openLongSession()
        attach(app, "1-running")
        XCTAssertFalse(element(app, "session.interruptSend").exists, "nothing typed: nothing to interrupt with")
        tapStop(app)
        XCTAssertTrue(element(app, "chat.stop").waitForNonExistence(timeout: 20), "the turn did not stop")
        XCTAssertTrue(text(app, containing: "38 of 120 shards").waitForExistence(timeout: 10),
                      "what the turn had written is kept")
        XCTAssertTrue(text(app, containing: "stopped before it finished").waitForExistence(timeout: 10),
                      "Stop leaves a card saying the turn was stopped")
        attach(app, "2-stopped")
        // The session is alive: a new message starts a new turn.
        type("Carry on, please", in: app)
        element(app, "chat.send").tap()
        XCTAssertTrue(text(app, containing: "get oriented").waitForExistence(timeout: 30), "no reply after Stop")
    }

    // MARK: - The queue strip

    func testAWordSentWhileItRunsWaitsInTheStripAndCanBeEditedAndWithdrawn() throws {
        let app = openLongSession()
        type("Skip the slow shards", in: app)
        XCTAssertTrue(element(app, "session.interruptSend").waitForExistence(timeout: 5), "no Interrupt & send")
        element(app, "chat.send").tap()
        let strip = element(app, "session.queue.strip")
        XCTAssertTrue(strip.waitForExistence(timeout: 20), "the queued message is not listed")
        XCTAssertTrue(element(app, "session.queue.headline").label.contains("Waiting to go in"),
                      "the strip says when it goes out")
        XCTAssertFalse(element(app, "chat.queuedBadge").exists, "the message is listed once: no second copy in the conversation")
        XCTAssertTrue(text(app, containing: "Skip the slow shards").exists, "the strip shows the words")
        attach(app, "3-queued")
        let row = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("Skip the slow shards"))

        // Edit it.
        row.tap()
        let editor = element(app, "session.queue.edit.text")
        XCTAssertTrue(editor.waitForExistence(timeout: 10), "the queued message did not open")
        attach(app, "4-edit-sheet")
        editor.tap()
        editor.press(forDuration: 1.0)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        editor.typeText("Skip the shards older than a week")
        element(app, "session.queue.save").tap()
        XCTAssertTrue(element(app, "session.queue.edit.text").waitForNonExistence(timeout: 10), "Save left the sheet up")
        let edited = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(edited.waitForExistence(timeout: 10))
        XCTAssertTrue(edited.label.contains("older than a week"), "the strip does not show the edited words")

        // Withdraw it with the cross, take it back, withdraw it for good.
        elements(app, beginningWith: "session.queue.withdraw.").firstMatch.tap()
        XCTAssertTrue(element(app, "session.queue.undo").waitForExistence(timeout: 10), "no way to take it back")
        XCTAssertTrue(elements(app, beginningWith: "session.queue.row.").firstMatch.waitForNonExistence(timeout: 10),
                      "the withdrawn message is still listed")
        attach(app, "4b-withdrawn")
        element(app, "session.queue.undo").tap()
        let again = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(again.waitForExistence(timeout: 20), "Undo did not bring the message back")
        XCTAssertTrue(again.label.contains("older than a week"))
        elements(app, beginningWith: "session.queue.withdraw.").firstMatch.tap()
        XCTAssertTrue(again.waitForNonExistence(timeout: 10))
        XCTAssertFalse(text(app, containing: "older than a week").exists, "its words are still on the page")
    }

    // MARK: - A double tap on Send

    func testADoubleTapOnSendQueuesOnceAndDoesNotStopTheAgent() throws {
        let app = openLongSession()
        type("Check the thumbnails too", in: app)
        // The seat turns into Stop under the finger: the second tap must not reach it.
        element(app, "chat.send").doubleTap()
        let row = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the queued message is not listed")
        // The second tap landed on the seat the send turned into Stop: it must not have stopped anything.
        sleep(2)
        let stop = element(app, "chat.stop")
        XCTAssertTrue(stop.exists, "the turn was stopped by the second tap")
        XCTAssertEqual(stop.label, "Stop", "Stop is already in progress")
        XCTAssertEqual(elements(app, beginningWith: "session.queue.row.").count, 1, "the message was queued twice")
        attach(app, "8-double-tap")
    }

    func testADoubleTapOnTheCrossWithdrawsOnlyThatMessage() throws {
        let app = openLongSession()
        type("First waiting words", in: app)
        element(app, "chat.send").tap()
        XCTAssertTrue(elements(app, beginningWith: "session.queue.row.").firstMatch.waitForExistence(timeout: 20))
        type("Second waiting words", in: app)
        element(app, "chat.send").tap()
        let rows = elements(app, beginningWith: "session.queue.row.")
        let deadline = Date().addingTimeInterval(20)
        while rows.count < 2 && Date() < deadline { usleep(200_000) }
        XCTAssertEqual(rows.count, 2, "both messages wait in the strip")
        elements(app, beginningWith: "session.queue.withdraw.").firstMatch.doubleTap()
        sleep(2)
        XCTAssertEqual(rows.count, 1, "one double tap withdrew more than the message it touched")
        attach(app, "10-cross-double-tap")
    }

    func testADoubleTapOnUndoBringsBackOnlyThatMessage() throws {
        let app = openLongSession()
        type("First waiting words", in: app)
        element(app, "chat.send").tap()
        XCTAssertTrue(elements(app, beginningWith: "session.queue.row.").firstMatch.waitForExistence(timeout: 20))
        type("Second waiting words", in: app)
        element(app, "chat.send").tap()
        let rows = elements(app, beginningWith: "session.queue.row.")
        let deadline = Date().addingTimeInterval(20)
        while rows.count < 2 && Date() < deadline { usleep(200_000) }
        XCTAssertEqual(rows.count, 2)
        elements(app, beginningWith: "session.queue.withdraw.").element(boundBy: 1).tap()
        let undo = element(app, "session.queue.undo")
        XCTAssertTrue(undo.waitForExistence(timeout: 10))
        undo.doubleTap()
        sleep(3)
        XCTAssertEqual(rows.count, 2, "Undo, tapped twice, took another message with it or brought one back twice")
        XCTAssertTrue(rows.element(boundBy: 0).label.contains("First waiting words"))
        XCTAssertTrue(rows.element(boundBy: 1).label.contains("Second waiting words"))
        attach(app, "12-undo-double-tap")
    }

    func testTheRowsStayPutWhenTheOfferToUndoGoesAway() throws {
        let app = openLongSession()
        type("First waiting words", in: app)
        element(app, "chat.send").tap()
        XCTAssertTrue(elements(app, beginningWith: "session.queue.row.").firstMatch.waitForExistence(timeout: 20))
        type("Second waiting words", in: app)
        element(app, "chat.send").tap()
        let rows = elements(app, beginningWith: "session.queue.row.")
        let deadline = Date().addingTimeInterval(20)
        while rows.count < 2 && Date() < deadline { usleep(200_000) }
        XCTAssertEqual(rows.count, 2)
        elements(app, beginningWith: "session.queue.withdraw.").element(boundBy: 1).tap()
        let undo = element(app, "session.queue.undo")
        XCTAssertTrue(undo.waitForExistence(timeout: 10))
        let cross = elements(app, beginningWith: "session.queue.withdraw.").firstMatch
        let before = cross.frame
        // Undo's place and the cross must never be the same place: the cross does not move when
        // the offer lapses, so a second tap meant for Undo cannot withdraw the next message.
        XCTAssertTrue(undo.waitForNonExistence(timeout: 25), "the offer to undo never lapsed")
        XCTAssertEqual(cross.frame, before, "the rows moved when the offer to undo went away")
        XCTAssertEqual(rows.count, 1)
    }

    func testUndoPutsTheMessageBackWhereItWasAndKeepsTheOrder() throws {
        let app = openLongSession()
        type("First waiting words", in: app)
        element(app, "chat.send").tap()
        XCTAssertTrue(elements(app, beginningWith: "session.queue.row.").firstMatch.waitForExistence(timeout: 20))
        type("Second waiting words", in: app)
        element(app, "chat.send").tap()
        let rows = elements(app, beginningWith: "session.queue.row.")
        var deadline = Date().addingTimeInterval(20)
        while rows.count < 2 && Date() < deadline { usleep(200_000) }
        XCTAssertEqual(rows.count, 2)
        sleep(1)
        elements(app, beginningWith: "session.queue.withdraw.").firstMatch.tap()
        let undo = element(app, "session.queue.undo")
        XCTAssertTrue(undo.waitForExistence(timeout: 10))
        undo.tap()
        // Undo sends it again and the one behind it follows, so the line reads as before.
        deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if rows.count == 2, rows.element(boundBy: 0).label.contains("First waiting words"),
               rows.element(boundBy: 1).label.contains("Second waiting words") { break }
            usleep(300_000)
        }
        XCTAssertEqual(rows.count, 2)
        XCTAssertTrue(rows.element(boundBy: 0).label.contains("First waiting words"), "Undo changed the order")
        XCTAssertTrue(rows.element(boundBy: 1).label.contains("Second waiting words"))
        attach(app, "13-undo-keeps-order")
    }

    // MARK: - Stop with a message waiting

    func testStopSetsTheWaitingMessageAsideAndSendPutsItBack() throws {
        let app = openLongSession()
        type("Then check the archive", in: app)
        element(app, "chat.send").tap()
        let row = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the queued message is not listed")
        tapStop(app)
        XCTAssertTrue(element(app, "chat.stop").waitForNonExistence(timeout: 20), "the turn did not stop")
        let headline = element(app, "session.queue.headline")
        XCTAssertTrue(headline.waitForExistence(timeout: 20))
        let said = NSPredicate(format: "label CONTAINS[c] %@", "not sent")
        expectation(for: said, evaluatedWith: headline)
        waitForExpectations(timeout: 20)
        attach(app, "7-stopped-with-queue")
        let send = elements(app, beginningWith: "session.queue.send.").firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 10), "a set-aside message offers Send")
        send.tap()
        XCTAssertTrue(text(app, containing: "get oriented").waitForExistence(timeout: 30), "Send was not answered")
        XCTAssertTrue(element(app, "session.queue.strip").waitForNonExistence(timeout: 10))
    }

    func testASetAsideMessageCanBeCorrectedAndAnUnsavedCorrectionIsNotLostSilently() throws {
        let app = openLongSession()
        type("Then check the archive", in: app)
        element(app, "chat.send").tap()
        let row = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the queued message is not listed")
        tapStop(app)
        XCTAssertTrue(element(app, "chat.stop").waitForNonExistence(timeout: 20), "the turn did not stop")
        XCTAssertTrue(elements(app, beginningWith: "session.queue.send.").firstMatch.waitForExistence(timeout: 20),
                      "a set-aside message offers Send")
        row.tap()
        let editor = element(app, "session.queue.edit.text")
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertTrue(editor.isEnabled, "a message a Stop set aside can still be corrected")
        editor.tap()
        editor.press(forDuration: 1.0)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        editor.typeText("Then check the archive from last year")
        // Closing with words not saved asks before it throws them away.
        app.buttons["Close"].tap()
        let keep = app.buttons["Keep editing"]
        XCTAssertTrue(keep.waitForExistence(timeout: 5), "Close dropped the unsaved words without asking")
        attach(app, "9-discard-asked")
        keep.tap()
        element(app, "session.queue.save").tap()
        XCTAssertTrue(element(app, "session.queue.edit.text").waitForNonExistence(timeout: 10), "Save left the sheet up")
        let saved = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 10))
        XCTAssertTrue(saved.label.contains("from last year"), "the strip does not show the corrected words")
        elements(app, beginningWith: "session.queue.send.").firstMatch.tap()
        XCTAssertTrue(text(app, containing: "get oriented").waitForExistence(timeout: 30), "Send was not answered")
    }

    func testStopStaysWithinReachWhileADraftIsTyped() throws {
        let app = openLongSession()
        type("Half a thought", in: app)
        let chip = element(app, "session.stopWithDraft")
        XCTAssertTrue(chip.waitForExistence(timeout: 5), "typing a draft left no way to take the agent back")
        chip.tap()
        XCTAssertTrue(element(app, "chat.stop").waitForNonExistence(timeout: 20), "the turn did not stop")
        XCTAssertTrue(text(app, containing: "stopped before it finished").waitForExistence(timeout: 10))
        XCTAssertTrue((element(app, "chat.composer").value as? String ?? "").contains("Half a thought"),
                      "Stop threw the draft away")
    }

    func testStopWithAMessageWaitingAsksFirstAndKeepGoingChangesNothing() throws {
        let app = openLongSession()
        type("Then check the archive", in: app)
        element(app, "chat.send").tap()
        let row = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the queued message is not listed")
        sleep(3)
        element(app, "chat.stop").tap()
        let keep = app.alerts.buttons["Keep going"]
        XCTAssertTrue(keep.waitForExistence(timeout: 5), "Stop did not ask before setting a message aside")
        attach(app, "11-stop-asks")
        keep.tap()
        XCTAssertTrue(element(app, "chat.stop").waitForExistence(timeout: 5), "the turn was stopped anyway")
        XCTAssertEqual(element(app, "chat.stop").label, "Stop")
        XCTAssertTrue(row.exists, "the waiting message went away")
        XCTAssertTrue(element(app, "session.queue.headline").label.contains("Waiting to go in"))
    }

    // MARK: - Interrupt & send

    func testInterruptAndSendStopsTheTurnAndAnswersTheNewWords() throws {
        let app = openLongSession()
        type("Stop that and tell me what is done", in: app)
        let steer = element(app, "session.interruptSend")
        XCTAssertTrue(steer.waitForExistence(timeout: 5), "no Interrupt & send")
        attach(app, "5-interrupt-offered")
        steer.tap()
        XCTAssertTrue(text(app, containing: "get oriented").waitForExistence(timeout: 30),
                      "the new words were not answered")
        XCTAssertFalse(element(app, "session.queue.strip").exists, "an interrupting send waits in no queue")
        attach(app, "6-steered")
    }

    func testSendNowFromTheQueuedMessageInterruptsToo() throws {
        let app = openLongSession()
        type("Do the other thing first", in: app)
        element(app, "chat.send").tap()
        let row = elements(app, beginningWith: "session.queue.row.").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the queued message is not listed")
        row.tap()
        let sendNow = element(app, "session.queue.sendNow")
        XCTAssertTrue(sendNow.waitForExistence(timeout: 10), "no Send now in the sheet")
        XCTAssertTrue(sendNow.label.contains("Interrupt"), "a running turn: the button says it interrupts")
        sendNow.tap()
        XCTAssertTrue(text(app, containing: "get oriented").waitForExistence(timeout: 30), "Send now was not answered")
        XCTAssertTrue(element(app, "session.queue.strip").waitForNonExistence(timeout: 10))
    }
}
