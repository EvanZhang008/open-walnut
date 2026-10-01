import Foundation
import XCTest
@testable import Walnut

/// Disconnect tells the paired server to drop this install's push token
/// (`DELETE /api/push/register {token}`), then stops APNs delivery, and never
/// waits on the server to do it. Before this, Disconnect only reset local state:
/// the old server kept the row and the phone kept getting its notifications.
@MainActor
final class PushUnregisterTests: XCTestCase {
    private let server = URL(string: "https://walnut.example.net")!
    private var savedURL: URL?
    private var savedToken: String?
    private var savedMemo: String?

    override func setUp() async throws {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        savedMemo = UserDefaults.standard.string(forKey: PushRegistration.uploadedTokenKey)
        AppConfig.processServerURLOverride = server
        AppConfig.processTokenOverride = "device-bearer-1"
        UserDefaults.standard.set(
            PushRegistration.uploadMemo(token: "abc123", server: server),
            forKey: PushRegistration.uploadedTokenKey
        )
    }

    override func tearDown() async throws {
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
        if let savedMemo {
            UserDefaults.standard.set(savedMemo, forKey: PushRegistration.uploadedTokenKey)
        } else {
            UserDefaults.standard.removeObject(forKey: PushRegistration.uploadedTokenKey)
        }
    }

    private final class Calls {
        var made: [PushRegistration.Unregistration] = []
    }

    private func registration(
        _ system: PushPermissionGateTests.FakeSystem,
        unregister: @escaping PushRegistration.Unregister
    ) -> PushRegistration {
        PushRegistration(
            system: system,
            fetchStatus: { throw APIError.network(underlying: URLError(.notConnectedToInternet)) },
            unregister: unregister
        )
    }

    func testAReachableServerIsToldWithThePairingDisconnectIsAboutToClear() async {
        let system = PushPermissionGateTests.FakeSystem()
        let calls = Calls()
        let push = registration(system) { call in calls.made.append(call) }

        let call = push.unregisterFromServer()
        // Disconnect clears the pairing right after this returns; the call
        // already holds what it needs.
        AppConfig.processServerURLOverride = URL(string: "https://somewhere-else.example.net")
        AppConfig.processTokenOverride = "a-later-pairing"
        await call?.value

        XCTAssertEqual(calls.made, [
            PushRegistration.Unregistration(token: "abc123", server: server, bearer: "device-bearer-1"),
        ])
        XCTAssertEqual(system.unregistrations, 1, "APNs delivery to this install stops")
        XCTAssertNil(UserDefaults.standard.string(forKey: PushRegistration.uploadedTokenKey),
                     "the upload memo goes too, so the next pairing uploads its token again")
    }

    func testAnUnreachableServerNeverHoldsUpDisconnect() async {
        let system = PushPermissionGateTests.FakeSystem()
        // A server that never answers.
        let push = registration(system) { _ in try await Task.sleep(for: .seconds(30)) }
        push.unregisterDeadline = 0.2

        let started = Date()
        let call = push.unregisterFromServer()
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.1, "Disconnect does not wait for the server")
        XCTAssertNotNil(call)
        XCTAssertEqual(system.unregistrations, 1, "APNs delivery stops whether or not the server answers")
        await call?.value
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "the call is abandoned at its deadline")
    }

    func testARefusedCallStillEndsQuietly() async {
        let system = PushPermissionGateTests.FakeSystem()
        let push = registration(system) { _ in throw APIError.network(underlying: URLError(.cannotConnectToHost)) }
        await push.unregisterFromServer()?.value
        XCTAssertEqual(system.unregistrations, 1)
        XCTAssertNil(UserDefaults.standard.string(forKey: PushRegistration.uploadedTokenKey))
    }

    func testTheDemoCallsNothing() async {
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        let system = PushPermissionGateTests.FakeSystem()
        let calls = Calls()
        let push = registration(system) { call in calls.made.append(call) }
        XCTAssertNil(push.unregisterFromServer(), "the demo registered nothing, so it unregisters nothing")
        XCTAssertEqual(calls.made, [])
        XCTAssertEqual(system.unregistrations, 0)
    }

    func testNoKnownTokenStillStopsAPNsButAsksNoServer() async {
        UserDefaults.standard.removeObject(forKey: PushRegistration.uploadedTokenKey)
        let system = PushPermissionGateTests.FakeSystem()
        let calls = Calls()
        let push = registration(system) { call in calls.made.append(call) }
        XCTAssertNil(push.unregisterFromServer())
        XCTAssertEqual(calls.made, [])
        XCTAssertEqual(system.unregistrations, 1)
    }

    func testWhichTokenIsUnregistered() {
        let other = URL(string: "https://other.example.net")!
        let memo = PushRegistration.uploadMemo(token: "memo-token", server: server)
        XCTAssertEqual(PushRegistration.tokenToUnregister(deviceToken: "live", memo: memo, server: server), "live",
                       "the token APNs handed this launch wins")
        XCTAssertEqual(PushRegistration.tokenToUnregister(deviceToken: nil, memo: memo, server: server), "memo-token")
        XCTAssertNil(PushRegistration.tokenToUnregister(deviceToken: nil, memo: memo, server: other),
                     "a token uploaded to another server is not this server's to drop")
        XCTAssertNil(PushRegistration.tokenToUnregister(deviceToken: nil, memo: "abcdef0123", server: server),
                     "a legacy memo names no server")
        XCTAssertNil(PushRegistration.tokenToUnregister(deviceToken: nil, memo: nil, server: server))
    }

    func testTheRequestIsTheServersOwnRoute() throws {
        let request = try WalnutAPI.unregisterPushRequest(
            token: "abc123", server: server, bearer: "device-bearer-1", timeout: 3
        )
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.absoluteString, "https://walnut.example.net/api/push/register")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-bearer-1")
        XCTAssertEqual(request.timeoutInterval, 3)
        let body = try XCTUnwrap(request.httpBody)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["token": "abc123"])
    }

    /// The order is the fix: the call is made while the pairing still exists.
    func testDisconnectAsksBeforeItClearsThePairing() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut/Stores/ConnectionStore.swift"), encoding: .utf8)
        let body = try XCTUnwrap(source.components(separatedBy: "func disconnect() {").dropFirst().first)
        let ask = try XCTUnwrap(body.range(of: "PushRegistration.shared.unregisterFromServer()"))
        let clear = try XCTUnwrap(body.range(of: "AppConfig.clear()"))
        XCTAssertLessThan(ask.lowerBound, clear.lowerBound)
    }
}
