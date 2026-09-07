import XCTest
@testable import Walnut

/// The gate for `TestProcessNetworkBlackhole.swift`.
///
/// A hosted test bundle inherits the app container's pairing, so "the tests do
/// not touch a real server" is not a property of the tests — it is a property of
/// one install hook running before them. Hooks are exactly the thing a refactor
/// drops silently (a renamed class, a regenerated Info.plist, a target rebuilt
/// from scratch), and the failure is invisible: the suite still passes, it just
/// starts writing to whatever server the human is dogfooding against. So the
/// guarantee gets its own assertions.
final class TestProcessNetworkBlackholeTests: XCTestCase {

    func testProcessIsPinnedToTheBlackhole() {
        XCTAssertEqual(AppConfig.serverURL, WalnutTestsPrincipal.blackholeURL,
            "the test process is NOT pinned to the blackhole — AppConfig resolves to "
            + "\(AppConfig.serverURL?.absoluteString ?? "nil"), which on a dogfood device is a REAL "
            + "server. The NSPrincipalClass hook (WalnutTests bundle → WalnutTestsPrincipal) is not running.")
        XCTAssertEqual(AppConfig.token, "",
            "the test process still carries a device token — a blackholed URL plus a live "
            + "credential is one bad merge away from live writes again")
        // `isConfigured` must stay TRUE: the point is to redirect the network, not
        // to send every store down its unpaired branch and change what is tested.
        XCTAssertTrue(AppConfig.isConfigured,
            "pinning must keep the paired shape (URL + non-nil token), only unreachable")
    }

    /// The blackhole engages before `main()` returns, and the only thing that
    /// tells `AppConfig` to do that is this environment variable. The principal
    /// class cannot cover the launch window (XCTest loads a hosted bundle after
    /// `applicationDidFinishLaunching`, by which point the app has already POSTed
    /// its client logs and opened its events SSE), so if xcodebuild ever stops
    /// setting this, the fix silently goes back to being partial.
    func testTheSignalThatArmsTheBlackholeBeforeAppLaunchIsPresent() {
        XCTAssertNotNil(ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"],
            "XCTestConfigurationFilePath is gone from the test host's environment — AppConfig's "
            + "blackhole default can no longer arm itself before the app's own startup requests, "
            + "and the principal class runs too late to cover them")
    }

    /// Everything that builds a URL goes through the same seam, so pinning one
    /// value has to cover the SSE feeds and image loads too, not just REST.
    func testDerivedURLsInheritTheBlackhole() {
        XCTAssertEqual(WalnutAPI.eventsFeedURL()?.absoluteString, "http://127.0.0.1:9/api/v1/events")
        XCTAssertEqual(WalnutAPI.sessionStreamURL(id: "s-1")?.absoluteString,
                       "http://127.0.0.1:9/api/v1/sessions/s-1/stream")
    }

    /// The override is IN MEMORY. If it ever starts writing the container, the
    /// device comes out of a test run re-paired to a dead port — the app opens on
    /// the setup screen and the human's pairing is gone.
    func testTheAppContainerWasNotRepointed() {
        let onDisk = UserDefaults.standard.string(forKey: "walnut.serverUrl")
        XCTAssertNotEqual(onDisk, WalnutTestsPrincipal.blackholeURL.absoluteString,
            "the blackhole reached UserDefaults — a test run has re-pointed the installed app")
    }

    /// Fail-FAST, not fail-eventually: a 30s URLSession timeout per call would
    /// make the suite unrunnable, and an unrunnable suite gets bypassed.
    func testReachingForTheNetworkFailsImmediately() async {
        let started = Date()
        do {
            _ = try await WalnutAPI().status()
            XCTFail("a request from the test process reached SOMETHING — the blackhole is not blackholing")
        } catch {
            // Connection refused on loopback; the error kind is URLSession's
            // business, the latency is ours.
        }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertLessThan(elapsed, 2.0,
            "a blackholed request took \(String(format: "%.2f", elapsed))s — the override points at "
            + "something that swallows the connection instead of refusing it; every networked test now "
            + "pays a timeout")
    }
}
