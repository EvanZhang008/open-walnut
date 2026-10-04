import XCTest
@testable import Walnut

/// The route choice is a pure decision table: which known route the app talks
/// through, given what the unauthenticated identity probes saw. These cases are
/// the table (multi-route connection).
final class RouteSelectorTests: XCTestCase {
    private let custom = ServerRoute(kind: .custom, origin: "http://127.0.0.1:13456", label: "Custom")
    private let lan = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "mac-1")
    private let tailnet = ServerRoute(kind: .tailnet, origin: "http://100.101.102.103:3456", label: "Tailscale", instance: "mac-1")
    private let cloud = ServerRoute(kind: .cloud, origin: "https://walnut.example.com", label: "Cloud", instance: "cloud-1")

    private func ok(_ instance: String?, _ ms: Int = 12) -> ProbeOutcome { .ok(instance: instance, latencyMs: ms) }

    private func choose(
        _ routes: [ServerRoute],
        _ probes: [ServerRoute: ProbeOutcome],
        current: ServerRoute?,
        rejected: Set<String> = []
    ) -> RouteSelector.Decision {
        RouteSelector.choose(
            routes: routes,
            probes: Dictionary(uniqueKeysWithValues: probes.map { ($0.key.origin, $0.value) }),
            current: current?.origin,
            rejected: rejected
        )
    }

    // MARK: - Decision table

    func testSingleCloudRouteOkStays() {
        XCTAssertEqual(choose([cloud], [cloud: ok("cloud-1")], current: cloud), .stay)
    }

    func testOnCloudAndWiFiAnswersUpgradesToWiFi() {
        XCTAssertEqual(choose([lan, cloud], [lan: ok("mac-1"), cloud: ok("cloud-1")], current: cloud), .switchTo(lan))
    }

    func testOnWiFiWithCloudAlsoOkStays() {
        XCTAssertEqual(choose([lan, cloud], [lan: ok("mac-1"), cloud: ok("cloud-1")], current: lan), .stay)
    }

    func testWiFiGoneFallsToTailscale() {
        XCTAssertEqual(
            choose([lan, tailnet, cloud], [lan: .unreachable, tailnet: ok("mac-1"), cloud: ok("cloud-1")], current: lan),
            .switchTo(tailnet)
        )
    }

    func testWiFiAndTailscaleGoneFallsToCloud() {
        XCTAssertEqual(
            choose([lan, tailnet, cloud], [lan: .unreachable, tailnet: .unreachable, cloud: ok("cloud-1")], current: lan),
            .switchTo(cloud)
        )
    }

    /// A stranger's box at the same LAN address answers fine, but it is not
    /// the paired Walnut: it must never be chosen (it would get the token).
    func testInstanceMismatchExcludesAnAnsweringRoute() {
        XCTAssertEqual(choose([lan, cloud], [lan: ok("someone-else"), cloud: ok("cloud-1")], current: cloud), .stay)
        XCTAssertEqual(choose([lan, cloud], [lan: .mismatch(instance: "x"), cloud: ok("cloud-1")], current: cloud), .stay)
        // An old server that cannot say who it is does not prove identity either.
        XCTAssertEqual(choose([lan, cloud], [lan: ok(nil), cloud: ok("cloud-1")], current: cloud), .stay)
    }

    func testRejectedOriginIsExcludedEvenWhenItAnswers() {
        XCTAssertEqual(
            choose([lan, cloud], [lan: ok("mac-1"), cloud: ok("cloud-1")], current: lan, rejected: [lan.origin]),
            .switchTo(cloud)
        )
        // Spelling of the rejected origin does not matter.
        XCTAssertEqual(
            choose([lan, cloud], [lan: ok("mac-1"), cloud: ok("cloud-1")], current: cloud,
                   rejected: ["HTTP://192.168.1.20:3456/"]),
            .stay
        )
    }

    func testRejected401ProbeDoesNotQualify() {
        XCTAssertEqual(choose([lan, cloud], [lan: .rejected401, cloud: ok("cloud-1")], current: lan), .switchTo(cloud))
    }

    func testNothingAnswersIsNone() {
        XCTAssertEqual(choose([lan, cloud], [lan: .unreachable, cloud: .unreachable], current: cloud), .none)
        XCTAssertEqual(choose([lan, cloud], [:], current: cloud), .none)
        XCTAssertEqual(choose([], [:], current: nil), .none)
    }

    func testCustomBeatsWiFi() {
        XCTAssertEqual(choose([custom, lan], [custom: ok("mac-1"), lan: ok("mac-1")], current: lan), .switchTo(custom))
        XCTAssertEqual(choose([custom, lan], [custom: ok("mac-1"), lan: ok("mac-1")], current: custom), .stay)
    }

    /// The custom route names no instance (the user typed it), so whoever
    /// answers there qualifies, an old server included.
    func testCustomWithoutInstanceAcceptsAnyAnswer() {
        XCTAssertEqual(choose([custom, cloud], [custom: ok(nil), cloud: ok("cloud-1")], current: cloud), .switchTo(custom))
    }

    func testCurrentNotAKnownRouteSwitchesToBest() {
        XCTAssertEqual(
            RouteSelector.choose(routes: [lan, cloud], probes: [cloud.origin: ok("cloud-1")],
                                 current: "http://192.168.1.99:3456", rejected: []),
            .switchTo(cloud)
        )
        XCTAssertEqual(
            RouteSelector.choose(routes: [lan, cloud], probes: [lan.origin: ok("mac-1")], current: nil, rejected: []),
            .switchTo(lan)
        )
    }

    /// Two Wi-Fi origins (ethernet + Wi-Fi on the Mac): a same-kind sibling is
    /// not an upgrade, so the app does not churn its streams between them.
    func testSameKindSiblingIsNotAnUpgrade() {
        let lan2 = ServerRoute(kind: .lan, origin: "http://192.168.1.21:3456", label: "Wi-Fi", instance: "mac-1")
        XCTAssertEqual(choose([lan, lan2, cloud], [lan: ok("mac-1"), lan2: ok("mac-1")], current: lan2), .stay)
        XCTAssertEqual(
            choose([lan, lan2, cloud], [lan: ok("mac-1"), lan2: ok("mac-1"), cloud: ok("cloud-1")], current: cloud),
            .switchTo(lan), "list order breaks a tie within one kind"
        )
    }

    /// The best route is refused; the current, worse one still qualifies.
    func testCurrentStaysWhenTheBetterRouteIsRejected() {
        XCTAssertEqual(
            choose([lan, cloud], [lan: ok("mac-1"), cloud: ok("cloud-1")], current: cloud, rejected: [lan.origin]),
            .stay
        )
    }

    func testProbeKeysAreNormalized() {
        XCTAssertEqual(
            RouteSelector.choose(routes: [lan, cloud], probes: ["http://192.168.1.20:3456/": ok("mac-1")],
                                 current: cloud.origin, rejected: []),
            .switchTo(lan)
        )
    }

    // MARK: - classify

    func testClassifyTurnsWrongInstanceIntoMismatch() {
        XCTAssertEqual(RouteSelector.classify(ok("other"), expected: "mac-1"), .mismatch(instance: "other"))
        XCTAssertEqual(RouteSelector.classify(ok(nil), expected: "mac-1"), .mismatch(instance: nil))
        XCTAssertEqual(RouteSelector.classify(ok("mac-1", 7), expected: "mac-1"), ok("mac-1", 7))
        XCTAssertEqual(RouteSelector.classify(ok("any"), expected: nil), ok("any"))
        XCTAssertEqual(RouteSelector.classify(.unreachable, expected: "mac-1"), .unreachable)
    }

    // MARK: - Debounce

    func testDebounceAllowsOnePerTwoSecondsPerTrigger() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var last: [RouteTrigger: Date] = [:]
        XCTAssertTrue(RouteSelector.shouldReselect(trigger: .foreground, lastRunAt: last, now: t0), "first run")
        last[.foreground] = t0
        XCTAssertFalse(RouteSelector.shouldReselect(trigger: .foreground, lastRunAt: last, now: t0.addingTimeInterval(1.9)))
        XCTAssertTrue(RouteSelector.shouldReselect(trigger: .foreground, lastRunAt: last, now: t0.addingTimeInterval(2)))
        // Kinds are independent.
        XCTAssertTrue(RouteSelector.shouldReselect(trigger: .pathChanged, lastRunAt: last, now: t0.addingTimeInterval(0.1)))
        for trigger in RouteTrigger.allCases where trigger != .foreground {
            XCTAssertTrue(RouteSelector.shouldReselect(trigger: trigger, lastRunAt: last, now: t0), "\(trigger)")
        }
    }

    // MARK: - Route list refresh cadence

    func testRoutesFetchCadence() {
        let t0 = Date(timeIntervalSince1970: 5_000)
        XCTAssertTrue(RouteSelector.routesFetchDue(lastFetchAt: nil, serverLacksRoutes: false, routeCount: 3, now: t0))
        // Several routes known: every 10 minutes.
        XCTAssertFalse(RouteSelector.routesFetchDue(lastFetchAt: t0, serverLacksRoutes: false, routeCount: 3,
                                                    now: t0.addingTimeInterval(599)))
        XCTAssertTrue(RouteSelector.routesFetchDue(lastFetchAt: t0, serverLacksRoutes: false, routeCount: 3,
                                                   now: t0.addingTimeInterval(600)))
        // One route known (fresh pairing): right away, past a 30 s burst floor.
        XCTAssertFalse(RouteSelector.routesFetchDue(lastFetchAt: t0, serverLacksRoutes: false, routeCount: 1,
                                                    now: t0.addingTimeInterval(5)))
        XCTAssertTrue(RouteSelector.routesFetchDue(lastFetchAt: t0, serverLacksRoutes: false, routeCount: 1,
                                                   now: t0.addingTimeInterval(30)))
        // An old server (404) is only asked on the slow interval.
        XCTAssertFalse(RouteSelector.routesFetchDue(lastFetchAt: t0, serverLacksRoutes: true, routeCount: 1,
                                                    now: t0.addingTimeInterval(120)))
        XCTAssertTrue(RouteSelector.routesFetchDue(lastFetchAt: t0, serverLacksRoutes: true, routeCount: 1,
                                                   now: t0.addingTimeInterval(600)))
    }

    // MARK: - Settings copy

    func testProbeDisplay() {
        XCTAssertEqual(RouteProbeDisplay.from(nil, rejected: false), .notChecked)
        XCTAssertEqual(RouteProbeDisplay.from(ok("mac-1", 23), rejected: false), .reachable(latencyMs: 23))
        XCTAssertEqual(RouteProbeDisplay.from(ok("mac-1", 23), rejected: false).text, "Reachable · 23 ms")
        XCTAssertEqual(RouteProbeDisplay.from(.mismatch(instance: "x"), rejected: false), .wrongServer)
        XCTAssertEqual(RouteProbeDisplay.from(.unreachable, rejected: false), .unreachable)
        XCTAssertEqual(RouteProbeDisplay.from(.rejected401, rejected: false), .tokenRefused)
        XCTAssertEqual(RouteProbeDisplay.from(ok("mac-1"), rejected: true), .tokenRefused,
                       "the probe carries no token, so a refusing box still answers it")
        XCTAssertEqual(RouteProbeDisplay.summary(route: lan, online: true), "Connected via Wi-Fi · 192.168.1.20:3456")
        XCTAssertEqual(RouteProbeDisplay.summary(route: cloud, online: true), "Connected via Cloud · walnut.example.com")
        XCTAssertEqual(RouteProbeDisplay.summary(route: tailnet, online: false), "Trying Tailscale · 100.101.102.103:3456")
        XCTAssertEqual(RouteProbeDisplay.summary(route: .custom("localhost:3456"), online: true),
                       "Connected via Custom · localhost:3456")
    }
}
