import Foundation

/// The replay that follows a snapshot of a turn in flight.
///
/// Opening a running session (or its stream coming back) gives the page the snapshot, which tells the
/// turn's text from its start, and then the server writes its ring of recent events once more: the end of
/// the same turn, event by event (all of it, from its `turn-start`, only while the turn is short). The
/// snapshot's text has been placed already (what the history holds is in the history, the rest is the live
/// region), so the replay must add nothing: appended again, every step the history shows is drawn twice.
///
/// The replay is told from the stream that follows it by its words: it is a stretch of the snapshot's text
/// that ends where the snapshot ends. This follows the replayed text against the snapshot's, scalar by
/// scalar and without whitespace (a snapshot joins blocks with blank lines, the stream does not). What is
/// replayed is kept back until it has run to the snapshot's end (then it was the replay, and only what
/// follows is new) or stopped matching (then it was new text all along, and is given back).
struct SessionReplayTwin {
    /// The snapshot's turn text without whitespace.
    private let expected: [Unicode.Scalar]
    /// Where each stretch still matching would go on in `expected`.
    private var alive: [Int] = []
    private var seenText = false
    private var consumed = 0
    /// The replayed `turn-start` has to come before this (the replay is written right after the snapshot).
    let until: TimeInterval
    private(set) var turnStartSeen = false
    /// The deltas kept back so far, in order.
    private(set) var held: [String] = []

    /// How long after the snapshot the replay may begin.
    static let window: TimeInterval = 2
    /// How long what is kept back waits for the replay to run to the snapshot's end.
    static let holdSpan: TimeInterval = 2.5
    /// A stretch of words this short that happens to end where the snapshot does proves nothing: it is
    /// taken for the replay only from this many characters on.
    static let shortestReplay = 6

    init(snapshotText: String, until: TimeInterval) {
        expected = SessionSentRuns.stripped(snapshotText)
        self.until = until
    }

    /// No text to follow: the replay has no say.
    var hasNothingToFollow: Bool { expected.isEmpty }

    /// Nothing replayed yet: a `turn-start` now is the replay's own.
    var untouched: Bool { !seenText && held.isEmpty }

    mutating func noteTurnStart() { turnStartSeen = true }

    enum Outcome: Equatable {
        /// Kept back: it is, so far, the snapshot's own words once more.
        case held
        /// The snapshot's text ends inside this delta: everything kept back was the replay; `rest` is new.
        case finished(rest: String)
        /// It is not the snapshot's words: `release` (what was kept back, then this delta) is new text.
        case differs(release: [String])
    }

    mutating func take(_ delta: String) -> Outcome {
        var index = delta.unicodeScalars.startIndex
        let end = delta.unicodeScalars.endIndex
        while index < end {
            let scalar = delta.unicodeScalars[index]
            index = delta.unicodeScalars.index(after: index)
            if Self.isSpace(scalar) { continue }
            if !seenText {
                seenText = true
                alive = expected.indices.filter { expected[$0] == scalar }.map { $0 + 1 }
            } else {
                alive = alive.compactMap { $0 < expected.count && expected[$0] == scalar ? $0 + 1 : nil }
            }
            consumed += 1
            if alive.contains(expected.count) {
                if consumed >= min(Self.shortestReplay, expected.count) {
                    held = []
                    return .finished(rest: String(delta.unicodeScalars[index...]))
                }
                alive.removeAll { $0 >= expected.count }
            }
            if alive.isEmpty {
                let release = held + [delta]
                held = []
                return .differs(release: release)
            }
        }
        held.append(delta)
        return .held
    }

    /// Give everything kept back (the replay did not come, or did not end where the snapshot does).
    mutating func release() -> [String] {
        defer { held = [] }
        return held
    }

    private static func isSpace(_ s: Unicode.Scalar) -> Bool {
        CharacterSet.whitespacesAndNewlines.contains(s)
    }
}
