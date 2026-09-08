import Foundation

/// Which SLICE of the in-flight turn's (unbounded) reasoning the always-open
/// live card shows.
///
/// WHY THIS IS ITS OWN TYPE — ONE cap, measured in ONE unit. The first version
/// trimmed the accumulation with a NEWLINE-counting tail and then sized and
/// rendered the row in WRAPPED lines. Real reasoning has almost no newlines, so
/// the trim kept everything and `Text(...).lineLimit(8)` was left to choose the
/// visible part — and `lineLimit` keeps the FIRST n lines and truncates the tail.
/// Measured on the simulator with 24 numbered reasoning sentences: the capsule
/// read "Step 21…" while the card under it sat on "Step 1 … Step 7" and did not
/// move at t+18s or t+26s. A row contradicting itself is worse than a row
/// showing nothing, so the window is cut in the SAME unit the cell renders in,
/// from the NEWEST end — `lineLimit` never has a choice left to make.
///
/// The cut is measurement-driven rather than arithmetic: `wrappedLines` is
/// injected, so the one measurement the builder already owns (its TextKit
/// measurer, at the card's real content width) is the one that decides, and this
/// whole decision is testable without a TextKit stack.
enum TimelineLiveThinkingWindow {
    /// Header on the live reasoning capsule. Deliberately a FIXED word rather
    /// than an echo of the text: the capsule used to print the newest line while
    /// the card printed the oldest, and even with both ends fixed an echo of the
    /// card's last sentence is the same sentence twice in one row (the
    /// "first line printed twice" half of the same report).
    static let capsuleLabel = "Reasoning"

    /// Prefix marking a window that dropped older reasoning off its head. It
    /// rides the measured string, so the line it may cost is paid for honestly.
    static let headMark = "… "

    /// Where the growth search starts, in characters. One 8-line caption window
    /// is ~450 characters on a phone, so the first probe is usually the last one
    /// that fits and the second one overflows.
    private static let firstSpan = 256

    struct Window: Equatable {
        /// Exactly what the card renders — never more than `lines` wrapped lines.
        let body: String
        /// Wrapped-line count of `body`: what the row reserves room for.
        let lines: Int
        /// Older reasoning exists above the window (the head was dropped).
        let droppedHead: Bool
    }

    /// Newest-anchored window of at most `maxLines` wrapped lines, or nil when
    /// there is nothing to show.
    static func window(of text: String, maxLines: Int,
                       wrappedLines: (String) -> Int) -> Window? {
        guard maxLines > 0 else { return nil }
        let full = normalized(text)
        guard !full.isEmpty else { return nil }
        let whole = wrappedLines(full)
        if whole <= maxLines {
            return Window(body: full, lines: max(1, whole), droppedHead: false)
        }
        // The answer is a SUFFIX, so bound the search space by growing a trailing
        // region until it overflows the cap. Exponential, so a long accumulation
        // costs a handful of measurements rather than a scan of the whole text.
        var span = firstSpan
        var regionStart = index(full, fromEnd: span)
        while regionStart > full.startIndex,
              wrappedLines(candidate(full, from: regionStart)) <= maxLines {
            span *= 2
            regionStart = index(full, fromEnd: span)
        }
        // Candidates are WORD starts, so the window never opens mid-word.
        let starts = wordStarts(full, from: regionStart)
        guard !starts.isEmpty else {
            return Window(body: candidate(full, from: regionStart),
                          lines: maxLines, droppedHead: true)
        }
        // Line count is non-increasing as the start moves forward, so binary
        // search the EARLIEST start that still fits: the most reasoning that can
        // be shown while still ending on the newest word.
        var lo = 0
        var hi = starts.count - 1
        var best: (body: String, lines: Int, start: String.Index)?
        while lo <= hi {
            let mid = (lo + hi) / 2
            let body = candidate(full, from: starts[mid])
            let count = wrappedLines(body)
            if count <= maxLines {
                best = (body, max(1, count), starts[mid])
                hi = mid - 1
            } else {
                lo = mid + 1
            }
        }
        guard let best else {
            // Not even the last word fits — one unbreakable token wider than the
            // card. Show it anyway and let the cell's own `lineLimit` cut it: the
            // alternative is an empty card while the agent is visibly reasoning.
            let start = starts[starts.count - 1]
            return Window(body: candidate(full, from: start),
                          lines: maxLines, droppedHead: start > full.startIndex)
        }
        return Window(body: best.body, lines: best.lines,
                      droppedHead: best.start > full.startIndex)
    }

    // MARK: - Pure helpers (no measurement)

    /// Trim the ends and collapse blank-line runs. A paragraph break costs a
    /// whole wrapped line of the window, and the window is the scarce thing
    /// here — the newline-counting version this replaces dropped empty lines for
    /// exactly the same reason.
    static func normalized(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        var pendingBreak = false
        var started = false
        for character in text {
            if character.isNewline {
                if started { pendingBreak = true }
                continue
            }
            // Whitespace before the first word, or between a break and the next
            // word, would open a line with a space.
            if character.isWhitespace, !started || pendingBreak { continue }
            if pendingBreak {
                out.append("\n")
                pendingBreak = false
            }
            out.append(character)
            started = true
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    /// The rendered string for a window starting at `start` — with the head mark
    /// only when something was actually dropped.
    static func candidate(_ text: String, from start: String.Index) -> String {
        start > text.startIndex ? headMark + String(text[start...]) : String(text[start...])
    }

    /// Ascending word starts at or after `region` (a non-space preceded by a
    /// space or by nothing). Seeded from the character BEFORE the region, so a
    /// region boundary that landed mid-word is not itself offered as a start —
    /// the whole point of searching word starts is that the window never opens
    /// mid-word.
    static func wordStarts(_ text: String, from region: String.Index) -> [String.Index] {
        var starts: [String.Index] = []
        var index = region
        var previousWasSpace = region == text.startIndex
            ? true
            : text[text.index(before: region)].isWhitespace
        while index < text.endIndex {
            let isSpace = text[index].isWhitespace
            if !isSpace, previousWasSpace { starts.append(index) }
            previousWasSpace = isSpace
            index = text.index(after: index)
        }
        return starts
    }

    private static func index(_ text: String, fromEnd count: Int) -> String.Index {
        text.index(text.endIndex, offsetBy: -min(count, text.count))
    }
}
