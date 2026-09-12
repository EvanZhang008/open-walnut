import XCTest
@testable import Walnut

/// The store half of the chat-richness report. Both live streams send the same
/// `thinking` / `tool` / `tool-result` events, and both stores used to handle
/// them with near-identical arms that THREW THE REASONING AWAY — `thinking
/// { delta }` became a constant `activity = "Thinking"`, so a whole turn of
/// reasoning showed as one blinking word.
///
/// `LiveAgentActivity` + `LiveStreamEvents` are now the single copy. These tests
/// pin the accumulation (bounded), the tool label, and — the point of extracting
/// it — that the two stores AGREE when fed byte-identical events.
///
/// Offline by construction: the test process is pointed at the discard port
/// (`WalnutTestsPrincipal`), so nothing here can reach a real server.
final class LiveAgentActivityTests: XCTestCase {

    // MARK: - The value type

    func testThinkingDeltasAccumulateOnlyOnFlush() {
        var live = LiveAgentActivity()
        live.appendThinking("I should check ")
        live.appendThinking("the lock ")
        live.appendThinking("first.")
        XCTAssertEqual(live.thinkingText, "",
                       "buffered deltas must not touch the published text — that is the "
                           + "coalescing contract the stores rely on")
        XCTAssertTrue(live.hasPendingThinking)
        XCTAssertTrue(live.flush())
        XCTAssertEqual(live.thinkingText, "I should check the lock first.")
        XCTAssertFalse(live.thinkingTruncated)
        XCTAssertFalse(live.flush(), "a second flush with nothing pending is a no-op")
    }

    /// A long turn's reasoning is unbounded; retaining it whole is the
    /// saturation mechanism `LiveMarkdownWindow` exists to prevent.
    ///
    /// RED PROOF: replacing `bound.bound(thinkingText)` in `flush()` with a plain
    /// `thinkingText += pendingThinking` fails both assertions below.
    func testAccumulationIsBounded() {
        var live = LiveAgentActivity()
        let chunk = String(repeating: "推理片段 reasoning chunk ", count: 400)
        for _ in 0..<40 {
            live.appendThinking(chunk)
            live.flush()
        }
        XCTAssertTrue(live.thinkingTruncated, "the head must have been dropped")
        // "Bounded" is "stops growing", which is a stronger and more honest claim
        // than any single byte figure — the cap is a CHARACTER count and this
        // fixture is mixed-width, so the byte total is not a constant.
        let unbounded = chunk.utf8.count * 40
        let settled = live.thinkingText.utf8.count
        XCTAssertLessThan(settled, unbounded / 2, "retention must not track the turn's length")
        for _ in 0..<40 {
            live.appendThinking(chunk)
            live.flush()
        }
        XCTAssertLessThanOrEqual(live.thinkingText.utf8.count, settled + chunk.utf8.count * 2,
                                 "40 more chunks must not grow the retained text")
        // …and it keeps the NEWEST text, which is the part worth showing.
        XCTAssertTrue(live.thinkingText.hasSuffix("reasoning chunk "))
    }

    func testShortAccumulationIsNeverTrimmed() {
        var live = LiveAgentActivity()
        live.appendThinking(String(repeating: "a", count: 5_000))
        live.flush()
        XCTAssertEqual(live.thinkingText.count, 5_000)
        XCTAssertFalse(live.thinkingTruncated, "the cap must be invisible to a normal turn")
    }

    func testActivityLabelNamesTheToolAndClearsOnItsResult() {
        var live = LiveAgentActivity()
        XCTAssertNil(live.activityLabel, "no tool running ⇒ the row shows its own shimmer")
        live.toolStarted(id: "a", name: "Read", detail: "src/agent/tools.ts")
        XCTAssertEqual(live.activityLabel, "Read · src/agent/tools.ts")
        live.toolFinished(id: "a")
        XCTAssertNil(live.activityLabel,
                     "leaving the name set is what made the row keep naming a returned tool")
        live.toolStarted(id: "b", name: "TodoWrite", detail: nil)
        XCTAssertEqual(live.activityLabel, "TodoWrite", "no detail ⇒ just the name")
        live.toolFinished(id: "b")
        live.toolStarted(id: "c", name: "TodoWrite", detail: "")
        XCTAssertEqual(live.activityLabel, "TodoWrite", "an empty detail is not a detail")
    }

