import XCTest

/// A control drawn smaller than a finger keeps a 44 pt touch (standard.md "Sizes", iOS column),
/// as a real tap finds it: each case taps a point OUTSIDE the control's drawing (its accessibility
/// frame, which is the drawn frame) but inside the touch `.walnutTouchTarget()` gives it
/// (WalnutTouchTarget.swift), and asserts the control did its thing. One case per way the touch
/// is grown: a SwiftUI label's hit shape, a family style, a key inside a sideways scroll view, a
/// UIKit button over a drawn pill, and a key on a tight row whose reach stops at half the gap.
///
/// Every launch is in the in-app demo (`DemoMode`, `-walnut.deviceToken walnut-demo-token`): its
/// board, chats, threads and calendar live in the app's memory, so nothing here reaches a server.
///
/// The unit layer (WalnutTouchTargetTests) owns the arithmetic; the source guard
/// (tests/web/ios-ui-standard-ratchet.test.ts, "a control drawn under 44 pt keeps a 44 pt touch")
/// fails when a new small control skips the helper.
final class TouchTargetUITests: XCTestCase {
    private static let demoURL = "https://demo.walnut.invalid"
    private static let demoToken = "walnut-demo-token"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launchDemo() -> XCUIApplication {
        UITestLaunch.launch([
            UITestLaunch.serverURLArgument, Self.demoURL, "-walnut.deviceToken", Self.demoToken,
        ])
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    private enum Side { case above, below, left }

    /// Tap past the drawn edge of `control` on `side`, at the middle of that edge, `points` out.
    /// SwiftUI reports a plain Button's accessibility frame either as its drawing or as its whole
    /// hit shape (the calendar header read 44 x 44 on 2026-11-27, the composer's `+` its 32 pt
    /// circle), so the frame is read for what it is:
    /// - under 44 pt on that axis, it is the drawing: the tap lands `points` past its edge;
    /// - 44 pt or more, it is the grown touch itself: then `drawn` (the size the view draws on
    ///   that axis) must be given, and the tap lands `points` past the drawing measured from the
    ///   frame's centre (the reach is even on an axis with open room), still inside the frame.
    /// Either way the point is outside the drawing, so a pass proves a grown touch.
    private func tapOutside(_ control: XCUIElement, _ side: Side, by points: CGFloat, drawn: CGFloat? = nil,
                            in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(waitToMatch(control, "isHittable == true", timeout: 20),
                      "\(control.identifier) never became hittable", file: file, line: line)
        waitStill(control)
        let frame = control.frame
        let size = side == .left ? frame.width : frame.height
        let edge: CGFloat
        if size < 44 {
            switch side {
            case .above: edge = frame.minY
            case .below: edge = frame.maxY
            case .left: edge = frame.minX
            }
        } else {
            guard let drawn else {
                XCTFail("\(control.identifier) reports \(size) pt: give the size it draws", file: file, line: line)
                return
            }
            XCTAssertLessThan(drawn + 2 * points, size + 0.5,
                              "\(control.identifier): a tap \(points) pt past a \(drawn) pt drawing leaves its \(size) pt touch",
                              file: file, line: line)
            switch side {
            case .above: edge = frame.midY - drawn / 2
            case .below: edge = frame.midY + drawn / 2
            case .left: edge = frame.midX - drawn / 2
            }
        }
        let point: CGVector
        switch side {
        case .above: point = CGVector(dx: frame.midX, dy: edge - points)
        case .below: point = CGVector(dx: frame.midX, dy: edge + points)
        case .left: point = CGVector(dx: edge - points, dy: frame.midY)
        }
        print("[touch] \(control.identifier) frame \(frame), tap at \(point)")
        app.windows.firstMatch.coordinate(withNormalizedOffset: .zero).withOffset(point).tap()
    }

    /// How far past a drawing `size` pt tall (or wide) the touch reaches with nothing near it.
    private func openReach(_ size: CGFloat) -> CGFloat { max(0, (44 - size) / 2) }

    private func keepScreenshot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// The Tasks tab with its board drawer open.
    private func openBoard(_ app: XCUIApplication) {
        let tasks = app.tab(.tasks)
        XCTAssertTrue(tasks.waitForExistence(timeout: 60), "the demo never opened")
        tasks.tap()
        let scrim = element(app, "tasks.drawer.scrim")
        if !scrim.waitForExistence(timeout: 3) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "no board button on the Tasks page")
            menu.tap()
        }
        XCTAssertTrue(scrim.waitForExistence(timeout: 10), "the board drawer did not open")
        // The scrim is there from the first frame of the slide, and the launch's restore opens the
        // drawer by itself a beat after the tab shows: a header key tapped while the drawer still
        // moves loses its tap (CI run 46033978979: the calendar key's tap opened nothing, the
        // drawer open and still afterwards). The keys are tapped once the header holds still.
        XCTAssertTrue(waitStill(app.buttons["tasks.calendar"], timeout: 10), "the board drawer never held still")
    }

    /// Put the keyboard away (a pill's first tap with it up only does that, by design).
    private func keyboardDown(_ app: XCUIApplication, tapping control: XCUIElement) {
        guard app.keyboards.element.exists else { return }
        control.tap()
        XCTAssertTrue(app.keyboards.element.waitForNonExistence(timeout: 10), "the keyboard stayed up")
        waitStill(control)
    }

    // MARK: - Cases

    /// A 32 pt composer key (a plain SwiftUI Button whose label carries the helper): a tap 4 pt
    /// above its circle opens the `+` popover. Before the helper it hit nothing.
    func testThePlusKeyTakesATapAboveItsCircle() throws {
        let app = launchDemo()
        let chat = app.tab(.chat)
        XCTAssertTrue(chat.waitForExistence(timeout: 60), "the demo never opened")
        chat.tap()
        app.leaveChatPeerForTheChat()
        let plus = app.buttons["chat.plus"]
        XCTAssertTrue(plus.waitForExistence(timeout: 30), "no composer on the Chat tab")
        tapOutside(plus, .above, by: openReach(plus.frame.height) - 2, in: app)
        XCTAssertTrue(element(app, "chat.photo").waitForExistence(timeout: 10),
                      "a tap just above the + key did not open its menu")
        keepScreenshot("touch-plus-above")
    }

    /// The New Session page's row of picker keys, three ways a touch grows:
    /// - a quick folder chip (26 pt) inside a sideways scroll view, which hit-tests only inside its
    ///   own frame: a tap 7 pt under the chip picks that folder, so the grown scroll view works;
    /// - the mode pill (34 pt), a UIKit button over the drawn capsule (`WalnutTouchUIButton`), on a
    ///   wrapping row whose lines are 6 pt apart: its touch stops 3 pt out, and a tap 2 pt above
    ///   the capsule opens its menu;
    /// - the folder pill (26 pt), a SwiftUI picker key on the same row: a tap 2 pt above it opens
    ///   the folder picker.
    func testTheNewSessionKeysTakeATapPastTheirDrawing() throws {
        let app = launchDemo()
        openBoard(app)
        let plus = element(app, "sessions.new")
        XCTAssertTrue(plus.waitForExistence(timeout: 10), "no + on the board")
        plus.tap()
        XCTAssertTrue(app.navigationBars["New Session"].waitForExistence(timeout: 15), "+ did not open New Session")

        // A quick folder that is not the current one.
        let chips = app.buttons.matching(identifier: "newSessionChat.quickDir")
        XCTAssertTrue(chips.firstMatch.waitForExistence(timeout: 15), "the demo has no quick folders")
        let other = try XCTUnwrap(
            (0..<chips.count).map { chips.element(boundBy: $0) }.first { !$0.isSelected && $0.isHittable },
            "every quick folder is already the current one"
        )
        let name = other.label
        tapOutside(other, .below, by: 7, in: app)
        let picked = chips.matching(NSPredicate(format: "label == %@", name)).firstMatch
        XCTAssertTrue(waitToMatch(picked, "isSelected == true", timeout: 10),
                      "a tap 7 pt under the \(name) chip did not pick it")

        // The mode pill: with the keyboard up its first tap only puts the keyboard away.
        let mode = element(app, "newSessionChat.modePill")
        XCTAssertTrue(mode.waitForExistence(timeout: 10), "no mode pill on the page")
        keyboardDown(app, tapping: mode)
        tapOutside(mode, .above, by: 2, in: app)
        let modeRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'newSessionChat.mode.'")).firstMatch
        XCTAssertTrue(modeRow.waitForExistence(timeout: 10), "a tap 2 pt above the mode pill did not open its menu")
        keepScreenshot("touch-mode-pill-above")
        // Close the menu without picking (a tap on the page's title, away from every key).
        app.navigationBars["New Session"].staticTexts.firstMatch.tap()
        XCTAssertTrue(modeRow.waitForNonExistence(timeout: 10), "the mode menu did not close")

        let path = element(app, "newSessionChat.pathPill")
        XCTAssertTrue(path.waitForExistence(timeout: 10), "no folder pill on the page")
        tapOutside(path, .above, by: 2, in: app)
        XCTAssertTrue(element(app, "pathPicker.field").waitForExistence(timeout: 10),
                      "a tap 2 pt above the folder pill did not open the folder picker")
        keepScreenshot("touch-path-pill-above")
    }

    /// The empty Tasks page's New Session (its words alone, 18 pt drawn): its touch reaches 4 pt up
    /// toward Open Pins and the rest down, so a tap 10 pt under the words opens New Session.
    func testTheEmptyPagesNewSessionTakesATapUnderItsWords() throws {
        let app = launchDemo()
        openBoard(app)
        let scrim = element(app, "tasks.drawer.scrim")
        scrim.tap()
        XCTAssertTrue(scrim.waitForNonExistence(timeout: 10), "the board did not close")
        let newSession = element(app, "tasks.empty.newSession")
        guard newSession.waitForExistence(timeout: 10) else {
            throw XCTSkip("the demo's Tasks page opened a session, not the empty page")
        }
        tapOutside(newSession, .below, by: 10, in: app)
        XCTAssertTrue(app.navigationBars["New Session"].waitForExistence(timeout: 15),
                      "a tap 10 pt under New Session did not open it")
    }

    /// The calendar header, three keys 12 pt apart: the funnel (about 20 pt wide) takes its missing
    /// width on its left, where only the title is, and the add key reaches 6 pt each way.
    func testTheCalendarHeaderKeysTakeATapPastTheirDrawing() throws {
        let app = launchDemo()
        openBoard(app)
        let calendarButton = app.buttons["tasks.calendar"]
        XCTAssertTrue(calendarButton.waitForExistence(timeout: 10), "no calendar button on the board")
        calendarButton.tap()
        XCTAssertTrue(app.navigationBars["Calendar"].waitForExistence(timeout: 15), "the calendar did not open")

        let filter = element(app, "calendar.filterButton")
        XCTAssertTrue(filter.waitForExistence(timeout: 10), "no filter key in the header")
        // The funnel's reach is lopsided (most of it on its left), so a frame that is its whole
        // touch is tapped 4 pt inside its left edge: about 14 pt left of the drawing.
        if filter.frame.width >= 44 {
            print("[touch] calendar.filterButton frame \(filter.frame)")
            app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: filter.frame.minX + 4, dy: filter.frame.midY)).tap()
        } else {
            tapOutside(filter, .left, by: 10, in: app)
        }
        XCTAssertTrue(element(app, "calendar.filterSheet").waitForExistence(timeout: 10),
                      "a tap 10 pt left of the funnel did not open the filter")
        element(app, "calendar.filter.done").tap()
        XCTAssertTrue(element(app, "calendar.filterSheet").waitForNonExistence(timeout: 10), "the filter did not close")

        let add = element(app, "calendar.add")
        XCTAssertTrue(add.waitForExistence(timeout: 10), "no add key in the header")
        tapOutside(add, .above, by: openReach(32) - 2, drawn: 32, in: app)
        XCTAssertTrue(element(app, "calendar.create.title").waitForExistence(timeout: 10),
                      "a tap just above the add key did not open the create sheet")
        keepScreenshot("touch-calendar-add-above")
    }
}

