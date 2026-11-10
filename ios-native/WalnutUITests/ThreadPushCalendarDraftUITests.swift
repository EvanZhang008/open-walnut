import XCTest

/// A thread push while the calendar's create sheet holds what he has not added (2026-11-08 review,
/// round 3): the push closed the sheet and the typed title and the changed time were gone. The
/// sheet now holds the push while it differs from the slot it opened on; it says so, keeps his
/// words and choice, and the push goes once he closes it.
final class ThreadPushCalendarDraftUITests: ThreadPushUITestCase {

    override var shotPrefix: String { "C" }

    func testThreadPushKeepsAnUnsubmittedCalendarDraft() throws {
        try launchToVPChat("C")
        app.tabBars.buttons["Tasks"].tap()
        let calendarButton = app.buttons["tasks.calendar"]
        // The Tasks tab may open on the session he last opened there: Back to its board.
        for _ in 0..<3 where !calendarButton.waitForExistence(timeout: 5) {
            let named = app.navigationBars.buttons["BackButton"]
            if named.exists { named.tap() } else { app.navigationBars.buttons.element(boundBy: 0).tap() }
        }
        XCTAssertTrue(calendarButton.waitForExistence(timeout: 15), "no Calendar button on the Tasks tab")
        calendarButton.tap()

        // The day's timeline: a tap on empty time opens the create sheet on that slot.
        let timeline = el("calendar.timeline")
        if !timeline.waitForExistence(timeout: 20) {
            // Another view was left in front: the Day view, from the view menu.
            let menu = el("calendar.viewMenu")
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "the calendar shows no view menu")
            menu.tap()
            let day = app.buttons["Day"]
            if !day.waitForExistence(timeout: 5) { menu.tap() }
            day.tap()
        }
        XCTAssertTrue(timeline.waitForExistence(timeout: 20), "the calendar shows no timeline")
        let sheet = el("calendar.createSheet")
        for spot in [0.55, 0.7, 0.4] where !sheet.exists {
            timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: spot)).tap()
            _ = sheet.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "a tap on empty time opened no create sheet")

        // A unique title, and the slot changed to all day.
        let title = el("calendar.create.title")
        XCTAssertTrue(title.waitForExistence(timeout: 10), "the create sheet has no title field")
        title.tap()
        let words = "Dentist \(Int(Date().timeIntervalSince1970) % 100_000)"
        title.typeText(words)
        let allDay = app.switches["calendar.create.allDay"]
        XCTAssertTrue(allDay.waitForExistence(timeout: 5), "the create sheet has no all-day switch")
        let before = allDay.value as? String
        // The switch itself, at the row's trailing end (a tap on its label does not flip it).
        allDay.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertTrue(poll(5) { (allDay.value as? String) != before }, "the all-day switch did not change")
        let changed = allDay.value as? String
        shot("C-draft")

        push(ids[4])
        expectHeld("C")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(sheet.exists, "C: the push closed the create sheet he was filling in")
        XCTAssertEqual(title.value as? String, words, "C: his title changed under the push")
        XCTAssertEqual(allDay.value as? String, changed, "C: the changed time went back under the push")
        XCTAssertFalse(el("org.node.page").exists, "C: the page opened under the sheet")
        // The held line sits clear of the sheet's own buttons.
        let held = el("nav.held")
        let cancel = app.navigationBars.buttons["Cancel"]
        if cancel.exists {
            XCTAssertFalse(held.frame.intersects(cancel.frame), "C: the held line \(held.frame) covers Cancel \(cancel.frame)")
        }
        shot("C-held")

        // He closes it: the sheet goes, then the push, and the thread is drawn.
        XCTAssertTrue(cancel.waitForExistence(timeout: 5), "C: the create sheet has no Cancel")
        let closedAt = Date()
        cancel.tap()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 20), "C: Cancel left the create sheet up")
        expectRevealed(ids[4], "C-after-close", outline: true, since: closedAt)
        XCTAssertFalse(sheet.exists, "C: the create sheet is still up over the page")
    }
}