    /// THE FINISHED CALL STAYS. Clearing the single live-tool slot on `tool-result`
    /// is what made the chip vanish the instant the tool returned, and reappear only
    /// when the turn ended and the transcript landed (2026-09-12 gate). The result
    /// frame marks the call done; only `reset()` (a turn boundary or a canonical
    /// history load) removes it.
    ///
    /// RED PROOF: making `toolFinished` remove the entry empties `tools` here.
    func testAFinishedCallStaysInTheTurnsToolList() {
        var live = LiveAgentActivity()
        live.toolStarted(id: "a", name: "Read", detail: "src/agent/tools.ts")
        live.toolStarted(id: "b", name: "Bash", detail: "npm test")
        live.toolFinished(id: "a")
        XCTAssertEqual(live.tools.map(\.name), ["Read", "Bash"],
                       "both calls stay on screen; the result changes state, not existence")
        XCTAssertEqual(live.tools.map(\.finished), [true, false])
        XCTAssertEqual(live.activityLabel, "Bash · npm test",
                       "the label follows the call still in flight, out of order or not")
        live.toolFinished(id: "b")
        XCTAssertEqual(live.tools.count, 2)
        XCTAssertNil(live.activityLabel)
        live.reset()
        XCTAssertTrue(live.tools.isEmpty, "a turn boundary is what retires the list")
    }

    /// A REPEATED `tool` frame for one id (a re-relay, a replay) updates that call
    /// rather than stacking a second chip for it.
    func testARepeatedToolFrameUpdatesTheSameCall() {
        var live = LiveAgentActivity()
        live.toolStarted(id: "a", name: "Bash", detail: "npm test")
        live.toolStarted(id: "a", name: "Bash", detail: "npm run test:quick")
        XCTAssertEqual(live.tools.count, 1)
        XCTAssertEqual(live.tools.first?.detail, "npm run test:quick")
    }

    /// An UNKNOWN id is a no-op: both relays only announce results for calls they
    /// announced, so an id we never saw belongs to somebody else (a subagent's, a
    /// replay), and "the newest must be it" would retire a chip still running.
    /// An EMPTY id is the one place guessing is right — an older server sends none.
    func testToolResultIdRoutingIsExactWithAnHonestFallback() {
        var live = LiveAgentActivity()
        live.toolStarted(id: "a", name: "Bash", detail: "npm test")
        live.toolFinished(id: "somebody-elses-call")
        XCTAssertEqual(live.tools.first?.finished, false,
                       "a foreign result must not retire this turn's running call")

        var old = LiveAgentActivity()
        old.toolStarted(name: "Bash", detail: "npm test")
        old.toolFinished()
        XCTAssertEqual(old.tools.first?.finished, true,
                       "with no ids at all, the newest unfinished call is the only candidate")
    }

    /// A long agentic turn can call dozens of tools; the live region is bounded.
    func testTheLiveToolListIsBounded() {
        var live = LiveAgentActivity()
        for index in 0..<(LiveAgentActivity.maxLiveTools + 10) {
            live.toolStarted(id: "t\(index)", name: "Bash", detail: "step \(index)")
        }
        XCTAssertEqual(live.tools.count, LiveAgentActivity.maxLiveTools)
        XCTAssertEqual(live.tools.last?.detail,
                       "step \(LiveAgentActivity.maxLiveTools + 9)",
                       "the NEWEST calls are the ones kept")
    }

    func testResetDropsEverythingAboutThePreviousTurn() {
        var live = LiveAgentActivity()
        live.appendThinking(String(repeating: "x", count: 200_000))
        live.flush()
        live.toolStarted(name: "Bash", detail: "npm test")
        live.reset()
        XCTAssertEqual(live.thinkingText, "")
        XCTAssertFalse(live.thinkingTruncated)
        XCTAssertNil(live.activityLabel)
        XCTAssertFalse(live.hasPendingThinking)
    }

    // MARK: - The shared event handler

    private func data(_ json: String) -> Data { Data(json.utf8) }

    func testHandlerOwnsExactlyTheThreeSharedEvents() {
        var live = LiveAgentActivity()
        XCTAssertNil(LiveStreamEvents.apply(event: "text-delta", data: data("{}"), to: &live))
        XCTAssertNil(LiveStreamEvents.apply(event: "turn-end", data: data("{}"), to: &live))
        XCTAssertNil(LiveStreamEvents.apply(event: "snapshot", data: data("{}"), to: &live))
        XCTAssertNotNil(LiveStreamEvents.apply(event: "thinking",
                                               data: data("{\"delta\":\"a\"}"), to: &live))
        XCTAssertNotNil(LiveStreamEvents.apply(event: "tool",
                                               data: data("{\"name\":\"Read\"}"), to: &live))
        XCTAssertNotNil(LiveStreamEvents.apply(event: "tool-result",
                                               data: data("{\"toolUseId\":\"t1\"}"), to: &live))
    }

