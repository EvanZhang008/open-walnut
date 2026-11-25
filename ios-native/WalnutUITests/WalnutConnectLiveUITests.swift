import XCTest

/// Walnut Connect, live: the app pairs through the setup form with a console pairing link that
/// carries a Walnut Connect key, reaches a Walnut it has no address for (no Wi-Fi route, no
/// companion), and loads its board through the Rust library's encrypted stream.
///
/// Needs its own isolated server, and skips unless a run names one: `/tmp/walnut-connect-live.json` on the Mac
/// (or `WALNUT_CONNECT_LIVE` with the same JSON in the runner's environment):
/// `{"link": "wn://pair?...&connect=...", "port": 41234, "task": "a task title on that board"}`.
/// docs/reference/walnut-connect.md says how a run makes one (an ephemeral Walnut on a dev box).
final class WalnutConnectLiveUITests: XCTestCase {
    private struct Live: Decodable { let link: String; let port: Int; let task: String? }

    /// The isolated server this run names, or a skip.
    private func live() throws -> Live {
        let raw = ProcessInfo.processInfo.environment["WALNUT_CONNECT_LIVE"].map { Data($0.utf8) }
            ?? FileManager.default.contents(atPath: "/tmp/walnut-connect-live.json")
        guard let raw, let live = try? JSONDecoder().decode(Live.self, from: raw) else {
            throw XCTSkip("no live Walnut named (/tmp/walnut-connect-live.json)")
        }
        guard live.link.hasPrefix("wn://pair?"), live.link.contains("&connect="), (20_000..<60_000).contains(live.port) else {
            throw XCTSkip("the live file names no Walnut Connect pairing")
        }
        return live
    }

    override func setUpWithError() throws { continueAfterFailure = false }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    @MainActor func testPairsAndLoadsTheBoardOverWalnutConnect() throws {
        let live = try live()
        let origin = "http://127.0.0.1:\(live.port)"
        // The app's Walnut Connect port is the one the run names, so the pinned address is it.
        let app = UITestLaunch.launch([UITestLaunch.serverURLArgument, origin, "-walnut.connect.port", String(live.port)])
        let paste = app.buttons["Paste pairing link"]
        // Another UI test (or an earlier run of this one) may have left a token in the test
        // Keychain namespace: start unpaired.
        if !paste.waitForExistence(timeout: 10), app.tabBars.firstMatch.exists {
            disconnect(app, keepLogin: false)
        }
        XCTAssertTrue(paste.waitForExistence(timeout: 20), "no pairing screen")
        shot(app, "1-pairing-screen")

        UIPasteboard.general.string = live.link
        paste.tap()
        allowPaste(app)
        let token = app.secureTextFields["setup.token"]
        XCTAssertTrue(token.waitForExistence(timeout: 5))
        shot(app, "2-link-pasted")
        app.buttons["setup.connect"].tap()

        // Nothing else reaches this Walnut: the board loads only through Walnut Connect.
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 60), "pairing over Walnut Connect failed")
        app.tab(.tasks).tap()
        if let title = live.task {
            XCTAssertTrue(app.staticTexts[title].firstMatch.waitForExistence(timeout: 45), "the board did not load: no \(title)")
        }
        shot(app, "3-board-over-walnut-connect")

        // The Tasks drawer hides the tab bar while it is open: close it first.
        let scrim = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", "tasks.drawer.scrim")).firstMatch
        if scrim.exists {
            scrim.tap()
            _ = scrim.waitForNonExistence(timeout: 5)
        }
        XCTAssertTrue(app.tab(.settings).waitForExistence(timeout: 10), "no Settings tab")
        app.tab(.settings).tap()
        // The run pins the server address to the Walnut Connect port, and a pinned address is
        // the Custom route, so Settings names that port: only the library listens there.
        let row = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "127.0.0.1:\(live.port)")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "Settings does not name the Walnut Connect port")
        shot(app, "4-settings-walnut-connect")
    }

    /// iOS asks before an app reads what another app (the test runner) put on the pasteboard.
    /// The question is SpringBoard's, and the app is never asked about it: its main thread
    /// waits inside the pasteboard read until the answer, so any query of the app meanwhile
    /// times out its snapshot and fails the test (2026-11-25, the first live run on iOS 26.0).
    private func allowPaste(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            for button in [springboard.alerts.buttons["Allow Paste"], springboard.buttons["Allow Paste"]] where button.exists {
                button.tap()
                return
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
