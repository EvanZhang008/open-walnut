import XCTest
@testable import Walnut

/// A message sent while a session's turn is running is drawn AFTER the part of the
/// turn already on screen, and before what streams in afterwards (2026-10-24 field
/// report, build 124: the bubble landed above the commentary it was answering).
/// The saved transcript was right all along; these pin the page's drawing to it.
@MainActor
final class SessionMidTurnOrderTests: XCTestCase {
    private typealias Message = SessionTranscript.Message

    private func event(_ name: String, _ json: String = "{}") -> SSEEvent {
        SSEEvent(id: nil, event: name, data: json)
    }

    private func store(_ tag: String) -> (SessionConversationStore, MockSessionSendTransport) {
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "midturn-\(tag)"),
                                             transport: transport)
        return (store, transport)
    }

    /// A running turn that has said something and called a tool.
    private func streamCommentary(_ store: SessionConversationStore, text: String = "Commentary one.",
                                  tool: String = "t1", finished: Bool = true) {
        store.handle(event("turn-start"))
        store.handle(event("text-delta", #"{"delta":"\#(text)"}"#))
        store.handle(event("tool", #"{"name":"Read","detail":"notes.md","toolUseId":"\#(tool)"}"#))
        if finished { store.handle(event("tool-result", #"{"toolUseId":"\#(tool)","resultPreview":"ok"}"#)) }
        store.flushPendingDelta()
    }

    private func shape(_ messages: [ChatMessage]) -> [String] {
        messages.map { m in
            switch m.kind {
            case .tool: return "tool:\(m.text)"
            case .thinking: return "thinking"
            default: return "\(m.role):\(m.text)"
            }
        }
    }

    func testAMidTurnMessageIsDrawnAfterTheOutputOnScreen() async {
        let (store, _) = store("basic")
        streamCommentary(store)
        let sent = await store.send("Summarize it")
        XCTAssertTrue(sent)
        XCTAssertEqual(shape(store.messages),
                       ["assistant:Commentary one.", "tool:Read", "user:Summarize it"])
        // The live region starts over: nothing shown twice.
        XCTAssertEqual(store.liveText, "")
        XCTAssertTrue(store.liveTools.isEmpty)
        // What streams after the send is the live region, below the bubble.
        store.handle(event("text-delta", #"{"delta":"Commentary two."}"#))
        store.flushPendingDelta()
        XCTAssertEqual(store.liveText, "Commentary two.")
        XCTAssertTrue(store.streaming)
    }

    func testTheTimelineDrawsTheBubbleBetweenEarlierAndLaterOutput() async {
        let (store, _) = store("layout")
        streamCommentary(store)
        await store.send("Summarize it")
        store.handle(event("text-delta", #"{"delta":"Commentary two."}"#))
        store.flushPendingDelta()
        let input = TimelineInput(messages: store.messages, streaming: store.streaming,
                                  liveText: store.liveText, liveTextTruncated: false,
                                  liveTools: store.liveTools, activity: store.activity,
                                  showLoadEarlier: false, width: 390, expandedRowIDs: [],
                                  afterLiveMessageIDs: store.afterLiveMessageIDs)
        let rows = await TimelineLayoutActor().buildSnapshot(input).rows.map(\.id)
        let bubble = store.messages.first { $0.isUser }!.id
        let first = rows.firstIndex { $0.contains("-text") }
        let user = rows.firstIndex { $0.contains(bubble) && !$0.contains("sent-run") }
        let live = rows.firstIndex { $0.contains("live") }
        XCTAssertNotNil(first); XCTAssertNotNil(user); XCTAssertNotNil(live)
        XCTAssertLessThan(first!, user!)
        XCTAssertLessThan(user!, live!)
    }

    func testTurnEndKeepsTheOrderAndTheRefetchReplacesItWithTheSavedRows() async {
        let (store, _) = store("turn-end")
        streamCommentary(store)
        await store.send("Summarize it")
        store.handle(event("text-delta", #"{"delta":"Commentary two."}"#))
        store.handle(event("turn-end"))
        XCTAssertEqual(shape(store.messages),
                       ["assistant:Commentary one.", "tool:Read", "user:Summarize it",
                        "assistant:Commentary two."])
        // The saved transcript, in the order the session wrote it.
        store.reconcile(SessionTranscript(
            sessionId: "midturn-turn-end", exportedAt: "x", truncated: false,
            messages: [
                Message(role: "assistant", text: "Commentary one.", timestamp: "2026-10-24T07:00:00Z", kind: nil),
                Message(role: "assistant", text: "Read", timestamp: "2026-10-24T07:00:01Z", kind: "tool",
                        detail: "notes.md"),
                Message(role: "user", text: "Summarize it", timestamp: "2026-10-24T07:00:02Z", kind: nil),
                Message(role: "assistant", text: "Commentary two.", timestamp: "2026-10-24T07:00:03Z", kind: nil),
            ]))
        XCTAssertEqual(shape(store.messages),
                       ["assistant:Commentary one.", "tool:Read", "user:Summarize it",
                        "assistant:Commentary two."])
        XCTAssertTrue(store.messages.allSatisfy { !$0.id.hasPrefix("sent-run") && !$0.id.hasPrefix("pending") })
    }

    func testAMessageTheTurnHasNotReadYetFollowsTheSavedTurn() async {
        let (store, _) = store("unread")
        streamCommentary(store)
        await store.send("Later question")
        store.handle(event("text-delta", #"{"delta":"Done."}"#))
        store.handle(event("turn-end"))
        // The turn ended before the session took the message: the read has the
        // whole turn and not the message yet.
        store.reconcile(SessionTranscript(
            sessionId: "midturn-unread", exportedAt: "x", truncated: false,
            messages: [
                Message(role: "assistant", text: "Commentary one.", timestamp: "2026-10-24T07:00:00Z", kind: nil),
                Message(role: "assistant", text: "Read", timestamp: "2026-10-24T07:00:01Z", kind: "tool"),
                Message(role: "assistant", text: "Done.", timestamp: "2026-10-24T07:00:03Z", kind: nil),
            ]))
        XCTAssertEqual(shape(store.messages),
                       ["assistant:Commentary one.", "tool:Read", "assistant:Done.", "user:Later question"])
    }

    func testTwoMidTurnMessagesEachFollowTheirOwnOutput() async {
        let (store, _) = store("two")
        streamCommentary(store)
        await store.send("First")
        store.handle(event("text-delta", #"{"delta":"Middle."}"#))
        store.flushPendingDelta()
        await store.send("Second")
        // Sent with nothing new on screen: right after the first.
        await store.send("Third")
        store.handle(event("text-delta", #"{"delta":"End."}"#))
        store.handle(event("turn-end"))
        XCTAssertEqual(shape(store.messages),
                       ["assistant:Commentary one.", "tool:Read", "user:First", "assistant:Middle.",
                        "user:Second", "user:Third", "assistant:End."])
    }

    func testACallStillRunningAtTheSendFinishesInItsPlace() async {
        let (store, _) = store("running-call")
        streamCommentary(store, finished: false)
        await store.send("While it reads")
        XCTAssertTrue(store.liveTools.isEmpty)
        store.handle(event("tool-result", #"{"toolUseId":"t1","resultPreview":"file body"}"#))
        let tool = store.messages.first { $0.kind == .tool }
        XCTAssertEqual(tool?.resultPreview, "file body")
        XCTAssertTrue(store.liveTools.isEmpty, "the result must not open a second chip in the live region")
        XCTAssertEqual(shape(store.messages), ["assistant:Commentary one.", "tool:Read", "user:While it reads"])
    }

    func testReasoningOnScreenStaysAboveTheMessage() async {
        let (store, _) = store("thinking")
        store.handle(event("turn-start"))
        store.handle(event("thinking", #"{"delta":"Weighing   the\noptions"}"#))
        store.flushLiveThinking()
        await store.send("Go with B")
        XCTAssertEqual(shape(store.messages), ["thinking", "user:Go with B"])
        XCTAssertEqual(store.messages.first?.text, "Weighing the options")
        XCTAssertEqual(store.liveThinking, "")
    }

    func testAMessageSentBetweenTurnsStaysAboveTheTurnItStarts() async {
        let (store, _) = store("idle")
        await store.send("Start")
        streamCommentary(store)
        XCTAssertEqual(shape(store.messages), ["user:Start"])
        XCTAssertEqual(store.liveText, "Commentary one.")
        store.handle(event("turn-end"))
        XCTAssertEqual(shape(store.messages), ["user:Start", "assistant:Commentary one."])
    }

    func testAFailedMidTurnMessageKeepsItsPlaceAndItsOutputOutlivesADiscard() async {
        let (store, transport) = store("failed")
        transport.permanentError = APIError.server(status: 500, code: "internal", message: "boom",
                                                   serverHash: nil, serverContent: nil)
        streamCommentary(store)
        let sent = await store.send("Lost")
        XCTAssertFalse(sent)
        store.handle(event("text-delta", #"{"delta":"After."}"#))
        store.handle(event("turn-end"))
        XCTAssertEqual(shape(store.messages),
                       ["assistant:Commentary one.", "tool:Read", "user:Lost", "assistant:After."])
        XCTAssertEqual(store.messages.first { $0.isUser }?.failed, true)
        store.discardFailed(store.messages.first { $0.isUser }!)
        XCTAssertEqual(shape(store.messages), ["assistant:Commentary one.", "tool:Read", "assistant:After."])
    }

    /// The app comes back from the background: the stream re-attaches and the
    /// snapshot carries the turn's whole text. What the runs already hold stays
    /// where it is; only the rest is live, below the bubble.
    func testASnapshotThatContinuesTheTurnKeepsEveryBubbleInPlace() async throws {
        let (store, _) = store("seed")
        streamCommentary(store)
        await store.send("Hold on")
        let snap = ScriptedSSE.Snapshot(blocks: [.init(content: "Commentary one."), .init(content: "More.")])
        store.handle(event("snapshot", String(data: try JSONEncoder().encode(snap), encoding: .utf8)!))
        XCTAssertEqual(store.liveText, "More.")
        XCTAssertTrue(store.afterLiveMessageIDs.isEmpty)
        XCTAssertEqual(shape(store.messages), ["assistant:Commentary one.", "tool:Read", "user:Hold on"])
        store.handle(event("turn-end"))
        XCTAssertEqual(shape(store.messages),
                       ["assistant:Commentary one.", "tool:Read", "user:Hold on", "assistant:More."])
    }

    /// A seed that does not continue the runs (clipped, or another turn's text):
    /// the runs give way, and the bubble is drawn below the re-seeded live text.
    func testASnapshotThatDoesNotContinueTheTurnMovesTheMessageBelowIt() async throws {
        let (store, _) = store("seed-other")
        streamCommentary(store)
        await store.send("Hold on")
        let snap = ScriptedSSE.Snapshot(blocks: [.init(content: "Something else entirely.")])
        store.handle(event("snapshot", String(data: try JSONEncoder().encode(snap), encoding: .utf8)!))
        XCTAssertEqual(store.liveText, "Something else entirely.")
        XCTAssertEqual(shape(store.messages), ["user:Hold on"], "the run gives way: nothing drawn twice")
        let bubble = store.messages[0].id
        XCTAssertEqual(store.afterLiveMessageIDs, [bubble])
        let input = TimelineInput(messages: store.messages, streaming: store.streaming,
                                  liveText: store.liveText, liveTextTruncated: false,
                                  activity: nil, showLoadEarlier: false, width: 390,
                                  expandedRowIDs: [], afterLiveMessageIDs: store.afterLiveMessageIDs)
        let rows = await TimelineLayoutActor().buildSnapshot(input).rows.map(\.id)
        XCTAssertLessThan(rows.firstIndex { $0.contains("live") }!, rows.firstIndex { $0.contains(bubble) }!)
        store.handle(event("turn-end"))
        XCTAssertTrue(store.afterLiveMessageIDs.isEmpty)
        XCTAssertEqual(shape(store.messages), ["assistant:Something else entirely.", "user:Hold on"])
    }

    func testTheFirstTextAfterASendIsNotIndented() async {
        let (store, _) = store("lead")
        streamCommentary(store)
        await store.send("Go on")
        store.handle(event("text-delta", #"{"delta":"  And then"}"#))
        store.handle(event("text-delta", #"{"delta":" more."}"#))
        store.flushPendingDelta()
        XCTAssertEqual(store.liveText, "And then more.")
    }

    func testACallStillRunningKeepsItsLabelUntilItFinishes() async {
        let (store, _) = store("label")
        streamCommentary(store, finished: false)
        let label = store.activity
        XCTAssertNotNil(label)
        await store.send("While it reads")
        XCTAssertEqual(store.activity, label)
        store.handle(event("tool-result", #"{"toolUseId":"t1","resultPreview":"done"}"#))
        XCTAssertNil(store.activity)
    }

    func testTheSavedMessageRetiresItsRunMidTurn() async {
        let (store, _) = store("absorbed")
        streamCommentary(store)
        await store.send("Summarize it")
        // A read during the turn already has the message and what came before it.
        store.reconcile(SessionTranscript(
            sessionId: "midturn-absorbed", exportedAt: "x", truncated: false,
            messages: [
                Message(role: "assistant", text: "Commentary one.", timestamp: "2026-10-24T07:00:00Z", kind: nil),
                Message(role: "assistant", text: "Read", timestamp: "2026-10-24T07:00:01Z", kind: "tool"),
                Message(role: "user", text: "Summarize it", timestamp: "2026-10-24T07:00:02Z", kind: nil),
            ]))
        XCTAssertEqual(shape(store.messages), ["assistant:Commentary one.", "tool:Read", "user:Summarize it"])
        XCTAssertFalse(store.messages.contains { $0.id.hasPrefix("sent-run") })
    }
    private func saved(_ store: SessionConversationStore, _ rows: [(String, String, String?)]) {
        store.reconcile(SessionTranscript(
            sessionId: "saved", exportedAt: "x", truncated: false,
            messages: rows.enumerated().map { i, row in
                Message(role: row.0, text: row.1, timestamp: String(format: "2026-10-24T07:00:%02dZ", i), kind: row.2)
            }))
    }

    func testARetriedMessageGoesBelowWhatStreamedWhileItWasNotSent() async {
        let (store, transport) = store("retry")
        transport.permanentError = APIError.server(status: 500, code: "internal", message: "boom",
                                                   serverHash: nil, serverContent: nil)
        streamCommentary(store)
        await store.send("Again")
        store.handle(event("text-delta", #"{"delta":"Meanwhile."}"#))
        store.flushPendingDelta()
        transport.permanentError = nil
        await store.retry(store.messages.first { $0.isUser }!)
        store.handle(event("turn-end"))
        XCTAssertEqual(shape(store.messages),
                       ["assistant:Commentary one.", "tool:Read", "assistant:Meanwhile.", "user:Again"])
    }

    func testAnEmptyReadKeepsTheEndedTurnOnScreen() async {
        let (store, _) = store("empty-read")
        streamCommentary(store)
        await store.send("Summarize it")
        store.handle(event("text-delta", #"{"delta":"Done."}"#))
        store.handle(event("turn-end"))
        let before = shape(store.messages)
        saved(store, [])
        XCTAssertEqual(shape(store.messages), before)
    }

    func testAnErrorEndsTheBelowTheLiveRegionPlacement() async throws {
        let (store, _) = store("error")
        streamCommentary(store)
        await store.send("Hold on")
        let snap = ScriptedSSE.Snapshot(blocks: [.init(content: "Something else.")])
        store.handle(event("snapshot", String(data: try JSONEncoder().encode(snap), encoding: .utf8)!))
        XCTAssertFalse(store.afterLiveMessageIDs.isEmpty)
        store.handle(event("error", #"{"message":"boom"}"#))
        XCTAssertTrue(store.afterLiveMessageIDs.isEmpty)
    }

    /// The degraded 5s poll and a repeated terminal status change nothing, so they
    /// must not invalidate the page (every invalidation rebuilds the timeline).
    func testAnUnchangedPollDoesNotInvalidateThePage() async {
        let (store, _) = store("poll")
        streamCommentary(store)
        await store.send("Summarize it")
        store.handle(event("turn-end"))
        let rows: [(String, String, String?)] = [("assistant", "Commentary one.", nil), ("assistant", "Read", "tool"),
                                                 ("user", "Summarize it", nil)]
        saved(store, rows)
        store.handle(event("status", #"{"processStatus":"stopped"}"#))
        var changed = false
        withObservationTracking {
            _ = store.messages
            _ = store.afterLiveMessageIDs
        } onChange: { changed = true }
        saved(store, rows)
        store.handle(event("status", #"{"processStatus":"stopped"}"#))
        XCTAssertFalse(changed)
    }
    private func seed(_ store: SessionConversationStore, _ blocks: [String]) throws {
        let snap = ScriptedSSE.Snapshot(blocks: blocks.map { .init(content: $0) })
        store.handle(event("snapshot", String(data: try JSONEncoder().encode(snap), encoding: .utf8)!))
    }

    /// A second re-attach (pull to refresh twice, Home and back twice): the read
    /// between them already holds the message and the commentary before it, so the
    /// seed's head is those rows and only the answer is live (ios-ui-qa r2, P1).
    func testASecondReseedAfterTheReadDrawsNothingTwice() async throws {
        let (store, _) = store("reseed-twice")
        streamCommentary(store)
        await store.send("Summarize it")
        store.handle(event("text-delta", #"{"delta":"Answer starts."}"#))
        store.flushPendingDelta()
        try seed(store, ["Commentary one.", "Answer starts."])
        XCTAssertEqual(store.liveText, "Answer starts.")
        saved(store, [("assistant", "Commentary one.", nil), ("assistant", "Read", "tool"),
                      ("user", "Summarize it", nil)])
        try seed(store, ["Commentary one.", "Answer starts. More."])
        XCTAssertEqual(store.liveText, "Answer starts. More.")
        XCTAssertEqual(shape(store.messages), ["assistant:Commentary one.", "tool:Read", "user:Summarize it"])
    }

    /// A turn with no send: a re-attach after a read that saved its first message
    /// re-seeds only what the read does not hold (this duplicated before the fix).
    func testAReseedWithNoSendDrawsTheSavedTextOnce() async throws {
        let (store, _) = store("reseed-nosend")
        streamCommentary(store)
        saved(store, [("user", "Go", nil), ("assistant", "Commentary one.", nil), ("assistant", "Read", "tool")])
        XCTAssertEqual(store.liveText, "", "the read holds the live text, so the live region gives it up")
        try seed(store, ["Commentary one.", "Second part."])
        XCTAssertEqual(store.liveText, "Second part.")
        XCTAssertEqual(shape(store.messages), ["user:Go", "assistant:Commentary one.", "tool:Read"])
    }

    /// A read during the turn saved the commentary but the session has not taken
    /// the message yet: the run gives up its copy, the bubble stays after it.
    func testAReadDuringTheTurnTakesOverTheRunsCopy() async {
        let (store, _) = store("read-midturn")
        streamCommentary(store)
        await store.send("Not read yet")
        saved(store, [("assistant", "Commentary one.", nil), ("assistant", "Read", "tool")])
        XCTAssertEqual(shape(store.messages), ["assistant:Commentary one.", "tool:Read", "user:Not read yet"])
    }

    // MARK: - The turn's text is shown once (independent review, after QA r2)

    /// A send cut a message in two; a read then saved the whole message. Both
    /// halves give way to it: the run's and the live region's.
    func testASendInsideAMessageThenAReadDrawsThatMessageOnce() async {
        let (store, _) = store("cut")
        store.handle(event("turn-start"))
        store.handle(event("text-delta", #"{"delta":"Answer sta"}"#))
        store.flushPendingDelta()
        await store.send("Hold on")
        store.handle(event("text-delta", #"{"delta":"rts. More."}"#))
        store.flushPendingDelta()
        XCTAssertEqual(store.liveText, "rts. More.")
        saved(store, [("assistant", "Answer starts. More.", nil)])
        XCTAssertEqual(shape(store.messages), ["assistant:Answer starts. More.", "user:Hold on"])
        XCTAssertEqual(store.liveText, "")
        // What streams next is still live, below the bubble.
        store.handle(event("text-delta", #"{"delta":" Next."}"#))
        store.flushPendingDelta()
        XCTAssertEqual(store.liveText, "Next.")
    }

    /// The saved message ends inside what the run holds (the session split its
    /// reply across two messages before the send): the run keeps the rest.
    func testARunKeepsTheTextTheReadHasNotSaved() async {
        let (store, _) = store("run-rest")
        store.handle(event("turn-start"))
        store.handle(event("text-delta", #"{"delta":"First part. Second"}"#))
        store.flushPendingDelta()
        await store.send("Hold on")
        saved(store, [("assistant", "First part.", nil)])
        XCTAssertEqual(shape(store.messages), ["assistant:First part.", "assistant:Second", "user:Hold on"])
    }

    /// The previous reply reads like the first words of this one. This turn has
    /// saved nothing, so nothing of the live text is taken for it.
    func testAPreviousReplyIsNotTakenForTheStartOfThisTurn() async throws {
        let (store, _) = store("prev-reply")
        saved(store, [("user", "Hi", nil), ("assistant", "Done.", nil)])
        store.handle(event("turn-start"))
        store.handle(event("text-delta", #"{"delta":"Done. Now checking."}"#))
        store.flushPendingDelta()
        saved(store, [("user", "Hi", nil), ("assistant", "Done.", nil), ("user", "Go on", nil)])
        XCTAssertEqual(store.liveText, "Done. Now checking.")
        try seed(store, ["Done. Now checking."])
        XCTAssertEqual(store.liveText, "Done. Now checking.")
    }

    /// The same with a page that opens mid-turn (no turn start seen): the
    /// previous reply ends inside the seed's first block, so it is not its head.
    func testAPageOpenedMidTurnDoesNotTakeThePreviousReplyForTheTurn() async throws {
        let (store, _) = store("cold-prev")
        saved(store, [("user", "Hi", nil), ("assistant", "Done.", nil), ("user", "Go on", nil)])
        try seed(store, ["Done. Now checking."])
        XCTAssertEqual(store.liveText, "Done. Now checking.")
        XCTAssertEqual(shape(store.messages), ["user:Hi", "assistant:Done.", "user:Go on"])
    }

    /// A page that opens mid-turn finds where the turn began from the seed, and
    /// a later read hands over only what it newly saved.
    func testAPageOpenedMidTurnShowsTheSavedPartOnce() async throws {
        let (store, _) = store("cold")
        saved(store, [("user", "Hi", nil), ("assistant", "Done.", nil), ("user", "Go on", nil),
                      ("assistant", "First part.", nil)])
        try seed(store, ["First part.", "Second."])
        XCTAssertEqual(store.liveText, "Second.")
        store.handle(event("text-delta", #"{"delta":" Third."}"#))
        store.flushPendingDelta()
        saved(store, [("user", "Hi", nil), ("assistant", "Done.", nil), ("user", "Go on", nil),
                      ("assistant", "First part.", nil), ("assistant", "Second.", nil)])
        XCTAssertEqual(store.liveText, "Third.")
    }

    /// A short line the session says every turn: the copy in an earlier turn
    /// does not make this turn's run give up its rows.
    func testAnEarlierTurnsSameWordsLeaveTheRunInPlace() async {
        let (store, _) = store("same-words")
        saved(store, [("user", "Hi", nil), ("assistant", "Let me run the tests.", nil)])
        store.handle(event("turn-start"))
        store.handle(event("text-delta", #"{"delta":"Let me run the tests."}"#))
        store.flushPendingDelta()
        await store.send("Only the unit ones")
        saved(store, [("user", "Hi", nil), ("assistant", "Let me run the tests.", nil), ("user", "Again", nil)])
        XCTAssertEqual(shape(store.messages),
                       ["user:Hi", "assistant:Let me run the tests.", "user:Again",
                        "assistant:Let me run the tests.", "user:Only the unit ones"])
    }

    /// A call that was running at the send finishes after the read took its row:
    /// its result frame stays with the run and draws no second chip.
    func testACallsLateFramesAfterTheReadDrawNothingTwice() async {
        let (store, _) = store("late-frames")
        streamCommentary(store, finished: false)
        await store.send("Hold on")
        saved(store, [("assistant", "Commentary one.", nil), ("assistant", "Read", "tool")])
        XCTAssertEqual(shape(store.messages), ["assistant:Commentary one.", "tool:Read", "user:Hold on"])
        store.handle(event("tool", #"{"name":"Read","detail":"notes.md","toolUseId":"t1"}"#))
        store.handle(event("tool-result", #"{"toolUseId":"t1","resultPreview":"ok"}"#))
        XCTAssertTrue(store.liveTools.isEmpty)
        XCTAssertEqual(shape(store.messages), ["assistant:Commentary one.", "tool:Read", "user:Hold on"])
    }

    /// A mid-turn read that changes nothing (the degraded 5s poll) does not
    /// invalidate the page, and does not trim the live text a second time.
    func testAnUnchangedReadDuringTheTurnChangesNothing() async {
        let (store, _) = store("poll-midturn")
        streamCommentary(store)
        await store.send("Hold on")
        store.handle(event("text-delta", #"{"delta":"Done. Done. ok"}"#))
        store.flushPendingDelta()
        let rows: [(String, String, String?)] = [("assistant", "Commentary one.", nil), ("assistant", "Read", "tool")]
        saved(store, rows)
        XCTAssertEqual(store.liveText, "Done. Done. ok")
        var changed = false
        withObservationTracking {
            _ = store.messages
            _ = store.liveText
        } onChange: { changed = true }
        saved(store, rows)
        XCTAssertFalse(changed)
    }

    /// A clipped run (a very long reply at the send) still hands over to the read.
    func testAClippedRunStillGivesWayToTheSavedMessage() async {
        let (store, _) = store("clipped")
        let long = String(repeating: "word ", count: 9000) + "end."
        store.handle(event("turn-start"))
        store.handle(event("text-delta", "{\"delta\":\"\(long)\"}"))
        store.flushPendingDelta()
        await store.send("Hold on")
        saved(store, [("assistant", long, nil)])
        XCTAssertEqual(store.messages.filter { $0.role == "assistant" }.count, 1)
        XCTAssertEqual(shape(store.messages).last, "user:Hold on")
    }

    /// Text in another script and emoji compare the same way.
    func testUnicodeTextHandsOverToo() async throws {
        let (store, _) = store("unicode")
        store.handle(event("turn-start"))
        store.handle(event("text-delta", #"{"delta":"\u597d\u7684\uff0c\u6211\u6765\u770b \ud83d\udc4d"}"#))
        store.flushPendingDelta()
        await store.send("Hold on")
        store.handle(event("text-delta", #"{"delta":"\u7ee7\u7eed"}"#))
        store.flushPendingDelta()
        try seed(store, ["\u{597D}\u{7684}\u{FF0C}\u{6211}\u{6765}\u{770B} \u{1F44D}", "\u{7EE7}\u{7EED}"])
        XCTAssertEqual(store.liveText, "\u{7EE7}\u{7EED}")
        XCTAssertTrue(store.afterLiveMessageIDs.isEmpty)
    }

    // MARK: - With turn folding (a server that says who sent each row)

    private func timelineRows(_ store: SessionConversationStore) async -> [String] {
        let input = TimelineInput(messages: store.messages, streaming: store.streaming,
                                  liveText: store.liveText, liveTextTruncated: false,
                                  liveTools: store.liveTools, activity: store.activity,
                                  showLoadEarlier: false, width: 390, expandedRowIDs: [],
                                  afterLiveMessageIDs: store.afterLiveMessageIDs)
        return await TimelineLayoutActor().buildSnapshot(input).rows.map(\.id)
    }

    private func savedBy(_ store: SessionConversationStore, _ rows: [(String, String, String?, String?)]) {
        store.reconcile(SessionTranscript(
            sessionId: "saved", exportedAt: "x", truncated: false,
            messages: rows.enumerated().map { i, row in
                Message(role: row.0, text: row.1, timestamp: String(format: "2026-10-24T07:00:%02dZ", i),
                        kind: row.2, sentBy: row.3)
            }))
    }

    /// Everything the runs hold is drawn before the bubble, the live region after it.
    private func assertBubbleBetweenRunsAndLive(_ rows: [String], bubble: String,
                                                file: StaticString = #filePath, line: UInt = #line) {
        guard let user = rows.firstIndex(where: { $0.contains(bubble) && !$0.contains("sent-run") }) else {
            return XCTFail("the bubble is not drawn: \(rows)", file: file, line: line)
        }
        XCTAssertTrue(rows[..<user].contains { $0.contains("sent-run") || $0.contains("fold") || $0.contains("run") },
                      "nothing of the turn is drawn above the bubble: \(rows)", file: file, line: line)
        XCTAssertFalse(rows[(user + 1)...].contains { $0.contains("sent-run") },
                       "a run's row is drawn below the bubble: \(rows)", file: file, line: line)
        if let live = rows.firstIndex(where: { $0.contains("live") }) {
            XCTAssertLessThan(user, live, "the live region is drawn above the bubble: \(rows)", file: file, line: line)
        }
    }

    /// A person's turn: the folding layout keeps the message below the output on screen.
    func testTurnFoldingKeepsAMidTurnMessageBelowAPersonsTurn() async {
        let (store, _) = store("fold-person")
        savedBy(store, [("user", "Go", nil, "person")])
        streamCommentary(store)
        await store.send("Hold on")
        store.handle(event("text-delta", #"{"delta":"After."}"#))
        store.flushPendingDelta()
        let bubble = store.messages.last { $0.isUser }!.id
        assertBubbleBetweenRunsAndLive(await timelineRows(store), bubble: bubble)
    }

    /// A turn a received message started, a call still running at the send and a
    /// new one running after it: the bubble stays between them.
    func testTurnFoldingKeepsAMidTurnMessageBelowAReceivedMessagesTurn() async {
        let (store, _) = store("fold-peer")
        savedBy(store, [("user", "<walnut-message kind=\"peer-note\" from=\"Docs lead [1a2b3c4d]\" title=\"Review\">\nCheck it.\n</walnut-message>", nil, "agent")])
        streamCommentary(store, finished: false)
        await store.send("Hold on")
        store.handle(event("tool", #"{"name":"Bash","detail":"make","toolUseId":"t2"}"#))
        let bubble = store.messages.last { $0.isUser && $0.sentBy == nil }!.id
        assertBubbleBetweenRunsAndLive(await timelineRows(store), bubble: bubble)
    }
}
