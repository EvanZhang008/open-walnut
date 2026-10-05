import XCTest
@testable import Walnut

/// The demo answers the three Places routes through the app's real client: the
/// visits stop inside the app, and a reset forgets them.
@MainActor
final class PlacesDemoRoutesTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?

    override func setUp() async throws {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.reset()
    }

    override func tearDown() async throws {
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    func testEveryPlacesRouteHasAnAnswer() async throws {
        let transport = WalnutPlacesTransport()
        let empty = try await transport.placesStatus(timeout: 30)
        XCTAssertEqual(empty.visitCount, 0)
        XCTAssertEqual(empty.recording, false)

        let record = PlaceVisitRecord(id: "v-1", arrival: Date(timeIntervalSince1970: 1_790_000_000), departure: nil,
                                      latitude: 38.7, longitude: -9.1, accuracyM: 30, timeZoneId: "UTC",
                                      recordedAt: Date())
        let body = PlacesSyncEngine.body([record], zone: "UTC", state: PlacesPhoneState(enabled: true, access: .always))
        guard case .ok(let result) = try await transport.placesSync(body: body, timeout: 30) else {
            return XCTFail("the demo stores the visit")
        }
        XCTAssertEqual(result.inserted, 1)
        let after = try await transport.placesStatus(timeout: 30)
        XCTAssertEqual(after.visitCount, 1)
        XCTAssertEqual(after.recording, true)

        let deleted = try await transport.placesDeleteData()
        XCTAssertEqual(deleted.removed, 1)
        _ = try await transport.placesSync(body: body, timeout: 30)
        DemoServer.shared.reset()
        let reset = try await transport.placesStatus(timeout: 30)
        XCTAssertEqual(reset.visitCount, 0)
    }
}
