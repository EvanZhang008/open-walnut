import UIKit
import XCTest
@testable import Walnut

/// The Chat tab's twin of `SessionSendAwayTests`: a message whose send is accepted
/// while the app is in the background shows once when the app is back.
///
/// The chat store skipped every write after an accepted POST while it was torn down,
/// the bubble's `pending` and its remembered photos included, and its merge keeps
/// every pending row (`carryLocalRows`), so the canonical row and a grey "sending"
/// copy both stayed on screen until a conversation switch (the session page's App
/// Store gate r8 finding 1, the same shape here). The same return covered a banked
/// message drained by the queue: its entry left the queue and its `queued-` row
/// stayed pending. Q1chat, Q1chat-q and the control Q1chat-k are the gate's probes,
/// adopted as shipped tests.
@MainActor
final class ChatSendAwayTests: XCTestCase {
    private let conv = "away-conv"
    private let words = "Please water the fern on Friday"
    private static let activeKey = "walnut.activeConversation.general"
    private var savedActive: String?
    private var stores: [ChatStore] = []

    override func setUp() async throws {
        savedActive = AppPrefs.defaults.string(forKey: Self.activeKey)
        DurableStore.removeAllForTesting()
        DiskCache.remove(key: "messages-\(conv)")
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
    }

    private var nowStamp: String { ISO8601DateFormatter().string(from: AppClock.now()) }

    private func waitUntil(_ what: String, timeout: Double = 5, _ condition: () -> Bool,
                           line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)", line: line)
    }

    /// One store on `conv`, its first (empty) page landed, the next POST held open.
    private func openedStore() async -> (ChatStore, MockChatMessagesTransport, MockChatSendTransport, CheckedContinuationGate) {
        let reads = MockChatMessagesTransport()
        reads.rows = [conv: []]
        let writes = MockChatSendTransport()
        let gate = CheckedContinuationGate()
        writes.sendGate = gate
        let chat = ChatStore(transport: reads, sendTransport: writes)
        stores.append(chat)
        chat.select(conv)
        await waitUntil("the first page") { reads.answeredConversations.count >= 1 }
        return (chat, reads, writes, gate)
    }

    private func shown(_ chat: ChatStore) -> Int {
        chat.messages.filter { $0.role == "user" && $0.text == words }.count
    }

    /// The conversation's own row, as the server writes it.
    private func serverRow() -> ChatMessage {
        ChatMessage(id: "m0", role: "user", text: words, createdAt: nowStamp, kind: nil)
    }

    private func comeBack(_ chat: ChatStore, _ reads: MockChatMessagesTransport) async {
        let before = reads.answeredConversations.count
        chat.resumeForForeground()
        await waitUntil("the read after the return") { reads.answeredConversations.count > before }
        for _ in 0..<20 { await Task.yield() }
    }

    /// Q1chat: the POST is accepted while the app is in the background; back in the
    /// foreground the conversation's own row is in the read.
    func testAChatMessageAcceptedWhileInTheBackgroundShowsOnce() async {
        let (chat, reads, writes, gate) = await openedStore()
        let send = Task { await chat.sendReportingOutcome(words) }
        await waitUntil("the POST is in flight") { writes.requests.count == 1 }
        chat.suspendForBackground()
        reads.rows[conv] = [serverRow()]
        gate.open()
        let outcome = await send.value
        XCTAssertEqual(outcome, .started(accepted: true), "the server took it")
        await comeBack(chat, reads)
        XCTAssertEqual(shown(chat), 1, "Q1chat: the message shows twice (its row and a bubble that never leaves)")
        XCTAssertFalse(chat.messages.contains { $0.pending == true }, "Q1chat: a bubble stays pending")
        XCTAssertEqual(writes.requests.count, 1)
    }

    /// Q1chat-q: a message banked behind a running turn is drained when the turn ends,
    /// and the drained POST is accepted while the app is in the background.
    func testABankedChatMessageDrainedWhileInTheBackgroundShowsOnce() async {
        let (chat, reads, writes, gate) = await openedStore()
        chat.streaming = true
        let banked = await chat.sendReportingOutcome(words)
        XCTAssertEqual(banked, .queued)
        chat.handleForTesting(
            SSEEvent(id: nil, event: "message-end", data: #"{ "turnId": "t", "fullText": "" }"#),
            conversationID: conv
        )
        await waitUntil("the drained POST is in flight") { writes.requests.count == 1 }
        chat.suspendForBackground()
        reads.rows[conv] = [serverRow()]
        gate.open()
        await waitUntil("the drained entry leaves the queue") { chat.queuedSends.isEmpty }
        for _ in 0..<20 { await Task.yield() }
        await comeBack(chat, reads)
        XCTAssertEqual(shown(chat), 1, "Q1chat-q: a drained message the server took shows twice")
        XCTAssertFalse(chat.messages.contains { $0.pending == true }, "Q1chat-q: its banked row stays pending")
        XCTAssertEqual(writes.requests.count, 1)
    }

    /// A photo accepted while the app is in the background keeps its picture: the
    /// bytes are remembered for the canonical row, as in the foreground.
    func testAPhotoAcceptedWhileInTheBackgroundKeepsItsPicture() async throws {
        let (chat, reads, writes, gate) = await openedStore()
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        let data = try XCTUnwrap(renderer.image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }.jpegData(compressionQuality: 0.8))
        let image = try XCTUnwrap(SelectedImage(jpegData: data))
        let send = Task { await chat.sendReportingOutcome(words, images: [image]) }
        await waitUntil("the POST is in flight") { writes.requests.count == 1 }
        chat.suspendForBackground()
        reads.rows[conv] = [serverRow()]
        gate.open()
        _ = await send.value
        await comeBack(chat, reads)
        let rows = chat.messages.filter { $0.role == "user" && $0.text == words }
        XCTAssertEqual(rows.count, 1, "the photo message shows twice")
        XCTAssertEqual(rows.first?.localImages?.isEmpty, false, "the canonical row lost its picture")
        XCTAssertFalse(chat.messages.contains { $0.pending == true })
    }

    /// Q1chat-k (control): the same send accepted while the app is in the foreground,
    /// then the same background and foreground.
    func testAChatMessageAcceptedInTheForegroundShowsOnce() async {
        let (chat, reads, writes, gate) = await openedStore()
        let send = Task { await chat.sendReportingOutcome(words) }
        await waitUntil("the POST is in flight") { writes.requests.count == 1 }
        reads.rows[conv] = [serverRow()]
        gate.open()
        let outcome = await send.value
        XCTAssertEqual(outcome, .started(accepted: true))
        chat.suspendForBackground()
        await comeBack(chat, reads)
        XCTAssertEqual(shown(chat), 1)
        XCTAssertFalse(chat.messages.contains { $0.pending == true })
        XCTAssertEqual(writes.requests.count, 1)
    }
}
