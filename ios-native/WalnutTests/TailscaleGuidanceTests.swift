import XCTest
@testable import Walnut

/// The Connection screen's Tailscale advice: every branch of
/// `TailscaleGuidance.derive`, the muted (footnote) flag, and the exact copy.
final class TailscaleGuidanceTests: XCTestCase {
    private let lan = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "mac-1")
    private let tailnet = ServerRoute(kind: .tailnet, origin: "http://100.101.102.103:3456", label: "Tailscale", instance: "mac-1")
    private let tailnetName = ServerRoute(kind: .tailnet, origin: "http://mac.example.ts.net:3456", label: "Tailscale", instance: "mac-1")
    private let cloud = ServerRoute(kind: .cloud, origin: "https://walnut.example.com", label: "Cloud", instance: "cloud-1")

    private let notInstalled = TailscaleHint(installed: false, running: false)
    private let stopped = TailscaleHint(installed: true, running: false)
    private let healthy = TailscaleHint(installed: true, running: true, dnsName: "mac.example.ts.net")

    private func derive(
        _ routes: [ServerRoute],
        probes: [String: ProbeOutcome] = [:],
        hint: TailscaleHint? = nil,
        phone: Bool = false,
        online: Bool = false,
        active: ServerRoute.Kind? = .cloud
    ) -> TailscaleGuidance {
        TailscaleGuidance.derive(
            routes: routes, probes: probes, hint: hint,
            phoneHasTailnet: phone, online: online, activeKind: active
        )
    }

    private func ok(_ route: ServerRoute) -> [String: ProbeOutcome] {
        [route.origin: .ok(instance: route.instance, latencyMs: 40)]
    }

    // MARK: - No tailnet route: only the Mac's hint speaks

    func testNoTailnetRouteAndNoHintSaysNothing() {
        XCTAssertEqual(derive([lan, cloud]), .none, "the app has no idea: say nothing")
        XCTAssertEqual(derive([]), .none)
        XCTAssertEqual(derive([lan, cloud], phone: true, online: true), .none)
    }

    func testNoTailnetRouteAndTailscaleMissingOnTheMac() {
        XCTAssertEqual(derive([lan, cloud], hint: notInstalled).kind, .setUpOnMac)
        XCTAssertEqual(derive([cloud], hint: notInstalled, phone: true).kind, .setUpOnMac,
                       "the phone having Tailscale does not help a Mac without it")
    }

    func testNoTailnetRouteAndTailscaleStoppedOnTheMac() {
        XCTAssertEqual(derive([lan, cloud], hint: stopped).kind, .setUpOnMac)
    }

    func testNoTailnetRouteAndAHealthyMacSaysNothing() {
        XCTAssertEqual(derive([lan, cloud], hint: healthy), .none, "nothing the user can act on")
    }

    func testPartialHints() {
        XCTAssertEqual(derive([cloud], hint: TailscaleHint(running: false)).kind, .setUpOnMac,
                       "not running is enough to say so")
        XCTAssertEqual(derive([cloud], hint: TailscaleHint(installed: false)).kind, .setUpOnMac)
        XCTAssertEqual(derive([cloud], hint: TailscaleHint(installed: true)), .none,
                       "installed with running unsaid is not a reason to nag")
        XCTAssertEqual(derive([cloud], hint: TailscaleHint(dnsName: "mac.example.ts.net")), .none)
    }

    // MARK: - A tailnet route exists

    func testAReachableTailnetRouteSaysNothing() {
        XCTAssertEqual(derive([lan, tailnet, cloud], probes: ok(tailnet)), .none)
        XCTAssertEqual(derive([lan, tailnet, cloud], probes: ok(tailnet), hint: notInstalled, phone: false), .none,
                       "an answer outranks both the hint and the phone check")
    }

    func testOneReachableTailnetRouteOfTwoIsEnough() {
        var probes = ok(tailnetName)
        probes[tailnet.origin] = .unreachable
        XCTAssertEqual(derive([tailnet, tailnetName, cloud], probes: probes, phone: true), .none)
    }

    func testTalkingThroughTailscaleRightNowSaysNothing() {
        XCTAssertEqual(derive([tailnet, cloud], online: true, active: .tailnet), .none,
                       "online on the tailnet route, even before its first probe")
    }

    func testNoTunnelOnThePhoneAsksToInstallTailscale() {
        let g = derive([lan, tailnet, cloud], probes: [tailnet.origin: .unreachable], phone: false)
        XCTAssertEqual(g.kind, .installOnPhone)
        XCTAssertFalse(g.isMuted)
        XCTAssertEqual(g.actionTitle, "Get Tailscale")
        XCTAssertEqual(g.actionURL?.absoluteString, "https://apps.apple.com/app/tailscale/id1470499037")
    }

    func testNoTunnelOnThePhoneAsksToInstallEvenBeforeTheFirstProbe() {
        XCTAssertEqual(derive([tailnet, cloud], probes: [:], phone: false).kind, .installOnPhone,
                       "without a tunnel the route cannot work, checked or not")
    }

    func testTheHintDoesNotMatterOnceATailnetRouteExists() {
        XCTAssertEqual(derive([tailnet, cloud], probes: [tailnet.origin: .unreachable], hint: notInstalled).kind,
                       .installOnPhone, "the route list is newer evidence than a no from the Mac")
    }

    func testTunnelUpButNoAnswerAsksToCheckTheConnection() {
        let g = derive([lan, tailnet, cloud], probes: [tailnet.origin: .unreachable], phone: true)
        XCTAssertEqual(g.kind, .turnOnOrSameAccount)
        XCTAssertNil(g.actionTitle)
        XCTAssertNil(g.actionURL)
    }

    func testTunnelUpAndAnotherBoxAnsweredAsksToCheckTheAccount() {
        XCTAssertEqual(derive([tailnet, cloud], probes: [tailnet.origin: .mismatch(instance: "someone-else")], phone: true).kind,
                       .turnOnOrSameAccount)
    }

    func testTunnelUpButNeverCheckedSaysNothingYet() {
        XCTAssertEqual(derive([tailnet, cloud], probes: [:], phone: true), .none,
                       "'did not answer' is only said once a probe said so")
        XCTAssertEqual(derive([tailnet, cloud], probes: ok(cloud), phone: true), .none)
    }

    func testARefusedTokenIsNotATailscaleProblem() {
        XCTAssertEqual(derive([tailnet, cloud], probes: [tailnet.origin: .rejected401], phone: true), .none)
        XCTAssertEqual(derive([tailnet, cloud], probes: [tailnet.origin: .rejected401], phone: false), .none)
    }

    func testProbesAreMatchedByNormalizedOrigin() {
        XCTAssertEqual(derive([tailnet, cloud], probes: ["HTTP://100.101.102.103:3456/": .ok(instance: "mac-1", latencyMs: 9)]),
                       .none)
        XCTAssertEqual(derive([tailnet, cloud], probes: ["http://100.101.102.103:3456/": .unreachable], phone: true).kind,
                       .turnOnOrSameAccount)
    }

    // MARK: - Muted on the Mac's Wi-Fi

    func testAdviceIsMutedWhileTheWiFiRouteIsInUseAndAnswers() {
        let install = derive([lan, tailnet, cloud], probes: [tailnet.origin: .unreachable], online: true, active: .lan)
        XCTAssertEqual(install, TailscaleGuidance(kind: .installOnPhone, isMuted: true),
                       "still shown at home: it is about leaving the house")
        XCTAssertEqual(derive([lan, cloud], hint: notInstalled, online: true, active: .lan),
                       TailscaleGuidance(kind: .setUpOnMac, isMuted: true))
        XCTAssertEqual(derive([lan, tailnet], probes: [tailnet.origin: .unreachable], phone: true, online: true, active: .lan),
                       TailscaleGuidance(kind: .turnOnOrSameAccount, isMuted: true))
    }

    func testAdviceIsProminentAwayFromTheWiFi() {
        let probes: [String: ProbeOutcome] = [tailnet.origin: .unreachable]
        XCTAssertFalse(derive([lan, tailnet, cloud], probes: probes, online: false, active: .lan).isMuted,
                       "the Wi-Fi route is in use but not answering: the user is likely away")
        XCTAssertFalse(derive([lan, tailnet, cloud], probes: probes, online: true, active: .cloud).isMuted)
        XCTAssertFalse(derive([lan, tailnet, cloud], probes: probes, online: true, active: .custom).isMuted)
        XCTAssertFalse(derive([lan, tailnet, cloud], probes: probes, online: true, active: nil).isMuted)
        XCTAssertFalse(derive([lan, tailnet, cloud], probes: probes, online: false, active: nil).isMuted)
    }

    func testNothingToSayIsNeverMuted() {
        XCTAssertEqual(derive([lan, cloud], online: true, active: .lan), TailscaleGuidance(kind: .none, isMuted: false))
    }

    // MARK: - Copy

    func testCopy() {
        XCTAssertNil(TailscaleGuidance.none.text)
        XCTAssertNil(TailscaleGuidance.none.actionTitle)
        XCTAssertEqual(TailscaleGuidance(kind: .setUpOnMac, isMuted: false).text,
                       "To reach this Mac from anywhere without the cloud, set up Tailscale on it: Walnut on the Mac, Settings, Phones & Cloud.")
        XCTAssertEqual(TailscaleGuidance(kind: .installOnPhone, isMuted: false).text,
                       "Install Tailscale on this iPhone and sign in with the same account as on the Mac. Walnut then reaches the Mac from anywhere.")
        XCTAssertEqual(TailscaleGuidance(kind: .turnOnOrSameAccount, isMuted: false).text,
                       "The Tailscale route did not answer. Check that Tailscale is connected on this iPhone, that both devices use the same account, and that the Mac is awake.")
        XCTAssertNil(TailscaleGuidance(kind: .setUpOnMac, isMuted: false).actionTitle, "the Mac-side fix has no phone action")
        for kind in TailscaleGuidance.Kind.allCases {
            let text = TailscaleGuidance(kind: kind, isMuted: false).text ?? ""
            XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}"), "no em or en dash in \(kind)")
        }
    }

    func testDeriveIsDeterministic() {
        let probes: [String: ProbeOutcome] = [tailnet.origin: .unreachable, lan.origin: .ok(instance: "mac-1", latencyMs: 4)]
        let first = derive([lan, tailnet, cloud], probes: probes, hint: stopped, phone: true, online: true, active: .lan)
        for _ in 0..<20 {
            XCTAssertEqual(derive([lan, tailnet, cloud], probes: probes, hint: stopped, phone: true, online: true, active: .lan), first)
        }
    }
}
