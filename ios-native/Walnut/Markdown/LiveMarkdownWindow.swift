import Foundation

/// Bounded render window for a STREAMING markdown text.
///
/// Why this exists (2026-08-07 watchdog-kill root cause): the live turn row
/// rendered the ENTIRE in-flight reply through `MarkdownParser.parse` on every
/// ~8Hz delta flush. The parse cache never hits mid-stream (each flush makes a
/// new string), so per-tick cost grew linearly with the reply — a long
/// research turn put multi-hundred-KB of markdown through parse + SwiftUI
/// layout per tick, stalled the main thread past the 5s limit, and iOS killed
/// the app with 0x8BADF00D ("stream attached" → freeze → watchdog kill).
/// Reproduced deterministically in the simulator: a growing multi-MB live text
/// tripped the app's own MainThreadWatchdog (6.0-6.4s stalls) with the exact
/// SwiftUICore/AttributeGraph-heavy stacks from the field crash reports.
///
/// The fix is structural, not a tuning knob:
///  1. WINDOW — only the newest `windowKeep` chars of the live text are
///     rendered (a clipped-prefix chip marks the rest). History is never
///     affected: transcript rows are server-clipped at 4KB, so the live row
///     was the only unbounded render path in the app.
///  2. SPLIT — the window is split at a QUANTIZED, fence-safe paragraph
///     boundary into a stable `head` and a small `tail`. Quantizing the split
///     keeps `head` byte-identical across many ticks, so `.equatable()` +
///     the parse cache skip it entirely; only the ≤(tailReserve+tailQuantum)
///     tail re-parses per tick. Per-tick cost is now O(tail), not O(reply).
///
/// Pure Foundation so the perf harness (scripts/ios-perf) can compile and
/// budget-test it headlessly alongside MarkdownParser.
enum LiveMarkdownWindow {
    /// Window engages above this length (UTF-16 units)…
    static let windowMax = 48_000
    /// …and keeps roughly this much of the newest text.
    static let windowKeep = 32_000
    /// The window start only advances in these steps, so the visible prefix
    /// stays stable (cache-hittable) while the reply grows within a quantum.
    static let dropQuantum = 16_000
    /// The hot tail segment: everything after the head boundary.
    static let tailReserve = 2_000
    /// Head boundary advances in these steps — head re-parses at most once
    /// per `tailQuantum` of new text instead of on every tick.
    static let tailQuantum = 8_000
    /// Boundary search gives up after this many candidates (pathological
    /// fence-heavy text) and falls back to no split for that region.
    private static let maxBoundaryTries = 24

    // MARK: - Store-side live-text bound (the attach/append fix)

    /// Hard cap on the live text a store RETAINS (Characters) — 2x `windowMax`
    /// so the render window's semantics (48K window + omitted-prefix chip) are
    /// always satisfiable from the retained tail. The window fix bounded the
    /// per-tick RENDER cost but the store still accumulated the whole reply:
    /// `segments()` bridges the full string to NSString O(n) per tick and every
    /// append copies it — at tens of MB that alone saturated the 120ms flush
    /// cadence and rebuilt the 0x8BADF00D stall (build-34 field crashes).
    static let liveTextCap = 96_000
    /// Trim hysteresis (UTF-8 bytes over the cap before a trim fires). Trimming
    /// on every flush would slide the string start each tick and defeat the
    /// window's quantized-head stability; with slack the start moves only once
    /// per ~16KB of growth, like the head's own tailQuantum cadence.
    static let liveTextTrimSlack = 16_000

    /// Keep only the newest ~`liveTextCap` Characters of a streamed text.
    /// Returns the (possibly) trimmed text and whether anything was dropped.
    ///
    /// Cost: O(liveTextCap), never O(text) — the fast path uses `utf8.count`
    /// (O(1) on native strings; bytes >= Characters, so <= cap+slack bytes can
    /// never exceed the cap in Characters) and the trim walks only `cap`
    /// Characters back from the end. Character-based slicing keeps grapheme
    /// clusters intact (never cut a CJK char / emoji mid-scalar).
    static func boundedTail(_ text: String) -> (text: String, truncated: Bool) {
        guard text.utf8.count > liveTextCap + liveTextTrimSlack else { return (text, false) }
        // Walk BACKWARD from the end: O(liveTextCap) regardless of text size.
        // (`text.suffix(n)` would first compute `count` — an O(text) grapheme
        // walk, exactly the O(reply) cost this function exists to kill.)
        // nil = the whole string is within the cap in Characters (multibyte
        // text can trip the byte trigger while under the Character cap).
        guard let cut = text.index(text.endIndex, offsetBy: -liveTextCap, limitedBy: text.startIndex),
              cut > text.startIndex else { return (text, false) }
        // Snap forward to a paragraph boundary so the retained tail doesn't
        // start mid-construct — but only if one exists nearby; a pathological
        // single giant paragraph must not collapse the window to almost nothing.
        var window = text[cut...]
        let searchLimit = window.index(window.startIndex, offsetBy: 4_096, limitedBy: window.endIndex) ?? window.endIndex
        if let r = window.range(of: "\n\n", range: window.startIndex..<searchLimit) {
            window = window[r.upperBound...]
        }
        return (String(window), true)
    }

