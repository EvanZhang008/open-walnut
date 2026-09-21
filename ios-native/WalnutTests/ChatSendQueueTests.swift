import Foundation
import UIKit
import XCTest
@testable import Walnut

/// Scripted `ChatSendTransport`: records every POST and can answer them in a
/// scripted order.
///
/// The queue's central promise is a NEGATIVE one — nothing reaches the server
/// while a turn is running — and that cannot be asserted against a live
/// URLSession, where "no request" is indistinguishable from "a request that
/// failed". It is also the only way to stage the 409 the drain has to survive.
final class MockChatSendTransport: ChatSendTransport, @unchecked Sendable {
    struct Posted: Equatable {
        let conversationID: String
        let agentID: String
        let text: String
        let imageCount: Int
    }

    private let lock = NSLock()
    private var posted: [Posted] = []
    private var answers: [Result<String, Error>] = []
    private var created = 0

    /// Holds every POST open after it has been RECORDED, so a test can act while
    /// one is genuinely in flight (the switch-mid-POST race) instead of trying to
    /// win a scheduling coin toss.
    var sendGate: CheckedContinuationGate?

    /// Every POST that reached the "server", in order.
    var requests: [Posted] {
        lock.lock(); defer { lock.unlock() }
        return posted
    }

    var requestedTexts: [String] { requests.map(\.text) }

    /// Answers are consumed in order; anything past the end is an accept.
    func script(_ answer: Result<String, Error>) {
        lock.lock(); answers.append(answer); lock.unlock()
    }

    private var stops = 0
    /// Stops that reached the "server".
    var stopCount: Int {
        lock.lock(); defer { lock.unlock() }
        return stops
    }

    func stopConversation(id: String, agentID: String) async throws -> ConversationStopped {
        lock.lock(); stops += 1; lock.unlock()
        return ConversationStopped(stopped: 1, questionCancelled: false)
    }

    /// Holds `createConversation` open the way `sendGate` holds a POST. This is the
    /// only suspension inside one send that happens BEFORE the POST, so it is the
    /// only place a test can act in the window the send reads its scope from.
    var createGate: CheckedContinuationGate?

    var createCount: Int {
        lock.lock(); defer { lock.unlock() }
        return created
    }

    func createConversation(agentID: String, title: String?) async throws -> String {
        lock.lock(); created += 1; let gate = createGate; lock.unlock()
        await gate?.wait()
        return "conv-created"
    }

    func sendMessage(
        conversationID: String, agentID: String, text: String, images: [ImagePayload]
    ) async throws -> String {
        lock.lock()
        posted.append(Posted(conversationID: conversationID, agentID: agentID,
                             text: text, imageCount: images.count))
        let answer = answers.isEmpty ? Result<String, Error>.success("turn-\(posted.count)")
                                     : answers.removeFirst()
        let gate = sendGate
        lock.unlock()
        await gate?.wait()
        switch answer {
        case .success(let turnID): return turnID
        case .failure(let error): throw error
        }
    }
}

/// A send typed while the agent is mid-turn must be TAKEN, not refused.
///
/// The report: eight web_search rows were streaming, the user dictated a long
/// paragraph, and the composer's trailing button was a red STOP — "he is talking
/// and I have no way to send". Three separate gates said no (the button's own
/// decision, `ComposerBar.canSend`, and `ChatStore`'s acceptance guard), so the
/// fix is all three plus somewhere for the words to wait.
///
/// Every assertion here is about the STORE's observable state or a recorded
/// request; nothing needs a hosted view.
@MainActor
final class ChatSendQueueTests: XCTestCase {

    private let convA = "queue-conv-a"
    private let convB = "queue-conv-b"

    private var stores: [ChatStore] = []

    override func tearDown() async throws {
        // Every store here arms a turn watchdog and tracked tasks; teardown is
        // what cancels them, and it must not be left to the next test.
        for store in stores { store.closeStream() }
        stores = []
        DurableStore.removeAllForTesting()
        DiskCache.remove(key: "messages-\(convA)")
        DiskCache.remove(key: "messages-\(convB)")
    }

    override func setUp() async throws {
        // A banked send is durable BY DESIGN, so it outlives a test unless the test
        // says otherwise. Wiping both ends keeps one case from seeding the next.
        DurableStore.removeAllForTesting()
    }

    // MARK: - Fixtures

    private func makeStore(
        history: [String: [ChatMessage]] = [:]
    ) -> (ChatStore, MockChatMessagesTransport, MockChatSendTransport) {
        let reads = MockChatMessagesTransport()
        reads.rows = history
        let writes = MockChatSendTransport()
        let store = ChatStore(transport: reads, sendTransport: writes)
        stores.append(store)
        return (store, reads, writes)
    }

    /// A store already mid-turn on `convA`, the exact state the report describes.
    /// `activeID` is set directly rather than through `select` so the test does not
    /// also depend on an SSE connect and a first page landing.
    private func makeMidTurnStore() -> (ChatStore, MockChatSendTransport) {
        let (store, _, writes) = makeStore()
        store.activeID = convA
        store.streaming = true
        return (store, writes)
    }

