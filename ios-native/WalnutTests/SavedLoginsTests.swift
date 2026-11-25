import Foundation
import XCTest
@testable import Walnut

/// Disconnect is not a sign-out: the login stays in `SavedLogins` so a tap reconnects
/// without a QR code (2026-11-18). These run in the test Keychain namespace
/// (`KeychainHelper.Namespace.tests`), never the real one.
@MainActor
final class SavedLoginsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        SavedLogins.removeAll()
    }

    override func tearDown() {
        SavedLogins.removeAll()
        super.tearDown()
    }

    private let lan = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi")
    private let cloud = ServerRoute(kind: .cloud, origin: "https://wn.example.net", label: "Cloud")

    func testALoginIsKeptWithItsTokenAndRoutes() {
        SavedLogins.remember(serverURL: "wn.example.net/", routes: [cloud, lan], token: "tok-1", deviceName: "iPhone")
        let all = SavedLogins.all()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].serverURL, "https://wn.example.net")
        XCTAssertEqual(all[0].token, "tok-1")
        XCTAssertEqual(all[0].deviceName, "iPhone")
        XCTAssertEqual(all[0].title, "wn.example.net")
        XCTAssertFalse(all[0].removedByServer)
    }

    /// The same Walnut reached on another of its routes is one login, not two, and a new
    /// QR code for it replaces the old token.
    func testTheSameWalnutOnAnotherRouteReplacesTheLogin() {
        let cloud = ServerRoute(kind: .cloud, origin: "https://wn.example.net", label: "Cloud", instance: "cloud-1")
        let lan = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "mac-1")
        SavedLogins.remember(serverURL: cloud.origin, routes: [cloud, lan], token: "old", deviceName: "iPhone")
        let id = SavedLogins.all()[0].id
        SavedLogins.remember(serverURL: lan.origin, routes: [lan], token: "new", deviceName: nil)
        let all = SavedLogins.all()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].id, id, "the row keeps its identity")
        XCTAssertEqual(all[0].token, "new")
        XCTAssertEqual(all[0].deviceName, "iPhone", "a name not given again is kept")
        XCTAssertEqual(all[0].serverURL, "http://192.168.1.20:3456")
    }

    func testTwoWalnutsAreTwoLoginsNewestFirst() {
        SavedLogins.remember(serverURL: "https://a.example.net", routes: [], token: "a", deviceName: nil,
                             now: Date(timeIntervalSince1970: 100))
        SavedLogins.remember(serverURL: "https://b.example.net", routes: [], token: "b", deviceName: nil,
                             now: Date(timeIntervalSince1970: 200))
        XCTAssertEqual(SavedLogins.all().map(\.token), ["b", "a"])
    }

    func testTheDemoIsNeverSaved() {
        SavedLogins.remember(serverURL: DemoMode.baseURLString, routes: [], token: DemoMode.token, deviceName: nil)
        XCTAssertTrue(SavedLogins.all().isEmpty)
    }

    func testForgetRemovesOnlyThatLogin() {
        SavedLogins.remember(serverURL: "https://a.example.net", routes: [], token: "a", deviceName: nil)
        SavedLogins.remember(serverURL: "https://b.example.net", routes: [], token: "b", deviceName: nil)
        let a = SavedLogins.all().first { $0.token == "a" }!
        SavedLogins.forget(id: a.id)
        XCTAssertEqual(SavedLogins.all().map(\.token), ["b"])
        SavedLogins.forget(id: SavedLogins.all()[0].id)
        XCTAssertTrue(SavedLogins.all().isEmpty)
        XCTAssertEqual(KeychainHelper.read(SavedLogins.key), .missing, "an empty list leaves no Keychain item behind")
    }

    /// Two Walnuts on two home networks at the same LAN address are two logins: a LAN
    /// address never names a Walnut on its own (review, 2026-11-18).
    func testTwoWalnutsAtTheSameLANAddressStayTwoLogins() {
        let home = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "home")
        let office = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "office")
        SavedLogins.remember(serverURL: home.origin, routes: [home], token: "h", deviceName: nil)
        SavedLogins.remember(serverURL: office.origin, routes: [office], token: "o", deviceName: nil)
        XCTAssertEqual(Set(SavedLogins.all().map(\.token)), ["h", "o"])
        // No instance known on either side: still two, the shared origin is a LAN one.
        SavedLogins.removeAll()
        SavedLogins.remember(serverURL: "http://192.168.1.20:3456",
                             routes: [ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi")],
                             token: "h", deviceName: nil)
        SavedLogins.remember(serverURL: "http://192.168.1.20:3456",
                             routes: [ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi")],
                             token: "o", deviceName: nil)
        XCTAssertEqual(SavedLogins.all().count, 2)
    }

    /// A fresh pairing (one typed route, its instance from the probe) and the same Walnut's
    /// later full route list are one login.
    func testTheSameInstanceIsOneLogin() {
        SavedLogins.remember(serverURL: "https://wn.example.net", routes: [.custom("https://wn.example.net")],
                             token: "old", deviceName: nil, instance: "mac-1")
        let lan = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "mac-1")
        SavedLogins.remember(serverURL: lan.origin, routes: [lan], token: "new", deviceName: nil)
        XCTAssertEqual(SavedLogins.all().map(\.token), ["new"])
        XCTAssertEqual(SavedLogins.all()[0].instance, "mac-1", "the pairing's instance is kept")
    }

    /// A list this build cannot decode is set aside, never destroyed, and a fresh list
    /// starts so Disconnect can still keep the login in use (review, 2026-11-18).
    func testAnUndecodableListIsSetAsideNotDestroyed() {
        SavedLogins.storeRawForTesting("not json")
        XCTAssertEqual(SavedLogins.load(), .undecodable("not json"))
        SavedLogins.remember(serverURL: "https://a.example.net", routes: [], token: "a", deviceName: nil)
        XCTAssertEqual(KeychainHelper.read(SavedLogins.setAsideKey), .value("not json"))
        XCTAssertEqual(SavedLogins.all().map(\.token), ["a"])
    }

    /// A typed or scanned origin is a custom route even at a LAN address: two Walnuts typed
    /// as the same private address, neither naming itself, stay two logins.
    func testTwoTypedPrivateAddressesStayTwoLogins() {
        for token in ["home", "office"] {
            SavedLogins.remember(serverURL: "http://192.168.1.20:3456", routes: [.custom("http://192.168.1.20:3456")],
                                 token: token, deviceName: nil)
        }
        XCTAssertEqual(SavedLogins.all().count, 2)
        // A public origin typed twice is one Walnut.
        SavedLogins.removeAll()
        for token in ["old", "new"] {
            SavedLogins.remember(serverURL: "https://wn.example.net", routes: [.custom("https://wn.example.net")],
                                 token: token, deviceName: nil)
        }
        XCTAssertEqual(SavedLogins.all().map(\.token), ["new"])
    }

    func testPrivateOrigins() {
        for origin in ["http://192.168.1.20:3456", "http://10.0.0.5", "http://172.20.1.1:3456", "http://127.0.0.1:9",
                       "http://169.254.3.4", "http://evans-mac.local:3456", "http://localhost:3456", "http://[fd00::1]:3456"] {
            XCTAssertTrue(SavedLogin.isPrivate(origin), origin)
        }
        for origin in ["https://wn.example.net", "http://172.32.0.1", "http://8.8.8.8", "https://mac.tail1234.ts.net"] {
            XCTAssertFalse(SavedLogin.isPrivate(origin), origin)
        }
    }

    /// Only a box that named itself can say the phone was removed.
    func testARefusalIsAVerdictOnlyFromABoxThatNamedItself() {
        XCTAssertTrue(ReconnectPlan.refusalIsVerified(ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "mac-1")))
        XCTAssertFalse(ReconnectPlan.refusalIsVerified(.custom("http://mac.local:3456")))
    }

    /// A newer version's route kind is skipped, never the login or the list.
    func testAnUnknownRouteKindDropsOnlyThatRoute() {
        let raw = #"[{"id":"x","serverURL":"https://wn.example.net","token":"t","lastUsedAt":100,"removedByServer":false,"#
            + #""routes":[{"kind":"satellite","origin":"https://sat.example.net"},{"kind":"cloud","origin":"https://wn.example.net"}]}]"#
        SavedLogins.storeRawForTesting(raw)
        let all = SavedLogins.all()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].routes.map(\.kind), [.cloud])
    }

    func testARefusedLoginIsMarkedAndAFreshPairingClearsTheMark() {
        SavedLogins.remember(serverURL: cloud.origin, routes: [cloud], token: "t", deviceName: nil)
        SavedLogins.markRemovedByServer(id: SavedLogins.all()[0].id)
        XCTAssertTrue(SavedLogins.all()[0].removedByServer)
        SavedLogins.remember(serverURL: cloud.origin, routes: [cloud], token: "t2", deviceName: nil)
        XCTAssertFalse(SavedLogins.all()[0].removedByServer)
    }

    /// A reconnect tries the last origin first, then every other route once, best first.
    func testCandidateRoutesStartWithTheLastOneAndHaveNoRepeats() {
        let login = SavedLogin(id: "x", serverURL: "http://192.168.1.20:3456", routes: [cloud, lan], token: "t",
                               deviceName: nil, lastUsedAt: Date(), removedByServer: false)
        XCTAssertEqual(login.candidateRoutes.map(\.origin), ["http://192.168.1.20:3456", "https://wn.example.net"])
    }

    // MARK: - Identity before credential

    /// The token goes only to a route whose box named itself as this Walnut: a stranger's box
    /// at the same LAN address (mismatch), one that will not say who it is (401 to the
    /// probe), and one that does not answer get nothing.
    func testTheTokenGoesOnlyToRoutesThatNamedThemselves() {
        let lan = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "mac-1")
        let tail = ServerRoute(kind: .tailnet, origin: "http://mac.tail.example:3456", label: "Tailscale", instance: "mac-1")
        let cloud = ServerRoute(kind: .cloud, origin: "https://wn.example.net", label: "Cloud", instance: "cloud-1")
        let login = SavedLogin(id: "x", serverURL: lan.origin, routes: [lan, tail, cloud], token: "t",
                               deviceName: nil, lastUsedAt: Date(), removedByServer: false)
        let probes: [String: ProbeOutcome] = [
            lan.normalizedOrigin: .mismatch(instance: "someone-else"),
            tail.normalizedOrigin: .rejected401,
            cloud.normalizedOrigin: .ok(instance: "cloud-1", latencyMs: 40),
        ]
        XCTAssertEqual(ReconnectPlan.routes(for: login, probes: probes).map(\.origin), [cloud.origin])
        XCTAssertEqual(ReconnectPlan.routes(for: login, probes: [:]), [], "nothing probed, nothing sent")
    }

    /// The typed origin names no instance; once the pairing saw one, a box there must say it.
    func testATypedOriginIsHeldToThePairingsInstance() {
        let login = SavedLogin(id: "x", serverURL: "http://192.168.1.20:3456", routes: [.custom("http://192.168.1.20:3456")],
                               token: "t", deviceName: nil, lastUsedAt: Date(), removedByServer: false, instance: "mac-1")
        let origin = ServerRoute.normalizeOrigin("http://192.168.1.20:3456")
        XCTAssertEqual(ReconnectPlan.routes(for: login, probes: [origin: .ok(instance: "stranger", latencyMs: 5)]), [])
        XCTAssertEqual(ReconnectPlan.routes(for: login, probes: [origin: .ok(instance: "mac-1", latencyMs: 5)]).count, 1)
        // A server older than the endpoint said nothing at pairing: whoever answers, as at pairing.
        var old = login
        old.instance = nil
        XCTAssertEqual(ReconnectPlan.routes(for: old, probes: [origin: .ok(instance: nil, latencyMs: 5)]).count, 1)
    }

    // MARK: - The bug class: Disconnect or an install check deleting what a reconnect needs

    /// Disconnect wipes every preference. The install marker must come back, or the next
    /// launch reads as a fresh install and deletes the saved logins from the Keychain.
    func testTheEraseKeepsTheInstallMarkerAndTheSavedLoginsFallback() throws {
        let scratch = try LocalDataResetTests.scratchLocations()
        defer { try? FileManager.default.removeItem(at: scratch.root) }
        let defaults = scratch.locations.defaults
        defaults.set(true, forKey: InstallMarker.key)
        defaults.set("[]", forKey: KeychainHelper.fallbackPrefix + SavedLogins.key)
        defaults.set("https://wn.example.net", forKey: AppConfig.urlKey)
        LocalDataReset.eraseAll(reason: "test", locations: scratch.locations)
        XCTAssertEqual(defaults.object(forKey: InstallMarker.key) as? Bool, true)
        XCTAssertEqual(defaults.string(forKey: KeychainHelper.fallbackPrefix + SavedLogins.key), "[]")
        XCTAssertNil(defaults.string(forKey: AppConfig.urlKey), "the pairing itself is still erased")
        // And the next launch is an ordinary one, not a fresh install.
        let outcome = InstallMarker.decide(
            persistent: defaults.persistentDomain(forName: scratch.suite), file: .absent, protectedDataAvailable: true)
        XCTAssertEqual(outcome, .relaunch)
    }

    /// Every Keychain item the app writes through `KeychainHelper` goes on a fresh install
    /// (iOS keeps the Keychain when the app is deleted). Items written with `SecItemAdd`
    /// directly (Health salt, vault, approval keys) have their own cleanup and tests. Enumerated from the source, so a
    /// new item fails here until the cleanup removes it and this list names it.
    func testEveryKeychainHelperItemIsRemovedOnAFreshInstall_KeychainHelperWritersOnly() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        var writers: [String] = []
        for folder in ["Walnut", "Shared"] {
            let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(folder), includingPropertiesForKeys: nil)
            while let url = enumerator?.nextObject() as? URL {
                guard url.pathExtension == "swift", url.lastPathComponent != "KeychainHelper.swift" else { continue }
                let source = try String(contentsOf: url, encoding: .utf8)
                if source.contains("KeychainHelper.set(") { writers.append(url.lastPathComponent) }
            }
        }
        XCTAssertEqual(Set(writers), ["AppConfig.swift", "SavedLogins.swift", "WalnutConnect.swift"],
                       "a new KeychainHelper item: remove it in InstallMarker.removeKeychainItemsLeftByEarlierInstall and list it here")

        SavedLogins.remember(serverURL: "https://wn.example.net", routes: [], token: "t", deviceName: nil)
        XCTAssertFalse(SavedLogins.all().isEmpty)
        let marker = try String(contentsOf: root.appendingPathComponent("Walnut/Core/InstallMarker.swift"), encoding: .utf8)
        XCTAssertTrue(marker.contains("SavedLogins.removeAll()"))
        XCTAssertTrue(marker.contains("AppConfig.removeTokenLeftByEarlierInstall()"))
        XCTAssertTrue(marker.contains("WalnutConnect.removeKeyLeftByEarlierInstall()"))
        SavedLogins.removeAll()
        XCTAssertTrue(SavedLogins.all().isEmpty)
    }

    /// Disconnect keeps the login before it clears the pairing; only Forget Login drops it.
    func testDisconnectSavesTheLoginBeforeItClearsThePairing() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut/Stores/ConnectionStore.swift"), encoding: .utf8)
        let body = try XCTUnwrap(source.components(separatedBy: "func disconnect(").dropFirst().first)
        let keep = try XCTUnwrap(body.range(of: "SavedLogins.rememberCurrentPairing("))
        let clear = try XCTUnwrap(body.range(of: "AppConfig.clear()"))
        XCTAssertLessThan(keep.lowerBound, clear.lowerBound)
    }
}
