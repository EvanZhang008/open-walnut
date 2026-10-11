import Foundation
import XCTest
@testable import Walnut

/// The demo keeps its state in a scope of its own (`AppPrefs`): whatever is
/// switched on or chosen in the demo lands in the demo's suite, which is wiped
/// when the demo starts, at every launch in it and when you leave it, and
/// nothing done in the demo changes the real app's preferences (App Store gate,
/// 2026-10-05: Apple Health turned on in the demo stayed on after a relaunch).
///
/// The host app's real preferences are only READ here, to prove they did not
/// change; every write goes to the demo suite or to scratch suites.
@MainActor
final class DemoScopeTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private var scratchSuites: [String] = []

    override func setUp() async throws {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppPrefs.eraseDemo()
    }

    override func tearDown() async throws {
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
        AppPrefs.eraseDemo()
        for suite in scratchSuites { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
    }

    private func enterDemo() {
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
    }

    private func leaveDemo() {
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    private func scratchSuite(_ name: String) -> (String, UserDefaults) {
        let suite = "demo-scope-\(name)-\(UUID().uuidString)"
        scratchSuites.append(suite)
        return (suite, UserDefaults(suiteName: suite)!)
    }

    /// What the host app has under these keys right now (nil = nothing).
    private func realValues(_ keys: [String]) -> [String: String] {
        var values: [String: String] = [:]
        for key in keys { values[key] = UserDefaults.standard.object(forKey: key).map { "\($0)" } ?? "nil" }
        return values
    }

    private static let watchedKeys = [
        HealthSync.enabledKey, PlacesSettings.enabledKey, PlacesSettings.askedAlwaysKey,
        InboxFilter.storageKey, CalendarViewPreference.key, VoiceRecorder.micRouteKey,
        PushRegistration.modeKey, BoardFilterPrefs.showDoneKey, "walnut.sessionStreamResumeIDs",
    ]

    func testTheScopeIsTheDemosOnlyWhileTheDemoRuns() {
        leaveDemo()
        XCTAssertFalse(DemoMode.isActive, "the test host is not paired with the demo")
        XCTAssertEqual(AppPrefs.scope, .real)
        XCTAssertTrue(AppPrefs.defaults === UserDefaults.standard)
        enterDemo()
        XCTAssertEqual(AppPrefs.scope, .demo)
        XCTAssertTrue(AppPrefs.defaults === AppPrefs.demo)
        AppPrefs.during(.real) { XCTAssertTrue(AppPrefs.defaults === UserDefaults.standard) }
        XCTAssertEqual(AppPrefs.scope, .demo, "the pin ends with its body")
        // A suite a test injected is kept; the app's own follows the scope.
        let (_, suite) = scratchSuite("resolve")
        XCTAssertTrue(AppPrefs.resolve(suite) === suite)
        XCTAssertTrue(AppPrefs.resolve(.standard) === AppPrefs.demo)
    }

    /// The gate's case and its siblings: every switch the demo offers writes to
    /// the demo's suite and never to the real app's.
    func testSwitchesInTheDemoLandInTheDemosSuite() {
        let before = realValues(Self.watchedKeys)
        enterDemo()
        HealthSync.isEnabled = true
        PlacesSettings.isEnabled = true
        PlacesSettings.askedAlways = true
        AppPrefs.defaults.set(VoiceRecorder.MicRoute.builtInMic.rawValue, forKey: VoiceRecorder.micRouteKey)
        XCTAssertEqual(VoiceRecorder.micRoute, .builtInMic)
        CalendarViewPreference().save(.list)
        let inbox = InboxStore()
        inbox.filter = .unread
        let streams = SessionStreamResumeIDs(defaults: .standard)
        streams.save(7, for: "demo-scope-stream")

        XCTAssertTrue(HealthSync.isEnabled)
        XCTAssertTrue(AppPrefs.demo.bool(forKey: HealthSync.enabledKey))
        XCTAssertTrue(AppPrefs.demo.bool(forKey: PlacesSettings.enabledKey))
        XCTAssertEqual(AppPrefs.demo.string(forKey: InboxFilter.storageKey), InboxFilter.unread.rawValue)
        XCTAssertEqual(AppPrefs.demo.string(forKey: CalendarViewPreference.key), CalendarViewMode.list.rawValue)
        XCTAssertNotNil(AppPrefs.demo.data(forKey: "walnut.sessionStreamResumeIDs"))
        XCTAssertEqual(realValues(Self.watchedKeys), before, "the real app's preferences did not change")

        // Outside the demo the same switches read the real app's values again.
        leaveDemo()
        XCTAssertEqual(HealthSync.isEnabled, UserDefaults.standard.bool(forKey: HealthSync.enabledKey))
        XCTAssertEqual(realValues(Self.watchedKeys), before)
    }

    /// A launch in the demo wipes the demo's preferences and files before any
    /// store reads them, and leaves the real app's preferences alone.
    func testALaunchInTheDemoStartsFromNothing() throws {
        let (realName, real) = scratchSuite("real")
        let (demoName, demo) = scratchSuite("demo")
        real.set(true, forKey: BoardFilterPrefs.showDoneKey)
        real.set(false, forKey: HealthSync.enabledKey)
        demo.set(true, forKey: HealthSync.enabledKey)
        demo.set("unread", forKey: InboxFilter.storageKey)
        let scratch = try LocalDataResetTests.scratchLocations()
        defer { try? FileManager.default.removeItem(at: scratch.root) }
        var locations = scratch.locations
        locations.defaults = real
        locations.defaultsDomain = realName
        locations.demoDefaults = demo
        locations.demoDefaultsDomain = demoName
        let leftover = locations.temporary.appendingPathComponent("demo-take.m4a")
        try Data([1, 2, 3]).write(to: leftover)

        let removed = LocalDataReset.eraseDemoAtLaunch(locations: locations)

        XCTAssertNil(demo.object(forKey: HealthSync.enabledKey), "Apple Health is off again in the demo")
        XCTAssertNil(demo.object(forKey: InboxFilter.storageKey))
        XCTAssertTrue(removed.contains("demo-take.m4a"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: leftover.path))
        XCTAssertEqual(real.object(forKey: BoardFilterPrefs.showDoneKey) as? Bool, true)
        XCTAssertEqual(real.object(forKey: HealthSync.enabledKey) as? Bool, false)
    }

    /// Leaving the demo erases the demo's state, and every store's own reset
    /// writes into the demo's scope, not the real app's: the Places reset
    /// writes its switch back as off, which used to land in the real app's
    /// preferences after their wipe.
    func testLeavingTheDemoLeavesTheRealAppAsItWas() throws {
        let (realName, real) = scratchSuite("real")
        let (demoName, demo) = scratchSuite("demo")
        real.set(true, forKey: BoardFilterPrefs.showDoneKey)
        real.set("review", forKey: InboxFilter.storageKey)
        demo.set(true, forKey: HealthSync.enabledKey)
        let scratch = try LocalDataResetTests.scratchLocations()
        defer { try? FileManager.default.removeItem(at: scratch.root) }
        var locations = scratch.locations
        locations.defaults = real
        locations.defaultsDomain = realName
        locations.demoDefaults = demo
        locations.demoDefaultsDomain = demoName
        let before = realValues(Self.watchedKeys)

        enterDemo()
        LocalDataReset.eraseAll(reason: "test-leave-demo", scope: .demo, locations: locations)
        leaveDemo()

        XCTAssertNil(demo.object(forKey: HealthSync.enabledKey), "the demo's switch is gone")
        XCTAssertEqual(real.object(forKey: BoardFilterPrefs.showDoneKey) as? Bool, true, "the real app's board filter stays")
        XCTAssertEqual(real.string(forKey: InboxFilter.storageKey), "review")
        XCTAssertEqual(realValues(Self.watchedKeys), before, "no reset wrote into the real app's preferences")

        // A real disconnect erases both.
        LocalDataReset.eraseAll(reason: "test-disconnect", scope: .real, locations: locations)
        XCTAssertNil(real.object(forKey: BoardFilterPrefs.showDoneKey))
        XCTAssertNil(demo.object(forKey: HealthSync.enabledKey))
    }

    /// Places in the demo asks iOS nothing: the switch turns on in the demo's
    /// suite, the screen reads it as on, and location access is untouched.
    func testPlacesInTheDemoAsksIOSNothing() async {
        enterDemo()
        let access = PlacesRecorder.shared.access
        await PlacesRecorder.shared.turnOn()
        XCTAssertTrue(PlacesSettings.isEnabled)
        XCTAssertFalse(PlacesSettings.askedAlways, "the Always question was not used up")
        XCTAssertEqual(PlacesRecorder.shared.access, access)
        XCTAssertFalse(PlacesRecorder.shared.monitoring)
        PlacesStore.shared.reload()
        XCTAssertTrue(PlacesStore.shared.recording, "the demo's screen shows Places on")
        PlacesRecorder.shared.turnOff()
        XCTAssertFalse(PlacesSettings.isEnabled)
    }

    /// The side question is answered from what was asked.
    func testTheDemoSideQuestionAnswersWhatWasAsked() {
        let file = DemoReplies.sideAnswer(to: "Which file had the force unwrap?", session: "s-crash")
        XCTAssertTrue(file.contains("AlbumViewModel.swift"), file)
        let tests = DemoReplies.sideAnswer(to: "Do the tests pass?", session: "s-crash")
        XCTAssertTrue(tests.contains("24 album tests"), tests)
        let why = DemoReplies.sideAnswer(to: "Why did it crash?", session: "s-crash")
        XCTAssertTrue(why.contains("nil"), why)
        let other = DemoReplies.sideAnswer(to: "What colour is the sky?", session: "s-crash")
        XCTAssertTrue(other.contains("What colour is the sky?"), other)
        XCTAssertEqual(Set([file, tests, why, other]).count, 4, "four questions, four answers")
        let grid = DemoReplies.sideAnswer(to: "Which file holds the cache?", session: "s-offline")
        XCTAssertTrue(grid.contains("ThumbnailCache.swift"), grid)
        // The sheet shows an answer as plain text: no markdown marks in any of them.
        let questions = ["Which file?", "Do the tests pass?", "Why?", "Is it safe?", "Is the PR merged?", "How long?", "Anything?"]
        for session in ["s-crash", "s-offline", "s-copy", "s-cache", "s-other"] {
            for question in questions {
                let answer = DemoReplies.sideAnswer(to: question, session: session)
                XCTAssertFalse(answer.contains("`") || answer.contains("**"), "\(session) \(question): \(answer)")
            }
        }
    }
}
