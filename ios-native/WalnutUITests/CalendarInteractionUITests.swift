import XCTest

/// UI layer (mock-gradient ladder, top rung) for the calendar's INTERACTION
/// contract — the parts no unit test can prove because they need real taps:
/// the view-switch menu, the month day → Day view drill-in, the week strip, and
/// the Today button. Each test launches the DEBUG calendar harness with an
/// explicit starting view (`-calendar-view`) and, where useful, an explicit
/// starting day (`-calendar-day`), so nothing depends on the wall clock beyond
/// "today exists".
///
/// Why XCUITest and not an outside-the-sandbox clicker: driving the Simulator's
/// macOS window by coordinate is unsafe on a shared desktop (a mis-aimed click
/// lands in whatever app is under it — that happened once here and completed a
/// real task in another app). XCUITest taps are scoped to this app's elements.
final class CalendarInteractionUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// Launch straight into the calendar harness.
    private func launch(view: String, day: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-calendar-harness", "-calendar-view", view]
        if let day { app.launchArguments += ["-calendar-day", day] }
        app.launch()
        return app
    }

    private func id(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    // MARK: - View switcher

    func testViewMenuOffersAllFourViewsAndSwitchesToTheChosenOne() {
        let app = launch(view: "day")
        let timeline = id("calendar.timeline", in: app)
        XCTAssertTrue(timeline.waitForExistence(timeout: 30), "day view should open on the timeline")

        let menu = id("calendar.viewMenu", in: app)
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        menu.tap()

        // All four Apple-parity entries are offered.
        for title in ["Day", "Multi-Day", "List", "Month"] {
            XCTAssertTrue(
                app.buttons[title].waitForExistence(timeout: 5),
                "view menu should offer \(title)"
            )
        }

        app.buttons["List"].tap()
        XCTAssertTrue(
            id("calendar.list", in: app).waitForExistence(timeout: 10),
            "choosing List should switch to the list view"
        )
    }

    func testSwitchingViewsKeepsTheSelectedDay() {
        // Open on a NON-today day, switch Day → Month, and the month must land
        // on that day's month (a view switch never loses your place in time).
        let app = launch(view: "day", day: "2026-08-20")
        XCTAssertTrue(id("calendar.timeline", in: app).waitForExistence(timeout: 30))
        XCTAssertTrue(id("calendar.strip.2026-08-20", in: app).exists)

        id("calendar.viewMenu", in: app).tap()
        app.buttons["Month"].tap()

        XCTAssertTrue(id("calendar.grid", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(
            id("calendar.day.2026-08-20", in: app).waitForExistence(timeout: 10),
            "the month should show the month of the day we came from"
        )
    }

    // MARK: - Month → Day drill-in

    func testTappingAMonthDayTwiceDrillsIntoThatDaysDayView() {
        let app = launch(view: "month", day: "2026-08-18")
        XCTAssertTrue(id("calendar.grid", in: app).waitForExistence(timeout: 30))

        let cell = id("calendar.day.2026-08-20", in: app)
        XCTAssertTrue(cell.waitForExistence(timeout: 10))
        // First tap previews the day below the grid (a mis-tap is not navigation).
        cell.tap()
        XCTAssertTrue(id("calendar.agenda", in: app).exists)
        // Second tap on the SAME day commits: Day view for that day.
        cell.tap()

        XCTAssertTrue(
            id("calendar.timeline", in: app).waitForExistence(timeout: 10),
            "the second tap should drill into the Day view"
        )
        XCTAssertTrue(
            id("calendar.strip.2026-08-20", in: app).waitForExistence(timeout: 10),
            "the drilled-in day should be the one tapped"
        )
    }

    // MARK: - Week strip

    func testTappingTheWeekStripSelectsThatDayWithoutLeavingTheView() {
        let app = launch(view: "day", day: "2026-08-18")
        XCTAssertTrue(id("calendar.timeline", in: app).waitForExistence(timeout: 30))

        let friday = id("calendar.strip.2026-08-21", in: app)
        XCTAssertTrue(friday.waitForExistence(timeout: 10))
        friday.tap()

        // Still the timeline (the view didn't change), now on the tapped day.
        XCTAssertTrue(id("calendar.timeline", in: app).exists)
        XCTAssertTrue(app.staticTexts["August 21"].waitForExistence(timeout: 10))
    }

    // MARK: - Today

    func testTodayButtonReturnsToTodayFromAnotherDay() {
        // Open two days out, then tap Today: the now-line (which only renders on
        // today) coming back is the proof.
        let app = launch(view: "day", day: "2026-08-20")
        XCTAssertTrue(id("calendar.timeline", in: app).waitForExistence(timeout: 30))
        XCTAssertFalse(id("calendar.nowLine", in: app).exists, "no now-line on a non-today column")

        let today = id("calendar.today", in: app)
        XCTAssertTrue(today.waitForExistence(timeout: 10))
        today.tap()

        XCTAssertTrue(
            id("calendar.nowLine", in: app).waitForExistence(timeout: 10),
            "Today should bring back the current-time line"
        )
    }

    func testTodayButtonExistsInEveryView() {
        for view in ["day", "multiday", "list", "month"] {
            let app = launch(view: view)
            XCTAssertTrue(
                id("calendar.today", in: app).waitForExistence(timeout: 30),
                "the Today control must be reachable in the \(view) view"
            )
            app.terminate()
        }
    }

    // MARK: - Persistence

    func testChosenViewIsRememberedAcrossRelaunch() {
        // Pick List through the menu (which writes the preference), relaunch
        // WITHOUT a forced view, and the list must come back.
        let app = launch(view: "day")
        XCTAssertTrue(id("calendar.timeline", in: app).waitForExistence(timeout: 30))
        id("calendar.viewMenu", in: app).tap()
        app.buttons["List"].tap()
        XCTAssertTrue(id("calendar.list", in: app).waitForExistence(timeout: 10))
        app.terminate()

        let relaunched = XCUIApplication()
        relaunched.launchArguments = ["-calendar-harness"] // no forced view
        relaunched.launch()
        XCTAssertTrue(
            id("calendar.list", in: relaunched).waitForExistence(timeout: 30),
            "the remembered view should be restored on the next open"
        )
    }
}
