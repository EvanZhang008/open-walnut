import XCTest
@testable import Walnut

/// The Chat tab comes back where the user left it (`ChatPlace`): a launch after the
/// system ended the app opens the same agent, the same conversation (or the new chat
/// they left), and the session they had pushed over the chat (Main, an ask).
/// The user, 2026-11-02: "if I am in the main chat, stay in the main chat, don't turn
/// it into a new chat".
@MainActor
final class ChatPlaceTests: XCTestCase {

    // An agent no other test uses, so no disk cache of its lists exists.
    private let agent = "place-test-agent"
    private var stores: [ChatStore] = []

    override func tearDown() async throws {
        for store in stores { store.closeStream() }
        stores = []
        for id in [agent, ChatStore.mainAgentID] {
            DiskCache.remove(key: "conversations-\(id)")
            DiskCache.remove(key: "asks-\(id)")
        }
        AppPrefs.defaults.removeObject(forKey: ChatPlace.conversationKey(agentID: agent))
        AppPrefs.defaults.removeObject(forKey: ChatPlace.newChatKey(agentID: agent))
        AppPrefs.defaults.removeObject(forKey: ChatPlace.agentKey)
        AppPrefs.defaults.removeObject(forKey: ChatPlace.openSessionKey)
    }

    private func makeStore() -> ChatStore {
        let store = ChatStore(transport: MockChatMessagesTransport(), sendTransport: MockChatSendTransport())
        stores.append(store)
        return store
    }

    private func session(_ id: String, task: String? = "t-main", title: String = "Main") -> WalnutSession {
        WalnutSession(
            id: id, title: title, taskId: task, taskTitle: "Main", project: nil, host: "",
            processStatus: "idle", model: nil, mode: nil,
            startedAt: "2026-11-02T10:00:00.000Z", lastActiveAt: "2026-11-02T10:00:00.000Z",
            messageCount: 3, cwd: nil, pinned: nil, focusTier: nil, description: nil
        )
    }

    // MARK: - Launch: agent and conversation

    /// The process ended on an agent's conversation: the launch opens that agent and
    /// that conversation, not a new chat on the main agent (the 2026-08-16 rule).
    func testLaunchOpensTheAgentAndConversationTheUserLeft() async {
        AppPrefs.defaults.set(agent, forKey: ChatPlace.agentKey)
        AppPrefs.defaults.set("c-left", forKey: ChatPlace.conversationKey(agentID: agent))
        let store = makeStore()
        await store.initialize()
        XCTAssertEqual(store.activeAgentID, agent)
        XCTAssertEqual(store.activeID, "c-left", "the chat the user left, not a new chat")
    }

    /// The user left a new chat (the drawer's New chat): a launch keeps it a new chat.
    func testLaunchKeepsANewChatTheUserLeft() async {
        AppPrefs.defaults.set(agent, forKey: ChatPlace.agentKey)
        let store = makeStore()
        await store.initialize()
        XCTAssertEqual(store.activeAgentID, agent)
        XCTAssertNil(store.activeID)
    }

    /// The drawer's New chat is the one way to start fresh, and it is remembered.
    func testNewChatIsRememberedAcrossALaunch() async {
        AppPrefs.defaults.set(agent, forKey: ChatPlace.agentKey)
        AppPrefs.defaults.set("c-left", forKey: ChatPlace.conversationKey(agentID: agent))
        let first = makeStore()
        await first.initialize()
        first.startNewConversation()
        first.closeStream()
        let second = makeStore()
        await second.initialize()
        XCTAssertNil(second.activeID, "New chat stays the place after a relaunch")
    }

    /// Nothing remembered (a first launch): the main agent.
    func testFirstLaunchOpensTheMainAgent() {
        XCTAssertEqual(ChatPlace.launchAgent(saved: nil, mainAgentID: "general"), "general")
        XCTAssertEqual(ChatPlace.launchAgent(saved: "  ", mainAgentID: "general"), "general")
        XCTAssertEqual(ChatPlace.launchAgent(saved: "mentor", mainAgentID: "general"), "mentor")
    }

    /// A remembered conversation the complete list no longer holds was deleted: a new
    /// chat, never some other old one. A list cut at its page limit proves nothing.
    func testADeletedConversationGivesWayToANewChat() {
        XCTAssertEqual(ChatPlace.conversationAfterList(remembered: "c-1", listed: ["c-1", "c-2"], pageLimit: 200), "c-1")
        XCTAssertNil(ChatPlace.conversationAfterList(remembered: "c-gone", listed: ["c-1", "c-2"], pageLimit: 200))
        XCTAssertEqual(ChatPlace.conversationAfterList(remembered: "c-old", listed: ["c-1", "c-2"], pageLimit: 2), "c-old")
        XCTAssertNil(ChatPlace.conversationAfterList(remembered: nil, listed: ["c-1"], pageLimit: 200))
    }

