import XCTest

/// An Org node's Tasks on the phone (2026-11-23, the user: "就显示一个名字", "working 是 automatically
/// collapsed ... 只有那个 needs you 是 default 是 show", "remve the time also"): Working starts
/// folded, and a row is its status circle and its name, with no line of what it does and no time.
final class OrgTasksRowsUITests: ThreadPushUITestCase {

    override var shotPrefix: String { "R" }

    func testWorkingStartsFoldedAndARowIsItsName() throws {
        try openBarPage("R")
        segment("Tasks").tap()
        let working = el("org.tasks.section.working")
        XCTAssertTrue(working.waitForExistence(timeout: 15), "the Tasks view has no Working section")
        XCTAssertEqual(working.value as? String, "Folded", "Working opens by default")
        XCTAssertFalse(titled(OrgThreadsFixture.workerTitle).exists, "a folded Working shows its rows")
        shot("tasks-folded")

        openWorkingSection()
        let row = app.buttons.matching(NSPredicate(format: "identifier == 'org.tasks.row' AND label CONTAINS %@", OrgThreadsFixture.workerTitle)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the worker's row is missing under Working")
        // Its name alone: not what it does now ("Writing the second draft"), not when it moved.
        XCTAssertFalse(row.label.contains("Writing the second draft"), "the row still says what it does: \(row.label)")
        XCTAssertNil(row.label.range(of: #"\b\d+\s?(m|h|d|min|hr)\b"#, options: .regularExpression), "the row still shows a time: \(row.label)")
        shot("tasks-working-open")
    }
}
