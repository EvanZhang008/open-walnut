import XCTest
@testable import Walnut

/// Regression tests for the 2026-08-23 dogfood round-10 P0: a chat turn
/// relayed through the cloud replica finished (message-end arrived, the
/// freeze-trail crumb proved finalizeTurn ran), yet the timeline lost BOTH the
/// user's message and the fresh reply. Mechanism: finalizeTurn's reconcile
/// loadMessages fetched the REPLICA's history copy, which lags git-sync by
/// ~30-60s after a relayed turn — and the old local-row filter only preserved
/// `pending`/`failed` bubbles, so the solidified `local-…` user echo and the
/// `turn-…` provisional reply were both replaced by the stale fetch.
///
/// The fix is ChatStore.carryLocalRows (echo preservation across stale
/// fetches) plus ChatStore.turnSettled (the watchdog must never settle a
/// watched turn from history that does not contain the watched user message).
final class ChatEchoPreservationTests: XCTestCase {

    /// Aligned with the fixtures' createdAt so the TTL backstop stays out of
    /// the way except in the test that exercises it.
    private let fixtureNow = ISO8601DateFormatter().date(from: "2026-08-23T09:38:00Z")!

    private func msg(
        _ id: String, _ role: String, _ text: String,
        kind: ChatMessage.Kind? = nil,
        createdAt: String = "2026-08-23T09:37:00Z",
        pending: Bool? = nil, failed: Bool? = nil
    ) -> ChatMessage {
        var m = ChatMessage(id: id, role: role, text: text, createdAt: createdAt, kind: kind)
        m.pending = pending
        m.failed = failed
        return m
    }

    /// The same row as the server sends it while its turn is still in flight.
    private func inFlight(_ m: ChatMessage) -> ChatMessage {
        ChatMessage(id: m.id, role: m.role, text: m.text, createdAt: m.createdAt,
                    kind: m.kind, source: m.source, detail: m.detail,
                    resultPreview: m.resultPreview, agent: m.agent,
                    thinkingText: m.thinkingText, inputPreview: m.inputPreview,
                    detailRef: m.detailRef, inFlight: true)
    }

    /// Canonical rows for turns 1-2, as an earlier fetch delivered them.
    private var canonicalTail: [ChatMessage] {
        [
            msg("m0", "user", "How should I frame the AMD thesis?"),
            msg("m1", "assistant", "Frame it around data-center share."),
            msg("m2", "user", "Tighten the risk section."),
            msg("m3", "assistant", "Here is the tightened risk section."),
        ]
    }

    // MARK: - The round-10 repro: stale fetch right after a relayed turn

    func testStaleFetchKeepsSolidifiedUserEchoAndProvisionalReply() {
        // After turn 3's message-end: 4 canonical rows + solidified user echo
        // (pending=false after the 202) + finalizeTurn's provisional reply.
        let current = canonicalTail + [
            msg("local-99", "user", "What price level would flip you bearish?"),
            msg("turn-100", "assistant", "Below $95 the thesis breaks."),
        ]
        // The replica's copy has not converged: it still serves only turns 1-2.
        let out = ChatStore.carryLocalRows(current: current, fetched: canonicalTail, now: fixtureNow)
        XCTAssertEqual(out.map(\.id), ["local-99", "turn-100"],
            "a stale fetch must keep the just-sent user echo AND the fresh reply")
    }

    func testEmptyFetchKeepsBothEchoes() {
        // Turn 1 in a conversation the replica created moments ago: its own
        // history file is still empty until git-sync delivers the primary's.
        let current = [
            msg("local-1", "user", "Start a Stock Analyzer thesis for AMD."),
            msg("turn-2", "assistant", "Here is the initial thesis."),
        ]
        let out = ChatStore.carryLocalRows(current: current, fetched: [], now: fixtureNow)
        XCTAssertEqual(out.map(\.id), ["local-1", "turn-2"])
    }

    // MARK: - Convergence: echoes retire once the canonical rows land

