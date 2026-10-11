import XCTest
@testable import Walnut

final class SessionConversationStoreTests: XCTestCase {

    /// clipProvisional mirrors the server's LIVE transcript budget (the turn-end
    /// rich read: 16K prose, 48K markup): the provisional row must be
    /// byte-identical to the canonical row the refetch swaps in, or the stable id
    /// changes and the bubble flashes.
    @MainActor
    func testClipProvisionalTruncatesPastTheLiveBudget() {
        let long = String(repeating: "a", count: 20_000)
        let clipped = SessionConversationStore.clipProvisional(long)
        XCTAssertEqual(clipped.count, 16_001, "16K chars + ellipsis")
        XCTAssertTrue(clipped.hasSuffix("\u{2026}"))
        XCTAssertEqual(String(clipped.prefix(16_000)), String(long.prefix(16_000)))
    }

    @MainActor
    func testClipProvisionalKeepsShortTextIntact() {
        XCTAssertEqual(SessionConversationStore.clipProvisional(""), "")
        let exact = String(repeating: "b", count: 16_000)
        XCTAssertEqual(SessionConversationStore.clipProvisional(exact), exact)
        let cjk = "\u{591a}\u{5b57}\u{8282}\u{5b57}\u{7b26}\u{3002}"
        XCTAssertEqual(SessionConversationStore.clipProvisional(cjk), cjk)
    }

    /// The 2026-10-10 report: a long reply streamed in whole, then turned into
    /// its first 4,000 characters plus "\u{2026}" at turn end. A 5,005-character
    /// CJK reply (the real one's length) must stay whole.
    @MainActor
    func testClipProvisionalKeepsAFiveThousandCharacterReplyWhole() {
        let reply = String(repeating: "\u{957f}\u{56de}\u{7b54}\u{3002}", count: 1_251) + "E"
        XCTAssertEqual(reply.count, 5_005)
        XCTAssertEqual(SessionConversationStore.clipProvisional(reply), reply)
    }

    /// Markup gets the live render window, as on the server, chosen by the
    /// server's own rule: a closing tag inside a code fence still counts.
    @MainActor
    func testClipProvisionalGivesMarkupTheLiveWindow() {
        let card = "<div class=\"c\">" + String(repeating: "word ", count: 6_000) + "</div>"
        XCTAssertGreaterThan(card.utf16.count, 16_000)
        XCTAssertEqual(SessionConversationStore.clipProvisional(card), card)
        let fenced = "```html\n</code>\n```\n" + String(repeating: "p", count: 20_000)
        XCTAssertTrue(SessionConversationStore.looksLikeMarkup(fenced))
        XCTAssertEqual(SessionConversationStore.clipProvisional(fenced), fenced)
        XCTAssertFalse(SessionConversationStore.looksLikeMarkup("if a < b and Vec<u8> then"))
    }

    /// The cut is counted in UTF-16 units and lands on a code point, like the
    /// server's: emoji (two units each) neither shift it nor leave a half behind.
    @MainActor
    func testClipProvisionalCutsWhereTheServerCuts() {
        let emoji = String(repeating: "\u{1F600}", count: 8_500) // 17,000 units
        let clipped = SessionConversationStore.clipProvisional(emoji)
        XCTAssertEqual(clipped.utf16.count, 16_001)
        XCTAssertEqual(clipped.unicodeScalars.count, 8_001)
        // One unit off: the cut would split a pair, so it backs off by one.
        let odd = "a" + emoji
        let oddClipped = SessionConversationStore.clipProvisional(odd)
        XCTAssertEqual(oddClipped.utf16.count, 16_000)
        XCTAssertTrue(oddClipped.hasSuffix("\u{1F600}\u{2026}"))
        // Under the budget in units: whole, never a stray ellipsis.
        let fits = String(repeating: "\u{1F600}", count: 7_999)
        XCTAssertEqual(SessionConversationStore.clipProvisional(fits), fits)
    }

