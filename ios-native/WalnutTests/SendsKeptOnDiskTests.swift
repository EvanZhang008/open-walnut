import XCTest
@testable import Walnut

/// A session page keeps every send on disk until the server has it, words alone too
/// (`PendingFileSends`). 2026-11-25: with the Mac away, a note that waited out its retries lived
/// only in memory, and an app that ended lost it ("the request won't be save I can't retyr").
@MainActor
final class SendsKeptOnDiskTests: XCTestCase {
    private func store(_ session: String, _ transport: MockSessionSendTransport) -> SessionConversationStore {
        SessionConversationStore(session: ScriptedSSE.session(id: session), transport: transport, uploads: FakeUploadHost())
    }

    private func waitUntil(_ timeout: Double = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
    }

    func testAWordsOnlySendTheServerRefusedComesBackAfterTheAppEnds() async throws {
        let session = "kept-refused-" + UUID().uuidString.lowercased()
        let first = MockSessionSendTransport()
        first.permanentError = APIError.server(status: 500, code: "internal", message: "Disk full.", serverHash: nil, serverContent: nil)
        let page1 = store(session, first)
        await page1.open()
        _ = await page1.sendFromComposer("note for the CEO")
        let failed = try XCTUnwrap(page1.messages.first { $0.failed == true })
        await waitUntil { PendingFileSends.entries(session: session).first?.failed == true }
        let kept = try XCTUnwrap(PendingFileSends.entries(session: session).first)
        XCTAssertEqual(kept.text, "note for the CEO")
        XCTAssertEqual(kept.messageID, failed.clientMessageId)
        XCTAssertTrue(kept.files.isEmpty)
        page1.close()

        // The app ended; the next run's page shows it again, not sent, for the person.
        let second = MockSessionSendTransport()
        let page2 = store(session, second)
        await page2.open()
        let back = try XCTUnwrap(page2.messages.first { $0.failed == true })
        XCTAssertEqual(back.text, "note for the CEO")
        XCTAssertEqual(back.clientMessageId, failed.clientMessageId)
        XCTAssertNil(back.localFiles, "words alone come back with no file cards")
        XCTAssertEqual(second.sendCalls.count, 0, "a send that failed for good waits for the person")
        // Retry: the same id, and once taken it is kept no more.
        await page2.retry(back)
        XCTAssertEqual(second.sendCalls.map(\.messageId), [failed.clientMessageId])
        await waitUntil { PendingFileSends.entries(session: session).isEmpty }
        XCTAssertTrue(PendingFileSends.entries(session: session).isEmpty)
        page2.close()
    }

    func testAWordsOnlySendStillWaitingWhenTheAppEndsGoesOutWhenThePageOpensAgain() async throws {
        let session = "kept-waiting-" + UUID().uuidString.lowercased()
        let first = MockSessionSendTransport()
        first.failuresRemaining = 1_000 // the Mac is away for this whole run
        let page1 = store(session, first)
        await page1.open()
        _ = await page1.sendFromComposer("while the Mac sleeps")
        await waitUntil { page1.messages.contains { $0.retryNotice != nil } }
        let waiting = try XCTUnwrap(page1.messages.first { $0.text == "while the Mac sleeps" })
        page1.close()
        XCTAssertEqual(PendingFileSends.entries(session: session).map(\.text), ["while the Mac sleeps"])

        let second = MockSessionSendTransport()
        let page2 = store(session, second)
        await page2.open()
        await waitUntil { !second.sendCalls.isEmpty }
        XCTAssertEqual(second.sendCalls.map(\.text), ["while the Mac sleeps"])
        XCTAssertEqual(second.sendCalls.first?.messageId, waiting.clientMessageId, "the same id, so the server takes it once")
        await waitUntil { PendingFileSends.entries(session: session).isEmpty }
        XCTAssertTrue(PendingFileSends.entries(session: session).isEmpty, "an accepted send is no longer kept")
        page2.close()
    }

    func testAnAcceptedWordsOnlySendIsNotKept() async throws {
        let session = "kept-accepted-" + UUID().uuidString.lowercased()
        let transport = MockSessionSendTransport()
        let page = store(session, transport)
        await page.open()
        _ = await page.sendFromComposer("hello")
        await waitUntil { PendingFileSends.entries(session: session).isEmpty }
        XCTAssertEqual(transport.sendCalls.count, 1)
        XCTAssertTrue(PendingFileSends.entries(session: session).isEmpty)
        page.close()
    }

    /// The same words sent earlier ("yes") never pass for a put-back send: a row that names
    /// another message id is another message, whatever it says.
    func testAPutBackSendIsMatchedByItsMessageIdBeforeItsWords() {
        var bubble = ChatMessage(id: "pending-1", role: "user", text: "yes", createdAt: "2026-11-25T18:48:00Z", kind: nil)
        bubble.clientMessageId = "qm-mobile-aaaaaaaaaaaa"
        var earlier = ChatMessage(id: "", role: "user", text: "yes", createdAt: "2026-11-25T18:47:00Z", kind: nil)
        earlier.walnutMessageId = "qm-mobile-bbbbbbbbbbbb"
        XCTAssertFalse(SessionConversationStore.rowIsRestoredSend(bubble, row: earlier))
        var own = earlier
        own.walnutMessageId = "qm-mobile-aaaaaaaaaaaa"
        XCTAssertTrue(SessionConversationStore.rowIsRestoredSend(bubble, row: own))
        var older = earlier
        older.walnutMessageId = nil
        XCTAssertTrue(SessionConversationStore.rowIsRestoredSend(bubble, row: older), "a row with no id (an older server) is judged by its words")
    }
}