    func testConvergedFetchAbsorbsBothEchoes() {
        let current = canonicalTail + [
            msg("local-99", "user", "What price level would flip you bearish?"),
            msg("turn-100", "assistant", "Below $95 the thesis breaks."),
        ]
        // git-sync converged: the fetch now carries turn 3 canonically. The
        // canonical reply's text differs slightly (server normalization) —
        // retirement must not depend on a byte-identical match.
        let converged = canonicalTail + [
            msg("m4", "user", "What price level would flip you bearish?"),
            msg("m5", "assistant", "Below $95 the thesis breaks. ", createdAt: "2026-08-23T09:37:54Z"),
        ]
        let out = ChatStore.carryLocalRows(current: current, fetched: converged, now: fixtureNow)
        XCTAssertTrue(out.isEmpty, "converged canonical rows must absorb both echoes: \(out.map(\.id))")
    }

    func testOlderIdenticalMessageCannotAbsorbTheNewEcho() {
        // The user has said "continue" before (canonically); a NEW "continue"
        // echo must survive a fetch that only carries the OLD one.
        let history = [
            msg("m0", "user", "continue"),
            msg("m1", "assistant", "Continuing."),
        ]
        let current = history + [msg("local-9", "user", "continue")]
        let out = ChatStore.carryLocalRows(current: current, fetched: history, now: fixtureNow)
        XCTAssertEqual(out.map(\.id), ["local-9"],
            "an identical older canonical row must not vanish the new echo")

        // Once the fetch carries BOTH "continue" rows, the echo retires.
        let converged = history + [msg("m2", "user", "continue")]
        XCTAssertTrue(ChatStore.carryLocalRows(current: current, fetched: converged, now: fixtureNow).isEmpty)
    }

    func testPendingAndFailedBubblesAlwaysSurvive() {
        let current = [
            msg("local-1", "user", "unsent draft", pending: true),
            msg("local-2", "user", "failed send", failed: true),
        ]
        let out = ChatStore.carryLocalRows(current: current, fetched: canonicalTail, now: fixtureNow)
        XCTAssertEqual(out.map(\.id), ["local-1", "local-2"])
    }

    func testEchoTTLBackstopDropsAncientEchoes() {
        // Compaction can rewrite history so an echo's canonical row never
        // appears — the TTL keeps it from duplicating forever. Pending/failed
        // rows are exempt (only copy of the text).
        let old = "2026-08-23T08:00:00Z" // > localEchoTTL before `now`
        let now = ISO8601DateFormatter().date(from: "2026-08-23T09:37:00Z")!
        let current = [
            msg("local-1", "user", "hours old", createdAt: old),
            msg("turn-2", "assistant", "hours old reply", createdAt: old),
            msg("local-3", "user", "old but failed", createdAt: old, failed: true),
        ]
        let out = ChatStore.carryLocalRows(current: current, fetched: [], now: now)
        XCTAssertEqual(out.map(\.id), ["local-3"])
    }

    func testUnchangedLastReplyDoesNotRetireTheProvisionalOne() {
        // The stale fetch's last assistant row is the PREVIOUS turn's reply —
        // identical to what we already held canonically. That must not count
        // as "the reply stream advanced".
        let current = canonicalTail + [
            msg("local-9", "user", "next question"),
            msg("turn-10", "assistant", "fresh reply"),
        ]
        let out = ChatStore.carryLocalRows(current: current, fetched: canonicalTail, now: fixtureNow)
        XCTAssertTrue(out.contains { $0.id == "turn-10" },
            "the previous turn's trailing reply must not retire the fresh provisional one")
    }

    // MARK: - Watchdog verdict (turnSettled)

    func testWatchedMessageMissingFromStaleHistoryNeverSettles() {
        // The naive last-is-assistant check would fire on the PREVIOUS turn's
        // trailing reply and clear `streaming` mid-turn.
        XCTAssertFalse(
            ChatStore.turnSettled(history: canonicalTail, watched: "What price level would flip you bearish?"),
            "stale history lacking the watched user message must never settle the turn"
        )
    }

