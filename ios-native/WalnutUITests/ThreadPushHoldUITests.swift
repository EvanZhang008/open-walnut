import XCTest

/// A thread push tapped while a sheet holds his unsaved work (2026-11-08 review, round 2): the
/// push waits, the sheet says so, his words stay, and the view under the sheet is not torn down.
/// Once he closes the sheet the push goes, and the thread's outline is drawn then, not under it.
///
///  - T: a task's description being edited in a task session opened from the VP's page, then a
///    push for the same VP.
///  - U: the VP's Memory & instructions edited, then a push for another VP.
///  - V: a session note being written, then a push for the same VP and one for another VP.
///  - W: a Follow up sent, closed while its receipt is on its way, reopened and written again:
///    the late receipt keeps the newer words.
final class ThreadPushHoldUITests: ThreadPushUITestCase {

    override var answerDelay: (String, String) -> TimeInterval { OrgThreadsFixture.slowSend }
    override var shotPrefix: String { "H" }

    // MARK: - T. A task's description, same VP

    func testTADescriptionBeingEditedHoldsASameVPPush() throws {
        try openBarPage("T")
        segment("Tasks").tap()
        let row = el("org.tasks.row")
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the Tasks view lists no work")
        XCTAssertTrue(poll(5) { inView(row) }, "the task row is not in view: \(whereIs(row))")
        touch(row)
        XCTAssertTrue(el("task.open.done").waitForExistence(timeout: 20), "the task's session did not open")
        sessionMenu("session.taskDetails")
        let edit = el("task.editDescription")
        XCTAssertTrue(edit.waitForExistence(timeout: 15), "the task's details did not open")
        edit.tap()
        let editor = el("task.descriptionEditor")
        XCTAssertTrue(editor.waitForExistence(timeout: 10), "the description editor did not open")
        editor.tap()
        clear(editor)
        let words = "Words he is still writing"
        editor.typeText(words)
        shot("T-editing")

        push(ids[9])
        expectHeld("T")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(editor.exists, "T: the push closed the editor")
        XCTAssertEqual(editor.value as? String, words, "T: his words changed under the push")
        XCTAssertTrue(el("task.open.done").exists, "T: the task session under the editor was torn down")

        // He closes the editor: the push goes, and he sees the thread drawn.
        let closedAt = Date()
        app.navigationBars["Description"].buttons["Cancel"].tap()
        expectRevealed(ids[9], "T-after-close", outline: true, since: closedAt)
        XCTAssertTrue(el("task.open.done").waitForNonExistence(timeout: 10), "T: the task session stayed over the page")
    }

    // MARK: - U. Memory & instructions, another VP

    func testUInstructionsBeingEditedHoldAnotherVPsPush() throws {
        try launchToVPChat("U")
        sessionMenu("session.memoryInstructions")
        let field = el("agentMemory.instructions")
        XCTAssertTrue(field.waitForExistence(timeout: 15), "the instructions did not load")
        field.tap()
        let added = " Check the budget every Friday."
        field.typeText(added)
        shot("U-editing")

        push(ids2[2], task: vp2)
        expectHeld("U")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(field.exists, "U: the push closed the instructions")
        XCTAssertTrue((field.value as? String)?.contains("budget every Friday") == true,
                      "U: his edit changed under the push: \(field.value ?? "nil")")
        XCTAssertTrue(app.navigationBars["Core Instructions"].exists || el("agentMemory.cancel").exists,
                      "U: the sheet is not up")

        // He discards them: the push for the other VP goes.
        el("agentMemory.cancel").tap()
        let discard = app.buttons["Discard Changes"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5), "U: Cancel did not ask about his changes")
        let closedAt = Date()
        discard.tap()
        expectRevealed(ids2[2], "U-after-close", outline: true, since: closedAt)
        XCTAssertTrue(titled(OrgThreadsFixture.vp2Name).waitForExistence(timeout: 10), "U: not the other VP's page")
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 15), "U: Back did not reach a VP chat")
        XCTAssertTrue(titled("Design").waitForExistence(timeout: 5), "U: Back did not reach the other VP's chat")
    }

    // MARK: - V. A session note, same VP and another

    private func writeNote(_ words: String, _ step: String) -> XCUIElement {
        plusMenu("session.note")
        let field = el("session.noteField")
        XCTAssertTrue(field.waitForExistence(timeout: 15), "\(step): the note did not load")
        field.tap()
        clear(field)
        field.typeText(words)
        shot("\(step)-writing")
        return field
    }

    func testVANoteBeingWrittenHoldsPushesForEitherVP() throws {
        try launchToVPChat("V")
        var field = writeNote("Call the printer", "V-same")
        push(ids[3])
        expectHeld("V-same")
        XCTAssertEqual(field.value as? String, "Call the printer", "V: his note changed under the push")
        var closedAt = Date()
        app.navigationBars["Note"].buttons["Cancel"].tap()
        expectRevealed(ids[3], "V-same-after-close", outline: true, since: closedAt)

        // From the VP's chat again, a note and a push for the other VP.
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 15))
        field = writeNote("Ask about the venue", "V-other")
        push(ids2[1], task: vp2)
        expectHeld("V-other")
        XCTAssertEqual(field.value as? String, "Ask about the venue", "V: his note changed under the other VP's push")
        closedAt = Date()
        app.navigationBars["Note"].buttons["Cancel"].tap()
        expectRevealed(ids2[1], "V-other-after-close", outline: true, since: closedAt)
        XCTAssertTrue(titled(OrgThreadsFixture.vp2Name).waitForExistence(timeout: 10), "V: not the other VP's page")
    }

    // MARK: - W. A late Follow up receipt

    func testWALateReceiptKeepsTheNewerWords() throws {
        try openBarPage("W")
        let thread = ids[2]
        let follow = card(thread).buttons["org.thread.followUp"]
        XCTAssertTrue(follow.waitForExistence(timeout: 10))
        bringIntoView(follow)
        touch(follow)
        let input = el("org.thread.followUp.input")
        XCTAssertTrue(input.waitForExistence(timeout: 10), "W: Follow up opened no composer")
        input.tap()
        clear(input)
        input.typeText("First words")
        el("org.thread.followUp.send").tap()
        // On its way (the receipt takes `sendSeconds`): he closes the composer and leaves the page.
        app.navigationBars["Follow up"].buttons["Cancel"].tap()
        XCTAssertTrue(input.waitForNonExistence(timeout: 5))
        back()
        XCTAssertTrue(el("org.bar.threads").waitForExistence(timeout: 15))
        el("org.bar.threads").tap()
        XCTAssertTrue(card(thread).waitForExistence(timeout: 20), "W: the page did not open again")
        bringIntoView(follow)
        touch(follow)
        XCTAssertTrue(input.waitForExistence(timeout: 10), "W: Follow up did not open again")
        input.tap()
        clear(input)
        let newer = "Newer words after the send"
        input.typeText(newer)
        shot("W-newer")
        // Past the receipt of the first send.
        Thread.sleep(forTimeInterval: OrgThreadsFixture.sendSeconds + 2)
        XCTAssertTrue(input.exists, "W: the late receipt closed the composer he is writing in")
        XCTAssertEqual(input.value as? String, newer, "W: the late receipt took his newer words")
        shot("W-after-receipt")

        // Leave no draft behind.
        clear(input)
        app.navigationBars["Follow up"].buttons["Cancel"].tap()
    }
}
