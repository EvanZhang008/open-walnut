import XCTest

extension XCTestCase {
    /// Settings > Disconnect, keeping the login on the pairing screen or forgetting it, back to
    /// the pairing screen. Shared by the tests that pair through the setup form, which start
    /// unpaired when another UI test left a token in the test Keychain namespace.
    func disconnect(_ app: XCUIApplication, keepLogin: Bool, file: StaticString = #filePath, line: UInt = #line) {
        app.tab(.settings).tap()
        let button = app.buttons["settings.disconnect"].firstMatch
        _ = button.waitForExistence(timeout: 10)
        revealInList(app, button)
        XCTAssertTrue(button.isHittable, "no Disconnect in Settings", file: file, line: line)
        button.tap()
        let choice = app.buttons[keepLogin ? "settings.disconnect.keepLogin" : "settings.disconnect.forgetLogin"].firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 5), "the Disconnect dialog has no such choice", file: file, line: line)
        choice.tap()
        XCTAssertTrue(app.buttons["setup.scan"].waitForExistence(timeout: 20), "Disconnect did not return to pairing", file: file, line: line)
    }
}
