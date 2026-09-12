import XCTest

/// HOW EVERY UI TEST LAUNCHES THE APP, so that none of them talks to the server this
/// simulator happens to be paired to.
///
/// The hosted unit-test bundle is already safe: it runs INSIDE the app, `xcodebuild`
/// puts `XCTestConfigurationFilePath` in that process's environment, and `AppConfig`
/// pins the whole process at the discard port before the first request (see
/// `AppConfig.testBlackholeURL`). The app under XCUITest is a DIFFERENT process and
/// gets no such variable — deliberately, because a UI test may want to pair the app
/// against a fixture server of its own. The cost of that freedom was a plain
/// `xcodebuild test` sending live traffic at a dogfood pairing: `POST
/// /api/v1/client-logs`, `POST /api/v1/devices/self`, `GET /api/v1/human-inbox`, `GET
/// /api/v1/focus/tasks` and an SSE subscribe, all against the human's real server
/// (2026-09-12 gate).
///
/// So the default moves here, where every launch has to come through:
///
///  - a test that says nothing about a server gets the blackhole, and its fixtures come
///    from its own `-*-harness` launch arguments rather than from the network;
///  - a test that DOES pair itself (`BoardRingTapUITests`, `VoiceQuickActionUITests`
///    stand up throwaway servers) passes `-walnut.serverUrl` and keeps it — the helper
///    never overrides an explicit choice.
///
/// `UITestLaunchRatchetTests` fails if a launch is written by hand again.
enum UITestLaunch {

    /// The discard port (RFC 863) with nothing bound to it, so a loopback connect is
    /// REFUSED in microseconds. Fail-fast is the requirement: a blackhole that hung
    /// would trade live writes for a 30s URLSession timeout per call.
    static let blackholeURL = "http://127.0.0.1:9"

    /// The launch-argument name `AppConfig.serverURL` reads through `NSArgumentDomain`.
    static let serverURLArgument = "-walnut.serverUrl"

    /// An app configured to reach nothing, plus whatever this test asked for.
    ///
    /// Not launched yet: a caller may still want to set `launchEnvironment` or take a
    /// reference before the app comes up.
    static func app(_ arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        // An explicit pairing wins. Prepending unconditionally would leave two values
        // for one key in the argument domain and make the winner an ordering detail.
        let pinsItsOwnServer = arguments.contains(serverURLArgument)
        app.launchArguments =
            (pinsItsOwnServer ? [] : [serverURLArgument, blackholeURL]) + arguments
        return app
    }

    /// The common case: configure, launch, hand it back.
    static func launch(_ arguments: [String] = []) -> XCUIApplication {
        let app = app(arguments)
        app.launch()
        return app
    }

    /// Kill the app under test. Here so that no test needs to construct a bare
    /// `XCUIApplication()` of its own — that constructor is the one the ratchet forbids,
    /// because an app you can construct is an app you can launch unpinned.
    static func terminate() {
        XCUIApplication().terminate()
    }
}
