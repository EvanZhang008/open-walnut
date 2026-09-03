import XCTest

/// UI layer for the board row's DONE RING — the part no unit test can prove, because the
/// question is not what the code computes but what a finger can reach.
///
/// The ring used to be tapped through its glyph box, 34x30. Two things follow from that
/// and only a driven app can show either: the target is under the platform's 44pt
/// minimum, and because the box is top-aligned, the lower half of the ring's own column
/// on a two-line row belonged to nothing at all. It matters more here than on an ordinary
/// control because the ring's neighbour is not empty space — everything to its right
/// opens the session — so a thumb that misses the ring does not do nothing.
///
/// The pair of assertions is deliberate: the target has to be BIG (this file's first two
/// tests) and it has to be big WITHOUT MOVING ANYTHING (the third). Growing a tap area by
/// shoving the title sideways would pass the first and fail the design.
///
/// Why XCUITest and not a coordinate clicker on the Simulator's window: a mis-aimed
/// desktop click lands in whatever app is under it. XCUITest taps are scoped to this
/// app's own elements, which is the same reason the calendar and AskUserQuestion suites
/// use it.
final class BoardRingTapUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// The live app, paired through launch arguments only (nothing is persisted).
    ///
    /// `WALNUT_UITEST_SERVER` / `WALNUT_UITEST_TOKEN` come from the environment so no
    /// credential is ever written down in this repo. Without them the test SKIPS rather
    /// than failing: a machine with no paired server is not a regression.
    ///
    /// RUN IT WITH `ios-native/tests/ui/run-ui-tests.sh`, not with a bare `xcodebuild`.
    /// Exporting these two names in your shell does NOT work, and that dead end is why
    /// every test in this file skipped on every machine for its whole life — a
    /// permanently-skipping test being indistinguishable from a deleted one. xcodebuild
    /// does not pass the invoking shell's environment through to the XCUITest RUNNER
    /// process; the runner only ever sees variables written into the `.xctestrun`'s
    /// `EnvironmentVariables`. `TEST_RUNNER_WALNUT_UITEST_SERVER=…` is the documented way
    /// to put one there and is worth passing, but measured on Xcode 26 / iOS 26.0 it did
    /// not land even when given to `build-for-testing`, so the script verifies the
    /// `.xctestrun` and writes the variables in itself.
    ///
    /// Measured on the script's offline default (a dead port): the three geometry tests
    /// here PASS, because the board renders disk-cached rows with no server. The tap test
    /// still skips until `WALNUT_UITEST_ROW_ID` names a throwaway task the run owns —
    /// which is the point, since a stray tap there completes somebody's real task.
    private func launchPaired() throws -> XCUIApplication {
        guard
            let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
            let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"],
            !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip(
                "no pairing reached the test runner — run this through "
                    + "ios-native/tests/ui/run-ui-tests.sh (exporting WALNUT_UITEST_SERVER in "
                    + "your shell does not reach an XCUITest runner; it has to be in the "
                    + ".xctestrun, which the script guarantees)"
            )
        }
        let app = XCUIApplication()
        app.launchArguments = [
            "-walnut.serverUrl", server,
            "-walnut.deviceToken", token,
        ]
        app.launch()
        return app
    }

    /// Open the Tasks tab and wait for the board to have rows.
    private func board(_ app: XCUIApplication) throws -> XCUIElement {
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 30), "the tab bar never appeared")
        tasks.tap()
        let rings = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'board.ring.'"))
        let deadline = Date().addingTimeInterval(45)
        while rings.count == 0, Date() < deadline {
            _ = rings.firstMatch.waitForExistence(timeout: 2)
        }
        guard rings.count > 0 else { throw XCTSkip("the board had no rows to measure") }
        return rings.element(boundBy: 0)
    }

    // MARK: - The target

    func testTheRingsTapAreaIsAtLeastFortyFourPointsWide() throws {
        let app = try launchPaired()
        let ring = try board(app)
        XCTAssertGreaterThanOrEqual(
            ring.frame.width, 44,
            "the ring's hit area measured \(ring.frame.width)pt wide — it shipped at 34"
        )
    }

    func testTheRingOwnsItsWholeColumnAndNotJustTheTopOfIt() throws {
        let app = try launchPaired()
        let ring = try board(app)
        // The ROW is the text column (`board.row.<id>` is deliberately a sibling of the
        // ring, so automation cannot tap one and get the other). Its height is the row's,
        // and the ring has to cover it: a 30pt box at the top of a 60pt row leaves the
        // bottom half of the leading column dead.
        let rowId = ring.identifier.replacingOccurrences(of: "board.ring.", with: "board.row.")
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", rowId)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no row for ring \(ring.identifier)")
        XCTAssertGreaterThanOrEqual(
            ring.frame.height, row.frame.height - 1,
            "the ring covers \(ring.frame.height)pt of a \(row.frame.height)pt row"
        )
    }

    func testTheBiggerTargetDidNotPushTheTitleSideways() throws {
        let app = try launchPaired()
        let ring = try board(app)
        let rowId = ring.identifier.replacingOccurrences(of: "board.ring.", with: "board.row.")
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", rowId)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        // 28pt of ring column + 11pt of HStack spacing, measured from the ring's own
        // leading edge (which sits 6pt before the row's content origin). The literal is
        // the SHIPPED geometry: this is the assertion that fails if the target was grown
        // by spending layout instead of by spending the gap.
        let expectedTitleX = ring.frame.minX + 6 + 28 + 11
        XCTAssertEqual(
            row.frame.minX, expectedTitleX, accuracy: 1.5,
            "the title starts at \(row.frame.minX), not \(expectedTitleX) — the leading "
                + "column changed width, so the hairline and the band headings moved too"
        )
        // …and the two targets must not overlap, or which one a tap reaches is a SwiftUI
        // implementation detail rather than a decision anybody made.
        XCTAssertLessThanOrEqual(ring.frame.maxX, row.frame.minX)
    }

    // MARK: - …and it still toggles

    /// The tap has to land on a row the run OWNS.
    ///
    /// Both outcomes of getting this wrong are writes to a real board: a tap that reaches
    /// the ring completes somebody's task, and a tap that falls through to the text column
    /// opens — or STARTS — a session. So the caller creates a throwaway task, passes its
    /// id here, and deletes it afterwards; without an id the test skips.
    func testATapLowInTheRingsColumnTogglesDoneRatherThanOpeningTheSession() throws {
        guard let rowId = ProcessInfo.processInfo.environment["WALNUT_UITEST_ROW_ID"],
              !rowId.isEmpty
        else { throw XCTSkip("set WALNUT_UITEST_ROW_ID to a throwaway task this run owns") }
        guard let needle = ProcessInfo.processInfo.environment["WALNUT_UITEST_ROW_QUERY"],
              !needle.isEmpty
        else { throw XCTSkip("set WALNUT_UITEST_ROW_QUERY to find the throwaway row") }
        let app = try launchPaired()
        _ = try board(app)   // wait for the board to have rows at all

        // Narrow the board to the one row this run owns. A real board has ~140 pinned
        // tasks and a freshly pinned one lands at the FOOT of its band (`pin_order = max
        // + 1`), so it is a hundred rows below the fold — searching is how a person would
        // find it too.
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 15), "no search field on the board")
        search.tap()
        search.typeText(needle)

        let ring = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", "board.ring.\(rowId)")).firstMatch
        XCTAssertTrue(
            ring.waitForExistence(timeout: 30),
            "the throwaway task's row never appeared on the board"
        )
        let before = ring.label   // "Mark done" / "Reopen"

        // The point this test exists for: inside the NEW hit area and outside the old
        // 34x30 box — low in the column, where a two-line row used to have dead space.
        ring.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.85)).tap()

        // Two ways the ring can prove it was hit, and both are the SAME event: the label
        // flips ("Mark done" → "Reopen"), or the row folds out of its band because done
        // rows are hidden. Requiring only the label would fail on a board that folds.
        var reached = false
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if !ring.exists { reached = true; break }
            if ring.label != before { reached = true; break }
            usleep(300_000)
        }
        XCTAssertTrue(
            reached,
            "a tap at 85%/85% of the ring's column did nothing — before this change that "
                + "point was outside the 34x30 box and belonged to no control at all"
        )
        // …and it must not have fallen through to the text column, whose tap OPENS the
        // session (and starts one when the task has none). The board's own quick-add field
        // is the cheapest proof we are still on the board rather than in a conversation.
        XCTAssertTrue(
            app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier == 'tasks.quickAdd.field'"))
                .firstMatch.waitForExistence(timeout: 5),
            "the tap pushed a session — it reached the row instead of the ring"
        )
        // No restore here: the caller owns the throwaway task and deletes it. A UI-driven
        // undo would depend on the row still being visible, which fold-done makes false.
    }
}
