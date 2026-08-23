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

/// Empty-state copy under an active search (2026-08-23 dogfood R11 FRICTION):
/// the filter's own wording read as "search failed" while the actual matches
/// were below in the Server Search section.
final class TasksEmptyPlaceholderTests: XCTestCase {
    func testFilterWordingWithoutQuery() {
        XCTAssertEqual(TasksView.emptyPlaceholder(filter: .sessions, query: ""), "No agent sessions.")
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
