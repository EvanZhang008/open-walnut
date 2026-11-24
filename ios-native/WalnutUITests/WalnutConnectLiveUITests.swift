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

        app.tab(.settings).tap()
        let row = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Walnut Connect")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "Settings does not say Walnut Connect")
        shot(app, "4-settings-walnut-connect")
    }

    /// iOS asks before an app reads what another app (the test runner) put on the pasteboard.
    private func allowPaste(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for button in [app.alerts.buttons["Allow Paste"], springboard.alerts.buttons["Allow Paste"], springboard.buttons["Allow Paste"]] {
            if button.waitForExistence(timeout: 3) { button.tap(); return }
        }
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
