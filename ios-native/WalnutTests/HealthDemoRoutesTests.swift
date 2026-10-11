import XCTest
@testable import Walnut

/// The demo answers the four Apple Health routes through the app's real client,
/// and a sync run in the demo never reads HealthKit.
@MainActor
final class HealthDemoRoutesTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private let api = WalnutAPI()

    override func setUp() async throws {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.reset()
        DemoURLProtocol.resetLog()
    }

    override func tearDown() async throws {
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    func testEveryHealthRouteHasAnAnswer() async throws {
        let status = try await api.healthStatus(timeout: 30)
        XCTAssertEqual(status.storeId, "hs-demo")
        XCTAssertEqual(status.paused, false)
        XCTAssertNotNil(status.coverage?.from, "a believable history")
        XCTAssertNotNil(status.supported?.generic)
        XCTAssertEqual(Set(status.supported?.raw ?? []), Set(HealthTypeCatalog.catalogSpecs.filter { $0.kind == .raw }.map(\.name)))

        let header = try JSONEncoder().encode(HealthSyncHeader(
            spec: try XCTUnwrap(HealthTypeCatalog.spec(named: "sleep")), storeId: "hs-demo", device: nil, tz: "UTC"
        ))
        let item = HealthBatcher.encode([HealthWireSample(uuid: "U1", start: "2026-09-20T23:00:00+00:00",
                                                          end: "2026-09-21T01:00:00+00:00", code: 3)])
        let body = HealthBatcher.batches(header: header, itemsKey: "samples", items: item, deleted: [])[0].body
        guard case .ok(let result) = try await api.healthSync(body: body, timeout: 30) else {
            return XCTFail("sync must answer 200")
        }
        XCTAssertEqual(result.accepted, 1)
        XCTAssertTrue(result.stored)

        let paused = try await api.healthSetPaused(true)
        XCTAssertEqual(paused.paused, true)
        let pausedStatus = try await api.healthStatus(timeout: 30)
        XCTAssertEqual(pausedStatus.paused, true)
        _ = try await api.healthSetPaused(false)

        let deleted = try await api.healthDeleteData()
        XCTAssertNotEqual(deleted.storeId, "hs-demo", "a delete rotates the store id")
        XCTAssertEqual(deleted.paused, true)
        // The phone still names the old store: 409, as on a real Mac.
        guard case .storeMismatch(let newId) = try await api.healthSync(body: body, timeout: 30) else {
            return XCTFail("an old store id must answer store_mismatch")
        }
        XCTAssertEqual(newId, deleted.storeId)

        XCTAssertEqual(DemoServer.shared.unansweredRoutes, [], "every health route has a demo answer")
        XCTAssertEqual(DemoURLProtocol.blockedByTheCodeUnderTest, [], "nothing went to any other host")
    }

    func testADemoRunUsesOnlyTheDemoServerAndNeverHealthKit() async throws {
        let source = FakeHealthSource()
        source.failIfTouched = true
        let clock = FakeHealthClock(Date())
        let engine = HealthSyncEngine(
            source: source, transport: WalnutHealthTransport(api: api), state: HealthSyncStateStore(fileURL: nil),
            environment: .test(clock: clock, demo: true), salt: MemoryHealthSalt()
        )
        let outcome = await engine.run(reason: "demo", budget: 30)
        XCTAssertEqual(outcome, .synced)
        XCTAssertEqual(source.forbiddenTouches, 0)
        XCTAssertEqual(DemoServer.shared.unansweredRoutes, [])
    }
}
