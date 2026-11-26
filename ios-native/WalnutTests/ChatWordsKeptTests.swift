import Foundation
import XCTest
@testable import Walnut

/// The main chat keeps every words send on disk until the server has it (`PendingFileSends`,
/// as a file send's): 2026-11-25, with the Mac away a refused note lived only in memory, and an
/// app that ended lost it ("the request won't be save I can't retyr").
@MainActor
final class ChatWordsKeptTests: XCTestCase {
    private let conv = "words-kept-conv"
    private static let activeKey = "walnut.activeConversation.general"
    private var savedActive: String?
    private var stores: [ChatStore] = []

    override func setUp() async throws {
        savedActive = AppPrefs.defaults.string(forKey: Self.activeKey)
        DurableStore.removeAllForTesting()
        DiskCache.remove(key: "messages-\(conv)")
        PendingFileSends.eraseAll()
    }

    override func tearDown() async throws {
        for store in stores { store.closeStream() }
        stores = []
        if let savedActive {
            AppPrefs.defaults.set(savedActive, forKey: Self.activeKey)
        } else {
            AppPrefs.defaults.removeObject(forKey: Self.activeKey)
        }
        DurableStore.removeAllForTesting()
        DiskCache.remove(key: "messages-\(conv)")
        PendingFileSends.eraseAll()
    }

    private func waitUntil(_ what: String, timeout: Double = 5, _ condition: () -> Bool, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)", line: line)
    }

    private func store(_ select: String?) async -> (ChatStore, MockChatMessagesTransport, MockChatSendTransport) {
        let reads = MockChatMessagesTransport()
        reads.rows = [conv: [], "conv-created": []]
        let writes = MockChatSendTransport()
        let chat = ChatStore(transport: reads, sendTransport: writes)
        stores.append(chat)
        chat.select(select)
        if select != nil { await waitUntil("the first page") { reads.answeredConversations.count >= 1 } }
        for _ in 0..<20 { await Task.yield() }
        return (chat, reads, writes)
    }

    private var convKey: String { PendingFileSends.chatKey(conversationID: conv, agentID: "general") }

    func testARefusedWordsSendComesBackAfterTheAppEndsAndARetryClearsIt() async {
        let (chat, _, writes) = await store(conv)
        writes.script(.failure(APIError.server(status: 500, code: "internal", message: "Disk full.", serverHash: nil, serverContent: nil)))
        _ = await chat.sendReportingOutcome("note for the CEO")
        let failed = chat.messages.first { $0.failed == true && $0.text == "note for the CEO" }
        XCTAssertNotNil(failed)
        XCTAssertEqual(PendingFileSends.entries(session: convKey).map(\.text), ["note for the CEO"])
        chat.closeStream()

        // The next run of the app: the chat shows it again, not sent, and sends nothing by itself.
        let (again, _, writes2) = await store(conv)
        let back = again.messages.first { $0.text == "note for the CEO" }
        XCTAssertEqual(back?.failed, true)
        XCTAssertEqual(back?.clientMessageId, failed?.clientMessageId)
        XCTAssertTrue(writes2.requests.isEmpty)
        // Retry: the same id; once the server has it, it is kept no more.
        await again.retry(back!)
        XCTAssertEqual(writes2.messageIds, [failed?.clientMessageId])
        await waitUntil("the kept copy goes") { PendingFileSends.entries(session: convKey).isEmpty }
    }

    func testAnAcceptedWordsSendIsNotKept() async {
        let (chat, _, writes) = await store(conv)
        _ = await chat.sendReportingOutcome("hello")
        XCTAssertEqual(writes.requests.count, 1)
        XCTAssertTrue(PendingFileSends.entries(session: convKey).isEmpty)
    }

    /// Every new chat of an agent shares one key: words still going from one new chat are drawn
    /// in no other, so the next new chat's first send never carries them along (review 2026-11-25).
    func testWordsStillGoingFromANewChatShowInNoOtherNewChat() async {
        let (chat, _, writes) = await store(nil)
        let creating = CheckedContinuationGate()
        writes.createGate = creating
        let send = Task { await chat.sendReportingOutcome("from the first new chat") }
        await waitUntil("the conversation is being made") { writes.createCount == 1 }
        chat.select(conv)
        for _ in 0..<20 { await Task.yield() }
        chat.select(nil)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(chat.messages.contains { $0.text == "from the first new chat" }, "another new chat drew a send still going")
        creating.open()
        _ = await send.value
        await waitUntil("the kept copy goes") {
            PendingFileSends.entries(session: PendingFileSends.chatKey(conversationID: nil, agentID: "general")).isEmpty
        }
    }
}