/// The org's small keys, on `ChatPlaceFixtureServer` with `OrgThreadsFixture` (a loopback server
/// this runner hosts; the in-app demo has no org): the VP chat's bar (36 pt keys with 6 pt around
/// them) and a thread card's Snooze, the family's small tool (28 pt, `WalnutButtonStyle`, a system
/// Menu). Nothing here sends a message or writes a thread.
final class TouchTargetOrgUITests: ThreadPushUITestCase {
    override var shotPrefix: String { "touch" }

    /// The point `out` pt above a key drawn `drawn` pt tall; its frame is either the drawing or,
    /// 44 pt or more, the grown touch around it (see `TouchTargetUITests.tapOutside`).
    private func above(_ frame: CGRect, drawn: CGFloat, by out: CGFloat) -> CGVector {
        let top = frame.height < 44 ? frame.minY : frame.midY - drawn / 2
        return CGVector(dx: frame.midX, dy: top - out)
    }

    private func tap(_ point: CGVector) {
        app.windows.firstMatch.coordinate(withNormalizedOffset: .zero).withOffset(point).tap()
    }

    /// A tap 2 pt above Threads on the bar opens the VP's page; there, a tap 6 pt above Snooze
    /// opens its choices, so the style's reach works on a Menu too.
    func testTheOrgBarAndSnoozeTakeATapAboveTheirDrawing() throws {
        try launchToVPChat("bar")
        let threads = el("org.bar.threads")
        XCTAssertTrue(waitToMatch(threads, "isHittable == true", timeout: 20), "Threads on the bar is not hittable")
        waitStill(threads)
        print("[touch] org.bar.threads frame \(threads.frame)")
        tap(above(threads.frame, drawn: 36, by: 2))
        XCTAssertTrue(el("org.node.page").waitForExistence(timeout: 15),
                      "a tap 2 pt above Threads did not open the VP's page")
        XCTAssertTrue(cardTitle(ids[0]).waitForExistence(timeout: 20), "the page shows no threads")

        let snoozes = app.descendants(matching: .any).matching(identifier: "org.thread.snooze")
        XCTAssertTrue(snoozes.firstMatch.waitForExistence(timeout: 15), "no Snooze on the VP's open threads")
        let snooze = try XCTUnwrap((0..<snoozes.count).map { snoozes.element(boundBy: $0) }.first { $0.isHittable },
                                   "no Snooze on screen")
        waitStill(snooze)
        print("[touch] org.thread.snooze frame \(snooze.frame)")
        tap(above(snooze.frame, drawn: 28, by: 6))
        XCTAssertTrue(app.buttons["In 3 hours"].waitForExistence(timeout: 10),
                      "a tap 6 pt above Snooze did not open its choices")
        shot("snooze-above")
    }
}
