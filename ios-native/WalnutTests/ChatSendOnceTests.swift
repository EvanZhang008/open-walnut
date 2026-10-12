import Foundation
import XCTest
@testable import Walnut

/// A chat message whose POST may have reached the server shows once, and every
/// attempt of it carries the same message id, so a server that already took it
/// answers the repeat once (`chat-send-once.ts`).
///
/// App Store gate r8, Q1chat-x: the POST reached the server, the app went to the
/// background before the answer, the request ended cancelled, and the store kept a
/// red "Not sent" bubble next to the conversation's own row of the same words. A
/// retry tap then posted with no id, the server could not tell it was a repeat, and
/// the agent got the instruction twice. The probe is adopted here as a shipped test,
/// beside the cases that say what must NOT give way.
@MainActor
final class ChatSendOnceTests: XCTestCase {
    private let conv = "send-once-conv"
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

    private func openedStore(history: [ChatMessage] = []) async
        -> (ChatStore, MockChatMessagesTransport, MockChatSendTransport, CheckedContinuationGate) {
        let reads = MockChatMessagesTransport()
        reads.rows = [conv: history]
        let writes = MockChatSendTransport()
        let gate = CheckedContinuationGate()
        writes.sendGate = gate
        let chat = ChatStore(transport: reads, sendTransport: writes)
        stores.append(chat)
        chat.select(conv)
        await waitUntil("the first page") { reads.answeredConversations.count >= 1 }
        for _ in 0..<20 { await Task.yield() }
        return (chat, reads, writes, gate)
    }

    private func shown(_ chat: ChatStore, _ text: String? = nil) -> [ChatMessage] {
        chat.messages.filter { $0.role == "user" && $0.text == (text ?? words) }
    }

    private func row(_ id: String, _ text: String, role: String = "user") -> ChatMessage {
        ChatMessage(id: id, role: role, text: text, createdAt: nowStamp, kind: nil)
    }

    /// A server user row that names the message id it was POSTed under.
    private func idRow(_ id: String, _ text: String, _ messageId: String) -> ChatMessage {
        var out = row(id, text)
        out.messageId = messageId
        return out
    }

    private func local(_ id: String, _ text: String, _ messageId: String,
                       pending: Bool = false, failed: Bool = false) -> ChatMessage {
        var out = row(id, text)
        out.clientMessageId = messageId
        if pending { out.pending = true }
        if failed { out.failed = true }
        return out
    }

    private func comeBack(_ chat: ChatStore, _ reads: MockChatMessagesTransport) async {
        let before = reads.answeredConversations.count
        chat.resumeForForeground()
        await waitUntil("the read after the return") { reads.answeredConversations.count > before }
        for _ in 0..<20 { await Task.yield() }
    }

    /// Send while the POST is held, go to the background, end the POST with `error`,
    /// and come back with `rows` on the server.
    private func loseTheAnswer(
        _ error: Error, rows: [ChatMessage], history: [ChatMessage] = []
    ) async -> (ChatStore, MockChatMessagesTransport, MockChatSendTransport) {
        let (chat, reads, writes, gate) = await openedStore(history: history)
        writes.script(.failure(error))
        let send = Task { await chat.sendReportingOutcome(words) }
        await waitUntil("the POST is in flight") { writes.requests.count == 1 }
        chat.suspendForBackground()
        reads.rows[conv] = rows
        gate.open()
        _ = await send.value
        await comeBack(chat, reads)
        return (chat, reads, writes)
    }

    // MARK: - The probe

    /// Q1chat-x: the server has the message; the words show once, as its row.
    func testAMessageWhoseAnswerWasLostInTheBackgroundShowsOnceAsItsRow() async {
        let (chat, _, writes) = await loseTheAnswer(URLError(.cancelled), rows: [row("m0", words)])
        XCTAssertEqual(shown(chat).count, 1, "Q1chat-x: a message the server has shows twice")
        XCTAssertEqual(shown(chat).first?.id, "m0", "its own row stands for it")
        XCTAssertFalse(chat.messages.contains { $0.failed == true }, "no Not sent is left beside it")
        XCTAssertEqual(writes.requests.count, 1)
        XCTAssertEqual(writes.messageIds.count, 1)
        XCTAssertTrue(writes.messageIds[0].map(SendRetryPolicy.isValidMessageId) ?? false,
                      "the POST carries the message's own id")
    }

