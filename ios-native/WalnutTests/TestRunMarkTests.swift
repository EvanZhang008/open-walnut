import XCTest

@testable import Walnut

/// AN APP UNDER AUTOMATION MARKS EVERY REQUEST TO WALNUT (2026-11-09: a Maestro run against the
/// live server queued a message that was recorded as the user's own words). Every request path
/// using the mark is pinned by tests/web/ios-test-run-mark-guard.test.ts.
final class TestRunMarkTests: XCTestCase {
    private func decide(_ arguments: [String: Any] = [:], _ environment: [String: String] = [:], simulator: Bool = false) -> String? {
        TestRunMark.decide(arguments: arguments, environment: environment, simulator: simulator, install: { "k3f9a2" })
    }

    func testAPersonsLaunchOnAPhoneIsNotMarked() {
        XCTAssertNil(decide())
        XCTAssertNil(decide(["walnut.uiTestKeychain": "NO"]))
        XCTAssertNil(decide(["walnut.serverUrl": ""]))
    }

    func testEveryAutomationSignMarksAndNamesTheInstall() {
        XCTAssertEqual(decide([:], ["XCTestConfigurationFilePath": "/x"]), "ios-xctest")
        XCTAssertEqual(decide(["walnut.uiTestKeychain": "YES"]), "ios-uitest-k3f9a2")
        XCTAssertEqual(decide(["walnut.silentAudio": true]), "ios-silent-audio-k3f9a2")
        XCTAssertEqual(decide(["walnut.deviceToken": "tok"]), "ios-launch-token-k3f9a2")
        XCTAssertEqual(decide(["walnut.serverUrl": "http://127.0.0.1:3456"]), "ios-launch-server-k3f9a2")
        // A simulator paired beforehand (`defaults write`) and launched with no argument at all.
        XCTAssertEqual(decide(simulator: true), "ios-simulator-k3f9a2")
        XCTAssertEqual(decide([:], ["WALNUT_TEST_RUN": "accept-1"]), "accept-1")
    }

    func testANamedRunWinsAndZeroTurnsMarkingOff() {
        XCTAssertEqual(decide(["walnut.testRun": "accept-stop", "walnut.uiTestKeychain": "YES"]), "accept-stop")
        // A demo recorded for the user is real work: `0` turns every other sign off.
        XCTAssertNil(decide(["walnut.testRun": "0", "walnut.uiTestKeychain": "YES"], ["XCTestConfigurationFilePath": "/x"], simulator: true))
        XCTAssertNil(decide(["walnut.testRun": "false"], simulator: true))
    }

    func testTheInstallIdIsKeptAndTheLabelIsHeaderSafe() {
        let name = "TestRunMarkTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let id = TestRunMark.installID(defaults)
        XCTAssertNotNil(id.range(of: "^[a-z0-9]{6}$", options: .regularExpression))
        XCTAssertEqual(TestRunMark.installID(defaults), id)
        XCTAssertEqual(TestRunMark.clean("  run\u{4E00}\n1  "), "run1")
        XCTAssertEqual(TestRunMark.clean(String(repeating: "a", count: 90))?.count, 60)
    }

    func testRequestsOfThisTestProcessCarryTheMark() throws {
        // The hosted unit-test process is under automation itself.
        XCTAssertEqual(TestRunMark.label, "ios-xctest")
        var request = URLRequest(url: URL(string: "http://127.0.0.1:9/api/v1/status")!)
        request.authorizeForWalnut(token: "tok")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(request.value(forHTTPHeaderField: TestRunMark.header), "ios-xctest")
        var unpaired = URLRequest(url: URL(string: "http://127.0.0.1:9/api/v1/status")!)
        unpaired.authorizeForWalnut(token: nil)
        XCTAssertNil(unpaired.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(unpaired.value(forHTTPHeaderField: TestRunMark.header), "ios-xctest")
        let probe = try XCTUnwrap(InstanceProbe.request(origin: "http://192.168.1.20:3456/"))
        XCTAssertEqual(probe.value(forHTTPHeaderField: TestRunMark.header), "ios-xctest")
        XCTAssertNil(probe.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(TestRunMark.headers(token: "tok"), ["Authorization": "Bearer tok", TestRunMark.header: "ios-xctest"])
    }
}
