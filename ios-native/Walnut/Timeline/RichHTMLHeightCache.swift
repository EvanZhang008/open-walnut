import Foundation
import CoreGraphics

/// What has moved in the height cache since the layout actor last drained it.
///
/// A plain monotonic counter could only ever say "something moved", so the
/// actor's only safe answer was to drop EVERY memo entry holding a rich row
/// plus the live-head cache. Naming the identities makes the answer
/// proportional to the measurement: see `RichHTMLHeightCache.drainChanges`.
enum RichHeightChanges {
    case none
    /// Exactly these identities moved (`documentIdentity` / `rowIdentity`).
    case identities(Set<String>)
    /// The whole table was replaced, so no identity can describe it.
    case everything
}

/// Measured heights of rich-HTML rows, shared between the LAYOUT ACTOR (which
/// must know a row's height before any cell exists) and the MAIN THREAD (the
/// only place a WKWebView can be asked how tall its document came out).
///
/// Every other row kind is measured on the actor, because TextKit and plain
/// arithmetic are available there. A web document is the one exception: WebKit
/// is main-thread-only, and a document's rendered height is not derivable from
/// its source at any price. So the flow inverts for these rows — the CELL
/// measures, banks the number here, and the coordinator rebuilds, at which
/// point the actor reads an exact height instead of a guess. The layout still
/// never self-sizes; the height just arrives one frame late.
///
/// Thread safety is an `NSLock` rather than an actor on purpose: the actor
/// reads this synchronously inside a build (`await` there would serialize the
/// whole build behind another executor), and the writes are a handful of
/// dictionary stores per measurement.
final class RichHTMLHeightCache: @unchecked Sendable {
    static let shared = RichHTMLHeightCache()

    /// Entries kept per table. A long session can accumulate one document key
    /// per card per width, so this is bounded — an unbounded dictionary here
    /// would be a slow leak for the lifetime of the process.
    static let capacity = 256

    private let lock = NSLock()
    /// "<document key>|<quantised width>" → exact measured content height.
    private var documentHeights: [String: CGFloat] = [:]
    private var documentOrder: [String] = []
    /// Row id → the last height that ROW had, whatever it was showing.
    private var rowHeights: [String: CGFloat] = [:]
    private var rowOrder: [String] = []
    private var generationValue = 0
    /// Identities whose banked height moved since the last drain.
    private var changed: Set<String> = []
    /// Set when the tables were replaced wholesale, which no identity describes.
    private var replaced = false

    private init() {}

    /// Bumped whenever a banked height actually CHANGES — the cache's own change
    /// stamp. The layout actor does not poll it (it drains identities, below);
    /// this is the number to assert on when the question is "did this report bank
    /// anything at all", e.g. that an unchanged re-report is a no-op.
    var generation: Int {
        lock.lock()
        defer { lock.unlock() }
        return generationValue
    }

    // MARK: - Invalidation

    /// The two names a rich row's height can be banked under: the DOCUMENT key
    /// (`height(key:width:)`) and the ROW id (`lastHeight(rowID:)`). Namespaced
    /// because one change set carries both kinds and a row id from a message
    /// called `rh…` would otherwise read as a document key.
    static func documentIdentity(_ key: String) -> String { "d:" + key }
    static func rowIdentity(_ rowID: String) -> String { "r:" + rowID }

    /// Everything that moved since the last call, and clear it.
    ///
    /// Why the actor needs this at all: it memoizes a message's rows, so a
    /// freshly measured card would otherwise replay from that memo carrying its
    /// old estimate for ever — the measurement would land here and never reach
    /// the layout. Why it is a DRAIN of identities rather than a counter to
    /// poll: with only "something changed" the actor had to discard every rich
    /// memo entry in the transcript plus the live head's TextKit measurement, so
    /// a card-heavy reply (measured: 61 documents in one 9 KB reply) re-built the
    /// whole 121-row message once per card as the cards measured themselves one
    /// by one. With the identities in hand the actor re-banks the rows that
    /// actually moved.
    ///
    /// Drain, not peek: a measurement that lands DURING a build is reported to
    /// the NEXT build instead of being dropped, and the host always resubmits
    /// after recording, so another build is always coming.
    func drainChanges() -> RichHeightChanges {
        lock.lock()
        defer { lock.unlock() }
        if replaced {
            replaced = false
            changed.removeAll(keepingCapacity: true)
            return .everything
        }
        guard !changed.isEmpty else { return .none }
        let moved = changed
        changed.removeAll(keepingCapacity: true)
        return .identities(moved)
    }

    // MARK: - Exact heights (per document, per width)

    /// Exact measured height for this document at this width, if known.
    func height(key: String, width: CGFloat) -> CGFloat? {
        let slot = Self.slotKey(key, width)
        lock.lock()
        defer { lock.unlock() }
        return documentHeights[slot]
    }

    func record(key: String, width: CGFloat, height: CGFloat) {
        guard height > 0 else { return }
        lock.lock()
        defer { lock.unlock() }
        if storeDocument(key: key, width: width, height: height) { generationValue += 1 }
    }