    /// The stored place tells "left on a new chat" from "never here", and never
    /// writes an empty conversation id an older build would try to open.
    func testTheStoredPlaceTellsANewChatFromNothing() throws {
        let suite = try XCTUnwrap(UserDefaults(suiteName: "chat-place-new-chat"))
        defer { suite.removePersistentDomain(forName: "chat-place-new-chat") }
        XCTAssertEqual(ChatPlace.remembered(agentID: agent, defaults: suite), .nothing)
        ChatPlace.save(conversation: nil, agentID: agent, defaults: suite)
        XCTAssertEqual(ChatPlace.remembered(agentID: agent, defaults: suite), .newChat)
        XCTAssertNil(suite.string(forKey: ChatPlace.conversationKey(agentID: agent)), "no empty id for an older build")
        ChatPlace.save(conversation: "c-1", agentID: agent, defaults: suite)
        XCTAssertEqual(ChatPlace.remembered(agentID: agent, defaults: suite), .conversation("c-1"))
        ChatPlace.save(conversation: nil, agentID: agent, defaults: suite)
        XCTAssertEqual(ChatPlace.remembered(agentID: agent, defaults: suite), .newChat)
        XCTAssertNil(ChatPlace.Remembered.newChat.conversationID)
    }

    private func chat(_ id: String) -> ConversationSummary {
        ConversationSummary(id: id, title: id, updatedAt: "2026-11-02T10:00:00.000Z", messageCount: 2)
    }

    /// A new chat left on an agent in an earlier run: switching to that agent in a
    /// fresh process keeps it a new chat, not the agent's newest old chat (review).
    func testANewChatLeftInAnEarlierRunStaysNewOnASwitch() async {
        DiskCache.save([chat("c-old")], key: "conversations-\(agent)")
        let first = makeStore()
        first.switchAgent(agent)
        first.select(nil)
        first.closeStream()
        let second = makeStore()
        second.switchAgent(agent)
        // The switch's task reads the disk cache, then the list (fails at once here).
        try? await Task.sleep(for: .milliseconds(600))
        XCTAssertNil(second.activeID, "the new chat the user left, not c-old")
    }

    /// A list the server did not answer (offline, a cache from before the chat was
    /// made) never forgets the remembered conversation (review).
    func testAListTheServerDidNotAnswerKeepsThePlace() async {
        DiskCache.save([chat("c-old")], key: "conversations-\(agent)")
        AppPrefs.defaults.set(agent, forKey: ChatPlace.agentKey)
        AppPrefs.defaults.set("c-made-last-run", forKey: ChatPlace.conversationKey(agentID: agent))
        let store = makeStore()
        await store.initialize()
        try? await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(store.activeID, "c-made-last-run")
        XCTAssertEqual(AppPrefs.defaults.string(forKey: ChatPlace.conversationKey(agentID: agent)), "c-made-last-run")
    }

    /// A voice shortcut that reached this process blocks the restore even once the
    /// composer took it (`pending` is nil again by then).
    func testAVoiceShortcutInThisProcessIsRemembered() {
        let quick = VoiceQuickAction.shared
        quick.handle(shortcutType: VoiceQuickAction.shortcutType, source: "test")
        _ = quick.consume()
        XCTAssertNil(quick.pending)
        XCTAssertTrue(quick.armedInThisProcess)
        quick.clear(reason: "test")
    }

    // MARK: - The session pushed over the chat

    func testTheOpenSessionIsRememberedAndForgottenOnBack() throws {
        let suite = try XCTUnwrap(UserDefaults(suiteName: "chat-place-tests"))
        defer { suite.removePersistentDomain(forName: "chat-place-tests") }
        ChatPlace.saveOpenSession(session("s-main"), defaults: suite)
        XCTAssertEqual(ChatPlace.savedOpenSession(defaults: suite)?.id, "s-main")
        ChatPlace.saveOpenSession(nil, defaults: suite)
        XCTAssertNil(ChatPlace.savedOpenSession(defaults: suite), "Back to the chat: a launch opens the chat")
    }

    func testTheRestoredSessionPrefersTheLiveCopy() {
        let live = session("s-main", title: "Main (renamed)")
        let restored = ChatPlace.sessionToRestore(
            saved: session("s-main"), liveSessions: [live], voiceActionPending: false, inDemo: false
        )
        XCTAssertEqual(restored?.title, "Main (renamed)")
        XCTAssertEqual(ChatPlace.sessionToRestore(
            saved: session("s-main"), liveSessions: [], voiceActionPending: false, inDemo: false
        )?.id, "s-main", "offline: the snapshot")
    }

    /// A voice Quick Action needs the chat's own composer; the demo has its own data.
    func testNoRestoreOverAVoiceActionOrInTheDemo() {
        XCTAssertNil(ChatPlace.sessionToRestore(
            saved: session("s-main"), liveSessions: [], voiceActionPending: true, inDemo: false
        ))
        XCTAssertNil(ChatPlace.sessionToRestore(
            saved: session("s-main"), liveSessions: [], voiceActionPending: false, inDemo: true
        ))
        XCTAssertNil(ChatPlace.sessionToRestore(
            saved: nil, liveSessions: [], voiceActionPending: false, inDemo: false
        ))
    }
}
