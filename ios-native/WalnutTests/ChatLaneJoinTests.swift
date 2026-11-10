import UIKit
import XCTest
@testable import Walnut

/// A message sent while the chat's turn runs goes straight into it, as on the web
/// (2026-11-09, the owner: "不要queue了 就像网页版也一样直接发出去 显示quue或者deliver for
/// each message", then "而且order一定要对"). Pinned on the real store with scripted
/// transports: the send goes to the server as a `join` at once, in the order the
/// sends were made; each bubble reads Queued then Delivered from the lane's line;
/// a turn that cannot take the message (409, which an older server answers too)
/// keeps it here in its place for after the turn; a lost answer is a failed bubble,
/// never sent twice by itself.
@MainActor
final class ChatLaneJoinTests: XCTestCase {
    private let conv = "lane-join-conv"
    private var stores: [ChatStore] = []

    override func setUp() async throws {
        DurableStore.removeAllForTesting()
        ChatStore.laneFollowPoll = .milliseconds(20)
        SessionQueueModel.deliveredSpan = 0.3
    }

    override func tearDown() async throws {
        for store in stores { store.closeStream() }
        stores = []
        DurableStore.removeAllForTesting()
        DiskCache.remove(key: "messages-\(conv)")
        ChatStore.laneFollowPoll = .milliseconds(1500)
        SessionQueueModel.deliveredSpan = 2
    }

    private struct Rig {
        let chat: ChatStore
        let reads: MockChatMessagesTransport
        let writes: MockChatSendTransport
        let queue: SessionQueueModelTests.Transport
    }

    /// A store on `conv` whose turn is running, its lane line read through `queue`.
    private func makeRig() -> Rig {
        let reads = MockChatMessagesTransport()
        let writes = MockChatSendTransport()
        writes.sendsIntoRunningTurn = true
        let queue = SessionQueueModelTests.Transport()
        let chat = ChatStore(
            transport: reads, sendTransport: writes,
            laneQueueMaker: { SessionQueueModel(sessionId: $0, api: queue) }
        )
        stores.append(chat)
        chat.activeID = conv
        chat.streaming = true
        return Rig(chat: chat, reads: reads, writes: writes, queue: queue)
    }

    private func turnEnd(_ chat: ChatStore) {
        chat.handleForTesting(SSEEvent(id: nil, event: "message-end", data: #"{"turnId":"t","fullText":""}"#),
                              conversationID: conv)
    }

    private func waitUntil(_ what: String, line: UInt = #line, _ condition: () -> Bool) async {
        for _ in 0..<2500 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("timed out waiting for \(what)", line: line)
    }

    private var unreachable: Error {
        APIError.network(underlying: NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost))
    }

    private var turnActive: Error {
        APIError.server(status: 409, code: "turn_active", message: "A turn is already active on this conversation",
                        serverHash: nil, serverContent: nil)
    }

    // MARK: - Into the running turn

    func testASendWhileTheTurnRunsGoesIntoItAtOnceAndReadsQueuedThenDelivered() async {
        let rig = makeRig()
        let outcome = await rig.chat.sendReportingOutcome("check the logs too")
        XCTAssertTrue(outcome.keptTheWords)
        XCTAssertTrue(rig.chat.queuedSends.isEmpty, "nothing waits here: it went to the turn")
        XCTAssertEqual(rig.chat.messages.map(\.text), ["check the logs too"], "one bubble, at once")
        let bubble = rig.chat.messages[0]
        // Waiting in the lane's line: the bubble reads Queued.
        rig.queue.rows = [SessionQueuedMessage(id: bubble.clientMessageId!, message: "check the logs too",
                                               status: "pending", enqueuedAt: "2026-11-09T00:00:00Z")]
        await rig.chat.awaitLaneJoinsForTesting()
        XCTAssertEqual(rig.writes.joinedTexts, ["check the logs too"])
        XCTAssertEqual(rig.writes.joinedIDs, [bubble.clientMessageId!], "under the bubble's own id")
        XCTAssertTrue(rig.writes.requests.isEmpty, "no new turn was started for it")
        await waitUntil("Queued on the bubble") { rig.chat.bubbleSendStates[bubble.id] == .pending }
        XCTAssertNotEqual(rig.chat.messages.first?.pending, true, "accepted: no longer sending")
        // The CLI took it: Delivered for a moment, then the bubble is plain.
        rig.queue.rows = []
        await waitUntil("Delivered on the bubble") { rig.chat.bubbleSendStates[bubble.id] == .delivered }
        await waitUntil("a plain bubble") { rig.chat.bubbleSendStates[bubble.id] == nil }
    }

