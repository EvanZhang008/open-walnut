import XCTest

/// Disconnect keeps the login: the pairing screen lists it and one tap signs in again, no QR
/// code (2026-11-18, "if I disconnect, I have to scan the qr code again, can it remember all
/// login"). Forget Login deletes it; a server that removed the phone is said so, once per tap.
/// Paired to a loopback fixture the runner hosts (`ChatPlaceFixtureServer`), through the setup
/// form, as a person pairs.
final class SavedLoginsUITests: XCTestCase {
    private var fixture: ChatPlaceFixtureServer?
    /// The fixture refuses every request with 401 while set: the console's Remove.
    private let removed = Flag()

    override func setUpWithError() throws {
        continueAfterFailure = false
        let server = try ChatPlaceFixtureServer()
        let removed = self.removed
        server.extraRoute = { _, path in
            // A current server names itself without a token: that is what makes its refusal
            // a verdict on this phone, not a stranger's.
            if path == "/api/v1/instance" { return (200, ["instance": "fixture-walnut", "mode": "LIVE"]) }
            // `/instance` answers without a token, as on a real server: a removed phone
            // still learns who is there, and only then hears its token refused.
            return removed.value && path.hasPrefix("/api/v1") ? (401, ["error": "unauthorized"]) : nil
        }
        try server.start()
        fixture = server
    }

    override func tearDown() {
        fixture?.stop()
        fixture = nil
        super.tearDown()
    }

    private let token = "saved-login-fixture"

    func testDisconnectReconnectRemovedAndForget() throws {
        let server = try XCTUnwrap(fixture).url
        var app = UITestLaunch.launch([UITestLaunch.serverURLArgument, server])
        // Another UI test may have left a token in the test Keychain namespace: start unpaired.
        if !app.textFields["setup.serverURL"].waitForExistence(timeout: 10), app.tabBars.firstMatch.exists {
            disconnect(app, keepLogin: false)
        }
        pairThroughTheForm(app, server: server)

        // 1. Disconnect keeps the login.
        disconnect(app, keepLogin: true)
        let row = app.buttons["setup.savedLogin"].firstMatch
        // At once, with the pairing screen: a list that fills in late reads as lost (2026-11-18).
        XCTAssertTrue(row.waitForExistence(timeout: 1), "Disconnect did not keep the login, or it showed late")
        XCTAssertTrue(row.label.contains("127.0.0.1"), "the row names the Walnut: \(row.label)")

        // 2. It outlives a relaunch (the erase must keep the install marker). Home first, as a
        // person leaves an app before swiping it away: the preferences reach disk on the way
        // out, where a kill straight after the tap could lose the last writes.
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        app.terminate()
        app = UITestLaunch.launch([
            UITestLaunch.serverURLArgument, server, UITestLaunch.keepSavedLoginsArgument, "YES",
        ])
        XCTAssertTrue(app.buttons["setup.savedLogin"].firstMatch.waitForExistence(timeout: 20),
                      "the saved login did not survive a relaunch")

        // 3. One tap reconnects, no token typed.
        app.buttons["setup.savedLogin"].firstMatch.tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 30), "the tap did not reconnect")

        // 4. The console removed the phone: the tap says so and the row is marked.
        disconnect(app, keepLogin: true)
        removed.value = true
        let again = app.buttons["setup.savedLogin"].firstMatch
        XCTAssertTrue(again.waitForExistence(timeout: 15))
        again.tap()
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 30), "a refused login said nothing")
        XCTAssertTrue(alert.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "was removed from")).firstMatch.exists)
        alert.buttons["OK"].tap()
        XCTAssertTrue(app.buttons["setup.savedLogin"].firstMatch.label.contains("Removed from this Walnut"),
                      "the row does not say the phone was removed")
        XCTAssertFalse(app.tabBars.firstMatch.exists, "a refused login must not sign in")

        // 5. Forget Login deletes it.
        app.buttons["setup.savedLogin.menu"].firstMatch.tap()
        let forget = app.buttons["setup.savedLogin.forget"].firstMatch
        XCTAssertTrue(forget.waitForExistence(timeout: 5))
        forget.tap()
        let confirm = app.buttons["setup.savedLogin.forgetConfirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(waitGone(app.buttons["setup.savedLogin"].firstMatch), "Forget Login left the row")

        // 6. Disconnect and Forget Login leaves nothing to tap.
        removed.value = false
        pairThroughTheForm(app, server: server)
        disconnect(app, keepLogin: false)
        XCTAssertTrue(app.buttons["setup.scan"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["setup.savedLogin"].firstMatch.exists, "Forget Login kept the login")
    }

    // MARK: - Steps

    private func pairThroughTheForm(_ app: XCUIApplication, server: String) {
        let url = app.textFields["setup.serverURL"]
        XCTAssertTrue(url.waitForExistence(timeout: 20), "no pairing screen")
        url.tap()
        url.typeText(server)
        let field = app.secureTextFields["setup.token"]
        field.tap()
        field.typeText(token)
        app.buttons["setup.connect"].tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 30), "pairing through the form failed")
    }

    private func disconnect(_ app: XCUIApplication, keepLogin: Bool) {
        app.tab(.settings).tap()
        let button = app.buttons["settings.disconnect"].firstMatch
        _ = button.waitForExistence(timeout: 10)
        revealInList(app, button)
        XCTAssertTrue(button.isHittable, "no Disconnect in Settings")
        button.tap()
        let choice = app.buttons[keepLogin ? "settings.disconnect.keepLogin" : "settings.disconnect.forgetLogin"].firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 5), "the Disconnect dialog has no such choice")
        choice.tap()
        XCTAssertTrue(app.buttons["setup.scan"].waitForExistence(timeout: 20), "Disconnect did not return to pairing")
    }

    private func waitGone(_ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }
}

/// A flag the test sets and the fixture's queue reads.
private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false
    var value: Bool {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
