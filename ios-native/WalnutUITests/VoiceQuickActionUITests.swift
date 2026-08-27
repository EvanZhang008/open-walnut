import XCTest

/// UI layer for the Home-screen voice Quick Action — the ONE hop no unit test and
/// no `simctl launch` can reach: whether SpringBoard actually renders the
/// "Voice to Walnut" item on a real long-press, and whether tapping it lands the
/// app on Chat with the mic already open.
///
/// Why this exists even though `VoiceQuickActionTests` already pins the plist
/// entry: the plist being right is necessary, not sufficient. Between the plist
/// and the microphone sit LaunchServices registration, SpringBoard's icon-state
/// cache, whichever UIKit callback the OS chooses for the app's current state,
/// the MainTabView tab switch, and the composer's consume guards. A typo test
/// cannot see any of that, and the earlier E2E (`-voice-quick-action`) enters
/// BELOW the delivery layer by design, so it cannot either.
///
/// XCUITest is the only automation that can drive SpringBoard safely: the
/// springboard app object is a first-class element query, so the long-press is
/// aimed at the real icon rather than at a screen coordinate (a blind coordinate
/// click on a shared desktop has landed in another app's window here before).
final class VoiceQuickActionUITests: XCTestCase {

    /// Exactly the Info.plist title. Duplicated as a literal on purpose: this
    /// test asserts what SPRINGBOARD renders, so reading the app's own constant
    /// would let a plist/constant drift pass by agreeing with itself.
    private let shortcutTitle = "Voice to Walnut"

    private var springboard: XCUIApplication {
        XCUIApplication(bundleIdentifier: "com.apple.springboard")
    }

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// SpringBoard must OFFER the item. This is the whole discoverability
    /// surface: if the menu doesn't list it, no amount of correct downstream
    /// code is reachable by a user.
    /// NOTE on the match: SpringBoard's accessibility label for a shortcut row is
    /// "<title>, <subtitle>", not the bare title, so this is a prefix check by
    /// necessity. An equality assertion here failed against a WORKING app — the
    /// kind of false alarm that gets a shipped feature "fixed".
    func testLongPressingTheAppIconOffersTheVoiceShortcut() throws {
        let menu = try openIconContextMenu()
        XCTAssertTrue(
            menu.contains { $0.hasPrefix(shortcutTitle) },
            "the long-press menu offered \(menu) — nothing starting with '\(shortcutTitle)', so the entry point is unreachable from the Home screen"
        )
    }