    /// Real JPEG bytes, because the drain rebuilds its attachments from the bytes
    /// it banked (`SelectedImage(jpegData:)` decodes a thumbnail and returns nil on
    /// anything it cannot read, so synthetic bytes would silently drop the image
    /// and the test would prove nothing about attachments surviving the queue).
    private func makeImage() -> SelectedImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4))
        let image = renderer.image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        let data = image.jpegData(compressionQuality: 0.8)!
        return SelectedImage(jpegData: data)!
    }

    /// `XCTAssertEqual(await …)` cannot be written (the assertion's autoclosure is
    /// not async), so the two outcomes this file asserts over and over get a helper
    /// each. `#line` keeps a failure pointing at the caller.
    @discardableResult
    private func expectQueued(
        _ chat: ChatStore, _ text: String, images: [SelectedImage] = [], line: UInt = #line
    ) async -> ChatStore.SendOutcome {
        let outcome = await chat.sendReportingOutcome(text, images: images)
        XCTAssertEqual(outcome, .queued, "\"\(text)\" should have been banked", line: line)
        return outcome
    }

    @discardableResult
    private func expectRefused(
        _ chat: ChatStore, _ text: String, images: [SelectedImage] = [], line: UInt = #line
    ) async -> ChatStore.SendOutcome {
        let outcome = await chat.sendReportingOutcome(text, images: images)
        XCTAssertEqual(outcome, .refusedKeepingNothing,
                       "\"\(text)\" should have been refused outright", line: line)
        return outcome
    }

    private func turnEnd(_ store: ChatStore, conversationID: String) {
        store.handleForTesting(
            SSEEvent(id: nil, event: "message-end",
                     data: #"{ "turnId": "t", "fullText": "" }"#),
            conversationID: conversationID
        )
    }

    /// Poll a MainActor condition, bounded. Used only where a real in-flight POST
    /// has to be observed; everything else is deterministic.
    private func waitUntil(
        _ description: String, _ condition: () -> Bool, line: UInt = #line
    ) async {
        // 5s, not 1s. The first `loadMessages` on a fresh store pays for a cache
        // write, and a 1s budget turned the watchdog test into a race it lost.
        for _ in 0..<2500 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("timed out waiting for \(description)", line: line)
    }

    /// Wait `window`, then report. Used where the assertion is that NOTHING reached
    /// the wire: a bare `Task.yield()` cannot carry `drainQueue → performSend →
    /// buildImagePayloads → sendMessage` to the mock, so it proves nothing.
    /// `testTheNoRequestWindowIsLongEnoughToCatchARealDrain` is the control that
    /// keeps this honest.
    private func expectNoRequest(
        for window: Duration, _ writes: MockChatSendTransport
    ) async {
        try? await Task.sleep(for: window)
        _ = writes.requests
    }

    private func summary(_ id: String) -> ConversationSummary {
        ConversationSummary(id: id, title: id, updatedAt: "2026-09-18T00:00:00Z",
                            messageCount: 0)
    }

    private var networkFailure: Error {
        APIError.network(underlying: NSError(
            domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost
        ))
    }

    private func serverFailure(status: Int, code: String) -> Error {
        APIError.server(status: status, code: code, message: "test",
                        serverHash: nil, serverContent: nil)
    }

    private var turnActiveFailure: Error {
        APIError.server(status: 409, code: "turn_active",
                        message: "a turn is already running",
                        serverHash: nil, serverContent: nil)
    }

    // MARK: - 1. The button

    /// The regression, stated as a table. Mid-turn WITH content is the row that
    /// shipped backwards: stop took the seat unconditionally, so a dictated
    /// paragraph had no send button at all.
    func testMidTurnWithContentTheSeatIsSend() {
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: true, hasContent: true,
                                         pendingQuestion: false, busyAcceptsSend: true),
            .send,
            "typed text mid-turn has somewhere to go: the store banks it"
        )
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: true, hasContent: false,
                                         pendingQuestion: false, busyAcceptsSend: true),
            .stop,
            "an empty composer has nothing to send, so the seat belongs to stop"
        )
        XCTAssertEqual(
            ComposerPrimaryAction
                .decide(busy: true, hasContent: false, pendingQuestion: false,
                        busyAcceptsSend: true)
                .availableWithStop(false),
            .disabled,
            "…and a composer with no turn to abort keeps its greyed send"
        )
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: true, hasContent: true,
                                         pendingQuestion: true, busyAcceptsSend: true),
            .send,
            "answering a blocked question is unchanged"
        )
    }

    /// The other half, and the one a blanket "content beats stop" rule broke: the
    /// new-session launcher is `busy` while it CREATES a session, nothing there can
    /// hold a second send, and a second send would create a SECOND session. It has
    /// no stop handler either, so the seat has to end up greyed.
    func testAComposerThatCannotHoldABusySendKeepsItsGreyedButton() {
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: true, hasContent: true,
                                         pendingQuestion: false, busyAcceptsSend: false)
                .availableWithStop(false),
            .disabled
        )
        XCTAssertFalse(
            ComposerBar.canSend(hasContent: true, disabled: false,
                                waitingForReply: true, busyAcceptsSend: false),
            "and the tap itself is refused, not merely styled as unavailable"
        )
        XCTAssertTrue(
            ComposerBar.canSend(hasContent: true, disabled: false,
                                waitingForReply: true, busyAcceptsSend: true),
            "the chat composer's tap goes through: the store banks it"
        )
        XCTAssertFalse(
            ComposerBar.canSend(hasContent: true, disabled: true,
                                waitingForReply: false, busyAcceptsSend: true),
            "offline still refuses, whatever the queue could do"
        )
    }

    // MARK: - 2. A send mid-turn is banked, not refused

    func testASendWhileStreamingIsQueuedAndNothingGoesOnTheWire() async {
        let (chat, writes) = makeMidTurnStore()

        let outcome = await chat.sendReportingOutcome("the dictated paragraph")

        XCTAssertEqual(outcome, .queued)
        XCTAssertTrue(outcome.keptTheWords)
        XCTAssertTrue(writes.requests.isEmpty, "a banked message must not be posted")
        XCTAssertEqual(chat.queuedSends.map(\.text), ["the dictated paragraph"])
        XCTAssertEqual(chat.messages.count, 1, "exactly ONE bubble, never two")
        XCTAssertEqual(chat.messages[0].text, "the dictated paragraph")
        XCTAssertEqual(chat.messages[0].pending, true, "it stays visually pending")
        XCTAssertNotEqual(chat.messages[0].failed, true)
        XCTAssertTrue(chat.queuedRowIDs.contains(chat.messages[0].id),
                      "the timeline asks the store which rows carry the badge")
        XCTAssertEqual(chat.localRowConversation[chat.messages[0].id], convA,
                       "a banked row belongs to ONE conversation")
    }

    /// `sending` is the other half of "a turn is in flight" and is set at a
    /// different moment (POST out, no SSE yet). A queue that only knew about
    /// `streaming` would leave a real window where a send is refused.
    func testASendWhileAPostIsStillInFlightIsAlsoQueued() async {
        let (chat, _, writes) = makeStore()
        chat.activeID = convA
        chat.sending = true

        await expectQueued(chat, "second thought")
        XCTAssertTrue(writes.requests.isEmpty)
    }

    // MARK: - 3. Order, and one turn each

    func testThreeQueuedSendsDrainInOrderAsThreeSeparateTurns() async {
        let (chat, writes) = makeMidTurnStore()
        for text in ["first", "second", "third"] {
            await expectQueued(chat, text)
        }
        XCTAssertEqual(chat.queuedSends.map(\.text), ["first", "second", "third"])
        XCTAssertEqual(chat.messages.count, 3)

        // One settle delivers ONE message: each drained entry starts a turn of its
        // own, so the next one waits for that turn to finish.
        for expected in ["first", "second", "third"] {
            turnEnd(chat, conversationID: convA)
            await chat.awaitQueueDrainForTesting()
            XCTAssertEqual(writes.requestedTexts.last, expected)
        }
        XCTAssertEqual(writes.requestedTexts, ["first", "second", "third"],
                       "three turns, in order, never merged and never last-only")
        XCTAssertTrue(chat.queuedSends.isEmpty)
        XCTAssertTrue(chat.queuedRowIDs.isEmpty, "the badge goes with the queue entry")
    }

    // MARK: - 4. The watchdog path

    /// A queue drained only from the `message-end` handler would strand on exactly
    /// the turn whose `message-end` was lost. This drives the same transition the
    /// watchdog drives after its refetch proves the turn is over, rather than
    /// mocking the 15-second poll away.
    func testTheDrainFiresOnTheWatchdogReconcileToo() async {
        let (chat, writes) = makeMidTurnStore()
        await expectQueued(chat, "after a lost message-end")
        XCTAssertTrue(writes.requests.isEmpty)

        chat.adoptLostTurnEndForTesting()
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requestedTexts, ["after a lost message-end"])
        XCTAssertTrue(chat.queuedSends.isEmpty)
    }

    /// …and the WATCHDOG really is wired to that settle. Nothing pinned the call
    /// itself, so re-inlining the body (which is how it looked before) would have
    /// gone unnoticed and the watchdog would have stopped draining again.
    ///
    /// Driven through the real loop: arm a turn, make the stream look silent, and let
    /// the watchdog's own poll reach its reconcile. The fetch answers "settled"
    /// because the mock history holds a plain assistant row after the watched text.
    func testTheWatchdogPollReachesTheSettleThatDrains() async {
        let settled = [
            ChatMessage(id: "m0", role: "user", text: "the turn that lost its end",
                        createdAt: "2026-09-18T00:00:00Z", kind: nil),
            ChatMessage(id: "m1", role: "assistant", text: "all done",
                        createdAt: "2026-09-18T00:00:01Z", kind: nil),
        ]
        let (chat, _, writes) = makeStore(history: [convA: settled])
        chat.activeID = convA
        chat.setWatchedUserTextForTesting("the turn that lost its end")
        chat.streaming = true
        await expectQueued(chat, "banked behind a lost message-end")

        chat.startTurnWatchdogForTesting(conversationID: convA, silentFor: 0,
                                         poll: .milliseconds(10))
        // WAIT ON THE DELIVERY, NOT ON `streaming`. The settle this test is about
        // puts the flag down and immediately drains, and the drained send raises it
        // again for the turn it starts — so `!streaming` is a state that exists for
        // microseconds and a poll loop legitimately misses it (measured: alone on an
        // idle machine the drain won that race every time, which is why waiting on
        // the flag failed while the behaviour was correct). The POST is the outcome
        // the watchdog is supposed to produce, and it is monotonic.
        await waitUntil("the watchdog's poll to settle the turn and deliver") {
            !writes.requests.isEmpty
        }
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requestedTexts, ["banked behind a lost message-end"],
                       "the watchdog's own poll has to end with the queue delivered")
    }

    /// The SSE `error` arm ends a turn too, and a queue stuck behind a failed turn
    /// is the same stall with a different cause.
    func testTheDrainFiresWhenATurnEndsInAnError() async {
        let (chat, writes) = makeMidTurnStore()
        await expectQueued(chat, "after a failed turn")

        chat.handleForTesting(
            SSEEvent(id: nil, event: "error", data: #"{ "message": "boom" }"#),
            conversationID: convA
        )
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requestedTexts, ["after a failed turn"])
    }

    // MARK: - 5. Teardown must not drain

    /// Teardown puts the flag down, so the observer on it fires; nothing may go out.
    ///
    /// THIS TEST HAS TO BE ABLE TO FAIL, which the first cut could not: awaiting a
    /// drain task returns instantly when none exists, and one `Task.yield()` cannot
    /// carry `drainQueue → performSend → buildImagePayloads → sendMessage` to the
    /// wire, so it was green either way. It now WAITS for a POST that must never
    /// come — long enough for the real chain to complete several times over — and
    /// only then declares the wire clean. Mutation-verified by removing the
    /// `isActive` guard from `scheduleQueueDrain`.
    func testTeardownPutsTheTurnDownWithoutDeliveringAnything() async {
        let (chat, writes) = makeMidTurnStore()
        await expectQueued(chat, "not yours to send")

        chat.closeStream()
        await chat.awaitQueueDrainForTesting()
        await expectNoRequest(for: .milliseconds(400), writes)

        XCTAssertFalse(chat.streaming, "teardown really does put the flag down")
        XCTAssertTrue(writes.requests.isEmpty,
                      "a store being torn down must not post the queue on its way out")
        XCTAssertEqual(chat.queuedSends.map(\.text), ["not yours to send"],
                       "…and must not drop it either")
        XCTAssertEqual(chat.queuedSends.first?.status, .pending,
                       "still banked, still withdrawable, still on disk")
    }

    /// The same for the control that proves the wait is long enough to catch a real
    /// drain. Without this, `expectNoRequest` could be too short and every
    /// "nothing on the wire" assertion above it would be vacuous.
    func testTheNoRequestWindowIsLongEnoughToCatchARealDrain() async {
        let (chat, writes) = makeMidTurnStore()
        await expectQueued(chat, "this one really goes")

        turnEnd(chat, conversationID: convA)
        await expectNoRequest(for: .milliseconds(400), writes)

        XCTAssertEqual(writes.requestedTexts, ["this one really goes"],
                       "the window a teardown must stay silent through is long "
                           + "enough for an allowed drain to reach the wire")
    }

    /// A store that cannot take words at all is the ONE refusal that keeps nothing,
    /// and the caller has to be able to tell it apart from a banked send.
    func testAnInactiveStoreRefusesKeepingNothing() async {
        let (chat, writes) = makeMidTurnStore()
        chat.closeStream()

        let outcome = await chat.sendReportingOutcome("nowhere to go")

        XCTAssertEqual(outcome, .refusedKeepingNothing)
        XCTAssertFalse(outcome.keptTheWords)
        XCTAssertTrue(chat.messages.isEmpty, "no bubble was appended, which is WHY it is false")
        XCTAssertTrue(writes.requests.isEmpty)
    }

    // MARK: - 6. A drained send that fails

    /// An INCONCLUSIVE failure leaves the retryable bubble and PRESERVES the rest of
    /// the queue. It does not deliver the rest: marching on turned one blip into a
    /// wall of red bubbles (see `testTheDrainStopsOnTheFirstFailure…`), and it does
    /// not drop them either, which is the half that would be data loss.
    func testAFailedDrainLeavesARetryableBubbleAndPreservesTheRest() async {
        let (chat, writes) = makeMidTurnStore()
        writes.script(.failure(serverFailure(status: 500, code: "internal")))
        for text in ["loses its round trip", "must not be burned with it"] {
            await expectQueued(chat, text)
        }
        let firstRowID = chat.messages[0].id

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requestedTexts, ["loses its round trip"],
                       "one attempt, then stop")
        let failed = chat.messages.first { $0.id == firstRowID }
        XCTAssertEqual(failed?.failed, true, "the words survive as a retryable bubble")
        XCTAssertEqual(failed?.text, "loses its round trip")
        XCTAssertEqual(chat.queuedSends.map(\.text), ["must not be burned with it"],
                       "the rest of the queue is not collateral damage")
    }

    /// The words must survive a conversation switch that races the POST. `select`
    /// empties `messages`, so the bubble holding them is gone and `markSendFailed`
    /// has nothing to mark: the entry goes back to the queue instead, and delivers
    /// when that conversation is opened again.
    func testADrainThatFailsAfterASwitchReBanksInsteadOfLosingTheWords() async {
        let (chat, _, writes) = makeStore(history: [convA: [], convB: []])
        chat.select(convA)
        chat.streaming = true
        await expectQueued(chat, "must not evaporate")

        // The POST is held open, the user switches away, and only then does it fail.
        let gate = CheckedContinuationGate()
        writes.sendGate = gate
        writes.script(.failure(networkFailure))
        turnEnd(chat, conversationID: convA)
        await waitUntil("the drained POST to be in flight") { writes.requests.count == 1 }
        chat.select(convB)
        gate.open()
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requestedTexts, ["must not evaporate"], "it was attempted")
        XCTAssertEqual(chat.queuedSends.map(\.text), ["must not evaporate"],
                       "…and it is banked again, because nothing else is holding it")

        chat.select(convA)
        await chat.awaitQueueDrainForTesting()
        XCTAssertEqual(writes.requestedTexts, ["must not evaporate", "must not evaporate"])
    }

    // MARK: - 7. The 409 race

    /// A turn can start between the settle and the POST. The message already
    /// carries a promise of delivery, so it goes BACK to the front of the queue
    /// rather than becoming a failure the user has to notice and retry.
    func testA409PutsTheDrainedMessageBackAtTheFrontOfTheQueue() async {
        let (chat, writes) = makeMidTurnStore()
        writes.script(.failure(turnActiveFailure))
        for text in ["head", "tail"] {
            await expectQueued(chat, text)
        }
        let headRowID = chat.messages[0].id

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(chat.queuedSends.map(\.text), ["head", "tail"],
                       "back at the FRONT, with the order behind it intact")
        XCTAssertTrue(chat.queuedRowIDs.contains(headRowID), "and badged again")
        XCTAssertNotEqual(chat.messages.first { $0.id == headRowID }?.failed, true,
                          "a re-banked message is not a failed one")
        XCTAssertTrue(chat.streaming, "the 409 told us a turn is running")

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requestedTexts, ["head", "head"],
                       "the next settle delivers it, still ahead of the tail")
        XCTAssertEqual(chat.queuedSends.map(\.text), ["tail"])
    }

    // MARK: - 8. The ceiling

    func testTheEleventhSendIsRefusedVisiblyAndTheFirstTenStillDeliver() async {
        let (chat, writes) = makeMidTurnStore()
        let texts = (1...ChatSendQueueRules.maxQueuedPerConversation).map { "message \($0)" }
        for text in texts {
            await expectQueued(chat, text)
        }
        XCTAssertEqual(chat.queueFullNotice, ChatSendQueueRules.Refusal.countCeiling.notice,
                       "the composer says so, in the row it already uses for notices")

        let refused = await chat.sendReportingOutcome("one too many")

        XCTAssertEqual(refused, .refusedKeepingNothing,
                       "refusing is fine; refusing SILENTLY is the bug")
        XCTAssertFalse(refused.keptTheWords,
                       "…and the composer must be TOLD, because it is holding the "
                           + "only copy of those words")
        XCTAssertEqual(chat.queuedSends.count, ChatSendQueueRules.maxQueuedPerConversation)
        XCTAssertFalse(chat.messages.contains { $0.text == "one too many" },
                       "the store kept nothing, so it appended nothing")

        for _ in texts {
            turnEnd(chat, conversationID: convA)
            await chat.awaitQueueDrainForTesting()
        }
        XCTAssertEqual(writes.requestedTexts, texts)
        XCTAssertNil(chat.queueFullNotice, "the notice clears itself once there is room")
    }

    /// THE KEYBOARD HALF, which is where the data loss actually lived. The store
    /// refusing is correct; the composer clearing its draft before hearing the
    /// refusal is what deleted the user's paragraph, with no bubble, no draft and no
    /// disk record anywhere. Asserting the store's `refusedKeepingNothing` alone
    /// pinned that loss as expected behaviour.
    func testASendRefusedAtTheCeilingComesBackToTheComposer() async {
        let (chat, _) = makeMidTurnStore()
        for index in 1...ChatSendQueueRules.maxQueuedPerConversation {
            await expectQueued(chat, "filler \(index)")
        }
        let key = "chat:\(convA)"
        ComposerDrafts.shared.clear(key)

        let outcome = await ComposerBar.deliver(
            text: "the long dictated paragraph", images: [], draftKey: key,
            drafts: ComposerDrafts.shared
        ) { text, images in await ComposerView.sendKeepingWords(chat, text, images) }

        XCTAssertEqual(outcome, .returnedToDraft)
        XCTAssertEqual(ComposerDrafts.shared.draft(key), "the long dictated paragraph",
                       "the words are back where the user can see and re-send them")
        XCTAssertNotNil(chat.queueFullNotice,
                        "…and the composer has a sentence to show for it")
        ComposerDrafts.shared.clear(key)
    }

    /// The same guarantee when the user typed again during the round trip: the
    /// refused text must not clobber what is in the field, and must not be dropped
    /// to avoid clobbering it either.
    func testARefusedSendMergesWithWhateverWasTypedMeanwhile() async {
        let (chat, _) = makeMidTurnStore()
        for index in 1...ChatSendQueueRules.maxQueuedPerConversation {
            await expectQueued(chat, "filler \(index)")
        }
        let key = "chat:merge-case"
        ComposerDrafts.shared.clear(key)

        _ = await ComposerBar.deliver(
            text: "first thought", images: [], draftKey: key,
            drafts: ComposerDrafts.shared
        ) { text, images in
            // Typed WHILE the round trip is out, which is the only way this state can
            // arise: `deliver` clears the field before it asks, so anything in there
            // when the answer lands was typed afterwards.
            ComposerDrafts.shared.setDraft("second thought", key: key)
            return await ComposerView.sendKeepingWords(chat, text, images)
        }

        XCTAssertEqual(ComposerDrafts.shared.draft(key), "first thought second thought",
                       "refused words go FIRST, because they were typed first")
        ComposerDrafts.shared.clear(key)
    }

    /// The happy path must still clear the field, or every send leaves its own text
    /// behind and the user sends it twice.
    func testAKeptSendClearsTheDraft() async {
        let (chat, writes) = makeMidTurnStore()
        let key = "chat:kept-case"
        ComposerDrafts.shared.setDraft("banked fine", key: key)

        let outcome = await ComposerBar.deliver(
            text: "banked fine", images: [], draftKey: key,
            drafts: ComposerDrafts.shared
        ) { text, images in await ComposerView.sendKeepingWords(chat, text, images) }

        XCTAssertEqual(outcome, .kept)
        XCTAssertEqual(ComposerDrafts.shared.draft(key), "")
        XCTAssertEqual(chat.queuedSends.map(\.text), ["banked fine"])
        XCTAssertTrue(writes.requests.isEmpty)
    }

    // MARK: - 9. One conversation per message

    func testAMessageQueuedOnOneConversationIsNeverDeliveredToAnother() async {
        let (chat, _, writes) = makeStore(history: [convA: [], convB: []])
        chat.select(convA)
        chat.streaming = true
        await expectQueued(chat, "belongs to A")

        // Switch away and let B finish a turn of its own.
        chat.select(convB)
        XCTAssertFalse(chat.messages.contains { $0.text == "belongs to A" },
                       "A's bubble left with A")
        chat.streaming = true
        turnEnd(chat, conversationID: convB)
        await chat.awaitQueueDrainForTesting()

        XCTAssertTrue(writes.requests.isEmpty,
                      "B settling is not permission to post A's message into B")
        XCTAssertEqual(chat.queuedSends.map(\.text), ["belongs to A"])

        // Back to A: the bubble is rebuilt from the queue, and it delivers here.
        chat.select(convA)
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requests.map(\.conversationID), [convA])
        XCTAssertEqual(writes.requestedTexts, ["belongs to A"])
        XCTAssertTrue(chat.messages.contains { $0.text == "belongs to A" },
                      "the bubble is derived from the queue, so a switch cannot lose it")
    }

    // MARK: - 10. Surviving a kill

    func testAQueueSurvivesAStoreTeardownAndRebuild() async {
        let (first, writes) = makeMidTurnStore()
        await expectQueued(first, "said before the app died")
        first.closeStream()

        // Read back through the REAL restore path (index + per-entry image payload),
        // so this asserts what a relaunch would actually find.
        let persisted = await ChatSendQueueStore.restore()
        XCTAssertEqual(persisted.map(\.text), ["said before the app died"])
        XCTAssertTrue(writes.requests.isEmpty)

        let (relaunched, _, relaunchedWrites) = makeStore()
        relaunched.activeID = convA
        relaunched.adoptQueuedSends(persisted)

        XCTAssertEqual(relaunched.queuedSends.map(\.text), ["said before the app died"])
        XCTAssertEqual(relaunched.messages.map(\.text), ["said before the app died"],
                       "the bubble comes back with it")
        XCTAssertEqual(relaunched.messages[0].pending, true)

        relaunched.streaming = true
        turnEnd(relaunched, conversationID: convA)
        await relaunched.awaitQueueDrainForTesting()
        XCTAssertEqual(relaunchedWrites.requestedTexts, ["said before the app died"])
    }

    /// Images ride the disk copy too — the bytes are the only copy by then, and a
    /// restored message with its attachment silently missing is a different message.
    func testAQueuedAttachmentSurvivesTheDiskRoundTrip() async {
        let (chat, _, writes) = makeStore()
        chat.activeID = convA
        chat.streaming = true
        await expectQueued(chat, "look at this", images: [makeImage()])

        let persisted = await ChatSendQueueStore.restore()
        XCTAssertEqual(persisted.first?.images.count, 1,
                       "the bytes ride their OWN file, and restore re-attaches them")
        XCTAssertEqual(persisted.first?.text, "look at this")
        XCTAssertEqual(chat.messages[0].localImages?.count, 1, "and the bubble shows it")

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()
        XCTAssertEqual(writes.requests.first?.imageCount, 1,
                       "the drained POST carries the attachment it banked")
    }

    /// A conversation deleted while its message waited has nowhere to deliver to.
    /// Pruning runs against a list that actually LANDED, never against an empty one
    /// from a failed read, or an offline launch would eat the user's words.
    func testAQueuedMessageForAConversationThatIsGoneIsDroppedWithoutASend() async {
        let (chat, _, writes) = makeStore()
        chat.activeID = convA
        chat.streaming = true
        await expectQueued(chat, "for a conversation that dies")
        let rowID = chat.messages[0].id

        chat.pruneQueue(against: [summary(convB)])

        XCTAssertTrue(chat.queuedSends.isEmpty)
        XCTAssertFalse(chat.messages.contains { $0.id == rowID }, "its bubble goes too")
        XCTAssertNil(chat.localRowConversation[rowID])
        XCTAssertTrue(writes.requests.isEmpty, "dropped, never delivered somewhere else")
    }

    /// The prune's three doubts, as the pure function. Each one resolved the wrong
    /// way deletes words the user is still owed, and none of them is safety work:
    /// the drain already refuses to post anywhere but the conversation an entry
    /// names, so keeping a dead entry costs nothing.
    func testPruningRefusesEveryAnswerItCannotTrust() {
        let entry = QueuedSend(id: "queued-1", conversationID: convA, agentID: "general",
                               text: "keep me", images: [], createdAt: "2026-09-18T00:00:00Z")
        XCTAssertEqual(
            ChatSendQueueRules.pruned([entry], listedConversations: [convA],
                                     agentID: "general", listWasTruncated: false),
            [entry],
            "listed, so kept"
        )
        XCTAssertTrue(
            ChatSendQueueRules.pruned([entry], listedConversations: [convB],
                                     agentID: "general", listWasTruncated: false).isEmpty,
            "absent from a complete list for its own agent: really gone"
        )
        XCTAssertEqual(
            ChatSendQueueRules.pruned([entry], listedConversations: [convB],
                                     agentID: "mentor", listWasTruncated: false),
            [entry],
            "another agent's list cannot judge this entry at all"
        )
        XCTAssertEqual(
            ChatSendQueueRules.pruned([entry], listedConversations: [convB],
                                     agentID: "general", listWasTruncated: true),
            [entry],
            "a page is not a census: absent may just mean further down"
        )
    }

    /// The agent-scope rule, through the REAL path: `switchAgent` clears the
    /// conversation, then its own task refreshes the new agent's conversation list,
    /// and THAT list is what the prune is handed. Writing `activeAgentID` by hand and
    /// calling `pruneQueue` directly never exercised the wiring, so the integration
    /// this claims to fix had never run.
    func testSwitchingConsoleAgentDoesNotPruneTheOtherAgentsQueue() async {
        let (chat, _, writes) = makeStore()
        chat.activeID = convA
        chat.streaming = true
        await expectQueued(chat, "banked under Walnut")
        XCTAssertEqual(chat.queuedSends.first?.agentID, "general")

        chat.switchAgent("mentor")
        // `switchAgent` fans out through a tracked task that refreshes the list and
        // prunes; the list read is a real (blackholed) request, so wait for the
        // agent id to have actually moved and the dust to settle.
        await waitUntil("the agent switch to settle") { chat.activeAgentID == "mentor" }
        await expectNoRequest(for: .milliseconds(300), writes)
        // …and the prune the switch triggers, run again with a landed list, to pin
        // the judgement rather than the timing.
        chat.pruneQueue(against: [summary("mentor-conv")])

        XCTAssertEqual(chat.queuedSends.map(\.text), ["banked under Walnut"],
                       "another agent's conversation list cannot judge these entries")
        XCTAssertTrue(writes.requests.isEmpty)
    }

    /// A conversation the user has not opened in a while sits past the page the
    /// list asks for, and "not on this page" is not "deleted".
    func testATruncatedConversationPageNeverPrunesAnything() async {
        let (chat, _, _) = makeStore()
        chat.activeID = convA
        chat.streaming = true
        await expectQueued(chat, "further down the list")

        chat.pruneQueue(against: (0..<50).map { summary("other-\($0)") })

        XCTAssertEqual(chat.queuedSends.map(\.text), ["further down the list"])
    }

    // MARK: - 11. The voice rescue truth table

    /// The duplicate-send hazard, from both sides. A dictated sentence whose audio
    /// is already deleted must land in exactly ONE place: a QUEUED message is
    /// already kept (bubble + persisted entry), so rescuing it into the composer as
    /// well would let the same words be sent twice.
    func testAQueuedDictationIsNotAlsoRescuedIntoTheComposer() async {
        let (chat, writes) = makeMidTurnStore()

        let kept = await ComposerView.sendKeepingWords(chat, "dictated mid-turn", [])

        XCTAssertTrue(kept, "the store banked it, so the composer owes it nothing")
        XCTAssertNil(ComposerBar.voiceRescueReason(storeKeptTheWords: kept))
        XCTAssertEqual(chat.messages.filter { $0.text == "dictated mid-turn" }.count, 1,
                       "exactly one copy exists anywhere")
        XCTAssertTrue(writes.requests.isEmpty)
    }

    /// …and the refusal that really keeps nothing must still rescue, or the words
    /// are gone: the audio was deleted the moment transcription succeeded.
    func testARefusalThatKeptNothingIsStillRescued() async {
        let (chat, _, _) = makeStore()
        chat.activeID = convA
        chat.streaming = true
        chat.closeStream()

        let kept = await ComposerView.sendKeepingWords(chat, "the only copy", [])

        XCTAssertFalse(kept)
        XCTAssertTrue(chat.messages.isEmpty)
        XCTAssertEqual(ComposerBar.voiceRescueReason(storeKeptTheWords: kept), "send-refused")
    }

    /// The ceiling is the other refusal that keeps nothing, and it is the one that
    /// can appear BETWEEN the take stopping and the send being attempted, which is
    /// why the rescue cannot be decided at stop time.
    func testADictationRefusedAtTheCeilingIsRescued() async {
        let (chat, _) = makeMidTurnStore()
        for index in 1...ChatSendQueueRules.maxQueuedPerConversation {
            _ = await chat.sendReportingOutcome("filler \(index)")
        }

        let kept = await ComposerView.sendKeepingWords(chat, "dictated too late", [])

        XCTAssertFalse(kept)
        XCTAssertEqual(ComposerBar.voiceRescueReason(storeKeptTheWords: kept), "send-refused")
        XCTAssertFalse(chat.messages.contains { $0.text == "dictated too late" })
    }

    /// A transport failure is NOT a refusal, and conflating them is the older half
    /// of the same bug: the text is already a retryable red bubble, so a rescue
    /// would put it in the composer as well.
    func testAFailedRoundTripIsNotRescued() async {
        let (chat, _, writes) = makeStore()
        chat.activeID = convA
        writes.script(.failure(networkFailure))

        let kept = await ComposerView.sendKeepingWords(chat, "lost its round trip", [])

        XCTAssertTrue(kept, "the store kept it as a failed bubble")
        XCTAssertNil(ComposerBar.voiceRescueReason(storeKeptTheWords: kept))
        XCTAssertEqual(chat.messages.first?.failed, true)
    }

    // MARK: - 12. What never enters the queue

    func testEmptyAndWhitespaceOnlySendsNeverQueue() async {
        let (chat, writes) = makeMidTurnStore()

        for text in ["", "   ", "\n \t"] {
            // Nothing here to bank: a whitespace-only message is not a message.
            await expectRefused(chat, text)
        }
        XCTAssertTrue(chat.queuedSends.isEmpty)
        XCTAssertTrue(chat.messages.isEmpty)
        XCTAssertTrue(writes.requests.isEmpty)
    }

    /// An images-only message is a message. Today's send allows empty text with
    /// attachments, and the queue must not be stricter than the send it defers.
    func testAnImagesOnlySendDoesQueue() async {
        let (chat, _, _) = makeStore()
        chat.activeID = convA
        chat.streaming = true

        await expectQueued(chat, "", images: [makeImage()])
        XCTAssertEqual(chat.queuedSends.count, 1)
        XCTAssertEqual(chat.messages.first?.localImages?.count, 1)
    }

    // MARK: - Withdraw

    /// Withdrawing is the only way back out, and it must put NOTHING on the wire:
    /// the message was never posted, so there is nothing to cancel server-side.
    func testWithdrawingAQueuedMessageRemovesItWithoutTouchingTheServer() async {
        let (chat, writes) = makeMidTurnStore()
        for text in ["keep", "take back"] {
            await expectQueued(chat, text)
        }
        let withdrawn = chat.queuedSends[1].id

        chat.withdrawQueued(withdrawn)

        XCTAssertEqual(chat.queuedSends.map(\.text), ["keep"])
        XCTAssertFalse(chat.queuedRowIDs.contains(withdrawn))
        XCTAssertFalse(chat.messages.contains { $0.id == withdrawn })
        XCTAssertNil(chat.localRowConversation[withdrawn])

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()
        XCTAssertEqual(writes.requestedTexts, ["keep"],
                       "the withdrawn message is never delivered")
    }

    /// A message already handed to the POST is past withdrawing, and asking again
    /// must not delete the bubble the delivery is now solidifying.
    func testWithdrawingAfterDeliveryIsANoOp() async {
        let (chat, writes) = makeMidTurnStore()
        await expectQueued(chat, "already gone")
        let rowID = chat.queuedSends[0].id

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()
        chat.withdrawQueued(rowID)

        XCTAssertEqual(writes.requestedTexts, ["already gone"])
        XCTAssertTrue(chat.messages.contains { $0.id == rowID },
                      "the delivered bubble stays on screen")
    }

    // MARK: - The badge's rows

    /// The badge and its withdraw control are ONE row under the bubble, and the row
    /// only exists while the message is banked.
    func testTheBuilderAddsAQueuedNoticeRowOnlyForABankedMessage() {
        let builder = TimelineRowBuilder()
        var message = ChatMessage(id: "queued-1", role: "user", text: "waiting",
                                  createdAt: "2026-09-18T00:00:00Z", kind: nil)
        message.pending = true

        let banked = builder.rows(for: message, width: 390, expandedRowIDs: [], queued: .pending)
        XCTAssertTrue(banked.contains { $0.content.reuseKind == "queuedNotice" })
        XCTAssertTrue(
            banked.contains {
                if case .userBubble(_, _, _, let pending) = $0.content { return pending }
                return false
            },
            "…and the bubble itself stays pending, which is the 0.65 treatment"
        )

        let plain = builder.rows(for: message, width: 390, expandedRowIDs: [], queued: nil)
        XCTAssertFalse(plain.contains { $0.content.reuseKind == "queuedNotice" })
    }

    /// Never both: a banked message has not been posted, so it cannot also have
    /// failed to post, and two notices under one bubble would contradict each other.
    func testAFailedBubbleGetsTheFailedNoticeAndNotTheQueuedOne() {
        let builder = TimelineRowBuilder()
        var message = ChatMessage(id: "queued-1", role: "user", text: "waiting",
                                  createdAt: "2026-09-18T00:00:00Z", kind: nil)
        message.failed = true

        let rows = builder.rows(for: message, width: 390, expandedRowIDs: [], queued: .pending)

        XCTAssertTrue(rows.contains { $0.content.reuseKind == "failedNotice" })
        XCTAssertFalse(rows.contains { $0.content.reuseKind == "queuedNotice" })
    }

    /// A banked bubble belongs AFTER the live region, not where it sits in
    /// `messages`.
    ///
    /// The store appends its bubble to the end of the message list while the live
    /// rows are appended after all of them, so an in-order build drew the queued
    /// message ABOVE the reply still streaming, as if it had been sent first. It also
    /// put the one row that confirms "your message was taken" above whatever the
    /// enqueue's re-pin scrolls to, i.e. off screen.
    func testABankedBubbleIsBuiltAfterTheLiveRegion() async {
        var history = ChatMessage(id: "m0", role: "user", text: "do the first thing",
                                  createdAt: "2026-09-18T00:00:00Z", kind: nil)
        history.pending = false
        var banked = ChatMessage(id: "queued-1", role: "user", text: "and then the second",
                                 createdAt: "2026-09-18T00:00:01Z", kind: nil)
        banked.pending = true

        let snapshot = await TimelineLayoutActor().buildSnapshot(TimelineInput(
            messages: [history, banked], streaming: true,
            liveText: "Working on the first thing now.", liveTextTruncated: false,
            activity: nil, showLoadEarlier: false, width: 390, expandedRowIDs: [],
            queuedMessageStates: ["queued-1": .pending]
        ))

        let badgeIndex = snapshot.rows.firstIndex { $0.content.reuseKind == "queuedNotice" }
        let liveIndex = snapshot.rows.lastIndex {
            if case .text(let attributed) = $0.content {
                return attributed.string.contains("Working on the first thing")
            }
            return false
        }
        XCTAssertNotNil(badgeIndex)
        XCTAssertNotNil(liveIndex)
        XCTAssertGreaterThan(badgeIndex ?? -1, liveIndex ?? .max,
                             "the banked bubble is next in line, so it reads last")
        XCTAssertEqual(snapshot.rows.last?.content.reuseKind, "queuedNotice")
    }


    // MARK: - Background to foreground (the trigger no flag observer can provide)

    /// Bank mid-turn, background the app, let the turn end while backgrounded, come
    /// back. Nothing in the resume path assigns `streaming`, so with the observer as
    /// the only trigger this queue had none at all and the badge went on promising
    /// "delivers when the current reply finishes" with no reply to finish.
    func testAQueueBankedBeforeBackgroundingDrainsOnForeground() async {
        let (chat, _, writes) = makeStore(history: [convA: []])
        chat.select(convA)
        chat.streaming = true
        await expectQueued(chat, "said before the app went away")

        // Background: teardown puts the flag down and nothing goes out.
        chat.suspendForBackground()
        await chat.awaitQueueDrainForTesting()
        await expectNoRequest(for: .milliseconds(300), writes)
        XCTAssertTrue(writes.requests.isEmpty)

        // Foreground. The turn ended while we were away, so there is no message-end
        // coming and no flag transition to observe.
        chat.resumeForForeground()
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requestedTexts, ["said before the app went away"])
    }

    /// A reconnect is the other moment the app regains its voice, and the drain
    /// refuses to run offline, so the two have to meet.
    func testReconnectingDrainsAQueueThatCouldNotBeDeliveredOffline() async {
        let (chat, _, writes) = makeStore(history: [convA: []])
        let connection = ConnectionStore()
        chat.connection = connection
        chat.activeID = convA
        chat.streaming = true
        await expectQueued(chat, "typed while the signal was gone")
        connection.online = false

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()
        await expectNoRequest(for: .milliseconds(300), writes)
        XCTAssertTrue(writes.requests.isEmpty,
                      "draining with no network turns the queue into a wall of red")
        XCTAssertEqual(chat.queuedSends.map(\.text), ["typed while the signal was gone"])

        connection.online = true
        chat.connectStream()
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requestedTexts, ["typed while the signal was gone"])
    }

    // MARK: - A kill inside the POST window

    /// The entry stays ON DISK while the POST is out, so a kill in that window
    /// cannot lose the words. Removing it first (the earlier cut) left them in no
    /// queue, no cache and possibly no server: the pending bubble is never
    /// persisted, because the message cache only holds server rows.
    func testAnEntryStaysOnDiskWhileItsPostIsInFlight() async {
        let (chat, _, writes) = makeStore(history: [convA: []])
        chat.activeID = convA
        chat.streaming = true
        await expectQueued(chat, "mid-flight when the app died")
        let gate = CheckedContinuationGate()
        writes.sendGate = gate

        turnEnd(chat, conversationID: convA)
        await waitUntil("the POST to be in flight") { writes.requests.count == 1 }

        let onDisk = await ChatSendQueueStore.restore()
        XCTAssertEqual(onDisk.map(\.text), ["mid-flight when the app died"],
                       "the words are still recoverable while the POST is out")
        XCTAssertEqual(onDisk.first?.status, .processing)
        XCTAssertEqual(chat.queuedRowStates.values.first, .processing)

        gate.open()
        await chat.awaitQueueDrainForTesting()
        let afterDelivery = await ChatSendQueueStore.restore()
        XCTAssertTrue(afterDelivery.isEmpty,
                      "…and only leaves the disk once the send is known to have landed")
    }

    /// What the NEXT launch does with that entry. Neither automatic answer is
    /// allowed: re-sending may hand the agent the same instruction twice (no
    /// idempotency key on this endpoint), dropping it deletes committed words. So it
    /// becomes the retryable failed bubble a human decides about.
    func testAnEntryKilledMidPostComesBackAsAFailedBubbleAndNeverAutoSends() async {
        let interrupted = QueuedSend(
            id: "queued-interrupted", conversationID: convA, agentID: "general",
            text: "did the server get this?", images: [],
            createdAt: "2026-09-18T00:00:00Z", status: .processing
        )
        let (chat, _, writes) = makeStore(history: [convA: []])
        chat.activeID = convA
        chat.adoptQueuedSends([interrupted])

        XCTAssertEqual(chat.queuedRowStates["queued-interrupted"], .undecided)
        let bubble = chat.messages.first { $0.id == "queued-interrupted" }
        XCTAssertEqual(bubble?.failed, true, "a red bubble the user can act on")
        XCTAssertNotEqual(bubble?.pending, true, "never a promise we cannot keep")
        XCTAssertEqual(bubble?.text, "did the server get this?")

        // Every automatic trigger, and none of them may send it.
        chat.streaming = true
        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()
        chat.resumeForForeground()
        await chat.awaitQueueDrainForTesting()
        await expectNoRequest(for: .milliseconds(300), writes)
        XCTAssertTrue(writes.requests.isEmpty)

        // The human's tap is the one thing that may.
        await chat.retry(bubble!)
        XCTAssertEqual(writes.requestedTexts, ["did the server get this?"])
        XCTAssertNil(chat.queuedRowStates["queued-interrupted"],
                     "and it leaves the disk with the bubble, so it cannot come back")
    }

    /// Committed words are not cache. `Caches/` is purged under disk pressure and
    /// deleted wholesale by `DiskCache.clearAll()` on a disconnect, both of which are
    /// fine for a re-fetchable page of messages and silent data loss for a sentence
    /// that exists nowhere else.
    func testTheQueueIsNotStoredInTheCacheDirectory() async {
        let (chat, _, _) = makeStore()
        chat.activeID = convA
        chat.streaming = true
        await expectQueued(chat, "not a cache entry")

        DiskCache.clearAll()
        // The cache's own queue serialises this behind the delete.
        _ = await DiskCache.loadAsync([String].self, key: "probe-after-clear")

        let survived = await ChatSendQueueStore.restore()
        XCTAssertEqual(survived.map(\.text), ["not a cache entry"],
                       "a disconnect wiping the cache must not wipe the user's words")
    }

    // MARK: - The bubble, not the conversation, is the judge

    /// A to B and back to A, with an INCONCLUSIVE failure landing after the round
    /// trip. The words must be on screen either way, and this is the shape the review
    /// predicted would lose them.
    ///
    /// It no longer can, and the reason is worth keeping: the entry now stays on disk
    /// for the whole POST (item 3), so `restoreQueuedBubbles` can rebuild the row when
    /// the user comes back, and `markSendFailed` has something to mark. Both halves of
    /// the old hole are closed, from opposite ends.
    func testTheWordsSurviveAConversationRoundTripDuringThePost() async {
        let (chat, _, writes) = makeStore(history: [convA: [], convB: []])
        chat.select(convA)
        chat.streaming = true
        await expectQueued(chat, "must survive A to B to A")

        let gate = CheckedContinuationGate()
        writes.sendGate = gate
        writes.script(.failure(serverFailure(status: 500, code: "internal")))
        turnEnd(chat, conversationID: convA)
        await waitUntil("the POST to be in flight") { writes.requests.count == 1 }
        chat.select(convB)
        chat.select(convA)
        gate.open()
        await chat.awaitQueueDrainForTesting()

        let row = chat.messages.first { $0.text == "must survive A to B to A" }
        XCTAssertNotNil(row, "the words are on screen in the conversation they belong to")
        XCTAssertEqual(row?.failed, true, "as a retryable bubble, because the outcome "
                           + "is unknown and nothing automatic may try again")
        XCTAssertTrue(chat.queuedSends.isEmpty)
    }

    /// The judge itself: it asks whether the BUBBLE is there, not whether the
    /// conversation matches. Conversation equality is a proxy, and the case it gets
    /// wrong is a row that is missing while its conversation is on screen — then
    /// `markSendFailed` is a silent no-op on a row that does not exist and the words
    /// exist nowhere at all.
    ///
    /// The row is removed directly here because it STANDS IN for any path that drops
    /// one; the point is what the store does when it happens, not which path did it.
    func testAFailureWhoseBubbleIsMissingIsReBankedRatherThanLost() async {
        let (chat, writes) = makeMidTurnStore()
        await expectQueued(chat, "its row went missing")
        let rowID = chat.queuedSends[0].id
        let gate = CheckedContinuationGate()
        writes.sendGate = gate
        // Inconclusive: on its own this becomes a failed bubble. With no bubble to
        // become, re-banking is the only thing left that keeps the words.
        writes.script(.failure(serverFailure(status: 500, code: "internal")))

        turnEnd(chat, conversationID: convA)
        await waitUntil("the POST to be in flight") { writes.requests.count == 1 }
        chat.messages.removeAll { $0.id == rowID }
        gate.open()
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(chat.queuedSends.map(\.text), ["its row went missing"],
                       "nothing else was holding these words, so the queue must")
        XCTAssertEqual(chat.queuedSends.first?.status, .pending)
        XCTAssertTrue(chat.messages.contains { $0.id == rowID },
                      "and the row is rebuilt where the user is looking")
    }

    // MARK: - Automatic re-send needs proof, and a reason to expect a different answer

    /// At-least-once against an endpoint with no client-minted id can hand the agent
    /// the same INSTRUCTION twice, so an automatic attempt needs proof that nothing
    /// arrived. It also needs a reason to expect the same bytes to fare better: a
    /// refusal the server read and declined is safe to repeat and pointless to.
    func testOnlyAFailureThatProvesNothingArrivedAndCanClearIsReSentAutomatically() {
        XCTAssertTrue(ChatSendQueueRules.earnsAutomaticRetry(
            APIError.network(underlying: NSError(domain: NSURLErrorDomain,
                                                code: NSURLErrorNotConnectedToInternet))))
        XCTAssertTrue(ChatSendQueueRules.earnsAutomaticRetry(
            APIError.network(underlying: NSError(domain: NSURLErrorDomain,
                                                code: NSURLErrorCannotConnectToHost))))
        XCTAssertTrue(ChatSendQueueRules.earnsAutomaticRetry(
            APIError.network(underlying: NSError(domain: NSURLErrorDomain,
                                                code: NSURLErrorDNSLookupFailed))))
        XCTAssertTrue(ChatSendQueueRules.earnsAutomaticRetry(APIError.notConfigured))
        XCTAssertTrue(ChatSendQueueRules.earnsAutomaticRetry(APIError.rateLimited),
                      "the one refusal a later identical attempt is expected to clear")

        // The inconclusive half. A timeout is DELIBERATELY not retryable here, which
        // is the opposite of `SendRetryPolicy.isRetryableTransport` — that path mints
        // a stable `qm-*` id the server dedupes on, and this one has none.
        XCTAssertFalse(ChatSendQueueRules.earnsAutomaticRetry(
            APIError.network(underlying: NSError(domain: NSURLErrorDomain,
                                                code: NSURLErrorTimedOut))))
        XCTAssertFalse(ChatSendQueueRules.earnsAutomaticRetry(
            APIError.network(underlying: NSError(domain: NSURLErrorDomain,
                                                code: NSURLErrorNetworkConnectionLost))))
        XCTAssertFalse(ChatSendQueueRules.earnsAutomaticRetry(
            serverFailure(status: 500, code: "internal")))

        // The conclusive-and-hopeless half. Identical bytes earn the identical
        // refusal, and an entry re-banked on every settle blocks its conversation's
        // queue forever behind a badge that has become a lie.
        XCTAssertFalse(ChatSendQueueRules.earnsAutomaticRetry(
            serverFailure(status: 400, code: "bad_request")))
        XCTAssertFalse(ChatSendQueueRules.earnsAutomaticRetry(
            serverFailure(status: 404, code: "not_found")))
        XCTAssertFalse(ChatSendQueueRules.earnsAutomaticRetry(APIError.unauthorized))
        XCTAssertFalse(ChatSendQueueRules.earnsAutomaticRetry(
            serverFailure(status: 409, code: "turn_active")),
            "a 409 is its own case: the front of the queue, not a re-send decision")
        XCTAssertTrue(SendRetryPolicy.isRetryableTransport(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)),
            "the divergence is intentional, so pin that the other rule still differs")
    }

    /// The store-level consequence of a refusal: the entry leaves the queue and the
    /// words become the retryable failed bubble. Re-banking it instead made the
    /// refused message the permanent head of its conversation's queue, so every
    /// message typed after it was stuck behind a `Queued` badge on one that could
    /// never go out, and nothing on screen said why.
    func testARefusedDrainBecomesAFailedBubbleAndDoesNotBlockTheQueue() async {
        let (chat, writes) = makeMidTurnStore()
        await expectQueued(chat, "the server will refuse this one")
        await expectQueued(chat, "and this one waits behind it")
        writes.script(.failure(serverFailure(status: 400, code: "bad_request")))

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()

        let refused = chat.messages.first { $0.text == "the server will refuse this one" }
        XCTAssertEqual(refused?.failed, true, "a refusal is the human's to decide about")
        XCTAssertFalse(chat.queuedSends.contains { $0.text == "the server will refuse this one" },
                       "and it is no longer anything automatic can send again")
        // A refusal is about ONE message, so the drain moves on: the entry behind it
        // goes out in the same pass instead of waiting behind a badge for a settle
        // that a refused head could never produce.
        XCTAssertEqual(writes.requestedTexts,
                       ["the server will refuse this one", "and this one waits behind it"])
        XCTAssertTrue(chat.queuedSends.isEmpty)

        // And the refused one is never re-sent by any later trigger.
        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()
        XCTAssertEqual(writes.requestedTexts.filter { $0 == "the server will refuse this one" }.count, 1)
    }

    /// End to end: an inconclusive failure leaves the retryable bubble and takes the
    /// entry OFF the disk, so no automatic trigger can send it a second time.
    func testAnInconclusiveFailureBecomesABubbleTheUserDecidesAbout() async {
        let (chat, writes) = makeMidTurnStore()
        writes.script(.failure(serverFailure(status: 500, code: "internal")))
        await expectQueued(chat, "may or may not have arrived")
        let rowID = chat.queuedSends[0].id

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requestedTexts, ["may or may not have arrived"])
        XCTAssertEqual(chat.messages.first { $0.id == rowID }?.failed, true)
        XCTAssertTrue(chat.queuedSends.isEmpty, "nothing automatic may try again")
        XCTAssertNil(chat.queuedRowStates[rowID])

        chat.resumeForForeground()
        await chat.awaitQueueDrainForTesting()
        await expectNoRequest(for: .milliseconds(250), writes)
        XCTAssertEqual(writes.requestedTexts.count, 1, "exactly one attempt, ever")
    }

    /// A failure that DOES prove nothing arrived keeps its promise instead.
    func testAProvenUndeliveredFailureStaysInTheQueue() async {
        let (chat, writes) = makeMidTurnStore()
        writes.script(.failure(networkFailure))
        await expectQueued(chat, "never left the device")

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(chat.queuedSends.map(\.text), ["never left the device"])
        XCTAssertEqual(chat.queuedSends.first?.status, .pending)
        XCTAssertNotEqual(chat.messages.first?.failed, true, "still a promise, not a failure")
    }

    // MARK: - One failure must not burn the queue

    /// Ten banked messages plus one network blip used to become ten red bubbles in a
    /// tight loop: the drain marched on after each failure. It stops on the first.
    func testTheDrainStopsOnTheFirstFailureInsteadOfBurningTheQueue() async {
        let (chat, writes) = makeMidTurnStore()
        writes.script(.failure(networkFailure))
        for index in 1...5 {
            await expectQueued(chat, "message \(index)")
        }

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()

        XCTAssertEqual(writes.requestedTexts, ["message 1"],
                       "one attempt, then stop: the rest keep their promise")
        XCTAssertEqual(chat.queuedSends.map(\.text),
                       ["message 1", "message 2", "message 3", "message 4", "message 5"])
        XCTAssertEqual(chat.messages.filter { $0.failed == true }.count, 0)
    }

    // MARK: - Ordering cannot invert

    /// The web console holds `isStreaming` true until its queue empties, so nothing
    /// can jump the line. Adopting the invariant directly: while anything is banked
    /// for this conversation, a new send joins the BACK of the queue even if the
    /// store looks idle at that instant.
    func testASendMadeWhileTheQueueIsNonEmptyJoinsTheBackOfIt() async {
        let (chat, writes) = makeMidTurnStore()
        await expectQueued(chat, "first")
        await expectQueued(chat, "second")

        // The window the invariant exists for: no turn running, queue not yet drained.
        chat.streaming = false
        XCTAssertTrue(chat.hasQueuedSendsHere)
        await expectQueued(chat, "third")

        XCTAssertEqual(chat.queuedSends.map(\.text), ["first", "second", "third"])
        await chat.awaitQueueDrainForTesting()
        for _ in 0..<3 {
            turnEnd(chat, conversationID: convA)
            await chat.awaitQueueDrainForTesting()
        }
        XCTAssertEqual(writes.requestedTexts, ["first", "second", "third"],
                       "in the order they were typed, with nothing overtaking")
    }

    // MARK: - Stop delivers the queue (a decision, not an accident)

    /// DELIBERATE divergence from the web console, which clears its queue on stop.
    /// Stop is aimed at the running turn; the banked messages are separate
    /// instructions the user gave, and deleting them silently is the worse failure.
    /// Stranding them is worse still: the drain's triggers are turn ends and
    /// reconnects, so a stop that does not drain leaves no trigger at all.
    func testAStopDeliversTheQueueOneTurnAtATimeInOrder() async {
        let (chat, writes) = makeMidTurnStore()
        for text in ["keep going", "and then this"] {
            await expectQueued(chat, text)
        }

        await chat.stopTurn()
        await chat.awaitQueueDrainForTesting()
        XCTAssertEqual(writes.requestedTexts, ["keep going"], "one turn at a time")

        turnEnd(chat, conversationID: convA)
        await chat.awaitQueueDrainForTesting()
        XCTAssertEqual(writes.requestedTexts, ["keep going", "and then this"])
        XCTAssertTrue(chat.queuedSends.isEmpty)
    }

    // MARK: - Withdraw never lies

    /// The control is GONE once a POST is out, not present-and-inert. A tap that
    /// silently does nothing while the badge still offers it is a lie the user only
    /// discovers when the message arrives anyway.
    func testWithdrawIsNotOfferedOnceDeliveryHasStarted() async {
        let (chat, writes) = makeMidTurnStore()
        await expectQueued(chat, "already on its way")
        let rowID = chat.queuedSends[0].id
        let gate = CheckedContinuationGate()
        writes.sendGate = gate

        turnEnd(chat, conversationID: convA)
        await waitUntil("delivery to start") { chat.queuedRowStates[rowID] == .processing }

        // The row model is what the cell reads, and it must not build the button.
        let builder = TimelineRowBuilder()
        var message = ChatMessage(id: rowID, role: "user", text: "already on its way",
                                  createdAt: "2026-09-18T00:00:00Z", kind: nil)
        message.pending = true
        let rows = builder.rows(for: message, width: 390, expandedRowIDs: [],
                                queued: .processing)
        let notice = rows.first { $0.content.reuseKind == "queuedNotice" }
        XCTAssertNotNil(notice, "the badge stays: the message is still not delivered")
        if case .queuedNotice(let delivering, _) = notice?.content {
            XCTAssertTrue(delivering, "and it reads as delivering, not as withdrawable")
        } else {
            XCTFail("expected a queuedNotice row")
        }
        // And the store refuses too, so no other caller can pretend otherwise.
        chat.withdrawQueued(rowID)
        XCTAssertEqual(chat.queuedRowStates[rowID], .processing)

        gate.open()
        await chat.awaitQueueDrainForTesting()
        XCTAssertEqual(writes.requestedTexts, ["already on its way"])
    }

    /// The pending state DOES offer it, or the control would never be reachable.
    func testAPendingRowOffersWithdraw() {
        let builder = TimelineRowBuilder()
        var message = ChatMessage(id: "queued-1", role: "user", text: "waiting",
                                  createdAt: "2026-09-18T00:00:00Z", kind: nil)
        message.pending = true
        let rows = builder.rows(for: message, width: 390, expandedRowIDs: [],
                                queued: .pending)
        guard case .queuedNotice(let delivering, _)? = rows.first(where: {
            $0.content.reuseKind == "queuedNotice"
        })?.content else {
            return XCTFail("expected a queuedNotice row")
        }
        XCTAssertFalse(delivering)
    }

    /// An `undecided` entry is a FAILED bubble, not a badge: it is not waiting for
    /// anything and offering Withdraw on it would be a third meaning for the row.
    func testAnUndecidedEntryGetsNoQueuedBadge() {
        let builder = TimelineRowBuilder()
        var message = ChatMessage(id: "queued-1", role: "user", text: "unknown fate",
                                  createdAt: "2026-09-18T00:00:00Z", kind: nil)
        message.failed = true
        let rows = builder.rows(for: message, width: 390, expandedRowIDs: [],
                                queued: .undecided)
        XCTAssertTrue(rows.contains { $0.content.reuseKind == "failedNotice" })
        XCTAssertFalse(rows.contains { $0.content.reuseKind == "queuedNotice" })
    }

    // MARK: - Pure rules

    func testTheCeilingMatchesTheWebConsole() {
        XCTAssertEqual(ChatSendQueueRules.maxQueuedPerConversation, 10,
                       "the web console's MAX_QUEUE_SIZE")
        // NOT `notice.contains("10")`: the notice is interpolated FROM the constant,
        // so that assertion passes for any value and proves only that Swift can
        // interpolate. What production could get wrong is the SHAPE of the sentence,
        // so assert the parts a user reads: the number, and what to do about it.
        let notice = ChatSendQueueRules.Refusal.countCeiling.notice
        XCTAssertTrue(notice.hasPrefix("10 messages"), notice)
        XCTAssertTrue(notice.lowercased().contains("wait for one"),
                      "a ceiling with no way out is a dead end: \(notice)")
        for notice in [ChatSendQueueRules.Refusal.countCeiling.notice,
                       ChatSendQueueRules.Refusal.byteCeiling.notice,
                       ChatSendQueueRules.Refusal.noConversation.notice,
                       ComposerBar.refusedNotice] {
            XCTAssertFalse(notice.contains("—") || notice.contains("–"),
                           "user-facing copy must not carry dashes: \(notice)")
            XCTAssertFalse(notice.lowercased().contains("sent to"),
                           "no sentence may claim delivery: \(notice)")
        }
    }

    /// The byte budget, which the count ceiling cannot see: ten short messages are
    /// nothing and ten photo messages are ~24MB of JPEG held in memory AND on disk.
    func testTheByteBudgetRefusesBeforeTheCountCeilingDoes() {
        func entry(_ id: String, bytes: Int) -> QueuedSend {
            QueuedSend(id: id, conversationID: convA, agentID: "general", text: id,
                       images: [Data(count: bytes)], createdAt: "2026-09-18T00:00:00Z")
        }
        let nearlyFull = [entry("big", bytes: ChatSendQueueRules.maxQueuedBytes - 10)]
        XCTAssertEqual(
            ChatSendQueueRules.refusal(toEnqueueInto: nearlyFull, conversationID: convA,
                                       agentID: "general", newBytes: 1_000),
            .byteCeiling,
            "one entry can exhaust the budget long before the count ceiling"
        )
        XCTAssertNil(
            ChatSendQueueRules.refusal(toEnqueueInto: nearlyFull, conversationID: convA,
                                       agentID: "general", newBytes: 0),
            "a message with no attachments costs nothing, and refusing it would "
                + "strand the only thing that can drain the queue back under budget"
        )
    }

    /// The ceiling is PER CONVERSATION. A global count made ten messages banked in
    /// one thread refuse a send in a different one, which is a limit the user has no
    /// way to understand from where they are standing.
    func testTheCountCeilingIsPerConversation() async {
        let (chat, _, writes) = makeStore(history: [convA: [], convB: []])
        chat.select(convA)
        chat.streaming = true
        for index in 1...ChatSendQueueRules.maxQueuedPerConversation {
            await expectQueued(chat, "A \(index)")
        }
        await expectRefused(chat, "A is full")

        chat.select(convB)
        chat.streaming = true
        await expectQueued(chat, "B still has room")

        XCTAssertEqual(chat.queuedSends.filter { $0.conversationID == convB }.count, 1)
        XCTAssertTrue(writes.requests.isEmpty)
    }

    /// The head of the queue may belong to a conversation the user has left. Taking
    /// it as the next delivery would block every entry behind it, so the one on
    /// screen would never go out.
    func testTheNextDeliverableSkipsOtherConversations() {
        func entry(_ id: String, _ conversation: String, agent: String = "general") -> QueuedSend {
            QueuedSend(id: id, conversationID: conversation, agentID: agent,
                       text: id, images: [], createdAt: "2026-09-18T00:00:00Z")
        }
        let queue = [entry("one", convB), entry("two", convA), entry("three", convA)]

        XCTAssertEqual(
            ChatSendQueueRules.nextDeliverable(queue, conversationID: convA, agentID: "general"), 1
        )
        XCTAssertNil(
            ChatSendQueueRules.nextDeliverable(queue, conversationID: nil, agentID: "general")
        )
        XCTAssertNil(
            ChatSendQueueRules.nextDeliverable(queue, conversationID: convA, agentID: "mentor"),
            "an agent switch is as much a different scope as a conversation switch"
        )
    }

    // MARK: - The scope a send goes out under

    /// A send's agent is decided when the user pressed send, not when the POST
    /// finally leaves. `createConversation` is the suspension in the middle of one
    /// send, and switching console agent across it used to change the agent the
    /// message was delivered to: conversation A's words handed to a persona that
    /// never saw the thread.
    func testAPostCarriesTheAgentTheSendStartedUnderNotTheOneOnScreenNow() async {
        let (chat, _, writes) = makeStore()
        chat.activeID = nil
        let gate = CheckedContinuationGate()
        writes.createGate = gate

        Task { await chat.send("who is this for?") }
        await waitUntil("the conversation to be created") { writes.createCount == 1 }

        chat.switchAgent("mentor")
        gate.open()
        await waitUntil("the POST to land") { writes.requests.count == 1 }

        XCTAssertEqual(writes.requests.first?.agentID, "general",
                       "the POST carries the agent the words were typed under")
        XCTAssertEqual(chat.activeAgentID, "mentor", "and the switch itself still took")
    }
}
