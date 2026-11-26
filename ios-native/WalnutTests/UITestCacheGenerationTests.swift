#if DEBUG
import XCTest
@testable import Walnut

/// A UI test's first launch drops the caches an earlier test left; a relaunch in the same test
/// keeps its own (`LocalDataReset.eraseCachesForNewUITest`, passed by `UITestLaunch`).
/// 2026-11-26, CI run 45784774186: a Threads-off test opened the Threads sheet from the copies
/// of the test before it.
@MainActor
final class UITestCacheGenerationTests: XCTestCase {
    private var root: URL!
    private var suite: String!

    override func setUp() async throws {
        try await super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ui-test-generation-\(UUID().uuidString)", isDirectory: true)
        suite = "ui-test-generation-\(UUID().uuidString)"
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
        UserDefaults().removePersistentDomain(forName: suite)
        try await super.tearDown()
    }

    /// Scratch folders standing in for the app's, with a server copy, a letter body and the
    /// HTTP cache's own folder in Caches.
    private func scratch() throws -> (LocalDataReset.Locations, UserDefaults) {
        let fm = FileManager.default
        let caches = root.appendingPathComponent("Caches", isDirectory: true)
        for dir in ["WalnutCache", "letter-bodies", Bundle.main.bundleIdentifier ?? "bundle"] {
            try fm.createDirectory(at: caches.appendingPathComponent(dir), withIntermediateDirectories: true)
        }
        try Data("[]".utf8).write(to: caches.appendingPathComponent("WalnutCache/tasks-list.json"))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let locations = LocalDataReset.Locations(
            applicationSupport: root.appendingPathComponent("Support"), caches: caches,
            temporary: root.appendingPathComponent("tmp"), documents: root.appendingPathComponent("docs"),
            defaults: defaults, defaultsDomain: suite
        )
        return (locations, defaults)
    }

    private func names(_ locations: LocalDataReset.Locations) -> Set<String> {
        Set((try? FileManager.default.contentsOfDirectory(atPath: locations.caches.path)) ?? [])
    }

    func testANewTestErasesTheCachesAndARelaunchKeepsThem() throws {
        let (locations, defaults) = try scratch()
        let bundle = Bundle.main.bundleIdentifier ?? "bundle"
        defaults.set("test-1", forKey: LocalDataReset.uiTestGenerationArgument)

        let first = LocalDataReset.eraseCachesForNewUITest(defaults: defaults, locations: locations)
        XCTAssertEqual(Set(first ?? []), ["WalnutCache", "letter-bodies"], "a new test's first launch kept an earlier test's copies")
        XCTAssertEqual(names(locations), [bundle], "the HTTP cache's folder is the sweep's to leave")

        try FileManager.default.createDirectory(at: locations.caches.appendingPathComponent("WalnutCache"), withIntermediateDirectories: true)
        XCTAssertNil(LocalDataReset.eraseCachesForNewUITest(defaults: defaults, locations: locations), "a relaunch in the same test erased")
        XCTAssertTrue(names(locations).contains("WalnutCache"), "a relaunch lost the test's own copies")

        defaults.set("test-2", forKey: LocalDataReset.uiTestGenerationArgument)
        XCTAssertEqual(LocalDataReset.eraseCachesForNewUITest(defaults: defaults, locations: locations), ["WalnutCache"])
    }

    func testALaunchOutsideAUITestErasesNothing() throws {
        let (locations, defaults) = try scratch()
        XCTAssertNil(LocalDataReset.eraseCachesForNewUITest(defaults: defaults, locations: locations))
        XCTAssertTrue(names(locations).isSuperset(of: ["WalnutCache", "letter-bodies"]))
    }

    func testADisconnectKeepsTheTestsGeneration() {
        XCTAssertTrue(LocalDataReset.keptAcrossErase.contains(LocalDataReset.uiTestGenerationSeenKey))
    }
}
#endif