    func testWatchedTurnSettlesOnlyWithReplyAfterTheWatchedMessage() {
        let watched = "What price level would flip you bearish?"
        let beforeReply = canonicalTail + [msg("m4", "user", watched)]
        XCTAssertFalse(ChatStore.turnSettled(history: beforeReply, watched: watched))

        let toolOnly = beforeReply + [msg("m5", "assistant", "Read", kind: .tool)]
        XCTAssertFalse(ChatStore.turnSettled(history: toolOnly, watched: watched),
            "a tool row is not a reply")

        let done = toolOnly + [msg("m6", "assistant", "Below $95 the thesis breaks.")]
        XCTAssertTrue(ChatStore.turnSettled(history: done, watched: watched))
    }

    /// THE 2026-09-17 P1: the old premise is dead. A lane transcript now carries
    /// the model's INTERMEDIATE text mid-turn, so an assistant text row after the
    /// watched user message is no longer proof the turn ended. The server says so
    /// with `inFlight`, and that answer outranks the heuristic.
    ///
    /// RED PROOF: dropping the `inFlight` check from `turnSettled` settles this
    /// turn, which is exactly what unlocked the composer 31 to 44s into a tool
    /// call three times in one probe.
    func testInFlightRowsNeverSettleTheTurnEvenWithAnAssistantTextRow() {
        let watched = "Run both echo commands"
        let midTurn = canonicalTail + [
            msg("m4", "user", watched),
            inFlight(msg("m5", "assistant", "Bash", kind: .tool)),
            // The row that broke the old rule: real assistant prose, mid-turn.
            inFlight(msg("m6", "assistant", "I will run the first echo, then the second command.")),
            inFlight(msg("m7", "assistant", "Bash", kind: .tool)),
        ]
        XCTAssertFalse(ChatStore.turnSettled(history: midTurn, watched: watched),
            "a row still marked in flight is proof the turn is NOT over")
        // Same list once the server stops flagging it: the turn really is over.
        let ended = midTurn.map { row in
            ChatMessage(id: row.id, role: row.role, text: row.text,
                        createdAt: row.createdAt, kind: row.kind)
        }
        XCTAssertTrue(ChatStore.turnSettled(history: ended, watched: watched))
    }

    /// An older server sends the field NOWHERE, so the heuristic stays in charge
    /// there. Absence must never be read as "in flight" (nothing would ever
    /// settle, and the composer would stay frozen after a lost message-end).
    func testWithoutTheFieldTheOldHeuristicStillDecides() {
        let watched = "What price level would flip you bearish?"
        let beforeReply = canonicalTail + [msg("m4", "user", watched)]
        XCTAssertFalse(ChatStore.turnSettled(history: beforeReply, watched: watched))
        let done = beforeReply + [msg("m5", "assistant", "Below $95 the thesis breaks.")]
        XCTAssertTrue(ChatStore.turnSettled(history: done, watched: watched),
            "no row carries the field, so the pre-2026-09-17 rule must still settle")
        XCTAssertTrue(done.allSatisfy { $0.inFlight == nil })
    }

    /// Decoding: the field is additive, so a row with it and a row without it must
    /// both decode, and absence is nil rather than false.
    func testInFlightDecodesWithAndWithoutTheKey() throws {
        let json = """
        [{"id":"m0","role":"user","text":"hi","createdAt":"2026-09-17T09:00:00Z"},
         {"id":"m1","role":"assistant","text":"Bash","createdAt":"2026-09-17T09:00:01Z",
          "kind":"tool","detail":"sleep 45","inFlight":true},
         {"id":"m2","role":"assistant","text":"done","createdAt":"2026-09-17T09:00:02Z",
          "inFlight":false}]
        """
        let rows = try JSONDecoder().decode([ChatMessage].self, from: Data(json.utf8))
        XCTAssertNil(rows[0].inFlight, "an absent key decodes to nil, not false")
        XCTAssertEqual(rows[1].inFlight, true)
        XCTAssertEqual(rows[2].inFlight, false)
        XCTAssertFalse(ChatStore.turnSettled(history: rows, watched: "hi"))
        // `false` is not `true`: an explicitly settled row must not block a settle.
        let settledOnly = [rows[0], rows[2]]
        XCTAssertTrue(ChatStore.turnSettled(history: settledOnly, watched: "hi"))
    }

