import XCTest
@testable import Walnut

/// Switching agents in the Chat drawer (`ChatStore.switchAgent`). The list reads go
/// to the hosted tests' blackhole and fail at once, so what is on screen is what
/// the switch itself put there: the gate saw a blank drawer for a frame or two on
/// every switch, and a quick switch back that forgot the agent's saved chat.
@MainActor
final class ChatAgentSwitchTests: XCTestCase {

    // Agents no other test uses, so no disk cache of theirs exists.
    private let first = "switch-test-first"
    private let second = "switch-test-second"
    private var stores: [ChatStore] = []

    override func tearDown() async throws {
        for store in stores { store.closeStream() }
        stores = []
        for agent in [first, second] {
            DiskCache.remove(key: "conversations-\(agent)")
            DiskCache.remove(key: "asks-\(agent)")
            AppPrefs.defaults.removeObject(forKey: "walnut.activeConversation.\(agent)")
        }
    }

    private func makeStore() -> ChatStore {
        let store = ChatStore(transport: MockChatMessagesTransport(), sendTransport: MockChatSendTransport())
        stores.append(store)
        return store
    }

    private func chat(_ id: String) -> ConversationSummary {
        ConversationSummary(id: id, title: id, updatedAt: "2026-10-11T17:30:00.000Z", messageCount: 2)
    }

    private func ask(_ id: String, conversation: String) -> AskSummary {
        AskSummary(id: id, title: id, state: .idle, activityAt: "2026-10-11T17:30:00.000Z",
                   createdAt: "2026-10-11T02:50:00.000Z", sessionId: "s-\(id)", phase: nil, unread: nil,
                   conversationId: conversation)
    }

    /// Back to an agent seen this session: its lists are on screen in the same
    /// call, with nothing blank in between and nothing of the other agent's.
    func testSwitchingBackShowsTheAgentsListsAtOnce() {
        let store = makeStore()
        store.switchAgent(first)
        store.conversations = [chat("c-1"), chat("c-2")]
        store.asks = [ask("t-1", conversation: "c-1")]
        store.asksListed = true

        store.switchAgent(second)
        XCTAssertTrue(store.conversations.isEmpty, "the other agent's chats never show under this one")
        XCTAssertFalse(store.asksListed)
        XCTAssertTrue(store.loadingList, "while its lists load, the drawer says nothing rather than 'no conversations'")

        store.switchAgent(first)
        XCTAssertEqual(store.conversations.map(\.id), ["c-1", "c-2"])
        XCTAssertEqual(store.asks.map(\.id), ["t-1"])
        XCTAssertTrue(store.asksListed)
    }

    /// A switch away and straight back must not forget the chat the agent had
    /// open. The outgoing switch's task ran on after the second switch and
    /// selected from a list that was not its agent's, erasing the saved chat
    /// (gate: the Walnut chat page came back empty).
    func testAQuickSwitchAwayAndBackKeepsTheSavedChat() async {
        AppPrefs.defaults.set("c-saved", forKey: "walnut.activeConversation.\(first)")
        let store = makeStore()
        store.switchAgent(first)
        store.switchAgent(second)
        store.switchAgent(first)
        // Let both switches' tasks run out: their list reads fail at once.
        try? await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(store.activeID, "c-saved")
        XCTAssertEqual(AppPrefs.defaults.string(forKey: "walnut.activeConversation.\(first)"), "c-saved")
    }

    /// Back to an agent the user left on a new chat: still a new chat. Opening its
    /// newest chat instead put the next message into an old conversation (gate).
    func testReturningToANewChatStaysANewChat() async {
        let store = makeStore()
        store.switchAgent(first)
        store.conversations = [chat("c-1"), chat("c-2")]
        store.select(nil)

        store.switchAgent(second)
        store.switchAgent(first)
        try? await Task.sleep(for: .milliseconds(600))
        XCTAssertNil(store.activeID)
        XCTAssertEqual(store.conversations.map(\.id), ["c-1", "c-2"])
    }

    /// …and back to an agent left on one of its chats: that chat.
    func testReturningToAChatReopensIt() async {
        let store = makeStore()
        store.switchAgent(first)
        store.conversations = [chat("c-1"), chat("c-2")]
        store.select("c-2")

        store.switchAgent(second)
        store.switchAgent(first)
        try? await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(store.activeID, "c-2")
    }
}
