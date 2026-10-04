import XCTest
@testable import Walnut

/// RouteCoordinator driven through its Environment: scripted probes, an
/// in-memory route store, no network and no app globals touched.
@MainActor
final class RouteCoordinatorTests: XCTestCase {
    private let lan = ServerRoute(kind: .lan, origin: "http://192.168.1.20:3456", label: "Wi-Fi", instance: "mac-1")
    private let cloud = ServerRoute(kind: .cloud, origin: "https://walnut.example.com", label: "Cloud", instance: "cloud-1")

    /// The world the coordinator sees.
    @MainActor
    final class World {
        var routes: [ServerRoute]
        var current: String?
        var switches: [ServerRoute] = []
        var restarts = 0
        var fetches = 0
        var fetchResult: Result<[ServerRoute], Error> = .success([])
        var fetchHint: TailscaleHint?
        init(routes: [ServerRoute], current: String?) {
            self.routes = routes
            self.current = current
        }
    }

    /// Probe answers by origin, with an optional hold so a test can keep one
    /// selection's probes in flight while a newer selection runs.
    final class ScriptedProbes: @unchecked Sendable {
        private let lock = NSLock()
        private var outcomes: [String: ProbeOutcome] = [:]
        private var holding = false
        private var held: [CheckedContinuation<Void, Never>] = []
        private var calls = 0

        func set(_ route: ServerRoute, _ outcome: ProbeOutcome) {
            lock.withLock { outcomes[route.normalizedOrigin] = outcome }
        }
        func hold(_ on: Bool) { lock.withLock { holding = on } }
        var heldCount: Int { lock.withLock { held.count } }
        var callCount: Int { lock.withLock { calls } }
        func releaseAll() {
            let waiting = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
                let all = held
                held = []
                return all
            }
            waiting.forEach { $0.resume() }
        }

