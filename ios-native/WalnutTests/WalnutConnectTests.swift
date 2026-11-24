import XCTest
@testable import Walnut

/// Walnut Connect on the phone (WalnutConnect.swift, docs/reference/walnut-connect.md): the
/// `connect` route's wire shape, how the phone dials it (its own 127.0.0.1 port), the pairing
/// QR's `connect` parameter, where the route ranks, and the linked Rust library itself.
final class WalnutConnectTests: XCTestCase {
    private let macID = String(repeating: "ab", count: 32)
    private let lan = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "mac-1")
    private let cloud = ServerRoute(kind: .cloud, origin: "https://walnut.example.com", label: "Cloud", instance: "cloud-1")
    private var connectRoute: ServerRoute {
        ServerRoute(kind: .connect, origin: "walnut-connect://\(macID)", label: "Walnut Connect", instance: "mac-1",
                    connect: ConnectPeer(id: macID, relayMode: "public", relays: ["https://relay-a.example.net./"], addrs: ["192.168.1.20:4100"]))
    }

    // MARK: - Wire

    func testConnectRouteDecodesWithItsPeerAndIsSkippedWithoutOne() throws {
        let json = """
        {"routes":[
          {"kind":"lan","origin":"http://192.168.1.20:3456","label":"Wi-Fi","instance":"mac-1"},
          {"kind":"connect","origin":"walnut-connect://\(macID.uppercased())","label":"Walnut Connect","instance":"mac-1",
           "connect":{"id":"\(macID.uppercased())","relayMode":"public","relays":["https://relay-a.example.net./"],"addrs":["192.168.1.20:4100"],"future":1}},
          {"kind":"connect","origin":"walnut-connect://x","label":"No peer","instance":"mac-1"},
          {"kind":"connect","origin":"walnut-connect://x","label":"Bad id","instance":"mac-1","connect":{"id":"nothex"}}
        ],"device":"Phone","connectEndpoint":"\(String(repeating: "cd", count: 32))"}
        """
        let decoded = try JSONDecoder().decode(ServerRoutesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.routes.count, 2, "a connect route without a peer, or with a bad id, is no route")
        XCTAssertEqual(decoded.connectRoute?.connect, connectRoute.connect, "the id reads in lower case")
        XCTAssertEqual(decoded.connectEndpoint, String(repeating: "cd", count: 32))

        let older = try JSONDecoder().decode(ServerRoutesResponse.self, from: Data(#"{"routes":[],"device":null}"#.utf8))
        XCTAssertNil(older.connectRoute)
        XCTAssertNil(older.connectEndpoint, "a Mac without Walnut Connect says nothing")
    }

    func testAStoredConnectRouteKeepsItsPeer() throws {
        let data = try JSONEncoder().encode([connectRoute, lan])
        XCTAssertEqual(try JSONDecoder().decode([ServerRoute].self, from: data), [connectRoute, lan])
    }

    // MARK: - Dialing

    func testThePhoneDialsAConnectRouteThroughItsOwnPort() {
        let local = AppConfig.localizedConnectRoutes([lan, connectRoute, cloud], origin: "http://127.0.0.1:41234/")
        XCTAssertEqual(local.map(\.origin), ["http://192.168.1.20:3456", "http://127.0.0.1:41234", "https://walnut.example.com"])
        XCTAssertEqual(local[1].connect, connectRoute.connect, "the peer goes with it")
        XCTAssertEqual(local[1].instance, "mac-1", "the probe still checks it is the same Mac")
        // Settings never shows the phone's own port as the Mac's address.
        XCTAssertEqual(RouteProbeDisplay.summary(route: local[1], online: true), "Connected via Walnut Connect \u{00B7} encrypted, from anywhere")
        XCTAssertEqual(local[1].displayAddress, "encrypted, from anywhere")
        XCTAssertEqual(lan.displayAddress, "http://192.168.1.20:3456")
    }

    func testConnectRanksBelowTheMacsOwnAddressesAndAboveTheCompanion() {
        XCTAssertLessThan(ServerRoute.Kind.lan.rank, ServerRoute.Kind.connect.rank)
        XCTAssertLessThan(ServerRoute.Kind.tailnet.rank, ServerRoute.Kind.connect.rank)
        XCTAssertLessThan(ServerRoute.Kind.connect.rank, ServerRoute.Kind.cloud.rank)
        let viaPort = AppConfig.localizedConnectRoutes([connectRoute], origin: "http://127.0.0.1:41234")[0]
        let ok = { (i: String) in ProbeOutcome.ok(instance: i, latencyMs: 40) }
        // Away from home: the Wi-Fi does not answer, Walnut Connect and the companion do.
        let away = RouteSelector.choose(
            routes: [lan, viaPort, cloud],
            probes: [lan.origin: .unreachable, viaPort.origin: ok("mac-1"), cloud.origin: ok("cloud-1")],
            current: cloud.origin, rejected: []
        )
        XCTAssertEqual(away, .switchTo(viaPort), "the Mac itself beats the companion's copy")
        // Home again: the Wi-Fi wins.
        let home = RouteSelector.choose(
            routes: [lan, viaPort, cloud],
            probes: [lan.origin: ok("mac-1"), viaPort.origin: ok("mac-1"), cloud.origin: ok("cloud-1")],
            current: viaPort.origin, rejected: []
        )
        XCTAssertEqual(home, .switchTo(lan))
    }

    // MARK: - Pairing

    func testPairingQRConnectParameter() {
        let key = String(repeating: "0f", count: 32)
        let payload = #"{"k":"\#(key.uppercased())","id":"\#(macID)","m":"public","r":["https://relay-a.example.net./"],"i":"mac-1"}"#
        let b64 = Data(payload.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let pc = AppConfig.parsePairingConnect("wn://pair?name=Phone&token=t0k&connect=\(b64)")
        XCTAssertEqual(pc, AppConfig.PairingConnect(
            key: key, peer: ConnectPeer(id: macID, relayMode: "public", relays: ["https://relay-a.example.net./"]), instance: "mac-1"))
        // The rest of the link reads as it always did.
        XCTAssertEqual(AppConfig.parsePairingURI("wn://pair?name=Phone&token=t0k&connect=\(b64)")?.token, "t0k")

        XCTAssertNil(AppConfig.parsePairingConnect("wn://pair?name=Phone&token=t0k"), "an older Mac's QR has none")
        XCTAssertNil(AppConfig.parsePairingConnect("wn://pair?name=Phone&token=t0k&connect=%%%"))
        let short = Data(#"{"k":"00","id":"\#(macID)"}"#.utf8).base64EncodedString()
        XCTAssertNil(AppConfig.parsePairingConnect("wn://pair?connect=\(short)"), "a key that is no key")
        XCTAssertNil(AppConfig.parsePairingConnect("https://pair?connect=\(b64)"))
    }

    // MARK: - Stored routes

    private func scratchDefaults() -> UserDefaults {
        let name = "walnut-connect-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        addTeardownBlock { d.removePersistentDomain(forName: name) }
        return d
    }

    /// The previous build's `Kind` (no `connect`), decoding strictly as it did.
    private struct OlderRoute: Decodable {
        enum Kind: String, Decodable { case custom, lan, tailnet, cloud }
        let kind: Kind
        let origin: String
    }

    func testAnOlderBuildStillReadsEveryOtherRoute() throws {
        let d = scratchDefaults()
        let local = AppConfig.localizedConnectRoutes([lan, connectRoute, cloud], origin: "http://127.0.0.1:41234")
        AppConfig.storeRoutes(local, anchor: "http://127.0.0.1:41234", in: d)
        let main = try XCTUnwrap(d.data(forKey: AppConfig.routesKey))
        // The list an older build reads holds only kinds it knows, so it keeps the Wi-Fi and the
        // companion (and moves to one of them: the anchor is the current URL it cannot reach).
        XCTAssertEqual(try JSONDecoder().decode([OlderRoute].self, from: main).map(\.origin), [lan.origin, cloud.origin])
        XCTAssertEqual(AppConfig.storedRoutes(in: d), local, "this build reads both lists back, best first")
        XCTAssertEqual(AppConfig.routes(in: d, serverURL: "http://127.0.0.1:41234"), local)
        AppConfig.clearRoutes(in: d)
        XCTAssertNil(d.data(forKey: AppConfig.connectRoutesKey))
        XCTAssertTrue(AppConfig.storedRoutes(in: d).isEmpty)
    }

    func testAStoredRouteThisBuildCannotReadCostsOnlyThatRoute() throws {
        let d = scratchDefaults()
        let json = #"[{"kind":"lan","origin":"http://192.168.1.20:3456","label":"Wi-Fi","instance":"mac-1"},{"kind":"satellite","origin":"x://y","label":"Later"}]"#
        d.set(Data(json.utf8), forKey: AppConfig.routesKey)
        XCTAssertEqual(AppConfig.storedRoutes(in: d).map(\.origin), [lan.origin])
    }

    func testTheMacsOwnListDropsAConnectRouteItNoLongerHas() {
        let local = AppConfig.localizedConnectRoutes([lan, connectRoute, cloud], origin: "http://127.0.0.1:41234")
        // The Mac's list without it (the experiment off): gone.
        XCTAssertEqual(AppConfig.mergeRoutes(local, server: [lan, cloud], dropUnlisted: [.connect]).map(\.kind), [.lan, .cloud])
        // A companion's copy without it says nothing about it: kept.
        XCTAssertEqual(AppConfig.mergeRoutes(local, server: [lan, cloud]).map(\.kind), [.lan, .connect, .cloud])
    }

    func testOnlyTheConnectPortIsHeldBack() {
        let connect = WalnutConnect.shared
        XCTAssertFalse(connect.isConnectURL(URL(string: "http://192.168.1.20:3456/api/v1/status")))
        XCTAssertFalse(connect.isConnectURL(URL(string: "https://walnut.example.com/api/v1/status")))
        XCTAssertTrue(connect.maySend(to: URL(string: "https://walnut.example.com/api/files/raw")), "other origins are never held back")
        guard connect.isAvailable else { return }
        let port = connect.preferredPort
        let url = URL(string: "http://127.0.0.1:\(port)/api/v1/status")
        XCTAssertTrue(connect.isConnectURL(url))
        // Nothing started in this process: the port is not this app's, so no token goes there.
        if !connect.holds(port) {
            XCTAssertFalse(connect.maySend(to: url))
            XCTAssertTrue(WalnutConnectGuard.canInit(with: URLRequest(url: url!)), "the guard fails the request")
        }
    }

    // MARK: - The library

    func testTheAppLinksTheRealLibrary() throws {
        try XCTSkipUnless(WalnutConnect.shared.isAvailable, "built with the stub (no Rust iOS targets on this Mac)")
        // The all-zero seed: the Mac (connect-phones.ts endpointOfKey) gives the same id, so a
        // key the QR carries is the id the Mac let in.
        XCTAssertEqual(
            WalnutConnect.endpointID(ofKey: String(repeating: "0", count: 64)),
            "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29")
        XCTAssertNil(WalnutConnect.endpointID(ofKey: "nope"))
    }
}
