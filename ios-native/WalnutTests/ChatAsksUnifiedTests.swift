import XCTest
@testable import Walnut

/// The Chat drawer lists the Mac's asks, and every chat with a session is one
/// (src/core/sessions/lane-ask-link.ts). Two fields tie the lists together: an
/// ask names the chat it was written in (`conversationId`), and a chat names
/// its ask (`askTaskId`). Both are additive, so an older server's answers must
/// still decode, and a chat that is not an ask yet must stay listed (Earlier)
/// instead of vanishing from the phone.
final class ChatAsksUnifiedTests: XCTestCase {

    private func response(_ path: String) -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "https://walnut.example\(path)")!,
                        statusCode: 200, httpVersion: nil, headerFields: nil)!
    }

    private func ask(_ id: String, conversation: String? = nil, session: String? = "sess-\(UUID().uuidString)") -> AskSummary {
        AskSummary(id: id, title: id, state: .idle, activityAt: "2026-10-10T17:30:00.000Z",
                   createdAt: "2026-10-10T02:50:00.000Z", sessionId: session, phase: nil, unread: nil,
                   conversationId: conversation)
    }

    private func chat(_ id: String, askTaskId: String? = nil) -> ConversationSummary {
        ConversationSummary(id: id, title: id, updatedAt: "2026-10-10T17:30:00.000Z", messageCount: 2, askTaskId: askTaskId)
    }

    // MARK: - Decoding

    func testAnAskNamesTheChatItWasWrittenIn() throws {
        let json = #"{"agentId":"general","project":"Ask Walnut","total":2,"launch":true,"asks":[{"id":"t-dish","title":"Dishwasher drain fault","state":"idle","activityAt":"2026-10-10T17:30:00.000Z","createdAt":"2026-10-10T02:50:00.000Z","sessionId":"s-1","conversationId":"conv-dish"},{"id":"t-mac","title":"Started on the Mac","state":"todo","activityAt":"2026-10-09T10:00:00.000Z","createdAt":"2026-10-09T10:00:00.000Z"}]}"#
        let list = try WalnutAPI.decode(AskList.self, data: Data(json.utf8), response: response("/api/v1/asks"))
        XCTAssertEqual(list.asks.map(\.conversationId), ["conv-dish", nil])
        // The Mac-started ask has neither a chat nor (yet) a session.
        XCTAssertNil(list.asks[1].sessionId)
    }

    func testAChatNamesItsAskAndAnOlderServersRowsStillDecode() throws {
        let json = #"[{"id":"conv-dish","title":"Dishwasher drain fault","updatedAt":"2026-10-10T17:30:00.000Z","messageCount":4,"askTaskId":"t-dish"},{"id":"conv-old","updatedAt":"2026-06-01T10:00:00.000Z","messageCount":1}]"#
        let rows = try WalnutAPI.decode([ConversationSummary].self, data: Data(json.utf8), response: response("/api/v1/conversations"))
        XCTAssertEqual(rows.map(\.askTaskId), ["t-dish", nil])
    }

    // MARK: - Earlier: the chats that are not asks yet

    func testEarlierKeepsOnlyTheChatsNoListedAskNames() {
        let conversations = [
            chat("conv-bound", askTaskId: "t-1"),
            chat("conv-bound-by-ask"),
            chat("conv-cloud-only"),
        ]
        // The ask side can arrive first (its list was read after the chat's):
        // a chat a listed ask names is in Recents even before its own row says so.
        let asks = [ask("t-1", conversation: "conv-bound"), ask("t-2", conversation: "conv-bound-by-ask"),
                    ask("t-mac", conversation: nil)]
        XCTAssertEqual(ChatStore.earlier(conversations, asks: asks).map(\.id), ["conv-cloud-only"])
    }

    /// A chat that names an ask the list does not hold (its ask was deleted, or
    /// it is past the page the server answered) must stay reachable: Recents has
    /// no row for it, so Earlier does.
    func testABoundChatWhoseAskIsNotListedStaysInEarlier() {
        let conversations = [chat("conv-listed", askTaskId: "t-1"), chat("conv-past-the-page", askTaskId: "t-999")]
        let asks = [ask("t-1", conversation: "conv-listed")]
        XCTAssertEqual(ChatStore.earlier(conversations, asks: asks).map(\.id), ["conv-past-the-page"])
    }

    func testEveryChatListedMeansNothingEarlier() {
        let conversations = [chat("a", askTaskId: "t-a"), chat("b", askTaskId: "t-b")]
        let asks = [ask("t-a", conversation: "a"), ask("t-b", conversation: "b")]
        XCTAssertTrue(ChatStore.earlier(conversations, asks: asks).isEmpty)
    }

    // MARK: - Starting an ask that has no session yet

    /// The task's own stamp picks the persona, so the body names the task and
    /// never an agent (an `agentId` that disagreed with the stamp would be a
    /// second answer to the same question).
    func testAnAskLaunchNamesTheTaskAndNoAgent() throws {
        let data = try JSONEncoder().encode(WalnutAPI.askLaunchBody(taskId: "t-mac", message: "hello"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["walnutAgent"] as? Bool, true)
        XCTAssertEqual(json["taskId"] as? String, "t-mac")
        XCTAssertEqual(json["message"] as? String, "hello")
        XCTAssertNil(json["agentId"])
        XCTAssertNil(json["cwd"])
    }

    // MARK: - One row per ask

    func testARepeatedAskKeepsTheFirstCopyInOrder() {
        let rows = [ask("t-1"), ask("t-2"), ask("t-1"), ask("t-3")]
        XCTAssertEqual(ChatDrawer.uniqueAsks(rows).map(\.id), ["t-1", "t-2", "t-3"])
    }
}
