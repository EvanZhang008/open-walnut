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
///
/// STILL MANUAL, and worth being honest about: this all runs on the SIMULATOR.
/// Which UIKit callback a REAL DEVICE picks for a warm shortcut has never been
/// verified on hardware. One long-press on a real phone settles it, and the
/// instrumentation added alongside these tests is what makes that one gesture
/// conclusive rather than anecdotal: the uploaded log carries a
/// `voice: quick action delivery {hook: …}` line for every hook the OS ran, so
/// `grep 'quick action delivery'` answers it after the fact.
///
/// HOW TO RUN — one line, and please use it rather than a bare `xcodebuild`:
///
///     ios-native/tests/ui/run-ui-tests.sh \
///       -only-testing:WalnutUITests/VoiceQuickActionUITests
///
/// The script arranges the two preconditions this file cannot arrange for
/// itself, both of which were silently unmet for its whole life:
///
///  1. **A PAIRED app** — needed by the warm test only. Everything it drives
///     (the tab bar, ChatView, the composer that owns the mic) lives behind
///     `AppConfig.isConfigured`; an unpaired launch renders `SetupView` and
///     nothing else. Pairing rides LAUNCH ARGUMENTS, never the Keychain and
///     never the setup form, from `WALNUT_UITEST_SERVER` +
///     `WALNUT_UITEST_TOKEN`. With them absent the test SKIPS — a machine with
///     no paired server is not a regression.
///
///     ⚠️ EXPORTING THOSE TWO NAMES IN YOUR SHELL DOES NOT WORK. xcodebuild does
///     not pass the invoking shell's environment through to the XCUITest RUNNER
///     process, so the guard below never saw them and every run skipped —
///     indistinguishable from the tests having been deleted. The runner only
///     ever sees variables written into the `.xctestrun`'s
///     `EnvironmentVariables`. `TEST_RUNNER_WALNUT_UITEST_SERVER=…` is the
///     documented way to put one there, but it is not reliable and must not be
///     trusted: measured on Xcode 26 / iOS 26.0, given to `build-for-testing`
///     (the step that generates the file) on a clean derived-data tree, it did
///     NOT land and the run skipped anyway. xcodebuild echoes the setting back
///     either way, which is how it has been mis-reported as working twice. The
///     script therefore verifies the `.xctestrun` with `plutil` and writes the
///     variables in itself when they are missing — the verification is the part
///     that keeps this from rotting back into folklore.
///
///     The server need not be REACHABLE, which is why the script defaults to a
///     dead port: a transport error is inconclusive to `ConnectionStore` so the
///     app stays paired, and the caption assertion below already accepts the
///     offline caption. An unreachable URL therefore exercises this whole
///     delivery path without touching anybody's data.
///  2. **MICROPHONE permission** — the script grants it, the same way the
///     sibling E2E does (`ios-native/tests/voice/voice-quickaction-e2e.sh`):
///
///         xcrun simctl privacy <udid> grant microphone dev.openwalnut.ios
///
///     A denied mic produces no recording row, i.e. the warm test fails for a
///     reason that has nothing to do with the Home-screen shortcut.
///
/// History worth keeping, because it is the reason the precondition below is an
/// assertion instead of a wait: the warm test used to call a bare
/// `app.launch()`. The app booted UNPAIRED into `SetupView` — no tab bar, no
/// ChatView, no ComposerBar, nothing in the process that could consume the
/// pending action — and then spent 194s failing: 30s waiting for a `Settings`
/// button a tab-less screen will never show, ~128s of long-press retries, and a
/// 30s caption wait. It read as a product regression in the warm delivery chain,
/// which field logs had already proven working. A test that burns 160 more
/// seconds after its precondition has already failed is a bad test even when its
/// verdict is right.
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
        let app = try launchPaired()
        // PRECONDITION, asserted the moment the app is up rather than implied by
        // a 30s wait 20 lines further down. `continueAfterFailure = false` means
        // this ENDS the test: the remaining ~160s of long-press retries and
        // caption waits cannot discover anything once the surface under test does
        // not exist.
        let tabBar = app.tabBars.firstMatch
        let settingsTab = app.buttons["Settings"].firstMatch
        XCTAssertTrue(
            tabBar.waitForExistence(timeout: 15) || settingsTab.waitForExistence(timeout: 5),
            "no tab bar 15s after launch: the app booted UNPAIRED into SetupView, so there is "
                + "no ChatView and no ComposerBar in this process to consume a quick action. "
                + "That is a harness problem (see this file's HOW TO RUN), not a regression in "
                + "the warm delivery chain."
        )
        // Land on a NON-Chat tab. If the tab switch is broken, the composer never
        // appears, the mailbox is never consumed, and the mic never opens — which
        // is precisely the failure this asserts against.
        XCTAssertTrue(
            settingsTab.waitForExistence(timeout: 10),
            "the tab bar is up but carries no Settings tab to park on"
        )
        settingsTab.tap()
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
            "a warm shortcut didn't open the microphone — the app came forward with no recording "
                + "row. Either the tab switch / composer consume is broken, or this simulator has "
                + "never been granted mic permission: xcrun simctl privacy <udid> grant "
                + "microphone dev.openwalnut.ios"
        )
        // The caption is a PROMISE about where the transcript goes, and it depends
        // on something this test does not control: whether the simulator is paired
        // to a reachable server. Offline is now a legitimate outcome (recording
        // offline is the D1 fix), and it deliberately reads as the plain caption
        // because promising a send the app cannot make is the lie that fix removed.
        // So the assertion is "one of the two honest captions" — pinning only the
        // armed one made this test fail on a WORKING app whose server was simply
        // down, which is the false alarm that gets shipped features "fixed".
        //
        // The claim that actually matters (a real Home-screen delivery reached the
        // composer) is asserted below, from the accessibility value, and it holds
        // in both states.
        XCTAssertTrue(
            ["Recording — stop to send", "Recording…"].contains(caption.label),
            "the recording caption read '\(caption.label)' — neither of the two captions the composer can honestly show, so the arming/offline logic has drifted"
        )
        // WHICH callback delivered it — the assertion this file was missing.
        //
        // "The mic opened" is not the claim worth making: it is equally true of
        // the DEBUG launch argument, which enters below the delivery layer by
        // design and therefore proves nothing about the Home screen. The caption
        // publishes the consumed request's `source` as its accessibility VALUE
        // (`VoiceQuickAction.lastConsumedSource`), so the delivery path is
        // assertable from out here for the first time.
        //
        // A SET, not one value, and the set is the point: `scene-perform` means
        // our own scene delegate won the race against SwiftUI's, `app-perform`
        // means we fell back to the application-level callback (correct on an OS
        // whose SwiftUI lacks the scene hook). Either is a genuine warm delivery.
        // `launch` would mean this test silently became a COLD test (the process
        // was killed somewhere), and `debug-arg`/`mic-button` would mean it is
        // not exercising the shortcut at all — each a false pass worth failing on.
        let source = caption.value as? String ?? ""
        XCTAssertTrue(
            ["scene-perform", "app-perform"].contains(source),
            "warm delivery reported source '\(source)' — expected scene-perform (our scene delegate) or app-perform (the fallback). 'launch' means this ran cold, 'mic-button' means no quick action reached the composer at all."
        )
        // Leave no hot mic behind for the next test / the next human.
        app.descendants(matching: .any)
            .matching(identifier: "chat.voiceCancel").firstMatch.tap()
    }

    // MARK: - Helpers

    /// Launch the app PAIRED, through launch arguments only — nothing is written
    /// to the Keychain and no credential is written down in this repo.
    ///
    /// Same mechanism and same skip policy as `BoardRingTapUITests.launchPaired`,
    /// deliberately: there is one way to pair a UI test in this repo and adding a
    /// second one would mean two things to keep working. How to actually get
    /// these variables to the runner is in this file's HOW TO RUN — the short
    /// version is `ios-native/tests/ui/run-ui-tests.sh`, because a shell `export`
    /// does not reach an XCUITest runner.
    ///
    /// Only the WARM test needs this. The two SpringBoard tests do not: one reads
    /// the long-press menu without launching anything, and the other asserts only
    /// that the tap brought the app to the foreground, which an unpaired app
    /// sitting on `SetupView` does just as well.
    private func launchPaired() throws -> XCUIApplication {
        guard
            let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
            let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"],
            !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip(
                "no pairing reached the test runner, so the warm delivery layer cannot run — "
                    + "unpaired, the app renders SetupView and there is no composer to consume a "
                    + "quick action. Run this through ios-native/tests/ui/run-ui-tests.sh; "
                    + "exporting WALNUT_UITEST_SERVER in your shell does NOT reach an XCUITest "
                    + "runner (it has to be in the .xctestrun)."
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