    /// A replica that has not been redeployed sends `thinking` with no payload at
    /// all. That must still mean "a turn is running", never a dropped event.
    func testThinkingWithoutADeltaStillReportsARunningTurn() {
        var live = LiveAgentActivity()
        let handled = LiveStreamEvents.apply(event: "thinking", data: data("{}"), to: &live)
        XCTAssertEqual(handled?.impliesStreaming, true)
        XCTAssertEqual(handled?.needsFlush, false, "nothing to flush without a delta")
        XCTAssertFalse(live.hasPendingThinking)

        // Same for a payload that is not JSON at all.
        let garbage = LiveStreamEvents.apply(event: "thinking", data: data("not json"), to: &live)
        XCTAssertEqual(garbage?.impliesStreaming, true)
    }

    func testToolEventReportsItsNameForTheQuestionGate() {
        var live = LiveAgentActivity()
        let handled = LiveStreamEvents.apply(
            event: "tool", data: data("{\"name\":\"user_ask\",\"detail\":\"pick one\"}"), to: &live)
        XCTAssertEqual(handled?.toolName, "user_ask")
        XCTAssertEqual(live.activityLabel, "user_ask · pick one")
    }

    // MARK: - Both stores agree

    /// One SSE script, two stores. The point of extracting the arms is that the
    /// session surface and the chat surface can no longer drift — the user asked
    /// for the SAME richness in both.
    ///
    /// RED PROOF: restoring either store's own arm (`setActivity("Thinking")`
    /// for thinking, or a local ToolPayload decode) fails the equality below.
    @MainActor
    func testChatAndSessionStoresAgreeOnReasoningAndToolLabel() {
        let chat = ChatStore()
        chat.activeID = "conv-1"
        let session = SessionConversationStore(session: ScriptedSSE.session())

        let script: [SSEEvent] = [
            SSEEvent(id: nil, event: "thinking", data: "{\"delta\":\"The lock is held \"}"),
            SSEEvent(id: nil, event: "thinking", data: "{\"delta\":\"by the previous writer.\"}"),
            SSEEvent(id: nil, event: "tool", data: "{\"name\":\"Read\",\"detail\":\"src/core/x.ts\"}"),
        ]
        for event in script {
            chat.handleForTesting(event, conversationID: "conv-1")
            session.handle(event)
        }
        // Flush deterministically instead of waiting on the 120ms coalescer.
        flushBoth(chat: chat, session: session)

        XCTAssertEqual(chat.liveThinking, "The lock is held by the previous writer.")
        XCTAssertEqual(chat.liveThinking, session.liveThinking,
                       "the two surfaces must accumulate identically")
        XCTAssertEqual(chat.activity, "Read · src/core/x.ts")
        XCTAssertEqual(chat.activity, session.activity,
                       "the activity row must name the tool on BOTH surfaces")

        // A tool-result retires the label on both, and leaves the reasoning
        // alone — it is the turn's record, not the tool's.
        let done = SSEEvent(id: nil, event: "tool-result", data: "{\"toolUseId\":\"t1\"}")
        chat.handleForTesting(done, conversationID: "conv-1")
        session.handle(done)
        XCTAssertNil(chat.activity)
        XCTAssertNil(session.activity)
        XCTAssertEqual(chat.liveThinking, session.liveThinking)
        XCTAssertFalse(chat.liveThinking.isEmpty)
    }

    /// The one place the two stores legitimately differ, pinned so nobody
    /// "unifies" it by accident: a tool/thinking event is proof the SESSION's own
    /// turn is running, while the Personal AI chat has never taken it as proof of
    /// a turn of its own (only message-start and queued do) — adopting the
    /// session policy would freeze the chat composer on somebody else's turn.
    @MainActor
    func testOnlyTheSessionStoreTreatsAToolEventAsItsOwnTurn() {
        let chat = ChatStore()
        chat.activeID = "conv-1"
        let session = SessionConversationStore(session: ScriptedSSE.session())
        let event = SSEEvent(id: nil, event: "tool", data: "{\"name\":\"Bash\"}")
        chat.handleForTesting(event, conversationID: "conv-1")
        session.handle(event)
        XCTAssertFalse(chat.streaming, "a tool event must not freeze the chat composer")
        XCTAssertTrue(session.streaming, "a CLI tool call IS the session's turn running")
    }

