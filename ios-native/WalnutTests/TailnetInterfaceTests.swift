import Darwin
import XCTest
@testable import Walnut

/// Phone-side Tailscale detection: the 100.64.0.0/10 boundaries and the
/// interface filter. The live interface list is the host's (the simulator
/// shares the Mac's network stack), so nothing here asserts on it.
final class TailnetInterfaceTests: XCTestCase {
    private func addr(_ dotted: String) -> in_addr {
        var a = in_addr()
        XCTAssertEqual(inet_pton(AF_INET, dotted, &a), 1, "bad fixture \(dotted)")
        return a
    }

    func testCgnatBoundariesOnDottedQuads() {
        XCTAssertFalse(TailnetInterface.isCgnatV4("100.63.255.255"), "one below the range")
        XCTAssertTrue(TailnetInterface.isCgnatV4("100.64.0.0"), "first address")
        XCTAssertTrue(TailnetInterface.isCgnatV4("100.101.102.103"))
        XCTAssertTrue(TailnetInterface.isCgnatV4("100.127.255.255"), "last address")
        XCTAssertFalse(TailnetInterface.isCgnatV4("100.128.0.0"), "one above the range")
    }

    func testOtherAddressesAndGarbageAreNotCgnat() {
        for dotted in ["192.168.1.20", "10.0.0.1", "172.16.0.1", "127.0.0.1", "0.0.0.0", "255.255.255.255", "99.64.0.1", "101.64.0.1"] {
            XCTAssertFalse(TailnetInterface.isCgnatV4(dotted), dotted)
        }
        for junk in ["", "100.64", "100.64.0.0.1", "100.64.0.256", "fd7a:115c:a1e0::1", "mac.example.ts.net"] {
            XCTAssertFalse(TailnetInterface.isCgnatV4(junk), "not a dotted quad: \(junk)")
        }
    }

    func testCgnatBoundariesOnRawAddresses() {
        // s_addr is network byte order: build it from host order explicitly.
        XCTAssertFalse(TailnetInterface.isCgnatV4(in_addr(s_addr: UInt32(0x643F_FFFF).bigEndian)))
        XCTAssertTrue(TailnetInterface.isCgnatV4(in_addr(s_addr: UInt32(0x6440_0000).bigEndian)))
        XCTAssertTrue(TailnetInterface.isCgnatV4(in_addr(s_addr: UInt32(0x647F_FFFF).bigEndian)))
        XCTAssertFalse(TailnetInterface.isCgnatV4(in_addr(s_addr: UInt32(0x6480_0000).bigEndian)))
        XCTAssertTrue(TailnetInterface.isCgnatV4(addr("100.64.0.0")), "inet_pton and the raw form agree")
    }

    func testOnlyAnUpTunnelInterfaceCounts() {
        let tailnet = addr("100.101.102.103")
        XCTAssertTrue(TailnetInterface.hasTailnet(in: [.init(name: "utun3", address: tailnet, isUp: true)]))
        XCTAssertTrue(TailnetInterface.hasTailnet(in: [.init(name: "ipsec0", address: tailnet, isUp: true)]))
        XCTAssertTrue(TailnetInterface.hasTailnet(in: [.init(name: "tun0", address: tailnet, isUp: true)]))
        XCTAssertFalse(TailnetInterface.hasTailnet(in: [.init(name: "pdp_ip0", address: tailnet, isUp: true)]),
                       "a carrier's CGNAT address on the cellular interface is not Tailscale")
        XCTAssertFalse(TailnetInterface.hasTailnet(in: [.init(name: "en0", address: tailnet, isUp: true)]))
        XCTAssertFalse(TailnetInterface.hasTailnet(in: [.init(name: "utun3", address: tailnet, isUp: false)]),
                       "a tunnel that is down carries nothing")
        XCTAssertFalse(TailnetInterface.hasTailnet(in: [.init(name: "utun4", address: addr("10.8.0.2"), isUp: true)]),
                       "another VPN's tunnel outside the range")
        XCTAssertFalse(TailnetInterface.hasTailnet(in: []))
        XCTAssertTrue(TailnetInterface.hasTailnet(in: [
            .init(name: "en0", address: addr("192.168.1.30"), isUp: true),
            .init(name: "pdp_ip0", address: addr("100.70.1.2"), isUp: true),
            .init(name: "utun5", address: tailnet, isUp: true),
        ]))
    }

    func testTheLiveReadRuns() {
        // Exercised for crashes only; its answer is the host's business.
        _ = TailnetInterface.hasTailnetInterface()
    }
}