    /// Bank ONE measurement: the document's exact height at this width and the
    /// last height of the row that showed it.
    ///
    /// One call because a measurement is one event about one row. As two calls
    /// it was two changes — two generation bumps, and (before invalidation was
    /// scoped) two chances for the actor to throw away work over a single card
    /// reporting its size.
    func recordMeasurement(key: String, width: CGFloat, rowID: String, height: CGFloat) {
        guard height > 0 else { return }
        lock.lock()
        defer { lock.unlock() }
        let document = storeDocument(key: key, width: width, height: height)
        let row = storeRow(rowID: rowID, height: height)
        if document || row { generationValue += 1 }
    }

    // MARK: - Per-row streaming estimate

    /// Last height this ROW had, whatever its content was. A streaming card
    /// gets a brand-new document key on every tick, so the exact-height table
    /// always misses mid-stream; without this fallback a growing card would
    /// snap back to the rough estimate on every tick and visibly jump.
    func lastHeight(rowID: String) -> CGFloat? {
        lock.lock()
        defer { lock.unlock() }
        return rowHeights[rowID]
    }

    func recordRow(rowID: String, height: CGFloat) {
        guard height > 0 else { return }
        lock.lock()
        defer { lock.unlock() }
        if storeRow(rowID: rowID, height: height) { generationValue += 1 }
    }

    /// Both `store…` helpers assume the lock is HELD (`NSLock` is not recursive)
    /// and report whether the banked number actually MOVED — an unchanged
    /// re-report must invalidate nothing, or a re-attached card would cost a
    /// rebuild every time it scrolled back on screen.
    private func storeDocument(key: String, width: CGFloat, height: CGFloat) -> Bool {
        let slot = Self.slotKey(key, width)
        let previous = documentHeights.updateValue(height, forKey: slot)
        if previous == nil {
            documentOrder.append(slot)
            Self.trim(&documentHeights, &documentOrder)
        }
        guard previous != height else { return false }
        // The identity is the KEY, not the width slot: the actor rebuilds at one
        // width, and a height banked for another width simply misses its lookup.
        markChanged(Self.documentIdentity(key))
        return true
    }

    /// Record an identity, degrading to "everything replaced" once the set
    /// outgrows the tables it describes. A change set only beats the blunt answer
    /// while it is SMALL, and nothing drains it while no timeline is on screen —
    /// which is also the only way it can get big.
    private func markChanged(_ identity: String) {
        guard changed.count < Self.capacity else {
            changed.removeAll(keepingCapacity: true)
            replaced = true
            return
        }
        changed.insert(identity)
    }

    private func storeRow(rowID: String, height: CGFloat) -> Bool {
        let previous = rowHeights.updateValue(height, forKey: rowID)
        if previous == nil {
            rowOrder.append(rowID)
            Self.trim(&rowHeights, &rowOrder)
        }
        guard previous != height else { return false }
        markChanged(Self.rowIdentity(rowID))
        return true
    }

    // MARK: - First guess