    /// The same lost answer, and the server does NOT have it yet (a lagging copy):
    /// the failed bubble stays, to retry, and gives way once the row arrives.
    func testTheFailedCopyStaysUntilTheRowArrives() async {
        let (chat, reads, _) = await loseTheAnswer(URLError(.timedOut), rows: [])
        XCTAssertEqual(shown(chat).count, 1)
        XCTAssertEqual(shown(chat).first?.failed, true, "nothing proves the server has it")
        reads.rows[conv] = [row("m0", words), row("m1", "Done.", role: "assistant")]
        await chat.loadMessages(conv)
        XCTAssertEqual(shown(chat).map(\.id), ["m0"])
    }

    // MARK: - Matched by id, in either order (send-once gate r1, MEDIUM-2)

    /// The order the simulator showed: the stream ends the turn and its refetch
    /// brings the message's own row while the POST's answer is still out; THEN the
    /// POST fails (the app went away). No copy waits beside the row at any point,
    /// nothing says "Not sent", and nothing is sent again.
    func testTheRowBeforeTheFailedPOSTLeavesOneRowAndNoNotSent() async {
        let (chat, reads, writes, gate) = await openedStore()
        writes.script(.failure(URLError(.cancelled)))
        let send = Task { await chat.sendReportingOutcome(words) }
        await waitUntil("the POST is in flight") { writes.requests.count == 1 }
        guard let sentId = writes.messageIds.first ?? nil else { return XCTFail("the POST carried no id") }
        reads.rows[conv] = [idRow("m0", words, sentId), row("m1", "Watered.", role: "assistant")]
        chat.handleForTesting(SSEEvent(id: nil, event: "message-start", data: #"{ "turnId": "t1" }"#),
                              conversationID: conv)
        chat.handleForTesting(
            SSEEvent(id: nil, event: "message-end", data: #"{ "turnId": "t1", "fullText": "Watered." }"#),
            conversationID: conv
        )
        await waitUntil("the refetch the end makes") { chat.messages.contains { $0.id == "m1" } }
        XCTAssertEqual(shown(chat).map(\.id), ["m0"], "a pending copy waits beside the message's own row")
        chat.suspendForBackground()
        gate.open()
        let outcome = await send.value
        XCTAssertEqual(outcome, .started(accepted: true), "a send its own row proves arrived reads as taken")
        await comeBack(chat, reads)
        XCTAssertEqual(shown(chat).map(\.id), ["m0"])
        XCTAssertFalse(chat.messages.contains { $0.failed == true }, "Not sent stands under the message's own row")
        XCTAssertEqual(writes.requests.count, 1, "the message was sent again")
    }

    /// The same order with the app in front, and the POST timing out: no banner
    /// says the message was not sent, and the composer is not left held.
    func testTheRowBeforeATimedOutPOSTSaysNothingWasLost() async {
        let (chat, reads, writes, gate) = await openedStore()
        writes.script(.failure(URLError(.timedOut)))
        let send = Task { await chat.sendReportingOutcome(words) }
        await waitUntil("the POST is in flight") { writes.requests.count == 1 }
        guard let sentId = writes.messageIds.first ?? nil else { return XCTFail("the POST carried no id") }
        reads.rows[conv] = [idRow("m0", words, sentId), row("m1", "Watered.", role: "assistant")]
        await chat.loadMessages(conv)
        XCTAssertEqual(shown(chat).map(\.id), ["m0"])
        gate.open()
        _ = await send.value
        XCTAssertNil(chat.errorMessage, "a banner says a message the server shows was not sent")
        XCTAssertFalse(chat.messages.contains { $0.failed == true || $0.pending == true })
        XCTAssertFalse(chat.sending)
    }

    /// The stream beat a slow 202: the turn started, ended and its refetch showed the
    /// message's own row while the POST was still out. The 202 that lands then
    /// opens nothing: the composer is free at once, not after the watchdog's 30 s.
    func testA202ThatLandsAfterItsTurnEndedLeavesTheComposerFree() async {
        let (chat, reads, writes, gate) = await openedStore()
        let send = Task { await chat.sendReportingOutcome(words) }
        await waitUntil("the POST is in flight") { writes.requests.count == 1 }
        guard let sentId = writes.messageIds.first ?? nil else { return XCTFail("the POST carried no id") }
        reads.rows[conv] = [idRow("m0", words, sentId), row("m1", "Watered.", role: "assistant")]
        chat.handleForTesting(SSEEvent(id: nil, event: "message-start", data: #"{ "turnId": "t1" }"#),
                              conversationID: conv)
        chat.handleForTesting(
            SSEEvent(id: nil, event: "message-end", data: #"{ "turnId": "t1", "fullText": "Watered." }"#),
            conversationID: conv
        )
        await waitUntil("the refetch the end makes") { chat.messages.contains { $0.id == "m1" } }
        gate.open()
        let outcome = await send.value
        XCTAssertEqual(outcome, .started(accepted: true))
        await waitUntil("the composer is free", timeout: 5) { !chat.streaming }
        XCTAssertEqual(shown(chat).map(\.id), ["m0"])
        XCTAssertFalse(chat.messages.contains { $0.pending == true || $0.failed == true })
    }

    /// The pure rule, in both orders, and what an older server (no ids) still gets.
    func testALocalCopyGivesWayToTheRowThatNamesItsIdInEitherOrder() {
        let server = idRow("m0", "ok", "qm-mobile-a")
        // The row lands while the POST is out: the pending copy gives way at once.
        let pending = local("local-1", "ok", "qm-mobile-a", pending: true)
        XCTAssertTrue(ChatStore.carryLocalRows(current: [pending], fetched: [server]).isEmpty)
        // The row was already on screen (no word budget left for it), then the POST
        // failed: the failed copy still gives way, and needs no may-have-arrived mark.
        let failed = local("local-1", "ok", "qm-mobile-a", failed: true)
        XCTAssertTrue(ChatStore.carryLocalRows(current: [server, failed], fetched: [server]).isEmpty)
        XCTAssertEqual(ChatStore.localRowsShownByServer(current: [server, failed], shown: [server]), ["local-1"])
        // A solid echo too.
        let echo = local("local-1", "ok", "qm-mobile-a")
        XCTAssertTrue(ChatStore.carryLocalRows(current: [server, echo], fetched: [server]).isEmpty)
        // An older server names no id: the words alone cannot tell, so the copy stays.
        let bare = row("m0", "ok")
        XCTAssertEqual(
            ChatStore.carryLocalRows(current: [bare, failed], fetched: [bare], mayHaveArrived: ["local-1"]).map(\.id),
            ["local-1"]
        )
    }

    /// The id rides the wire: a user row of `GET /conversations/:id/messages` names
    /// the message id it was POSTed under, and a row of an older server names none.
    func testAServerRowReadsItsMessageIdOffTheWire() throws {
        let json = Data(#"""
        [{ "id": "m0", "role": "user", "text": "ok", "createdAt": "2026-10-11T10:00:00.000Z", "messageId": "qm-mobile-a" },
         { "id": "m1", "role": "user", "text": "ok", "createdAt": "2026-10-11T10:00:01.000Z" }]
        """#.utf8)
        let rows = try JSONDecoder().decode([ChatMessage].self, from: json)
        XCTAssertEqual(rows.map(\.messageId), ["qm-mobile-a", nil])
        let again = try JSONDecoder().decode([ChatMessage].self, from: JSONEncoder().encode(rows))
        XCTAssertEqual(again.map(\.messageId), ["qm-mobile-a", nil], "the disk copy drops the id")
    }

    /// A row that names ANOTHER id is another message, whatever its words: it never
    /// stands for this copy, and it leaves the word budget alone.
    func testARowUnderAnotherIdNeverStandsForThisCopy() {
        let other = idRow("m0", "ok", "qm-mobile-b")
        let failed = local("local-1", "ok", "qm-mobile-a", failed: true)
        XCTAssertEqual(
            ChatStore.carryLocalRows(current: [failed], fetched: [other], mayHaveArrived: ["local-1"]).map(\.id),
            ["local-1"], "a failed copy was taken for another message's row"
        )
        let echo = local("local-2", "ok", "qm-mobile-a")
        XCTAssertEqual(ChatStore.carryLocalRows(current: [echo], fetched: [other]).map(\.id), ["local-2"],
                       "an echo was absorbed by another message's row")
        // Two copies, one row: only the copy it names gives way.
        let mine = local("local-3", "ok", "qm-mobile-b")
        XCTAssertEqual(ChatStore.carryLocalRows(current: [echo, mine], fetched: [other]).map(\.id), ["local-2"])
    }

    /// A row the install leaves out (a turn still in flight) cannot stand for the
    /// copy by id either: the words would be on screen nowhere.
    func testARowThePageDoesNotShowDoesNotTakeTheCopyByIdEither() {
        let server = idRow("m0", "ok", "qm-mobile-a")
        let failed = local("local-1", "ok", "qm-mobile-a", failed: true)
        XCTAssertEqual(ChatStore.carryLocalRows(current: [failed], fetched: [server], installed: []).map(\.id),
                       ["local-1"])
    }

    // MARK: - A banked retry's id on disk (send-once gate r1, LOW-5)

    /// A retry banked behind a running turn keeps the id its first POST carried
    /// through the disk index, so the copy drained after a relaunch posts it, and
    /// the server can answer it once.
    func testABankedRetryKeepsItsFirstIdAcrossTheDisk() async {
        let (chat, _, _, gate) = await openedStore()
        gate.open()
        chat.streaming = true
        let banked = await chat.sendReportingOutcome(words, messageId: "qm-mobile-first-post")
        XCTAssertEqual(banked, .queued)
        let onDisk = await ChatSendQueueStore.restore()
        XCTAssertEqual(onDisk.map(\.postedMessageId), ["qm-mobile-first-post"],
                       "the banked retry lost its first POST's id on disk")
        chat.closeStream()

        let reads = MockChatMessagesTransport()
        reads.rows = [conv: []]
        let writes = MockChatSendTransport()
        let relaunched = ChatStore(transport: reads, sendTransport: writes)
        stores.append(relaunched)
        relaunched.activeID = conv
        relaunched.adoptQueuedSends(onDisk)
        relaunched.streaming = true
        relaunched.handleForTesting(
            SSEEvent(id: nil, event: "message-end", data: #"{ "turnId": "t", "fullText": "" }"#),
            conversationID: conv
        )
        await relaunched.awaitQueueDrainForTesting()
        XCTAssertEqual(writes.messageIds, ["qm-mobile-first-post"], "the drained retry posted another id")
    }

    // MARK: - What must not give way

    /// The server's own answer says it did not take the message: the bubble stays
    /// even when an identical new row shows up (the same words from another device).
    func testARefusedOrFailedSendIsNotTakenForAnotherDevicesRow() async {
        for error: Error in [
            APIError.server(status: 500, code: "internal", message: "boom", serverHash: nil, serverContent: nil),
            APIError.server(status: 400, code: "bad_request", message: "no", serverHash: nil, serverContent: nil),
            APIError.network(underlying: URLError(.cannotConnectToHost)),
        ] {
            let (chat, _, _) = await loseTheAnswer(error, rows: [row("m0", words)])
            XCTAssertEqual(shown(chat).count, 2, "\(error): a send the server refused or never got was hidden")
            XCTAssertEqual(shown(chat).filter { $0.failed == true }.count, 1)
            chat.closeStream()
            DurableStore.removeAllForTesting()
            DiskCache.remove(key: "messages-\(conv)")
        }
    }

    /// An identical OLDER message is not this one: the row was on the page before.
    func testAnOlderIdenticalMessageDoesNotTakeThePlaceOfAFailedOne() async {
        let older = row("m0", words)
        let (chat, _, _) = await loseTheAnswer(URLError(.cancelled), rows: [older], history: [older])
        XCTAssertEqual(shown(chat).count, 2, "the failed copy was hidden behind an earlier message")
        XCTAssertEqual(shown(chat).last?.failed, true)
    }

    /// A row the install leaves out (the turn is still in flight) cannot stand for
    /// the bubble yet: the words would be on screen nowhere.
    func testARowStillInFlightDoesNotTakeThePlaceYet() {
        var bubble = ChatMessage(id: "local-1", role: "user", text: words, createdAt: nowStamp, kind: nil)
        bubble.failed = true
        let fetched = [row("m0", words)]
        let kept = ChatStore.carryLocalRows(
            current: [bubble], fetched: fetched, installed: [], mayHaveArrived: ["local-1"]
        )
        XCTAssertEqual(kept.map(\.id), ["local-1"], "absorbed by a row the page does not show")
        let gone = ChatStore.carryLocalRows(
            current: [bubble], fetched: fetched, installed: fetched, mayHaveArrived: ["local-1"]
        )
        XCTAssertTrue(gone.isEmpty)
        let notMarked = ChatStore.carryLocalRows(current: [bubble], fetched: fetched, installed: fetched)
        XCTAssertEqual(notMarked.map(\.id), ["local-1"], "a failed send not marked may-have-arrived gave way")
    }

    /// Two failed copies of the same words, one row: one gives way, one stays.
    func testOneRowStandsForOneFailedCopy() {
        var first = ChatMessage(id: "local-1", role: "user", text: "ok", createdAt: nowStamp, kind: nil)
        first.failed = true
        var second = ChatMessage(id: "local-2", role: "user", text: "ok", createdAt: nowStamp, kind: nil)
        second.failed = true
        let kept = ChatStore.carryLocalRows(
            current: [first, second], fetched: [row("m0", "ok")], mayHaveArrived: ["local-1", "local-2"]
        )
        XCTAssertEqual(kept.map(\.id), ["local-2"])
    }

    // MARK: - The id

    func testWhichFailuresLeaveOpenThatTheServerHasIt() {
        let yes: [Error] = [
            CancellationError(), URLError(.cancelled), URLError(.timedOut), URLError(.networkConnectionLost),
            APIError.cancelled, APIError.badResponse,
            APIError.network(underlying: URLError(.timedOut)),
            APIError.server(status: 504, code: "http_error", message: "", serverHash: nil, serverContent: nil),
            APIError.server(status: 502, code: "http_error", message: "", serverHash: nil, serverContent: nil),
        ]
        let no: [Error] = [
            URLError(.cannotConnectToHost), URLError(.notConnectedToInternet),
            APIError.network(underlying: URLError(.cannotFindHost)),
            APIError.server(status: 500, code: "internal", message: "", serverHash: nil, serverContent: nil),
            APIError.server(status: 503, code: "http_error", message: "", serverHash: nil, serverContent: nil),
            APIError.server(status: 409, code: "turn_active", message: "", serverHash: nil, serverContent: nil),
            APIError.unauthorized, APIError.rateLimited, APIError.notConfigured,
        ]
        for error in yes { XCTAssertTrue(ChatStore.sendMayHaveArrived(error), "\(error)") }
        for error in no { XCTAssertFalse(ChatStore.sendMayHaveArrived(error), "\(error)") }
    }

    /// A retry goes out under the id of the attempt it repeats, and a server that had
    /// the message answers it once: no second turn, and nothing left waiting.
    func testARetryCarriesTheFirstIdAndARepeatTheServerHadSettlesAtOnce() async {
        let (chat, reads, writes, gate) = await openedStore()
        writes.answersRepeatsOnce = true
        writes.script(.failure(URLError(.timedOut)))
        gate.open()
        _ = await chat.sendReportingOutcome(words)
        let failed = shown(chat).first { $0.failed == true }
        XCTAssertNotNil(failed, "the lost answer left a failed bubble")
        // The turn the first POST started ran and ended meanwhile.
        reads.rows[conv] = [row("m0", words), row("m1", "Watered.", role: "assistant")]
        guard let failed else { return }
        await chat.retry(failed)
        XCTAssertEqual(writes.messageIds.count, 2)
        XCTAssertEqual(writes.messageIds[0], writes.messageIds[1], "the retry minted a new id")
        await waitUntil("the repeat's turn settles") { !chat.streaming }
        XCTAssertEqual(shown(chat).count, 1)
        XCTAssertFalse(chat.messages.contains { $0.pending == true || $0.failed == true })
    }

    func testEachNewMessageGetsItsOwnId() async {
        let (chat, _, writes, gate) = await openedStore()
        gate.open()
        _ = await chat.sendReportingOutcome("one")
        chat.streaming = false
        _ = await chat.sendReportingOutcome("two")
        XCTAssertEqual(writes.messageIds.count, 2)
        XCTAssertNotNil(writes.messageIds[0])
        XCTAssertNotEqual(writes.messageIds[0], writes.messageIds[1])
    }

    /// A banked message posts under its entry's id, and an entry whose POST was out
    /// when the process died (undecided) gives way to its row and leaves the disk.
    func testABankedMessagePostsItsEntryIdAndAnUndecidedOneLeavesWithItsRow() async {
        let (chat, reads, writes, gate) = await openedStore()
        gate.open()
        chat.streaming = true
        let banked = await chat.sendReportingOutcome(words)
        XCTAssertEqual(banked, .queued)
        let entryID = chat.queuedSends.first?.id
        chat.handleForTesting(
            SSEEvent(id: nil, event: "message-end", data: #"{ "turnId": "t", "fullText": "" }"#),
            conversationID: conv
        )
        await waitUntil("the drained POST") { writes.requests.count == 1 }
        XCTAssertEqual(writes.messageIds.first ?? nil, entryID, "a banked message posts under its entry's id")

        // A process that died with a POST out leaves an undecided entry behind.
        let undecided = QueuedSend(id: "queued-died", conversationID: conv, agentID: "general",
                                   text: "Order more soil", images: [], createdAt: nowStamp,
                                   status: .processing)
        chat.adoptQueuedSends([undecided])
        let bubble = chat.messages.first { $0.id == "queued-died" }
        XCTAssertEqual(bubble?.failed, true)
        XCTAssertEqual(bubble?.clientMessageId, "queued-died")
        reads.rows[conv] = [row("m0", words), row("m1", "Order more soil")]
        chat.streaming = false // the drained message's turn is over
        await chat.loadMessages(conv)
        XCTAssertEqual(shown(chat, "Order more soil").map(\.id), ["m1"])
        XCTAssertFalse(chat.queuedSends.contains { $0.id == "queued-died" }, "the undecided entry stayed on disk")
    }
}