    func testThreeSendsInARowReachTheServerInTheOrderTheyWereMade() async {
        let rig = makeRig()
        // The first is slow on the wire: the later ones must not overtake it.
        rig.writes.joinDelays = [.milliseconds(150), .milliseconds(10), .zero]
        for text in ["order one", "order two", "order three"] {
            _ = await rig.chat.sendReportingOutcome(text)
        }
        XCTAssertEqual(rig.chat.messages.map(\.text), ["order one", "order two", "order three"])
        await rig.chat.awaitLaneJoinsForTesting()
        XCTAssertEqual(rig.writes.joinedTexts, ["order one", "order two", "order three"])
        XCTAssertTrue(rig.writes.requests.isEmpty)
    }

    func testASendRightAfterOneStillOnItsWayFollowsItIntoTheTurnEvenIfTheTurnJustEnded() async {
        let rig = makeRig()
        rig.writes.joinDelays = [.milliseconds(100)]
        _ = await rig.chat.sendReportingOutcome("first")
        turnEnd(rig.chat) // the turn ends while the first is on its way
        _ = await rig.chat.sendReportingOutcome("second")
        await rig.chat.awaitLaneJoinsForTesting()
        XCTAssertEqual(rig.writes.joinedTexts, ["first", "second"], "the second never overtakes the first")
    }

    // MARK: - The turn cannot take it: it waits here, in its place

    func testATurnThatCannotTakeItKeepsItHereAndItGoesOutFirstAfterTheTurn() async {
        let rig = makeRig()
        rig.writes.joinAnswers = [.failure(turnActive), .failure(turnActive)]
        _ = await rig.chat.sendReportingOutcome("first")
        _ = await rig.chat.sendReportingOutcome("second")
        await rig.chat.awaitLaneJoinsForTesting()
        XCTAssertEqual(rig.chat.queuedSends.map(\.text), ["first", "second"])
        XCTAssertEqual(rig.chat.messages.map(\.text), ["first", "second"], "both bubbles, where they were")
        XCTAssertFalse(rig.chat.messages.contains { $0.failed == true })
        XCTAssertEqual(rig.chat.bubbleSendStates[rig.chat.messages[0].id], .pending, "Queued")
        turnEnd(rig.chat)
        await rig.chat.awaitQueueDrainForTesting()
        XCTAssertEqual(rig.writes.requestedTexts.first, "first", "then a turn of its own, first first")
    }

    func testOnceOneWaitsHereTheNextNeverOvertakesIt() async {
        let rig = makeRig()
        rig.writes.joinAnswers = [.failure(unreachable)]
        _ = await rig.chat.sendReportingOutcome("first")
        _ = await rig.chat.sendReportingOutcome("second")
        await rig.chat.awaitLaneJoinsForTesting()
        XCTAssertEqual(rig.writes.joinedTexts, ["first"], "the second never went past the first")
        XCTAssertEqual(rig.chat.queuedSends.map(\.text), ["first", "second"])
    }

    func testAWordBackFromTheTurnKeepsItsPlaceAheadOfLaterOnes() {
        let earlier = QueuedSend(id: "q-1", conversationID: conv, agentID: "general", text: "earlier",
                                 images: [], createdAt: "2026-11-09T10:00:00Z")
        let later = QueuedSend(id: "q-3", conversationID: conv, agentID: "general", text: "later",
                               images: [], createdAt: "2026-11-09T10:00:00Z")
        let back = QueuedSend(id: "q-2", conversationID: conv, agentID: "general", text: "back",
                              images: [], createdAt: "2026-11-09T10:00:00Z")
        // Sent in the order earlier, back, later, all within one second.
        let order = ["q-1": 0, "q-2": 1, "q-3": 2]
        XCTAssertEqual(ChatLaneJoinRules.inserting(back, into: [earlier, later]) { order[$0.id]! > 1 }.map(\.text),
                       ["earlier", "back", "later"])
        XCTAssertEqual(ChatLaneJoinRules.inserting(back, into: [earlier]) { order[$0.id]! > 1 }.map(\.text),
                       ["earlier", "back"])
    }

    func testPicturesWaitForATurnOfTheirOwn() async throws {
        let rig = makeRig()
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        let picture = renderer.image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let image = try XCTUnwrap(SelectedImage(jpegData: picture.jpegData(compressionQuality: 0.8)!))
        _ = await rig.chat.sendReportingOutcome("look", images: [image])
        await rig.chat.awaitLaneJoinsForTesting()
        XCTAssertTrue(rig.writes.joinedTexts.isEmpty)
        XCTAssertEqual(rig.chat.queuedSends.map(\.text), ["look"])
    }