    /// Tapping the item must actually COLD-LAUNCH the app. This is the hop that
    /// carries `launchOptions[.shortcutItem]`, i.e. the real delivery path the
    /// `-voice-quick-action` E2E deliberately enters below.
    ///
    /// Scope note, and it is a real limitation: the assertion stops at "the app
    /// came to the foreground". XCUITest cannot query an app that SPRINGBOARD
    /// launched — it is not attached to the automation session, and reaching into
    /// it fails with "Lost connection to the application" (observed here, which
    /// is why the assertion is shaped this way rather than richer). What the app
    /// then DID with the shortcut is asserted where it is observable: the mic
    /// opening and the recording caption are covered by
    /// `ios-native/tests/voice/voice-quickaction-e2e.sh`, and the delivery path
    /// itself is greppable in the uploaded log as
    /// `voice: quick action armed {source: launch}`.
    func testTappingTheVoiceShortcutColdLaunchesTheApp() throws {
        let menu = try openIconContextMenu()
        try XCTSkipUnless(
            menu.contains { $0.hasPrefix(shortcutTitle) },
            "no '\(shortcutTitle)' item to tap — see testLongPressingTheAppIconOffersTheVoiceShortcut"
        )
        // Match by prefix for the same reason as above (the label carries the
        // subtitle), so this keeps working if the subtitle copy ever changes.
        springboard.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", shortcutTitle))
            .firstMatch
            .tap()

        let app = XCUIApplication(bundleIdentifier: "dev.openwalnut.ios")
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 30),
            "tapping '\(shortcutTitle)' did not bring the app to the foreground — the shortcut is listed but inert"
        )
    }

    /// WARM delivery, and the richest assertion in this file: the app is ALREADY
    /// RUNNING (backgrounded, sitting on a non-Chat tab), then the shortcut
    /// arrives. That path is `application(_:performActionFor:)` → the mailbox →
    /// `MainTabView`'s `onChange` tab switch → the composer's `onChange`, none of
    /// which the cold path exercises.
    ///
    /// This one CAN assert the microphone, unlike the cold test: the app is
    /// launched by XCUITest here, so it stays attached to the automation session
    /// across the background/foreground round trip. A SpringBoard-launched
    /// process is not attached, which is why the cold test stops at "foreground".
    func testWarmShortcutSwitchesToChatAndOpensTheMicrophone() throws {
        let app = XCUIApplication()
        app.launch()
        // Land on a NON-Chat tab. If the tab switch is broken, the composer never
        // appears, the mailbox is never consumed, and the mic never opens — which
        // is precisely the failure this asserts against.
        let settingsTab = app.buttons["Settings"].firstMatch
        if settingsTab.waitForExistence(timeout: 30) { settingsTab.tap() }
        // Background it WITHOUT killing it: this is what makes the delivery warm.
        // `terminateFirst: false` is the whole difference from the cold test.
        let menu = try openIconContextMenu(terminateFirst: false)
        try XCTSkipUnless(
            menu.contains { $0.hasPrefix(shortcutTitle) },
            "no '\(shortcutTitle)' item to tap — see testLongPressingTheAppIconOffersTheVoiceShortcut"
        )
        springboard.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", shortcutTitle))
            .firstMatch
            .tap()

        let caption = app.descendants(matching: .any)
            .matching(identifier: "chat.voiceRecordingCaption").firstMatch
        XCTAssertTrue(
            caption.waitForExistence(timeout: 30),
            "a warm shortcut didn't open the microphone — the app came forward with no recording row (tab switch or composer consume is broken)"
        )
        XCTAssertEqual(
            caption.label, "Recording — stop to send",
            "the mic opened but auto-send is NOT armed: this transcript would land in the draft instead of reaching the agent"
        )
        // Leave no hot mic behind for the next test / the next human.
        app.descendants(matching: .any)
            .matching(identifier: "chat.voiceCancel").firstMatch.tap()
    }

    // MARK: - Helpers

    /// Go Home, find the Walnut icon wherever it lives, and long-press it.
    /// Returns the resulting menu's item titles.
    ///
    /// `terminateFirst` selects the DELIVERY PATH under test and is the only
    /// difference between the cold and warm cases: `true` kills the process so
    /// the tap becomes a cold launch (`launchOptions[.shortcutItem]`), `false`
    /// leaves it backgrounded so the tap becomes
    /// `application(_:performActionFor:)`. Everything else about the gesture is
    /// identical, so neither case can pass on a different code path than it
    /// claims to test.
    ///
    /// `firstMatch` on `icons` is not enough: the same simulator carries a
    /// `WalnutUITests-Runner` icon whose label also begins with "Walnut", and
    /// long-pressing THAT produced a menu with no shortcuts — which reads
    /// exactly like the feature being broken.
    private func openIconContextMenu(terminateFirst: Bool = true) throws -> [String] {
        if terminateFirst { XCUIApplication().terminate() }
        let board = springboard
        // Two presses, not one: the first dismisses whatever is open (a context
        // menu left by an earlier test in this run, an app), the second returns
        // to the FIRST Home page. Without the reset, test order decided whether
        // the icon was reachable — the second test in this file skipped itself
        // because the first had left the Home screen paged over.
        XCUIDevice.shared.press(.home)
        XCUIDevice.shared.press(.home)
        let icon = board.icons.matching(NSPredicate(format: "label == %@", "Walnut")).firstMatch
        // The icon may be on a later Home page. Swipe until it is hittable.
        //
        // `exists` is NOT enough, and neither is `isHittable` alone: SpringBoard
        // reports an off-page icon as existing with a ZERO frame, and pressing
        // that fails with "Not hittable: Icon, {{0,0},{0,0}}" (seen here). A
        // non-empty frame is the only signal that the icon is really on screen.
        var pages = 0
        while !icon.exists || icon.frame.isEmpty || !icon.isHittable {
            guard pages < 5 else { break }
            board.swipeLeft()
            // Let the page-turn animation settle; a mid-flight frame is a lie.
            Thread.sleep(forTimeInterval: 1)
            pages += 1
        }
        try XCTSkipUnless(
            icon.waitForExistence(timeout: 10) && !icon.frame.isEmpty && icon.isHittable,
            "the Walnut icon isn't on any Home page of this simulator — install the app before running this test"
        )
        // Retry the press itself. A long-press on a Home icon is timing-sensitive
        // (too short = launch, too long = jiggle mode) and SpringBoard sometimes
        // swallows the first one right after a page swipe. Reading the menu once
        // and reporting "no shortcut" would blame the app for a gesture that
        // never landed — the exact false negative this file exists to avoid.
        for attempt in 0..<3 {
            // Re-check the frame immediately before EVERY press, not once above.
            // SpringBoard hands out a stale zero frame for a beat after a page
            // turn or a foreground transition, and pressing on that stale value
            // fails with "Not hittable: {{0,0},{0,0}}" — a flake that looks
            // exactly like a broken shortcut in the log.
            var settle = 0
            while (icon.frame.isEmpty || !icon.isHittable) && settle < 10 {
                Thread.sleep(forTimeInterval: 0.5)
                settle += 1
            }
            guard !icon.frame.isEmpty, icon.isHittable else { continue }
            icon.press(forDuration: 1.2)
            // "Edit Home Screen" is in EVERY icon context menu, so its presence
            // means the menu is up — independent of whether our item is there.
            if board.buttons["Edit Home Screen"].waitForExistence(timeout: 5) {
                return board.buttons.allElementsBoundByIndex.compactMap {
                    $0.exists ? $0.label : nil
                }
            }
            if attempt < 2 {
                // Whatever the press DID do (launched the app, entered jiggle
                // mode), get back to a plain Home screen before trying again.
                // In the WARM case this must NOT terminate: killing the process
                // here would silently convert the retry into a cold launch, and
                // the test would then pass while proving the wrong path.
                if terminateFirst { XCUIApplication().terminate() }
                XCUIDevice.shared.press(.home)
                XCUIDevice.shared.press(.home)
            }
        }
        XCTFail("the long-press never produced an icon context menu after 3 attempts — gesture problem, not a shortcut problem")
        return []
    }
}
