import XCTest
@testable import Walnut

/// The route model: origin normalization, the merge of the server's route list
/// into the stored one, persistence (isolated UserDefaults suites only: the
/// standard domain is the installed app's real pairing), the lenient wire
/// decode, and the identity probe's request + answer mapping.
final class ServerRouteTests: XCTestCase {
    private let custom = ServerRoute.custom("http://127.0.0.1:13456")
    private let lan = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "mac-1")
    private let tailnet = ServerRoute(kind: .tailnet, origin: "http://100.101.102.103:3456", label: "Tailscale", instance: "mac-1")
    private let cloud = ServerRoute(kind: .cloud, origin: "https://walnut.example.com", label: "Cloud", instance: "cloud-1")

    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "walnut.tests.routes.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Normalization

    func testOriginNormalization() {
        XCTAssertEqual(ServerRoute.normalizeOrigin("HTTP://Mac.Local:3456/"), "http://mac.local:3456")
        XCTAssertEqual(ServerRoute.normalizeOrigin("https://walnut.example.com:443"), "https://walnut.example.com")
        XCTAssertEqual(ServerRoute.normalizeOrigin("http://192.168.1.20:80//"), "http://192.168.1.20")
        XCTAssertEqual(ServerRoute.normalizeOrigin("  walnut.example.com  "), "https://walnut.example.com")
        XCTAssertEqual(ServerRoute.normalizeOrigin("https://proxy.example.com/walnut/"), "https://proxy.example.com/walnut")
        XCTAssertTrue(ServerRoute.sameOrigin("http://192.168.1.20:3456", "HTTP://192.168.1.20:3456/"))
        XCTAssertFalse(ServerRoute.sameOrigin("http://192.168.1.20:3456", "https://192.168.1.20:3456"))
        XCTAssertFalse(ServerRoute.sameOrigin(nil, "http://192.168.1.20:3456"))
    }

    func testDisplayHost() {
        XCTAssertEqual(lan.displayHost, "192.168.1.20:3456")
        XCTAssertEqual(cloud.displayHost, "walnut.example.com")
    }

    // MARK: - Merge

    func testServerListReplacesSameKinds() {
        let movedLan = ServerRoute(kind: .lan, origin: "http://192.168.1.21:3456", label: "Wi-Fi", instance: "mac-1")
        let merged = AppConfig.mergeRoutes([lan, cloud], server: [movedLan])
        XCTAssertEqual(merged, [movedLan, cloud], "the new Wi-Fi address replaces the old one; cloud is kept")
    }

    func testUnmentionedKindsAreKept() {
        // The cloud box was down when the list was built: it is not gone.
        let merged = AppConfig.mergeRoutes([lan, tailnet, cloud], server: [lan])
        XCTAssertEqual(merged, [lan, tailnet, cloud])
    }

    func testCustomDroppedWhenTheServerListsTheSameOrigin() {
        let pairedViaLan = ServerRoute.custom("http://192.168.1.20:3456/")
        let merged = AppConfig.mergeRoutes([pairedViaLan], server: [cloud, lan])
        XCTAssertEqual(merged, [lan, cloud], "the server's own name for the origin wins; result is best first")
    }

    func testCustomKeptWhenTheServerDoesNotListIt() {
        let merged = AppConfig.mergeRoutes([custom], server: [cloud, tailnet, lan])
        XCTAssertEqual(merged, [custom, lan, tailnet, cloud])
    }

    func testEmptyServerListChangesNothing() {
        XCTAssertEqual(AppConfig.mergeRoutes([custom, cloud], server: []), [custom, cloud])
    }

    func testServerCannotNameACustomRouteAndDuplicatesCollapse() {
        let fake = ServerRoute(kind: .custom, origin: "http://10.0.0.9:3456", label: "Custom")
        let merged = AppConfig.mergeRoutes([cloud], server: [fake, lan, lan])
        XCTAssertEqual(merged, [lan, cloud])
    }

    func testTwoOriginsOfOneKindKeepServerOrder() {
        let lan2 = ServerRoute(kind: .lan, origin: "http://192.168.1.21:3456", label: "Ethernet", instance: "mac-1")
        let merged = AppConfig.mergeRoutes([cloud, lan], server: [lan2, lan])
        XCTAssertEqual(merged, [lan2, lan, cloud])
    }

    // MARK: - Persistence (isolated suite)

    func testRoutesRoundTripThroughUserDefaults() {
        AppConfig.storeRoutes([lan, cloud], anchor: lan.origin, in: defaults)
        XCTAssertEqual(AppConfig.routes(in: defaults, serverURL: lan.origin), [lan, cloud])
        XCTAssertEqual(AppConfig.routes(in: defaults, serverURL: cloud.origin), [lan, cloud])
        XCTAssertEqual(defaults.string(forKey: AppConfig.routesAnchorKey), lan.origin)
        AppConfig.storeRoutes([], anchor: lan.origin, in: defaults)
        XCTAssertNil(defaults.data(forKey: AppConfig.routesKey))
        XCTAssertNil(defaults.string(forKey: AppConfig.routesAnchorKey))
    }

    /// `walnut.serverUrl` set by something that knows nothing about routes (a
    /// UI test's launch argument, `simctl defaults write`): the stored list is
    /// another pairing's and must not be acted on.
    func testStoredRoutesDoNotApplyToAForeignURL() {
        AppConfig.storeRoutes([lan, cloud], anchor: lan.origin, in: defaults)
        XCTAssertEqual(AppConfig.routes(in: defaults, serverURL: "http://127.0.0.1:5555"),
                       [.custom("http://127.0.0.1:5555")])
    }

    /// The server dropped the origin the app is on (the Mac's Wi-Fi address
    /// changed): the list still belongs to this URL through its anchor, so the
    /// app can move to the new address.
    func testAnchorKeepsTheListWhenTheServerDroppedTheCurrentOrigin() {
        let movedLan = ServerRoute(kind: .lan, origin: "http://192.168.1.21:3456", label: "Wi-Fi", instance: "mac-1")
        AppConfig.storeRoutes([movedLan, cloud], anchor: lan.origin, in: defaults)
        XCTAssertEqual(AppConfig.routes(in: defaults, serverURL: lan.origin), [movedLan, cloud])
        XCTAssertNil(AppConfig.activeRoute(in: [movedLan, cloud], serverURL: lan.origin))
    }

    /// An install paired before routes existed has a URL and no routes: its URL
    /// is the paired route. An unpaired install has none.
    func testMigrationFromSingleURL() {
        XCTAssertEqual(AppConfig.routes(in: defaults, serverURL: "http://192.168.1.20:3456"),
                       [.custom("http://192.168.1.20:3456")])
        XCTAssertEqual(AppConfig.routes(in: defaults, serverURL: nil), [])
        AppConfig.storeRoutes([lan, cloud], anchor: lan.origin, in: defaults)
        XCTAssertEqual(AppConfig.routes(in: defaults, serverURL: nil), [], "unpaired: no routes, whatever is stored")
        defaults.set(Data("not json".utf8), forKey: AppConfig.routesKey)
        XCTAssertEqual(AppConfig.routes(in: defaults, serverURL: cloud.origin), [.custom(cloud.origin)],
                       "an unreadable stored list falls back to the paired URL")
    }

    func testActiveRouteMatchesTheServerURL() {
        XCTAssertEqual(AppConfig.activeRoute(in: [lan, cloud], serverURL: "HTTPS://walnut.example.com/"), cloud)
        XCTAssertNil(AppConfig.activeRoute(in: [lan, cloud], serverURL: "http://192.168.1.99:3456"))
        XCTAssertNil(AppConfig.activeRoute(in: [lan, cloud], serverURL: nil))
    }

    /// Switching a route writes the server URL and nothing else.
    func testSetActiveRouteWritesOnlyTheServerURL() {
        defaults.set("tok-must-stay", forKey: "walnut.deviceToken")
        defaults.set("Phone", forKey: "walnut.deviceName")
        AppConfig.storeRoutes([lan, cloud], anchor: lan.origin, in: defaults)
        AppConfig.setActiveRoute(cloud, in: defaults)
        XCTAssertEqual(defaults.string(forKey: AppConfig.urlKey), "https://walnut.example.com")
        XCTAssertEqual(defaults.string(forKey: AppConfig.routesAnchorKey), "https://walnut.example.com",
                       "the anchor follows the switch, so the list stays this pairing's")
        XCTAssertEqual(defaults.string(forKey: "walnut.deviceToken"), "tok-must-stay")
        XCTAssertEqual(defaults.string(forKey: "walnut.deviceName"), "Phone")
        XCTAssertEqual(AppConfig.routes(in: defaults, serverURL: cloud.origin), [lan, cloud])
    }

    /// The hosted test process is pinned to its blackhole: the container's real
    /// routes are never read here (they would be probed) and never written.
    func testTestProcessRoutesArePinnedToTheBlackhole() {
        XCTAssertTrue(AppConfig.routesArePinned)
        XCTAssertEqual(AppConfig.routes, [.custom(AppConfig.testBlackholeURL.absoluteString)])
        XCTAssertFalse(AppConfig.mergeRoutes(server: [lan, cloud]), "a pinned process must not store routes")
    }

    // MARK: - Wire decode

    func testRoutesResponseDecodesLeniently() throws {
        let json = """
        {"routes":[
          {"kind":"lan","origin":"http://192.168.1.20:3456","label":"Wi-Fi","instance":"mac-1"},
          {"kind":"relay","origin":"https://relay.example.com","label":"Future","instance":"r"},
          {"kind":"custom","origin":"http://10.0.0.9:3456","label":"Nope","instance":"x"},
          {"kind":"cloud","origin":"https://walnut.example.com","instance":""},
          {"kind":"tailnet"}
        ],"device":null}
        """
        let decoded = try JSONDecoder().decode(ServerRoutesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.routes, [
            lan,
            ServerRoute(kind: .cloud, origin: "https://walnut.example.com", label: "Cloud", instance: nil),
        ], "unknown kinds, a server-named custom route and malformed rows are skipped; label defaults; empty instance is nil")
        XCTAssertNil(decoded.device)
    }

    /// The Mac's `tailscale` hint is optional and can never cost the route list.
    func testRoutesResponseTailscaleHintIsLenient() throws {
        func decode(_ tail: String) throws -> ServerRoutesResponse {
            let json = #"{"routes":[{"kind":"lan","origin":"http://192.168.1.20:3456","label":"Wi-Fi","instance":"mac-1"}],"device":"Phone""# + tail + "}"
            return try JSONDecoder().decode(ServerRoutesResponse.self, from: Data(json.utf8))
        }
        let full = try decode(#","tailscale":{"installed":true,"running":true,"dnsName":"mac.example.ts.net"}"#)
        XCTAssertEqual(full.tailscale, TailscaleHint(installed: true, running: true, dnsName: "mac.example.ts.net"))
        XCTAssertEqual(full.routes, [lan])
        XCTAssertEqual(full.device, "Phone")

        XCTAssertNil(try decode("").tailscale, "absent: a cloud replica or an older server")
        XCTAssertNil(try decode(#","tailscale":null"#).tailscale)
        XCTAssertNil(try decode(#","tailscale":{}"#).tailscale, "an object that says nothing is no hint")

        XCTAssertEqual(try decode(#","tailscale":{"installed":false,"running":false}"#).tailscale,
                       TailscaleHint(installed: false, running: false, dnsName: nil))
        XCTAssertEqual(try decode(#","tailscale":{"running":false}"#).tailscale,
                       TailscaleHint(installed: nil, running: false), "partial: an unsaid field stays nil, never false")
        XCTAssertEqual(try decode(#","tailscale":{"installed":"yes","running":true,"dnsName":""}"#).tailscale,
                       TailscaleHint(installed: nil, running: true, dnsName: nil), "a wrong-typed field and an empty name read as unsaid")

        let garbage = try decode(#","tailscale":"on""#)
        XCTAssertNil(garbage.tailscale)
        XCTAssertEqual(garbage.routes, [lan], "a hint of the wrong shape leaves the routes intact")
    }

    func testStoredRoutesKeepTheirShape() throws {
        let data = try JSONEncoder().encode([custom, lan, cloud])
        XCTAssertEqual(try JSONDecoder().decode([ServerRoute].self, from: data), [custom, lan, cloud])
    }

    // MARK: - Identity probe

    func testProbeRequestCarriesNoCredential() throws {
        let request = try XCTUnwrap(InstanceProbe.request(origin: "http://192.168.1.20:3456/"))
        XCTAssertEqual(request.url?.absoluteString, "http://192.168.1.20:3456/api/v1/instance")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"),
                     "identity before credential: a stranger's box at this address must never see the token")
        XCTAssertEqual(request.timeoutInterval, 2.5)
        XCTAssertEqual(request.httpMethod, "GET")
    }

    func testProbeAnswerMapping() {
        let body = Data(#"{"instance":"mac-1","mode":"LIVE"}"#.utf8)
        XCTAssertEqual(InstanceProbe.outcome(status: 200, data: body, latencyMs: 9), .ok(instance: "mac-1", latencyMs: 9))
        XCTAssertEqual(InstanceProbe.outcome(status: 200, data: Data("<html>portal</html>".utf8), latencyMs: 9),
                       .unreachable, "a captive portal's page is not a Walnut")
        XCTAssertEqual(InstanceProbe.outcome(status: 404, data: Data(), latencyMs: 9), .ok(instance: nil, latencyMs: 9),
                       "an old server answers, but cannot prove who it is")
        XCTAssertEqual(InstanceProbe.outcome(status: 401, data: Data(), latencyMs: 9), .rejected401)
        XCTAssertEqual(InstanceProbe.outcome(status: 403, data: Data(), latencyMs: 9), .rejected401)
        XCTAssertEqual(InstanceProbe.outcome(status: 302, data: Data(), latencyMs: 9), .unreachable)
        XCTAssertEqual(InstanceProbe.outcome(status: 502, data: Data(), latencyMs: 9), .unreachable)
    }

    // MARK: - Pairing URI (unchanged by routes)

    func testPairingURIParsingIsUnchanged() throws {
        let full = try XCTUnwrap(AppConfig.parsePairingURI("wn://pair?name=Phone&token=abc123&server=http://192.168.1.20:3456"))
        XCTAssertEqual(full.name, "Phone")
        XCTAssertEqual(full.token, "abc123")
        XCTAssertEqual(full.server, "http://192.168.1.20:3456")
        let bare = try XCTUnwrap(AppConfig.parsePairingURI("  WN://pair?token=t  "))
        XCTAssertNil(bare.name)
        XCTAssertNil(bare.server)
        XCTAssertNil(AppConfig.parsePairingURI("wn://pair?name=x"))
        XCTAssertNil(AppConfig.parsePairingURI("wn://pair?token="))
        XCTAssertNil(AppConfig.parsePairingURI("https://example.com/?token=t"))
    }
}