    /// Turn end keeps the whole streamed reply on screen: no "\u{2026}" appears
    /// where the reader was just reading.
    @MainActor
    func testFinalizeTurnKeepsALongReplyWhole() {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        store.streaming = true
        let reply = String(repeating: "\u{957f}\u{56de}\u{7b54}\u{3002}", count: 1_500)
        store.liveText = reply
        store.handle(SSEEvent(id: nil, event: "turn-end", data: "{}"))
        let rows = store.messages.filter { $0.role == "assistant" }
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.text, reply)
    }

    // MARK: - A clipped copy never replaces the whole text

    private typealias Message = SessionTranscript.Message

    private func transcript(_ messages: [Message]) -> SessionTranscript {
        SessionTranscript(sessionId: "clip", exportedAt: "x", truncated: false,
                          messages: messages, pageable: true)
    }

    /// Server shape of a slim (4K) read of `text`.
    private func slimClip(_ text: String) -> String { String(text.prefix(4_000)) + "\u{2026}" }

    /// The degraded 5s poll is a slim read (4K). After a rich read delivered a
    /// reply whole, the poll used to cut it back to its head plus "\u{2026}" on
    /// every tick.
    @MainActor
    func testSlimPollKeepsAReplyTheRichReadDeliveredWhole() {
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "clip-poll"),
                                             transport: MockSessionSendTransport())
        let reply = String(repeating: "\u{957f}\u{56de}\u{7b54}\u{3002}", count: 1_300)
        let ask = Message(role: "user", text: "explain", timestamp: "2026-10-10T00:00:01.000Z", kind: nil)
        let rich = Message(role: "assistant", text: reply, timestamp: "2026-10-10T00:00:02.000Z", kind: nil)
        store.reconcile(transcript([ask, rich]))
        XCTAssertEqual(store.messages.last?.text, reply)

        let slim = Message(role: "assistant", text: slimClip(reply), timestamp: rich.timestamp, kind: nil)
        store.reconcile(transcript([ask, slim]))
        XCTAssertEqual(store.messages.last?.text, reply, "a slim poll cut the whole reply back")
        let firstID = store.messages.last?.id
        store.reconcile(transcript([ask, slim]))
        XCTAssertEqual(store.messages.last?.id, firstID, "the row keeps one identity across polls")

        // A NEWER whole text (the reply grew, or the server now sends more) wins.
        let grown = reply + "\u{8865}\u{5145}"
        store.reconcile(transcript([ask, Message(role: "assistant", text: grown, timestamp: rich.timestamp, kind: nil)]))
        XCTAssertEqual(store.messages.last?.text, grown)
        store.close()
    }

    /// Only the SAME row lends its text: same role and time, a text row, and the
    /// clipped text must start the held one.
    @MainActor
    func testKeepingWholeTextMatchesOnlyTheSameRow() {
        let whole = String(repeating: "x", count: 6_000)
        let ts = "2026-10-10T00:00:02.000Z"
        let held = [ChatMessage(id: "a", role: "assistant", text: whole, createdAt: ts, kind: nil)]
        func kept(_ m: Message) -> String {
            SessionConversationStore.keepingWholeText([m], held: held)[0].text
        }
        let clip = slimClip(whole)
        XCTAssertEqual(kept(Message(role: "assistant", text: clip, timestamp: ts, kind: nil)), whole)
        // Another time, another role, a tool row, or text that does not start it: untouched.
        XCTAssertEqual(kept(Message(role: "assistant", text: clip, timestamp: "2026-10-10T00:00:03.000Z", kind: nil)), clip)
        XCTAssertEqual(kept(Message(role: "user", text: clip, timestamp: ts, kind: nil)), clip)
        XCTAssertEqual(kept(Message(role: "assistant", text: clip, timestamp: ts, kind: "tool")), clip)
        let other = String(repeating: "y", count: 4_000) + "\u{2026}"
        XCTAssertEqual(kept(Message(role: "assistant", text: other, timestamp: ts, kind: nil)), other)
        // An unclipped incoming row is the server's word, even when shorter.
        XCTAssertEqual(kept(Message(role: "assistant", text: "edited", timestamp: ts, kind: nil)), "edited")
    }

    /// A reply that really ends in "\u{2026}" is not a clipped row: a held sibling
    /// at the same time, which it happens to start, never replaces it (nothing
    /// that short was ever clipped by the server).
    @MainActor
    func testKeepingWholeTextLeavesARealEllipsisAlone() {
        let ts = "2026-10-10T00:00:02.000Z"
        let held = [ChatMessage(id: "a", role: "assistant", text: "Let me check the logs first, then the config.",
                                createdAt: ts, kind: nil)]
        let real = "Let me check\u{2026}"
        let out = SessionConversationStore.keepingWholeText(
            [Message(role: "assistant", text: real, timestamp: ts, kind: nil)], held: held)
        XCTAssertEqual(out[0].text, real)
    }

    /// The server cuts on a code point, which can split a grapheme cluster (here
    /// "e" + COMBINING ACUTE). The match compares scalars, so it still holds.
    @MainActor
    func testKeepingWholeTextMatchesACutInsideAGraphemeCluster() {
        let ts = "2026-10-10T00:00:02.000Z"
        let whole = String(repeating: "x", count: 3_999) + "e\u{301}" + String(repeating: "z", count: 2_000)
        let clip = String(repeating: "x", count: 3_999) + "e\u{2026}" // 4,000 units + the mark
        XCTAssertFalse(whole.hasPrefix(String(clip.dropLast())), "Character prefix misses it")
        let held = [ChatMessage(id: "a", role: "assistant", text: whole, createdAt: ts, kind: nil)]
        let out = SessionConversationStore.keepingWholeText(
            [Message(role: "assistant", text: clip, timestamp: ts, kind: nil)], held: held)
        XCTAssertEqual(out[0].text, whole)
    }

    /// A provisional reply holds the whole turn's streamed text, which can span
    /// several server rows, so it never lends text to a clipped one.
    @MainActor
    func testKeepingWholeTextNeverBorrowsFromAProvisionalRow() {
        let ts = "2026-10-10T00:00:02.000Z"
        let streamed = String(repeating: "x", count: 4_500) + String(repeating: "z", count: 3_000)
        let held = [ChatMessage(id: "provisional-1", role: "assistant", text: streamed, createdAt: ts, kind: nil)]
        let clip = slimClip(streamed)
        let out = SessionConversationStore.keepingWholeText(
            [Message(role: "assistant", text: clip, timestamp: ts, kind: nil)], held: held)
        XCTAssertEqual(out[0].text, clip)
    }

    // MARK: - liveText retention cap (build-34 watchdog fix) behavior guards

    /// Short replies (<96K) must be BYTE-IDENTICAL through the whole live
    /// path: no trim, no truncated flag — the cap must be invisible to every
    /// normal-size session.
    @MainActor
    func testShortLiveTextIsNeverTrimmed() {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        store.streaming = true
        var expected = ""
        for _ in 0..<20 {
            let event = ScriptedSSE.deltaEvent(bytes: 2_000)
            // Mirror what the store appends (decode the scripted payload).
            struct P: Decodable { let delta: String }
            expected += (try! JSONDecoder().decode(P.self, from: Data(event.data.utf8))).delta
            store.handle(event)
            store.flushPendingDelta()
        }
        XCTAssertEqual(store.liveText, expected, "short liveText must be byte-identical (no trim)")
        XCTAssertFalse(store.liveTextTruncated)
    }

    /// Past the cap the store keeps only a bounded tail, flags truncation,
    /// and the retained text is a true SUFFIX of the full accumulation.
    @MainActor
    func testGiantLiveTextIsTrimmedToBoundedSuffix() {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        store.streaming = true
        store.liveText = ScriptedSSE.liveText(megabytes: 2)
        let full = store.liveText
        let event = ScriptedSSE.deltaEvent(bytes: 2_000)
        struct P: Decodable { let delta: String }
        let delta = (try! JSONDecoder().decode(P.self, from: Data(event.data.utf8))).delta
        store.handle(event)
        store.flushPendingDelta()
        XCTAssertTrue(store.liveTextTruncated, "multi-MB liveText must be trimmed on flush")
        XCTAssertLessThanOrEqual(
            store.liveText.count,
            LiveMarkdownWindow.liveTextCap + delta.count,
            "retained liveText must be bounded (cap + the fresh delta)"
        )
        // liveText = trimmed-suffix-of-full + delta: trims may drop the head
        // but must never reorder or corrupt the retained tail.
        XCTAssertTrue(store.liveText.hasSuffix(delta))
        XCTAssertTrue(full.hasSuffix(String(store.liveText.dropLast(delta.count))),
                      "retained tail must be a suffix of the accumulated text")
    }

    /// boundedTail: under the trigger → untouched; over → bounded suffix on a
    /// Character boundary (never splits a grapheme cluster).
    @MainActor
    func testBoundedTailSemantics() {
        let small = String(repeating: "短文本。\n\n", count: 100)
        let (keptSmall, trimmedSmall) = LiveMarkdownWindow.boundedTail(small)
        XCTAssertEqual(keptSmall, small)
        XCTAssertFalse(trimmedSmall)

        let unit = "第一段分析文字,含**加粗**。\n\n"
        let big = String(repeating: unit, count: 40_000) // ~1.6M bytes
        let (kept, trimmed) = LiveMarkdownWindow.boundedTail(big)
        XCTAssertTrue(trimmed)
        XCTAssertTrue(big.hasSuffix(kept), "bounded tail must be a suffix")
        XCTAssertLessThanOrEqual(kept.count, LiveMarkdownWindow.liveTextCap)
        XCTAssertTrue(kept.hasPrefix("第一段"), "trim must snap to the paragraph boundary")
    }

    /// A truncated liveText must NOT produce a provisional row at turn-end
    /// (its prefix is no longer the reply's start — it would mismatch the
    /// canonical transcript row and flash). Normal replies keep the row.
    @MainActor
    func testFinalizeTurnSkipsProvisionalWhenTruncated() {
        // Normal short reply → provisional row appended.
        let normal = SessionConversationStore(session: ScriptedSSE.session())
        normal.streaming = true
        normal.handle(ScriptedSSE.deltaEvent(bytes: 500))
        normal.flushPendingDelta()
        normal.handle(SSEEvent(id: nil, event: "turn-end", data: "{}"))
        XCTAssertEqual(normal.messages.filter { $0.role == "assistant" }.count, 1,
                       "short reply must keep its provisional row")

        // Truncated giant reply → NO provisional row (refetch paints canonical).
        let giant = SessionConversationStore(session: ScriptedSSE.session())
        giant.streaming = true
        giant.liveText = ScriptedSSE.liveText(megabytes: 2)
        giant.handle(ScriptedSSE.deltaEvent(bytes: 500))
        giant.flushPendingDelta()
        XCTAssertTrue(giant.liveTextTruncated)
        giant.handle(SSEEvent(id: nil, event: "turn-end", data: "{}"))
        XCTAssertTrue(giant.messages.filter { $0.role == "assistant" }.isEmpty,
                      "truncated reply must skip the (head-less) provisional row")
        XCTAssertFalse(giant.liveTextTruncated, "turn-end resets the truncated flag")
    }

    /// Small snapshots stay on the fully synchronous path (zero behavior
    /// change); the seeded liveText matches the block content exactly.
    @MainActor
    func testSmallSnapshotSeedsSynchronously() {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        let event = ScriptedSSE.snapshotEvent(megabytes: 0) // tiny (< async threshold)
        store.handle(event)
        XCTAssertNil(store.snapshotDecodeTask, "small snapshots must not go async")
        XCTAssertFalse(store.liveText.isEmpty, "snapshot must seed synchronously")
        XCTAssertFalse(store.liveTextTruncated)
        XCTAssertTrue(store.streaming)
    }

    /// Giant snapshots decode off-main; deltas arriving mid-decode must apply
    /// AFTER the snapshot (which resets the live region), preserving arrival
    /// order — never before it.
    @MainActor
    func testEventsQueuedDuringAsyncSnapshotReplayInOrder() async {
        let store = SessionConversationStore(session: ScriptedSSE.session())
        store.handle(ScriptedSSE.snapshotEvent(megabytes: 8))
        XCTAssertNotNil(store.snapshotDecodeTask, "8MB snapshot must decode off-main")
        // Delta lands while the decode is still in flight.
        store.handle(ScriptedSSE.deltaEvent(bytes: 100))
        await store.snapshotDecodeTask?.value
        store.flushPendingDelta()
        XCTAssertFalse(store.liveText.isEmpty)
        XCTAssertTrue(store.liveTextTruncated, "8MB seed must arrive pre-bounded")
        // The queued delta must have appended AFTER the seed, i.e. the live
        // text ends with the delta's content, not the snapshot's.
        struct P: Decodable { let delta: String }
        let event = ScriptedSSE.deltaEvent(bytes: 100)
        let delta = (try! JSONDecoder().decode(P.self, from: Data(event.data.utf8))).delta
        XCTAssertTrue(store.liveText.hasSuffix(delta), "queued delta must replay after the snapshot seed")
    }
}