    func testNoWatchedTextFallsBackToTrailingReply() {
        // 409 turn_active path (someone else's turn): trailing plain assistant
        // reply means it ended.
        XCTAssertTrue(ChatStore.turnSettled(history: canonicalTail, watched: nil))
        XCTAssertFalse(ChatStore.turnSettled(
            history: canonicalTail + [msg("m4", "user", "another question")], watched: nil
        ))
        XCTAssertFalse(ChatStore.turnSettled(history: [], watched: nil))
    }
}

/// A MID-TURN REFETCH MUST NOT INSTALL THE RUNNING TURN'S ROWS (2026-09-17 gate,
/// probe gsrnmo). The live region owns the current turn: its tool rows know a
/// call is still running and carry the previews the stream relays. The same
/// call's MESSAGE row is a transcript row, where an absent `resultPreview`
/// legitimately means "printed nothing", so a refetch that landed 45.9s into a
/// `sleep 45` replaced a correct live row with one whose drawer read "No output"
/// while the command still had 10s to run.
///
/// Offline by construction: message reads go through `MockChatMessagesTransport`
/// and nothing here sends.
@MainActor
final class ChatInFlightTurnRowsTests: XCTestCase {

    private let conversation = "conv-inflight"
    private let watched = "Run both echo commands"

    override func setUp() async throws { DiskCache.remove(key: "messages-\(conversation)") }
    override func tearDown() async throws { DiskCache.remove(key: "messages-\(conversation)") }

    private func msg(_ id: String, _ role: String, _ text: String,
                     kind: ChatMessage.Kind? = nil, detail: String? = nil,
                     resultPreview: String? = nil, inFlight: Bool? = nil) -> ChatMessage {
        ChatMessage(id: id, role: role, text: text,
                    createdAt: "2026-09-17T09:00:00Z", kind: kind,
                    detail: detail, resultPreview: resultPreview, inFlight: inFlight)
    }

    /// Settled history plus the watched user row: everything a mid-turn fetch is
    /// allowed to install.
    private var settledPrefix: [ChatMessage] {
        [
            msg("m0", "user", "How do I check the two markers?"),
            msg("m1", "assistant", "Run them one after the other."),
            msg("m2", "user", watched),
        ]
    }

    /// The rows of the turn in flight, as the server flags them.
    private var inFlightTail: [ChatMessage] {
        [
            msg("m3", "assistant", "Bash", kind: .tool, detail: "echo first",
                resultPreview: "first", inFlight: true),
            msg("m4", "assistant", "I will run the first echo, then the second command.",
                inFlight: true),
            // The call still running: no output has been produced yet, which a
            // transcript row would render as "No output".
            msg("m5", "assistant", "Bash", kind: .tool, detail: "sleep 45", inFlight: true),
        ]
    }

    private func makeStore(_ rows: [ChatMessage]) -> (ChatStore, MockChatMessagesTransport) {
        let mock = MockChatMessagesTransport()
        mock.rows[conversation] = rows
        let store = ChatStore(transport: mock)
        store.activeID = conversation
        return (store, mock)
    }

