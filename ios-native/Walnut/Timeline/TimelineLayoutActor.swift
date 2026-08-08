import Foundation
import CoreGraphics

/// Background build pipeline: TimelineInput (a plain snapshot of store state)
/// → immutable, height-measured TimelineSnapshot. All parsing, markdown
/// attribution and TextKit measurement happen HERE, off the main thread.
///
/// Coalescing is latest-wins: if inputs arrive faster than builds complete
/// (500 ev/s microbursts), intermediate snapshots are skipped — the UI only
/// ever needs the newest state, and the actor's serial execution makes the
/// pending-slot handoff race-free.
///
/// INCREMENTAL BY MEMOIZATION, not by delta protocol: message rows are cached
/// keyed on (message id, revision-relevant flags, expansion, width). The
/// store's ids are content-derived, so an unchanged message costs a
/// dictionary hit — a 21 ev/s storm re-BUILDS only the live tail while the
/// 105 history messages replay from cache. Live head rows use the dedicated
/// head cache (LiveMarkdownWindow's quantized head is byte-stable across
/// many ticks).
actor TimelineLayoutActor {
    private let builder = TimelineRowBuilder()
    private var generation = 0

    private var pendingInput: TimelineInput?
    private var building = false

    /// Memoized rows per message. Key includes everything that affects a
    /// message's rows; value is the built rows (immutable).
    private var rowCache: [String: [TimelineRow]] = [:]
    private var cacheWidth: CGFloat = 0
    private static let rowCacheLimit = 600

    /// Live-head memo (see TimelineRowBuilder.liveRows).
    private var headCache: (key: String, rows: [TimelineRow])?
    private var tailRevision = 0

    /// Submit the newest input. `onSnapshot` is invoked (on the actor) for
    /// every COMPLETED build — the caller hops to the main queue itself.
    func submit(_ input: TimelineInput, onSnapshot: @escaping @Sendable (TimelineSnapshot) -> Void) {
        pendingInput = input
        guard !building else { return } // the running loop picks it up
        building = true
        while let next = pendingInput {
            pendingInput = nil
            let snapshot = build(next)
            onSnapshot(snapshot)
        }
        building = false
    }

    /// Synchronous build — actor-serialized. Exposed for tests (deterministic
    /// single build without the coalescing loop).
    func buildSnapshot(_ input: TimelineInput) -> TimelineSnapshot {
        build(input)
    }

    private func build(_ input: TimelineInput) -> TimelineSnapshot {
        generation += 1
        if input.width != cacheWidth {
            rowCache = [:]
            headCache = nil
            cacheWidth = input.width
        }
        var rows: [TimelineRow] = []
        rows.reserveCapacity(input.messages.count * 2 + 4)
        if input.showLoadEarlier {
            rows.append(builder.loadEarlierRow())
        }
        for message in input.messages {
            let key = cacheKey(message, expandedRowIDs: input.expandedRowIDs)
            if let cached = rowCache[key] {
                rows.append(contentsOf: cached)
            } else {
                let built = builder.rows(for: message, width: input.width,
                                         expandedRowIDs: input.expandedRowIDs)
                rowCache[key] = built
                rows.append(contentsOf: built)
            }
        }
        if rowCache.count > Self.rowCacheLimit {
            // Simple pressure valve: drop everything and let the next build
            // repopulate from the visible window (bounded at ≤400 messages).
            rowCache = [:]
        }
        if input.streaming {
            tailRevision += 1
            let live = builder.liveRows(
                liveText: input.liveText, storeTruncated: input.liveTextTruncated,
                activity: input.activity, width: input.width,
                tailRevision: tailRevision, cachedHead: headCache
            )
            headCache = live.headCache
            rows.append(contentsOf: live.rows)
        } else {
            headCache = nil
        }
        return TimelineSnapshot(rows: rows, width: input.width, generation: generation)
    }

    /// Everything that can change a message's rows must be in the key.
    /// Message ids are content-derived (role|timestamp|kind|text-hash), so
    /// text/kind changes already produce a new id; the optimistic-bubble
    /// mutable flags and expansion state ride explicitly.
    private func cacheKey(_ m: ChatMessage, expandedRowIDs: Set<String>) -> String {
        var key = m.id
        if m.pending == true { key += "|p" }
        if m.failed == true { key += "|f" }
        if let images = m.localImages, !images.isEmpty { key += "|i\(images.count)" }
        if expandedRowIDs.contains("\(m.id)#0") { key += "|x" }
        return key
    }
}