    /// Stateful O(1)-per-call hysteresis around `boundedTail` — one instance
    /// per streaming store. The byte trigger alone over-fires on multibyte
    /// text (96K CJK Characters ≈ 280KB UTF-8, permanently past the trigger),
    /// which would re-walk O(cap) Characters AND slide the string start every
    /// flush — destabilizing the window's quantized head (a cache-miss storm
    /// with extra steps). The floor re-arms only `liveTextTrimSlack` bytes
    /// above the last result, so trims fire on the same ~16KB cadence as the
    /// head's own tailQuantum. Self-healing: any reset of the text to small
    /// (turn-start, finalize) re-arms the floor on the next call.
    struct TailBound {
        private var nextCheckBytes = LiveMarkdownWindow.liveTextCap + LiveMarkdownWindow.liveTextTrimSlack

        mutating func bound(_ text: String) -> (text: String, truncated: Bool) {
            let bytes = text.utf8.count // O(1) on native strings
            if bytes < LiveMarkdownWindow.liveTextCap {
                nextCheckBytes = LiveMarkdownWindow.liveTextCap + LiveMarkdownWindow.liveTextTrimSlack
                return (text, false)
            }
            guard bytes >= nextCheckBytes else { return (text, false) }
            let result = LiveMarkdownWindow.boundedTail(text)
            nextCheckBytes = result.text.utf8.count + LiveMarkdownWindow.liveTextTrimSlack
            return result
        }
    }

    struct Segments: Equatable {
        /// True when older output was dropped from the render window.
        var omittedPrefix: Bool
        /// Stable-across-ticks prefix ("" when the text is short).
        var head: String
        /// Small growing suffix — the only part re-parsed per tick.
        var tail: String
    }

    static func segments(_ text: String) -> Segments {
        let ns = text as NSString
        let len = ns.length
        var start = 0
        var omitted = false
        if len > windowMax {
            let target = ((len - windowKeep) / dropQuantum) * dropQuantum
            start = safeBoundary(ns, atOrBefore: target, lowerBound: 0) ?? target
            omitted = start > 0
        }
        let windowLen = len - start
        var headEnd = start
        if windowLen > tailReserve + tailQuantum {
            let target = start + ((windowLen - tailReserve) / tailQuantum) * tailQuantum
            headEnd = safeBoundary(ns, atOrBefore: min(target, len), lowerBound: start) ?? start
        }
        let head = headEnd > start
            ? ns.substring(with: NSRange(location: start, length: headEnd - start))
            : ""
        let tail = ns.substring(from: headEnd)
        return Segments(omittedPrefix: omitted, head: head, tail: tail)
    }

    /// Last "\n\n" at or before `index` (position AFTER the pair) whose prefix
    /// [lowerBound, boundary) contains an EVEN number of code-fence lines —
    /// splitting inside an open ``` block would shatter it into two half
    /// fences that render as garbage. Returns nil when no safe cut exists.
    private static func safeBoundary(_ ns: NSString, atOrBefore index: Int, lowerBound: Int) -> Int? {
        var searchEnd = min(index, ns.length)
        var tries = 0
        while searchEnd > lowerBound, tries < maxBoundaryTries {
            tries += 1
            let range = ns.range(
                of: "\n\n",
                options: [.backwards, .literal],
                range: NSRange(location: lowerBound, length: searchEnd - lowerBound)
            )
            guard range.location != NSNotFound else { return nil }
            let boundary = range.location + range.length
            if fenceCount(ns, in: NSRange(location: lowerBound, length: range.location - lowerBound)) % 2 == 0 {
                return boundary
            }
            searchEnd = range.location
        }
        return nil
    }

    /// Number of lines starting with ``` in `range` (fence opens + closes).
    private static func fenceCount(_ ns: NSString, in range: NSRange) -> Int {
        var count = 0
        var cursor = range.location
        let end = range.location + range.length
        // Count "\n```" occurrences + a fence at the very start of the range.
        if range.length >= 3, ns.substring(with: NSRange(location: range.location, length: 3)) == "```" {
            count += 1
        }
        while cursor < end {
            let found = ns.range(
                of: "\n```",
                options: [.literal],
                range: NSRange(location: cursor, length: end - cursor)
            )
            guard found.location != NSNotFound else { break }
            count += 1
            cursor = found.location + found.length
        }
        return count
    }
}
