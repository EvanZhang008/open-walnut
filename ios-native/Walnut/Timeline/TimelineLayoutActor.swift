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
/// many ticks); a live window carrying raw HTML has no head, because it is
/// segmented whole (see TimelineRowBuilder.liveRows).
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

    /// Memo entries whose rows hold a rich-HTML document → the height-cache
    /// identities those rows read (document keys + row ids). Rich rows are the
    /// ONE kind whose height is measured by the cell (WebKit is
    /// main-thread-only) and banked afterwards, so a memoized row would
    /// otherwise replay the rough first guess for ever and the measurement would
    /// never reach the layout.
    ///
    /// The identities are what keeps the response proportional: a measurement
    /// touches the rows that read the number that moved, and every other
    /// message's memo — plus the live head's TextKit measurement — is none of
    /// its business.
    private var richEntryIdentities: [String: Set<String>] = [:]

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
            richEntryIdentities.removeAll(keepingCapacity: true)
            cacheWidth = input.width
        }
        applyRichHeightChanges()
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
                let identities = TimelineRowBuilder.richIdentities(in: built)
                if !identities.isEmpty { richEntryIdentities[key] = identities }
                rows.append(contentsOf: built)
            }
        }
        if rowCache.count > Self.rowCacheLimit {
            // Simple pressure valve: drop everything and let the next build
            // repopulate from the visible window (bounded at ≤400 messages).
            rowCache = [:]
            richEntryIdentities.removeAll(keepingCapacity: true)
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

    /// Fold the heights measured since the last build into the memo.
    ///
    /// A measurement changes a HEIGHT, never markup, so the rows it affects are
    /// re-banked in place through the builder's own height resolver: dropping
    /// their memo entry would re-segment the reply and re-parse its markdown to
    /// arrive at byte-identical rows, which on a card-heavy reply is that work
    /// once per card as the cards measure themselves one by one. Everything the
    /// change set does not name — other messages, and the live head's TextKit
    /// measurement, which is exactly the cost the live window exists to bound —
    /// is left alone.
    ///
    /// The race is benign and pre-existing: a height banked between this drain
    /// and the end of the build is reported to the NEXT build, and the host
    /// always resubmits after recording, so the row converges one build later.
    private func applyRichHeightChanges() {
        switch RichHTMLHeightCache.shared.drainChanges() {
        case .none:
            return
        case .everything:
            // No identity describes a wholesale replacement (a test reset), so
            // the only correct answer is the blunt one: drop every rich entry and
            // let the next build guess again.
            for key in richEntryIdentities.keys { rowCache.removeValue(forKey: key) }
            richEntryIdentities.removeAll(keepingCapacity: true)
            headCache = nil
        case .identities(let changed):
            for (key, identities) in richEntryIdentities
            where !identities.isDisjoint(with: changed) {
                guard let cached = rowCache[key] else { continue }
                rowCache[key] = builder.rebankRichHeights(cached, width: cacheWidth,
                                                          changed: changed)
            }
            // The head is memoized on its own byte-stable string, so a card
            // sitting in it would be just as stuck as one in a message — but a
            // head with no rich row has nothing a measurement can move.
            if let head = headCache,
               !TimelineRowBuilder.richIdentities(in: head.rows).isDisjoint(with: changed) {
                headCache = (head.key, builder.rebankRichHeights(head.rows, width: cacheWidth,
                                                                 changed: changed))
            }
        }
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