    /// A turn boundary drops the previous turn's reasoning, or the next turn
    /// opens with the last one's text under it.
    @MainActor
    func testTurnStartClearsTheReasoningOnBothStores() {
        let chat = ChatStore()
        chat.activeID = "conv-1"
        let session = SessionConversationStore(session: ScriptedSSE.session())
        let thinking = SSEEvent(id: nil, event: "thinking", data: "{\"delta\":\"old turn\"}")
        chat.handleForTesting(thinking, conversationID: "conv-1")
        session.handle(thinking)
        flushBoth(chat: chat, session: session)
        XCTAssertEqual(chat.liveThinking, "old turn")
        XCTAssertEqual(session.liveThinking, "old turn")

        chat.handleForTesting(SSEEvent(id: nil, event: "message-start", data: "{}"),
                              conversationID: "conv-1")
        session.handle(SSEEvent(id: nil, event: "turn-start", data: "{}"))
        XCTAssertEqual(chat.liveThinking, "")
        XCTAssertEqual(session.liveThinking, "")
    }

    /// The handoff to history: the reasoning retires when canonical rows land,
    /// NOT at turn end — so a refetch that fails or arrives late leaves the
    /// reasoning on screen instead of blanking the spot it occupied.
    @MainActor
    func testReasoningSurvivesTurnEndAndRetiresWhenTheTranscriptLands() {
        let session = SessionConversationStore(session: ScriptedSSE.session())
        session.handle(SSEEvent(id: nil, event: "thinking",
                                data: "{\"delta\":\"about to answer\"}"))
        session.flushLiveThinking()
        XCTAssertEqual(session.liveThinking, "about to answer")

        session.handle(SSEEvent(id: nil, event: "turn-end", data: "{}"))
        XCTAssertEqual(session.liveThinking, "about to answer",
                       "turn end alone must not blank the reasoning")

        session.reconcile(SessionTranscript(
            sessionId: "s1", exportedAt: "2026-09-08T04:00:02Z", truncated: false,
            messages: [
                SessionTranscript.Message(role: "assistant", text: "about to answer",
                                          timestamp: "2026-09-08T04:00:00Z", kind: "thinking",
                                          thinkingText: "about to answer the question"),
                SessionTranscript.Message(role: "assistant", text: "Here it is.",
                                          timestamp: "2026-09-08T04:00:01Z", kind: nil),
            ]))
        XCTAssertEqual(session.liveThinking, "",
                       "canonical rows landed, so the live copy must go — never both")
        XCTAssertEqual(session.messages.first?.thinkingText, "about to answer the question",
                       "the excerpt must survive the transcript mapping")
    }

    /// A mid-turn poll lands a transcript while reasoning is still accumulating.
    /// Clearing there would wipe the live region on a 5s timer.
    @MainActor
    func testAMidTurnTranscriptLoadKeepsTheAccumulatingReasoning() {
        let session = SessionConversationStore(session: ScriptedSSE.session())
        session.handle(SSEEvent(id: nil, event: "thinking", data: "{\"delta\":\"still going\"}"))
        session.flushLiveThinking()
        XCTAssertTrue(session.streaming, "premise: the turn is still running")
        session.reconcile(SessionTranscript(
            sessionId: "s1", exportedAt: "2026-09-08T04:00:02Z", truncated: false,
            messages: [SessionTranscript.Message(role: "user", text: "go",
                                                 timestamp: "2026-09-08T03:59:00Z", kind: nil)]))
        XCTAssertEqual(session.liveThinking, "still going")
    }

    /// A tool row seen mid-run and then again with its output must be a DIFFERENT
    /// stable id, or the layout actor's per-message row memo keeps serving the
    /// "Running…" card for ever.
    @MainActor
    func testToolRowIdentityTracksItsPayload() {
        let session = SessionConversationStore(session: ScriptedSSE.session())
        func load(result: String?) -> String? {
            session.reconcile(SessionTranscript(
                sessionId: "s1", exportedAt: "2026-09-08T04:00:02Z", truncated: false,
                messages: [SessionTranscript.Message(
                    role: "assistant", text: "Bash", timestamp: "2026-09-08T04:00:00Z",
                    kind: "tool", detail: "npm test", resultPreview: result,
                    inputPreview: "npm test --silent")]))
            return session.messages.first?.id
        }
        let running = load(result: nil)
        let finished = load(result: "42 passing")
        XCTAssertNotNil(running)
        XCTAssertNotEqual(running, finished,
                          "the row id must move when the payload does, or the memo goes stale")
    }

    // MARK: - Helpers

    /// Deterministic flush of both stores' coalesced live buffers — the same
    /// seam both stores expose for exactly this, so no test waits on the 120ms
    /// coalescer (a sleep in a test is a flake with a timer attached).
    @MainActor
    private func flushBoth(chat: ChatStore, session: SessionConversationStore) {
        chat.flushLiveThinking()
        session.flushLiveThinking()
    }
}