    /// Rough height for a document nothing is known about yet — on screen for
    /// the single frame between "row built" and "cell reported its real
    /// height", so cheap beats accurate.
    ///
    /// The heuristic: count the characters that are NOT inside a tag (what the
    /// reader will see wrapped), divide by how many fit on a line at the body
    /// font, and give every second tag a line of vertical rhythm of its own —
    /// a card built from many small elements is mostly structure, not prose.
    /// Deliberately a single pass with no regex: the actor runs this once per
    /// rich row per build until the first measurement lands, and a regex over
    /// a 100KB document there is exactly the per-tick cost that scales with
    /// the reply which this whole engine exists to avoid.
    ///
    /// Whitespace is counted the way HTML renders it, not the way it is typed: a
    /// run collapses to ONE character between two visible characters and to
    /// NOTHING when it touches a tag. Counting the newline + indent of a
    /// pretty-printed card as prose made the guess depend on how the model
    /// happened to format its markup, always in the OVER-estimating direction —
    /// measured on a 40-row card written one element per indented line: 2024pt
    /// against 1936pt for the identical markup on one line, four lines of prose
    /// that do not exist. Over is the worse direction, too: the row opens a gap
    /// the measurement then closes, so the content visibly jumps up, where a
    /// short guess only grows into place.
    ///
    /// KNOWN BIAS, left in on purpose: a bare `<` in a script body (`i < 20`)
    /// opens a pseudo-tag whose `>` is only found at the `</script>`, so the
    /// closer is missed and everything after it stays suppressed. That
    /// under-estimates, and it stays because the cell lays every document out at
    /// a probe height and reports its real one — so this number is on screen for
    /// one frame either way. Note the shape is NOT island-only: a `<script>`
    /// inside a code FENCE is a sample, so it does not classify its chunk as an
    /// app, and a fence glued onto raw HTML with no blank line between them
    /// shares ONE `.richHTML` segment that carries the script text. A JS-aware
    /// scanner in a one-frame heuristic would be the wrong trade; don't add one
    /// without a measurement saying the gap is visible.
    static func estimate(html: String, width: CGFloat) -> CGFloat {
        var visible = 0
        var tags = 0
        var inTag = false
        // A whitespace run is open, and something visible preceded it since the
        // last tag — together these decide whether the run is a rendered space
        // or the source's own indentation.
        var pendingSpace = false
        var textSinceTag = false
        // `<style>` and `<script>` bodies sit BETWEEN tags, so a naive
        // not-inside-a-tag count reads CSS as prose — and every html run of a
        // reply carries the whole message's harvested `<style>`, which made a
        // small card guess itself several hundred points tall.
        var name = ""
        var readingName = false
        var closingTag = false
        var suppressDepth = 0
        for scalar in html.unicodeScalars {
            if scalar == "<" {
                inTag = true
                tags += 1
                name = ""
                readingName = true
                closingTag = false
                // A run that ends at a tag is layout, not a rendered space.
                pendingSpace = false
                textSinceTag = false
                continue
            }
            if inTag {
                if scalar == ">" {
                    inTag = false
                    if name == "style" || name == "script" {
                        suppressDepth = closingTag ? max(0, suppressDepth - 1) : suppressDepth + 1
                    }
                    continue
                }
                guard readingName else { continue }
                if scalar == "/" {
                    if name.isEmpty { closingTag = true } else { readingName = false }
                } else if scalar == " " || scalar == "\t" || scalar == "\n" || scalar == "\r" {
                    readingName = false
                } else if name.unicodeScalars.count < 6 {
                    // ASCII-lowercase in place: `<STYLE>` is the same element as
                    // `<style>`, and a tag name is ASCII by spec.
                    let upper = scalar.value >= 65 && scalar.value <= 90
                    let lowered = Unicode.Scalar(upper ? scalar.value + 32 : scalar.value)
                    name.unicodeScalars.append(lowered ?? scalar)
                } else {
                    readingName = false
                }
                continue
            }
            guard suppressDepth == 0 else { continue }
            // HTML's own collapsible set (space, tab, LF, CR, FF) — an ASCII
            // compare, not `Unicode.Scalar.Properties`: this loop runs per
            // character of a document that can be 100KB, and a non-breaking
            // space is deliberately NOT whitespace here (it renders).
            if scalar.value == 32 || (scalar.value >= 9 && scalar.value <= 13) {
                pendingSpace = true
                continue
            }
            if pendingSpace {
                if textSinceTag { visible += 1 } // one collapsed space between words
                pendingSpace = false
            }
            visible += 1
            textSinceTag = true
        }
        // ~8pt per glyph at the body text size. `width` is already the web
        // view's own width (TimelineMetrics.richContentWidth), so the row
        // margins are not subtracted again; whatever padding the card's markup
        // adds inside itself is unknowable from here anyway.
        let charsPerLine = max(24, width / 8)
        let textLines = (CGFloat(visible) / charsPerLine).rounded(.up)
        let structuralLines = (CGFloat(tags) / 2).rounded(.up)
        let guess = (textLines + structuralLines) * estimateLineHeight
        return min(TimelineMetrics.richMaxHeight,
                   max(TimelineMetrics.richMinHeight, guess))
    }

    /// Body-font line height, hard-coded rather than read from `UIFont`: this
    /// is a guess either way, and keeping the estimate a pure function of its
    /// arguments makes it identical in a test and on device.
    private static let estimateLineHeight: CGFloat = 22

    /// The estimate's line height, for a test that asserts what a tag adds.
    static var estimateLineHeightForTesting: CGFloat { estimateLineHeight }

    // MARK: - Internals

    /// Sub-pixel width jitter (an inset animating, a rotation settling) must
    /// not miss the cache and re-guess a height we already know, so widths are
    /// keyed at whole-point resolution.
    private static func slotKey(_ key: String, _ width: CGFloat) -> String {
        "\(key)|\(Int(width.rounded()))"
    }

    /// FIFO eviction in batches: dropping a quarter when the cap is hit keeps
    /// the amortised cost of a record at O(1) instead of shifting the order
    /// array on every single insert past the cap. A table therefore sits at
    /// most ONE entry past `capacity` between trims.
    private static func trim(_ table: inout [String: CGFloat], _ order: inout [String]) {
        guard order.count > capacity else { return }
        let drop = capacity / 4
        for stale in order.prefix(drop) { table.removeValue(forKey: stale) }
        order.removeFirst(drop)
    }

    /// Tests share one process, and a height banked by one case would silently
    /// satisfy the next case's "nothing is known yet" branch.
    ///
    /// Reported as `.everything`: every banked number is gone at once, so no set
    /// of identities describes it and the actor has to re-guess from scratch.
    func resetForTesting() {
        lock.lock()
        defer { lock.unlock() }
        documentHeights = [:]
        documentOrder = []
        rowHeights = [:]
        rowOrder = []
        changed.removeAll(keepingCapacity: true)
        replaced = true
        generationValue += 1
    }
}
