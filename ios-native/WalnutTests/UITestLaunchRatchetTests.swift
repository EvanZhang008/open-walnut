import XCTest

/// NO UI TEST MAY LAUNCH THE APP BY HAND.
///
/// The app under XCUITest is its own process and does not get the environment variable
/// that blackholes the hosted unit-test bundle, so a launch that says nothing about a
/// server inherits the SIMULATOR'S PAIRING. On a dogfood pairing that is live traffic at
/// the human's server: a plain `xcodebuild test` was measured sending `POST
/// /api/v1/client-logs`, `POST /api/v1/devices/self`, `GET /api/v1/human-inbox`, `GET
/// /api/v1/focus/tasks` and an SSE subscribe at :3456 (2026-09-12 gate).
///
/// `UITestLaunch` fixes that for every launch that goes through it. This file is what
/// makes "goes through it" true — the hole existed for a long time precisely because it
/// depended on each author remembering. Read as TEXT, like
/// `TimelineHarnessIdentifierTests` reads the harness: the property is about the call
/// sites in those files, so the source is the only place it exists. Nothing here imports
/// XCUITest, so it runs in the ordinary unit target where the gate will see it.
final class UITestLaunchRatchetTests: XCTestCase {

    /// The helper itself is the one file allowed to construct and launch an app.
    private static let helper = "UITestLaunch.swift"

    /// Source with `//` comments removed. The first version of this ratchet matched
    /// `.launch()` anywhere and fired on a DOC COMMENT explaining a past bug — a rule
    /// that reads prose cannot be trusted about code.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                guard let slashes = line.range(of: "//") else { return String(line) }
                return String(line[..<slashes.lowerBound])
            }
            .joined(separator: "\n")
    }

    private func uiTestSources() throws -> [(name: String, text: String)] {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // WalnutTests/
            .deletingLastPathComponent()      // ios-native/
            .appendingPathComponent("WalnutUITests")
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".swift") && $0 != Self.helper }
            .sorted()
        // Zero files would make every case below pass vacuously.
        XCTAssertFalse(names.isEmpty, "no UI test sources found at \(dir.path)")
        return try names.map {
            (name: $0,
             text: code(try String(contentsOf: dir.appendingPathComponent($0),
                                   encoding: .utf8)))
        }
    }

    /// AN APP YOU CAN CONSTRUCT IS AN APP YOU CAN LAUNCH UNPINNED, so the bare
    /// `XCUIApplication()` initialiser belongs to the helper alone.
    ///
    /// The construction is the gate rather than the `.launch()` call: it is one spelling
    /// instead of several, and it cannot be reached around by launching through a stored
    /// reference. `XCUIApplication(bundleIdentifier:)` stays allowed — that is how a test
    /// reaches the Springboard, and how it waits on an app the OS launched for it.
    func testNoUITestConstructsItsOwnApp() throws {
        for source in try uiTestSources() {
            XCTAssertFalse(
                source.text.contains("XCUIApplication()"),
                """
                \(source.name) constructs its own app. Use `UITestLaunch.launch([…])` \
                (or `.terminate()`) so the app is pointed at the discard port instead of \
                whatever this simulator is paired to — an unpinned launch sends live \
                traffic at a dogfood server.
                """
            )
        }
    }

    /// The other half: assigning `launchArguments` by hand is how a launch acquires a
    /// server (or fails to), so that assignment belongs to the helper too.
    func testNoUITestSetsLaunchArgumentsByHand() throws {
        for source in try uiTestSources() {
            XCTAssertFalse(
                source.text.contains("launchArguments"),
                """
                \(source.name) sets launchArguments directly. Pass them to \
                `UITestLaunch.launch([…])`, which adds the blackhole server URL unless \
                the test pins one of its own.
                """
            )
        }
    }

    /// And the helper still has to be the thing that does it — a rename or a refactor
    /// that drops the blackhole would leave both cases above green.
    func testTheHelperStillPinsTheBlackhole() throws {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WalnutUITests")
        let text = try String(contentsOf: dir.appendingPathComponent(Self.helper),
                              encoding: .utf8)
        XCTAssertTrue(text.contains("http://127.0.0.1:9"),
                      "the helper no longer points unpinned launches at the discard port")
        XCTAssertTrue(text.contains("-walnut.serverUrl"),
                      "the helper no longer passes the argument AppConfig reads")
    }
}