    /// (c) The flagged rows are dropped and the earlier history is kept whole.
    ///
    /// RED PROOF: installing `fetched` unconditionally puts m3/m4/m5 in the
    /// timeline, which is the shipped bug.
    func testAMidTurnFetchDropsTheInFlightRowsAndKeepsTheHistory() async {
        let (store, _) = makeStore(settledPrefix + inFlightTail)
        store.streaming = true
        store.setWatchedUserTextForTesting(watched)

        await store.loadMessages(conversation)

        XCTAssertEqual(store.messages.map(\.id), ["m0", "m1", "m2"],
            "the running turn's rows belong to the live region, not the timeline")
        XCTAssertFalse(store.messages.contains { $0.inFlight == true })
        XCTAssertTrue(store.streaming, "and the fetch must not settle the turn")
    }

    /// (d) Older server: no row carries the field, so the watched user row is the
    /// boundary. Without this fallback the very refetch that broke the probe would
    /// still install a running tool row on any box that has not been redeployed.
    ///
    /// Tool rows only, on purpose: that is the shape of a turn whose model has not
    /// emitted prose yet, which is where the heuristic correctly says "not over"
    /// and the boundary is the only thing keeping the running call out.
    func testTheOlderServerFallbackDropsRowsAfterTheWatchedUserRow() async {
        let unflagged = [
            msg("m3", "assistant", "Bash", kind: .tool, detail: "echo first",
                resultPreview: "first"),
            msg("m4", "assistant", "Bash", kind: .tool, detail: "sleep 45"),
        ]
        let (store, _) = makeStore(settledPrefix + unflagged)
        store.streaming = true
        store.setWatchedUserTextForTesting(watched)

        await store.loadMessages(conversation)

        XCTAssertEqual(store.messages.map(\.id), ["m0", "m1", "m2"],
            "with no flag to read, the watched user row is the only boundary there is")
        XCTAssertTrue(store.streaming)
    }

    /// The LIMIT of an older server, pinned rather than papered over: once the
    /// turn's intermediate prose lands, a box that sends no `inFlight` is
    /// indistinguishable from a finished turn. The heuristic settles, so the
    /// watchdog is about to unfreeze the composer, and the full list is installed.
    ///
    /// Withholding rows from a turn the client has just declared over would be
    /// worse than the stale row: the reply itself would be missing from the
    /// timeline. `inFlight` is what removes the ambiguity; the client cannot.
    func testAnOlderServerStillSettlesOnIntermediateProseAndInstallsEverything() async {
        let unflagged = inFlightTail.map {
            ChatMessage(id: $0.id, role: $0.role, text: $0.text, createdAt: $0.createdAt,
                        kind: $0.kind, detail: $0.detail, resultPreview: $0.resultPreview)
        }
        let (store, _) = makeStore(settledPrefix + unflagged)
        store.streaming = true
        store.setWatchedUserTextForTesting(watched)

        await store.loadMessages(conversation)

        XCTAssertTrue(ChatStore.turnSettled(history: settledPrefix + unflagged, watched: watched),
            "an unflagged prose row after the watched message reads as a finished turn")
        XCTAssertEqual(store.messages.map(\.id), ["m0", "m1", "m2", "m3", "m4", "m5"],
            "a turn declared over must be installed whole, reply included")

        // The SAME rows with the server's flag are withheld, which is the fix.
        let (flagged, _) = makeStore(settledPrefix + inFlightTail)
        flagged.streaming = true
        flagged.setWatchedUserTextForTesting(watched)
        await flagged.loadMessages(conversation)
        XCTAssertEqual(flagged.messages.map(\.id), ["m0", "m1", "m2"])
    }

    /// …and with NO watched text (the 409 turn_active path, someone else's turn)
    /// nothing is dropped: guessing a boundary would make a finished turn's rows
    /// disappear from the timeline.
    func testNothingIsDroppedWhenThereIsNoBoundaryToTrust() async {
        let unflagged = inFlightTail.map {
            ChatMessage(id: $0.id, role: $0.role, text: $0.text, createdAt: $0.createdAt,
                        kind: $0.kind, detail: $0.detail, resultPreview: $0.resultPreview)
        }
        let (store, _) = makeStore(settledPrefix + unflagged)
        store.streaming = true
        store.setWatchedUserTextForTesting(nil)

        await store.loadMessages(conversation)

        XCTAssertEqual(store.messages.map(\.id), ["m0", "m1", "m2", "m3", "m4", "m5"])
    }

