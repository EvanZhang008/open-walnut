import XCTest
@testable import Walnut

/// The phone reads one agent's asks from `GET /api/v1/asks` and must show them
/// exactly as the Mac's Ask Walnut drawer does: same rows, same order, same
/// titles, same state.
///
/// The phone deliberately has no sort or filter of its own: the server answers
/// with the rule the Mac's drawer imports (src/core/sessions/ask-list.ts), so
/// decoding must keep the ORDER it is given and read every state the same way.
///
/// The answer below was PRODUCED BY THE SERVER CODE:
/// `tests/core/sessions/ask-list-ios-fixture.test.ts` runs the real `buildAskList`
/// over `tests/fixtures/ask-list/board.json` and pins `expected.json`, which this
/// suite decodes. A hand-written answer would only prove the decoder agrees with
/// its author.
final class AskListDecodingTests: XCTestCase {

    private static let fixtureDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()      // WalnutTests/
        .deletingLastPathComponent()      // ios-native/
        .deletingLastPathComponent()      // repo root
        .appendingPathComponent("tests/fixtures/ask-list")

    private func expectedData() throws -> Data {
        try Data(contentsOf: Self.fixtureDir.appendingPathComponent("expected.json"))
    }

    private func response(_ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "https://walnut.example/api/v1/asks")!,
                        statusCode: status, httpVersion: nil, headerFields: nil)!
    }

    // MARK: - The server's answer, decoded as the server ordered it

    func testDecodesTheServersAnswerInItsOrderWithTitlesAndStates() throws {
        let list = try WalnutAPI.decode(AskList.self, data: expectedData(), response: response(200))
        XCTAssertEqual(list.agentId, "general")
        XCTAssertEqual(list.project, "Ask Walnut")
        XCTAssertEqual(list.total, 8)
        XCTAssertEqual(list.asks.map(\.id), [
            "ask-release", "ask-garden", "todo-by-hand", "ask-untitled",
            "ask-moved", "ask-tie-a", "ask-tie-b", "ask-reading",
        ])
        XCTAssertEqual(list.asks.map(\.state), [.running, .idle, .todo, .idle, .idle, .idle, .idle, .done])
        // The untitled ask reads as its agent's project, as on the Mac.
        XCTAssertEqual(list.asks[3].title, "Ask Walnut")
        // Mixed script survives the round trip (U+7814 U+7A76, "research").
        XCTAssertEqual(list.asks[4].title, "Garden \u{7814}\u{7A76} notes")
        // No session yet: no session id to open.
        XCTAssertNil(list.asks[2].sessionId)
        XCTAssertEqual(list.asks[0].sessionId, "sess-release")
        XCTAssertEqual(list.asks[7].unread, true)
        XCTAssertNil(list.asks[0].unread)
    }

    /// The printed stamp is the sort stamp, so the times the phone would print
    /// never increase down the list (the Mac's reported bug: "1d ago" among the
    /// "1w ago" rows).
    func testActivityStampsNeverIncreaseDownTheList() throws {
        let list = try WalnutAPI.decode(AskList.self, data: expectedData(), response: response(200))
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let stamps = try list.asks.map { try XCTUnwrap(formatter.date(from: $0.activityAt), $0.id) }
        for (earlier, later) in zip(stamps, stamps.dropFirst()) {
            XCTAssertGreaterThanOrEqual(earlier, later)
        }
    }

    /// A state a newer server adds must not fail the whole list.
    func testAnUnknownStateDecodesAsOtherInsteadOfFailingTheList() throws {
        let json = #"{"agentId":"general","project":"Ask Walnut","total":1,"asks":[{"id":"x","title":"New kind","state":"paused","activityAt":"2026-09-26T08:00:00.000Z","createdAt":"2026-09-26T08:00:00.000Z"}]}"#
        let list = try WalnutAPI.decode(AskList.self, data: Data(json.utf8), response: response(200))
        XCTAssertEqual(list.asks.first?.state, .other("paused"))
        XCTAssertEqual(list.asks.first?.state.rawValue, "paused")
    }

    // MARK: - Whether New chat can launch an ask

    /// The server's own answer says the Mac launches asks.
    func testTheServersAnswerCanLaunch() throws {
        let list = try WalnutAPI.decode(AskList.self, data: expectedData(), response: response(200))
        XCTAssertEqual(list.launch, true)
        XCTAssertTrue(list.canLaunch)
    }

    /// A Mac that lists asks but predates ask launches omits the flag: the phone
    /// must not offer a New chat that Mac would refuse ("cwd is required").
    func testAnAnswerWithoutTheLaunchFlagCannotLaunch() throws {
        let json = #"{"agentId":"general","project":"Ask Walnut","total":0,"asks":[]}"#
        let list = try WalnutAPI.decode(AskList.self, data: Data(json.utf8), response: response(200))
        XCTAssertNil(list.launch)
        XCTAssertFalse(list.canLaunch)
        let off = #"{"agentId":"general","project":"Ask Walnut","total":0,"launch":false,"asks":[]}"#
        XCTAssertFalse(try WalnutAPI.decode(AskList.self, data: Data(off.utf8), response: response(200)).canLaunch)
    }

    // MARK: - An older server (the stale cloud companion)

    /// An older server has no such route and answers Express's plain 404
    /// (`{"error":"Not found: GET /api/v1/asks"}`, not the v1 envelope). That is
    /// "keep what you have", never an error shown to the user.
    func testAnOlderServersPlain404ReadsAsAMissingEndpoint() {
        let body = Data(#"{"error":"Not found: GET /api/v1/asks"}"#.utf8)
        XCTAssertThrowsError(try WalnutAPI.decode(AskList.self, data: body, response: response(404))) { error in
            guard let apiError = error as? APIError else { return XCTFail("not an APIError: \(error)") }
            XCTAssertTrue(WalnutAPI.isMissingEndpoint(apiError))
        }
    }

    /// A companion that already relays `server.asks`, in front of a Mac that does
    /// not know the action yet, answers `400 session_control_needs_upgrade`. That
    /// is "not available yet" too, never an error shown to the user.
    func testAReplicaInFrontOfAnOlderMacReadsAsAMissingEndpoint() {
        let body = Data(#"{"error":{"code":"session_control_needs_upgrade","message":"Unknown control action: server.asks"}}"#.utf8)
        XCTAssertThrowsError(try WalnutAPI.decode(AskList.self, data: body, response: response(400))) { error in
            guard let apiError = error as? APIError else { return XCTFail("not an APIError: \(error)") }
            XCTAssertTrue(WalnutAPI.isMissingEndpoint(apiError))
        }
        // Any other 400 (a malformed agent id) is a real answer.
        let bad = APIError.server(status: 400, code: "bad_request", message: "", serverHash: nil, serverContent: nil)
        XCTAssertFalse(WalnutAPI.isMissingEndpoint(bad))
    }

    /// A v1 `not_found` (an agent this server does not offer) is a real answer.
    func testAV1NotFoundIsNotAMissingEndpoint() {
        let body = Data(#"{"error":{"code":"not_found","message":"Agent not found: ghost"}}"#.utf8)
        XCTAssertThrowsError(try WalnutAPI.decode(AskList.self, data: body, response: response(404))) { error in
            guard let apiError = error as? APIError else { return XCTFail("not an APIError: \(error)") }
            XCTAssertFalse(WalnutAPI.isMissingEndpoint(apiError))
        }
        let offline = APIError.server(status: 503, code: "bridge_offline", message: "", serverHash: nil, serverContent: nil)
        XCTAssertFalse(WalnutAPI.isMissingEndpoint(offline))
    }

    // MARK: - The request

    func testThePathEncodesTheSearchAsAQueryValue() {
        XCTAssertEqual(WalnutAPI.asksPath(agentID: "general", query: nil, limit: nil), "/asks?agentId=general")
        XCTAssertEqual(WalnutAPI.asksPath(agentID: "mentor", query: "   ", limit: 50), "/asks?agentId=mentor&limit=50")
        XCTAssertEqual(
            WalnutAPI.asksPath(agentID: "general", query: "plan & review=1+2", limit: nil),
            "/asks?agentId=general&q=plan%20%26%20review%3D1%2B2"
        )
        XCTAssertEqual(
            WalnutAPI.asksPath(agentID: "general", query: "\u{7814}\u{7A76}", limit: nil),
            "/asks?agentId=general&q=%E7%A0%94%E7%A9%B6"
        )
    }
}
