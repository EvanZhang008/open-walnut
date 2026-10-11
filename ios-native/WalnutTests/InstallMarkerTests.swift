import XCTest
@testable import Walnut

/// The first launch after an install: a fresh install after a delete removes
/// the token the deleted install left in the Keychain; an update keeps it (no
/// TestFlight user is logged out by updating); an ordinary relaunch does
/// nothing; and preferences that cannot be read decide nothing. Each case runs
/// on a suite of its own, never on the app's preferences.
final class InstallMarkerTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "install-marker-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private func run(file: InstallMarker.FileView? = nil, protectedData: Bool = true) -> (InstallMarker.Outcome, removed: Int) {
        var removed = 0
        let view = file ?? .contents(defaults.persistentDomain(forName: suiteName) ?? [:])
        let outcome = InstallMarker.reconcile(
            defaults: defaults, domain: suiteName, file: { view },
            protectedDataAvailable: protectedData, removeLeftToken: { removed += 1 })
        return (outcome, removed)
    }

    func testAFreshInstallAfterADeleteRemovesTheLeftTokenAndWritesTheMarker() {
        // Deleting the app took its preferences: no marker, no address.
        let (outcome, removed) = run(file: .absent)
        XCTAssertEqual(outcome, .freshInstall)
        XCTAssertEqual(removed, 1, "the token the deleted install left was not removed")
        XCTAssertEqual(defaults.bool(forKey: InstallMarker.key), true)
        // The next launch is an ordinary one.
        XCTAssertEqual(run().0, .relaunch)
        XCTAssertEqual(run().removed, 0)
    }

    func testAnUpdateKeepsThePairingAndWritesTheMarker() {
        // A phone paired with an earlier version, which had no marker.
        defaults.set("https://wn.example.com", forKey: AppConfig.urlKey)
        let (outcome, removed) = run()
        XCTAssertEqual(outcome, .upgrade)
        XCTAssertEqual(removed, 0, "an update logged the user out")
        XCTAssertEqual(defaults.bool(forKey: InstallMarker.key), true)
        XCTAssertEqual(defaults.string(forKey: AppConfig.urlKey), "https://wn.example.com")
    }

    func testAnOrdinaryRelaunchChangesNothing() {
        defaults.set(true, forKey: InstallMarker.key)
        defaults.set("https://wn.example.com", forKey: AppConfig.urlKey)
        let before = defaults.persistentDomain(forName: suiteName) as NSDictionary?
        let (outcome, removed) = run()
        XCTAssertEqual(outcome, .relaunch)
        XCTAssertEqual(removed, 0)
        XCTAssertEqual(defaults.persistentDomain(forName: suiteName) as NSDictionary?, before)
        // Disconnected since: still an ordinary launch, nothing to remove.
        defaults.removeObject(forKey: AppConfig.urlKey)
        XCTAssertEqual(run().0, .relaunch)
    }

    func testPreferencesThatCannotBeReadDecideNothing() {
        // Before the first unlock: iOS cannot read the preferences at all.
        var (outcome, removed) = run(file: .unreadable, protectedData: false)
        XCTAssertEqual(outcome, .notNow)
        XCTAssertEqual(removed, 0)
        // The file is there but could not be read, and the defaults look empty.
        (outcome, removed) = run(file: .unreadable)
        XCTAssertEqual(outcome, .notNow)
        XCTAssertEqual(removed, 0)
        XCTAssertNil(defaults.object(forKey: InstallMarker.key), "a launch that decided nothing wrote the marker")
    }

    func testTheFileOnDiskWinsOverAnEmptyLookingDefaults() {
        // UserDefaults read empty, the file on disk has the pairing: an update.
        let (outcome, removed) = run(file: .contents([AppConfig.urlKey: "https://wn.example.com"]))
        XCTAssertEqual(outcome, .upgrade)
        XCTAssertEqual(removed, 0)
    }

    func testALaunchArgumentAddressIsNotAPairing() {
        // `-walnut.serverUrl` puts the address in the argument domain, which
        // `string(forKey:)` reads; the decision reads the persistent domain only.
        XCTAssertEqual(InstallMarker.decide(persistent: [:], file: .absent, protectedDataAvailable: true), .freshInstall)
        XCTAssertEqual(InstallMarker.decide(persistent: nil, file: .absent, protectedDataAvailable: true), .freshInstall)
    }

    /// The real token store: removing the left token takes the Keychain item and
    /// the fallback copy kept in the preferences when the Keychain is unavailable.
    func testRemovingTheLeftTokenTakesTheKeychainItemAndTheFallback() {
        let account = "walnut.installMarkerTest.\(UUID().uuidString)"
        defer { KeychainHelper.delete(account) }
        KeychainHelper.set("left-by-an-earlier-install", forKey: account)
        UserDefaults.standard.set("fallback-copy", forKey: "walnut.keychainFallback." + account)
        XCTAssertNotNil(KeychainHelper.get(account))
        KeychainHelper.delete(account)
        XCTAssertNil(KeychainHelper.get(account))
        XCTAssertNil(UserDefaults.standard.object(forKey: "walnut.keychainFallback." + account))
    }

    /// The marker is decided where the app object exists, never in `WalnutApp.init`.
    func testTheMarkerIsDecidedAtDidFinishLaunching() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let delegate = try String(contentsOf: root.appendingPathComponent("Walnut/App/QuickActionDelegate.swift"), encoding: .utf8)
        XCTAssertTrue(delegate.contains("InstallMarker.reconcile(protectedDataAvailable: application.isProtectedDataAvailable)"))
        let app = try String(contentsOf: root.appendingPathComponent("Walnut/App/WalnutApp.swift"), encoding: .utf8)
        XCTAssertFalse(app.contains("InstallMarker.reconcile"), "the marker moved into App.init, which iOS can prewarm before the first unlock")
    }
}
