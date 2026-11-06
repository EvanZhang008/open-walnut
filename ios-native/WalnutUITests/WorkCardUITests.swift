import XCTest

/// The lock-screen work card, end to end through real taps, on the demo's sample tasks (the
/// demo answers `GET /api/push/work-card` from them, so no network is reached):
///  - opening the app while tasks work starts the card: it is on the Home Screen's Dynamic
///    Island and on the lock screen, with the demo's numbers;
///  - a tap on the island opens the list it shows; the expanded island opens each count's own;
///  - a tap on a count on the lock screen opens that list, and the chips switch between the three;
///  - a row opens its task;
///  - Settings, Lock Screen, Work card off ends the card.
///
/// The app is pinned at the demo server with the demo's token as launch arguments, so it
/// saves no pairing and erases nothing on this simulator.
final class WorkCardUITests: XCTestCase {
    private static let demoArguments = [
        UITestLaunch.serverURLArgument, "https://demo.walnut.invalid", "-walnut.deviceToken", "walnut-demo-token",
    ]

    private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    private func labelled(_ app: XCUIApplication, _ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
    }

    /// One of the card's counts, "6 Working": the number and the name, so nothing else on
    /// SpringBoard that says "Working" is taken for it.
    private func count(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label MATCHES %@", "^[0-9]+ \(name)$")).firstMatch
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    @MainActor
    func testTheCardShowsOnTheLockScreenAndItsCountsOpenTheirLists() throws {
        let app = UITestLaunch.launch(Self.demoArguments)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "the demo never opened")
        // The controller reads the numbers when the app comes forward and starts the card.
        sleep(4)
        shot("1-app-open")

        // Home Screen: the card sits in the Dynamic Island, the app's mark and one count: Needs you.
        XCUIDevice.shared.press(.home)
        sleep(2)
        shot("2-dynamic-island")
        let island = count(springboard, "Needs you")
        XCTAssertTrue(island.waitForExistence(timeout: 10), "no work card in the Dynamic Island")
        let sheet = element(app, "workcard.sheet")

        // A tap on the island opens the list it shows.
        island.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "the island tap did not open Walnut")
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "the island tap opened no list")
        XCTAssertTrue(element(app, "workcard.sheet.chip.needs").isSelected, "the island opened another list than the one it shows")
        element(app, "workcard.sheet.done").tap()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))

        // Held, the island opens up with every count, each its own link.
        XCUIDevice.shared.press(.home)
        sleep(2)
        count(springboard, "Needs you").press(forDuration: 1.2)
        let expandedWorking = count(springboard, "Working")
        XCTAssertTrue(expandedWorking.waitForExistence(timeout: 5), "the island did not open up")
        sleep(1)
        shot("2b-island-expanded")
        expandedWorking.tap()
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "the expanded island's Working opened no list")
        XCTAssertTrue(element(app, "workcard.sheet.chip.working").isSelected, "Working on the island opened another list")
        element(app, "workcard.sheet.done").tap()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))

        // Lock screen: the full card with its three counts.
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        sleep(2)
        XCUIDevice.shared.press(.home)
        sleep(2)
        shot("3-lock-screen")
        let needs = count(springboard, "Needs you")
        XCTAssertTrue(needs.waitForExistence(timeout: 10), "no work card on the lock screen")
        XCTAssertTrue(count(springboard, "Completed").exists, "the lock-screen card has no Completed count")
        // The first card on a lock screen comes with iOS's own "Allow Live Activities" question.
        // Once another of Walnut's Live Activities (Talk to Walnut) was answered on this simulator,
        // "Allow" stays in the tree as the card's hidden swipe action: only a shown one is a question.
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 3), allow.isHittable {
            allow.tap()
            sleep(1)
            shot("3b-lock-screen-allowed")
        }

        // A tap on a count opens that list in the app: the tap itself, no link opened behind it.
        needs.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "the lock-screen tap did not open Walnut")
        XCTAssertTrue(sheet.waitForExistence(timeout: 15), "the lock-screen tap opened no list")
        let needsChip = element(app, "workcard.sheet.chip.needs")
        XCTAssertTrue(needsChip.waitForExistence(timeout: 5))
        XCTAssertTrue(needsChip.isSelected, "the Needs you link opened another list")
        XCTAssertTrue(element(app, "workcard.sheet.since").waitForExistence(timeout: 10), "no stretch line")
        XCTAssertTrue(element(app, "workcard.sheet.row").waitForExistence(timeout: 10), "Needs you shows no task")
        shot("4-needs-list")

        // The chips switch lists; Working has the demo's running tasks.
        element(app, "workcard.sheet.chip.working").tap()
        XCTAssertTrue(element(app, "workcard.sheet.chip.working").isSelected)
        XCTAssertTrue(element(app, "workcard.sheet.row").waitForExistence(timeout: 5), "Working shows no task")
        shot("5-working-list")
        element(app, "workcard.sheet.chip.completed").tap()
        XCTAssertTrue(element(app, "workcard.sheet.chip.completed").isSelected)
        shot("6-completed-list")

        // A row opens its task; finishing it there moves it from Working to Completed.
        element(app, "workcard.sheet.chip.working").tap()
        let workingBefore = element(app, "workcard.sheet.chip.working").label
        element(app, "workcard.sheet.row").tap()
        // A row opens the task's conversation; its title opens the task's page.
        let title = app.buttons["session.title"]
        let doneSegment = app.segmentedControls.buttons["Done"]
        let until = Date().addingTimeInterval(15)
        while !title.exists && !doneSegment.exists && Date() < until { usleep(250_000) }
        XCTAssertTrue(title.exists || doneSegment.exists, "the row did not open its task")
        shot("7-task-opened")
        // A task that never had a session opens its page at once.
        if title.exists { title.tap() }
        XCTAssertTrue(doneSegment.waitForExistence(timeout: 10), "the conversation's title did not open the task")
        doneSegment.tap()
        sleep(2)
        // Down off the task's page, then the conversation's own Done.
        app.swipeDown(velocity: .fast)
        let conversationDone = app.buttons["task.open.done"]
        if conversationDone.waitForExistence(timeout: 3) { conversationDone.tap() }
        let completedChip = element(app, "workcard.sheet.chip.completed")
        let moved = expectation(for: NSPredicate(format: "label BEGINSWITH '1 '"), evaluatedWith: completedChip)
        XCTAssertEqual(XCTWaiter().wait(for: [moved], timeout: 30), .completed, "the finished task is not under Completed")
        XCTAssertNotEqual(element(app, "workcard.sheet.chip.working").label, workingBefore, "Working did not go down")
        shot("7b-after-done")
        // ...and it is there, as a row, under Completed.
        completedChip.tap()
        XCTAssertTrue(element(app, "workcard.sheet.row").waitForExistence(timeout: 10), "Completed counts a task it does not list")
        shot("7b2-completed-row")

        // The card took the new numbers: Completed 1 on the lock screen, and that count opens Completed.
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        sleep(2)
        XCUIDevice.shared.press(.home)
        sleep(2)
        shot("7c-lock-screen-updated")
        let completedTile = count(springboard, "Completed")
        XCTAssertTrue(labelled(springboard, "1 Completed").waitForExistence(timeout: 10), "the card did not take the new numbers")
        completedTile.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "the Completed tap did not open Walnut")
        XCTAssertTrue(sheet.waitForExistence(timeout: 15))
        let completedNow = element(app, "workcard.sheet.chip.completed")
        XCTAssertTrue(completedNow.waitForExistence(timeout: 10))
        XCTAssertTrue(completedNow.isSelected, "Completed on the lock screen opened another list")

        // Off in Settings ends the card.
        let done = element(app, "workcard.sheet.done")
        if done.exists { done.tap() }
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10), "the list did not close")
        app.tabBars.buttons["Settings"].tap()
        let toggle = app.switches["settings.workCard"]
        for _ in 0..<12 where !toggle.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(toggle.isHittable, "no Work card switch in Settings")
        XCTAssertEqual(toggle.value as? String, "1", "the work card is on by default")
        shot("8-settings")
        toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()
        XCTAssertEqual(toggle.value as? String, "0")
        sleep(2)
        XCUIDevice.shared.press(.home)
        sleep(2)
        shot("9-card-off")
        XCTAssertFalse(count(springboard, "Needs you").exists, "the card is still in the Dynamic Island after turning it off")
        // ...nor on the lock screen.
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        sleep(2)
        XCUIDevice.shared.press(.home)
        sleep(2)
        shot("9b-lock-screen-off")
        XCTAssertFalse(count(springboard, "Completed").exists, "the card is still on the lock screen after turning it off")
        XCUIDevice.shared.press(.home)
        sleep(1)

        // Back on for whoever uses this simulator next.
        app.activate()
        let again = app.switches["settings.workCard"]
        XCTAssertTrue(again.waitForExistence(timeout: 10))
        again.switches.firstMatch.exists ? again.switches.firstMatch.tap() : again.tap()
    }
}