        func probe(_ route: ServerRoute) async -> ProbeOutcome {
            let shouldHold = lock.withLock { () -> Bool in
                calls += 1
                return holding
            }
            if shouldHold {
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                    lock.withLock { held.append(c) }
                }
            }
            return lock.withLock { outcomes[route.normalizedOrigin] ?? .unreachable }
        }
    }

    private func makeCoordinator(_ world: World, _ probes: ScriptedProbes) -> RouteCoordinator {
        let env = RouteCoordinator.Environment(
            routes: { world.routes },
            currentOrigin: { world.current },
            setActive: { route in
                world.current = route.origin
                world.switches.append(route)
            },
            mergeServerRoutes: { server in
                let merged = AppConfig.mergeRoutes(world.routes, server: server)
                guard merged != world.routes else { return false }
                world.routes = merged
                return true
            },
            probe: { await probes.probe($0) },
            fetchRoutes: { @MainActor in
                world.fetches += 1
                return ServerRoutesResponse(routes: try world.fetchResult.get(), tailscale: world.fetchHint)
            },
            restartStreams: { world.restarts += 1 },
            isEnabled: { true },
            now: { Date() }
        )
        return RouteCoordinator(environment: env, monitorsNetworkPath: false)
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { XCTFail("timed out waiting for \(what)"); return }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    // MARK: - Switching

    func testUpgradeFromCloudToWiFiSwitchesAndRestartsStreamsOnce() async {
        let world = World(routes: [lan, cloud], current: cloud.origin)
        let probes = ScriptedProbes()
        probes.set(lan, .ok(instance: "mac-1", latencyMs: 8))
        probes.set(cloud, .ok(instance: "cloud-1", latencyMs: 80))
        let coordinator = makeCoordinator(world, probes)

        let outcome = await coordinator.select(.pathChanged)

        XCTAssertEqual(outcome, .decided(.switchTo(lan)))
        XCTAssertEqual(world.current, lan.origin)
        XCTAssertEqual(world.restarts, 1)
        XCTAssertEqual(coordinator.probes[lan.normalizedOrigin]?.outcome, .ok(instance: "mac-1", latencyMs: 8))
        XCTAssertFalse(coordinator.checking)
    }

    func testWrongBoxAtTheWiFiAddressIsNeverChosen() async {
        let world = World(routes: [lan, cloud], current: cloud.origin)
        let probes = ScriptedProbes()
        probes.set(lan, .ok(instance: "a-strangers-box", latencyMs: 3))
        probes.set(cloud, .ok(instance: "cloud-1", latencyMs: 80))
        let coordinator = makeCoordinator(world, probes)

        let outcome = await coordinator.select(.foreground)

        XCTAssertEqual(outcome, .decided(.stay))
        XCTAssertEqual(world.switches, [])
        XCTAssertEqual(coordinator.probes[lan.normalizedOrigin]?.outcome, .mismatch(instance: "a-strangers-box"))
    }

    /// A selection whose probes come back after a newer one started must not
    /// act on them, even when they would have switched.
    func testResultsOfASupersededSelectionAreDropped() async {
        let world = World(routes: [lan, cloud], current: cloud.origin)
        let probes = ScriptedProbes()
        probes.set(lan, .unreachable)
        probes.set(cloud, .ok(instance: "cloud-1", latencyMs: 80))
        let coordinator = makeCoordinator(world, probes)

        probes.hold(true)
        guard let first = coordinator.trigger(.foreground) else { return XCTFail("first selection did not start") }
        await waitUntil("the first selection's probes to be in flight") { probes.heldCount == 2 }
        probes.hold(false)
        let second = await coordinator.select(.manual)
        XCTAssertEqual(second, .decided(.stay))

        // The held answers now say Wi-Fi is up; the stale selection must ignore them.
        probes.set(lan, .ok(instance: "mac-1", latencyMs: 8))
        probes.releaseAll()
        let firstOutcome = await first.value

        XCTAssertEqual(firstOutcome, .superseded)
        XCTAssertEqual(world.current, cloud.origin)
        XCTAssertEqual(world.switches, [])
        XCTAssertEqual(world.restarts, 0)
    }

    func testTriggerIsDebouncedPerKind() async {
        let world = World(routes: [lan, cloud], current: cloud.origin)
        let probes = ScriptedProbes()
        let coordinator = makeCoordinator(world, probes)

        let a = coordinator.trigger(.foreground)
        XCTAssertNotNil(a)
        XCTAssertNil(coordinator.trigger(.foreground), "second foreground within 2 s is debounced")
        let b = coordinator.trigger(.pathChanged)
        XCTAssertNotNil(b, "another trigger kind is not")
        _ = await a?.value
        _ = await b?.value
    }

    func testASingleRouteNeverStartsASelection() {
        let world = World(routes: [.custom(cloud.origin)], current: cloud.origin)
        let probes = ScriptedProbes()
        let coordinator = makeCoordinator(world, probes)
        XCTAssertNil(coordinator.trigger(.foreground))
        XCTAssertNil(coordinator.trigger(.offline))
        XCTAssertEqual(probes.callCount, 0)
    }

    func testSuspendedCoordinatorDoesNothing() {
        let world = World(routes: [lan, cloud], current: cloud.origin)
        let coordinator = makeCoordinator(world, ScriptedProbes())
        coordinator.suspend()
        XCTAssertNil(coordinator.trigger(.pathChanged))
    }

    // MARK: - 401

    func testRefusedTokenOnWiFiMovesToCloudInsteadOfUnpairing() async {
        let world = World(routes: [lan, cloud], current: lan.origin)
        let probes = ScriptedProbes()
        probes.set(lan, .ok(instance: "mac-1", latencyMs: 8))
        probes.set(cloud, .ok(instance: "cloud-1", latencyMs: 80))
        let coordinator = makeCoordinator(world, probes)

        let rerouted = await coordinator.recoverFromRejectedToken(origin: lan.origin)

        XCTAssertTrue(rerouted, "another route still takes the token: do not disconnect")
        XCTAssertEqual(world.current, cloud.origin)
        XCTAssertEqual(coordinator.probes[lan.normalizedOrigin]?.outcome, .rejected401)
        XCTAssertTrue(coordinator.rejectedOrigins().contains(lan.normalizedOrigin))

        // The refusal sticks: the next foreground does not go back to Wi-Fi.
        let next = await coordinator.select(.foreground)
        XCTAssertEqual(next, .decided(.stay))
        XCTAssertEqual(world.current, cloud.origin)
    }

    func testRefusedTokenWithNoOtherQualifyingRouteFallsThroughToDisconnect() async {
        let world = World(routes: [lan, cloud], current: lan.origin)
        let probes = ScriptedProbes()
        probes.set(lan, .ok(instance: "mac-1", latencyMs: 8))
        probes.set(cloud, .unreachable)
        let coordinator = makeCoordinator(world, probes)

        let rerouted = await coordinator.recoverFromRejectedToken(origin: lan.origin)

        XCTAssertFalse(rerouted)
        XCTAssertEqual(world.current, lan.origin)
    }

    func testRefusedTokenOnTheOnlyRouteFallsThroughToDisconnect() async {
        let world = World(routes: [.custom(lan.origin)], current: lan.origin)
        let probes = ScriptedProbes()
        let coordinator = makeCoordinator(world, probes)

        let rerouted = await coordinator.recoverFromRejectedToken(origin: lan.origin)

        XCTAssertFalse(rerouted)
        XCTAssertEqual(probes.callCount, 0, "nothing to probe with one route")
    }

    func testRefusalForARouteAlreadyLeftDoesNotDisconnect() async {
        let world = World(routes: [lan, cloud], current: cloud.origin)
        let coordinator = makeCoordinator(world, ScriptedProbes())
        let rerouted = await coordinator.recoverFromRejectedToken(origin: lan.origin)
        XCTAssertTrue(rerouted)
        XCTAssertEqual(world.current, cloud.origin)
    }

    func testResetForgetsRefusals() async {
        let world = World(routes: [lan, cloud], current: lan.origin)
        let probes = ScriptedProbes()
        probes.set(cloud, .ok(instance: "cloud-1", latencyMs: 80))
        let coordinator = makeCoordinator(world, probes)
        _ = await coordinator.recoverFromRejectedToken(origin: lan.origin)
        XCTAssertFalse(coordinator.rejectedOrigins().isEmpty)
        coordinator.reset()
        XCTAssertTrue(coordinator.rejectedOrigins().isEmpty)
        XCTAssertTrue(coordinator.probes.isEmpty)
    }

    // MARK: - Route list

    func testStatusSuccessLearnsRoutesThenUpgrades() async {
        let paired = ServerRoute.custom(cloud.origin)
        let world = World(routes: [paired], current: cloud.origin)
        world.fetchResult = .success([lan, cloud])
        let probes = ScriptedProbes()
        probes.set(lan, .ok(instance: "mac-1", latencyMs: 8))
        probes.set(cloud, .ok(instance: "cloud-1", latencyMs: 80))
        let coordinator = makeCoordinator(world, probes)

        coordinator.statusSucceeded()
        await waitUntil("the upgrade to Wi-Fi") { world.current == lan.origin }

        XCTAssertEqual(world.fetches, 1)
        XCTAssertEqual(world.routes, [lan, cloud], "the paired custom origin is the server's cloud route")
        XCTAssertEqual(coordinator.routes, [lan, cloud])
        XCTAssertEqual(world.restarts, 1)

        // The rate limit is per origin: the new route reads the list once...
        coordinator.statusSucceeded()
        await waitUntil("the read on the new origin") { world.fetches == 2 }
        // ...and with several routes known, not again for 10 minutes.
        try? await Task.sleep(for: .milliseconds(50))
        coordinator.statusSucceeded()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(world.fetches, 2)
        XCTAssertEqual(world.restarts, 1, "an unchanged list does not reselect")
    }

    func testOldServerWithoutRoutesIsIgnoredAndNotAskedEveryTime() async {
        let paired = ServerRoute.custom(lan.origin)
        let world = World(routes: [paired], current: lan.origin)
        world.fetchResult = .failure(APIError.server(status: 404, code: "not_found", message: "Not found",
                                                     serverHash: nil, serverContent: nil))
        let coordinator = makeCoordinator(world, ScriptedProbes())

        coordinator.statusSucceeded()
        await waitUntil("the route list read") { world.fetches == 1 }
        try? await Task.sleep(for: .milliseconds(50))
        coordinator.statusSucceeded()
        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(world.fetches, 1)
        XCTAssertEqual(world.routes, [paired], "the single paired route is kept")
        XCTAssertEqual(world.switches, [])
    }

    /// The Mac's Tailscale hint rides the route list: kept, kept across a list
    /// without one, never a reselect, forgotten with the pairing.
    func testRouteListKeepsTheTailscaleHintWithoutReselecting() async {
        let paired = ServerRoute.custom(lan.origin)
        let world = World(routes: [paired], current: lan.origin)
        world.fetchResult = .success([])
        world.fetchHint = TailscaleHint(installed: false, running: false)
        let probes = ScriptedProbes()
        let coordinator = makeCoordinator(world, probes)
        XCTAssertNil(coordinator.tailscaleHint)

        coordinator.statusSucceeded()
        await waitUntil("the hint") { coordinator.tailscaleHint != nil }
        XCTAssertEqual(coordinator.tailscaleHint, TailscaleHint(installed: false, running: false))
        XCTAssertEqual(probes.callCount, 0, "a hint alone never starts a selection")
        XCTAssertEqual(world.switches, [])

        // On the cloud now: the replica's list has no hint, and the Mac's last word stays.
        world.current = cloud.origin
        world.fetchHint = nil
        coordinator.statusSucceeded()
        await waitUntil("the replica's list") { world.fetches == 2 }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(coordinator.tailscaleHint, TailscaleHint(installed: false, running: false))

        coordinator.reset()
        XCTAssertNil(coordinator.tailscaleHint, "a new pairing forgets the old Mac's hint")
    }

    // MARK: - Network path

    func testFirstPathSampleIsABaselineNotAChange() {
        let world = World(routes: [lan, cloud], current: cloud.origin)
        let probes = ScriptedProbes()
        let coordinator = makeCoordinator(world, probes)
        coordinator.pathUpdated("up|wifi/en0")
        coordinator.pathUpdated("up|wifi/en0")
        XCTAssertEqual(probes.callCount, 0)
    }
}