    /// (e) After message-end the turn is over: `streaming` is already false on the
    /// finalizeTurn path, so the FULL list is installed exactly as before.
    func testAfterMessageEndTheWholeListIsInstalled() async {
        let ended = (settledPrefix + inFlightTail).map {
            ChatMessage(id: $0.id, role: $0.role, text: $0.text, createdAt: $0.createdAt,
                        kind: $0.kind, detail: $0.detail,
                        resultPreview: $0.id == "m5" ? "done" : $0.resultPreview)
        }
        let (store, _) = makeStore(ended)
        store.streaming = false

        await store.loadMessages(conversation)

        XCTAssertEqual(store.messages.map(\.id), ["m0", "m1", "m2", "m3", "m4", "m5"],
            "the transcript is the whole turn once the turn is over")
        XCTAssertEqual(store.messages.last?.resultPreview, "done")
    }

    /// A fetch that PROVES the turn is over installs everything even while
    /// `streaming` is still true (the lost-message-end case), or the watchdog
    /// would unfreeze the composer onto a truncated timeline.
    func testAFetchThatProvesTheTurnEndedInstallsEverything() async {
        // No row is flagged and a plain assistant reply follows the watched row:
        // `turnSettled` is true, so nothing may be withheld.
        let settled = settledPrefix + [
            msg("m3", "assistant", "Bash", kind: .tool, detail: "echo first",
                resultPreview: "first"),
            msg("m4", "assistant", "Both markers printed."),
        ]
        let (store, _) = makeStore(settled)
        store.streaming = true
        store.setWatchedUserTextForTesting(watched)

        await store.loadMessages(conversation)

        XCTAssertEqual(store.messages.map(\.id), ["m0", "m1", "m2", "m3", "m4"])
    }

    /// The pure rule behind all of the above, pinned on its own so the boundary
    /// cases are readable: the cut is at the FIRST flagged row, so a row the
    /// server forgot to flag cannot slip in behind one it did.
    func testSettledRowsCutsAtTheFirstFlaggedRow() {
        let rows = settledPrefix + [
            msg("m3", "assistant", "Bash", kind: .tool, inFlight: true),
            msg("m4", "assistant", "unflagged but inside the same turn"),
        ]
        XCTAssertEqual(ChatStore.settledRows(rows, watched: watched).map(\.id),
                       ["m0", "m1", "m2"])
        // Nothing flagged and nothing to match: the list passes through whole.
        XCTAssertEqual(ChatStore.settledRows(settledPrefix, watched: "not in this list").map(\.id),
                       ["m0", "m1", "m2"])
        XCTAssertEqual(ChatStore.settledRows([], watched: watched).count, 0)
    }
}

/// Empty-state copy under an active search (2026-08-23 dogfood R11 FRICTION):
/// the filter's own wording read as "search failed" while the actual matches
/// were below in the Server Search section.
final class TasksEmptyPlaceholderTests: XCTestCase {
    func testFilterWordingWithoutQuery() {
        // The board's empty state says how to fill it (pin something), not just
        // that it is empty — an empty board with no next step read as broken.
        XCTAssertEqual(
            TasksView.emptyPlaceholder(filter: .sessions, query: ""),
            "Nothing pinned yet — pin a task to put it on the board."
        )
        XCTAssertEqual(TasksView.emptyPlaceholder(filter: .allOpen, query: ""), "No open tasks.")
    }

    func testActiveQueryPointsAtServerSearch() {
        for filter in [TaskFilter.sessions, .allOpen, .today, .inProgress, .done] {
            XCTAssertEqual(
                TasksView.emptyPlaceholder(filter: filter, query: "AMD"),
                "No local matches — see Server Search below.",
                "filter \(filter) must not show its own empty copy while searching"
            )
        }
    }
}
