import XCTest
@testable import Walnut

final class SessionConversationStoreTests: XCTestCase {

    /// clipProvisional mirrors the server transcript clip (TEXT_MAX = 4000):
    /// the provisional row must be byte-identical to the canonical row the
    /// refetch swaps in, or the stable id changes and the bubble flashes.
    @MainActor
    func testClipProvisionalTruncatesLongText() {
        let long = String(repeating: "a", count: 5_000)
        let clipped = SessionConversationStore.clipProvisional(long)
        XCTAssertEqual(clipped.count, 4_001, "4000 chars + ellipsis")
        XCTAssertTrue(clipped.hasSuffix("…"))
        XCTAssertEqual(String(clipped.prefix(4_000)), String(long.prefix(4_000)))
    }

    @MainActor
    func testClipProvisionalKeepsShortTextIntact() {
        XCTAssertEqual(SessionConversationStore.clipProvisional(""), "")
        let exact = String(repeating: "b", count: 4_000)
        XCTAssertEqual(SessionConversationStore.clipProvisional(exact), exact)
        let cjk = "多字节字符也按字符数截断,不是字节数。"
        XCTAssertEqual(SessionConversationStore.clipProvisional(cjk), cjk)
    }

    @MainActor
    func testClipProvisionalCountsCharactersNotBytes() {
        let cjkLong = String(repeating: "字", count: 4_100)
        let clipped = SessionConversationStore.clipProvisional(cjkLong)
        XCTAssertEqual(clipped.count, 4_001)
        XCTAssertTrue(clipped.hasSuffix("…"))
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