    // MARK: - Other answers

    func testASendWhoseAnswerWasLostIsAFailedBubbleNeverResentByItself() async {
        let rig = makeRig()
        rig.writes.joinAnswers = [.failure(APIError.server(status: 500, code: "internal", message: "boom",
                                                           serverHash: nil, serverContent: nil))]
        _ = await rig.chat.sendReportingOutcome("maybe arrived")
        await rig.chat.awaitLaneJoinsForTesting()
        XCTAssertEqual(rig.chat.messages.first?.failed, true, "kept as a failed bubble to retry")
        XCTAssertTrue(rig.chat.queuedSends.isEmpty, "nothing automatic sends it a second time")
    }

    func testATurnThatHadJustEndedRunsTheMessageAsTheNextTurnAndTheScreenFollowsIt() async {
        let rig = makeRig()
        rig.writes.joinAnswers = [.success(ChatJoinReceipt(turnId: "turn-next"))]
        rig.writes.joinDelays = [.milliseconds(60)]
        _ = await rig.chat.sendReportingOutcome("next question")
        turnEnd(rig.chat)
        XCTAssertFalse(rig.chat.streaming)
        await rig.chat.awaitLaneJoinsForTesting()
        XCTAssertTrue(rig.chat.streaming, "the message's own turn runs")
        XCTAssertTrue(rig.writes.requests.isEmpty, "not posted a second time")
        XCTAssertNotEqual(rig.chat.messages.first?.pending, true)
    }

    func testATransportThatCannotSendIntoATurnKeepsTheLine() async {
        let rig = makeRig()
        rig.writes.sendsIntoRunningTurn = false
        let outcome = await rig.chat.sendReportingOutcome("old way")
        XCTAssertEqual(outcome, .queued)
        XCTAssertEqual(rig.chat.queuedSends.map(\.text), ["old way"])
        XCTAssertTrue(rig.writes.joinedTexts.isEmpty)
    }

    // MARK: - Withdraw

    func testAQueuedMessageSentIntoTheTurnCanBeWithdrawn() async {
        let rig = makeRig()
        _ = await rig.chat.sendReportingOutcome("take me back")
        let bubble = rig.chat.messages[0]
        rig.queue.rows = [SessionQueuedMessage(id: bubble.clientMessageId!, message: "take me back",
                                               status: "pending", enqueuedAt: "2026-11-09T00:00:00Z")]
        await rig.chat.awaitLaneJoinsForTesting()
        await waitUntil("Queued on the bubble") { rig.chat.bubbleSendStates[bubble.id] == .pending }
        rig.chat.withdrawQueued(bubble.id)
        await waitUntil("the bubble gone") { rig.chat.messages.isEmpty }
        XCTAssertEqual(rig.queue.deleted, [bubble.clientMessageId!])
    }

    // MARK: - The watchdog's reading of a turn with a message inside it

    private func row(_ role: String, _ text: String, inFlight: Bool? = nil) -> ChatMessage {
        ChatMessage(id: UUID().uuidString, role: role, text: text, createdAt: "2026-11-09T00:00:00Z",
                    kind: nil, inFlight: inFlight)
    }

    func testATurnIsOverOnlyOnceItAnsweredTheMessageSentIntoIt() {
        let asked = [row("user", "start"), row("assistant", "Starting."), row("user", "also this")]
        XCTAssertFalse(ChatStore.turnSettled(history: asked, watched: "start"),
                       "the message sent into the turn has no answer yet")
        XCTAssertTrue(ChatStore.turnSettled(history: asked + [row("assistant", "Done, both.")], watched: "start"))
    }

    func testAMidTurnInstallStopsAtTheTurnsOwnMessage() {
        // A server that takes the last user row as the turn's start flags only what
        // follows the joined message.
        let fetched = [row("user", "before"), row("assistant", "earlier"), row("user", "start"),
                       row("assistant", "Starting."), row("user", "also this"),
                       row("assistant", "tool", inFlight: true)]
        XCTAssertEqual(ChatStore.settledRows(fetched, watched: "start").map(\.text), ["before", "earlier", "start"])
    }

    func testBubbleStatesPreferTheBankedRow() {
        let states = ChatLaneJoinRules.bubbleStates(
            banked: ["queued-1": .pending], lane: ["qm-a": .delivered, "qm-b": .pending],
            joined: ["local-a": "qm-a", "local-b": "qm-b", "queued-1": "qm-b"]
        )
        XCTAssertEqual(states, ["queued-1": .pending, "local-a": .delivered, "local-b": .pending])
    }
}
