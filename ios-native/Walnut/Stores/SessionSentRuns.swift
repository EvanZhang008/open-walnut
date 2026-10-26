import Foundation

/// Where a session page draws the messages the user sends while a turn runs.
///
/// The page used to draw `history + pending bubbles + live turn`, so a message sent
/// mid-turn landed ABOVE the reply, thinking and tool calls already on screen, as if
/// it had been sent before the agent started (2026-10-24 field report, build 124).
/// The saved transcript had the right order all along; only the phone's drawing was
/// wrong.
///
/// The fix keeps what the user saw where they saw it: every send closes a RUN, the
/// part of the live turn that was on screen when the message went out, and the
/// bubble is drawn right after it. Whatever streams in afterwards stays in the live
/// region, below the bubble. The turn's last stretch becomes a run with no bubble
/// when the turn ends, in place of the provisional reply row, and the turn-end
/// transcript read replaces all of it with the canonical rows, the way it replaces
/// that provisional row today.
struct SessionSentRuns: Equatable {
    struct Run: Equatable {
        let id: String
        /// The bubble drawn right after this run; nil for the turn's last stretch,
        /// and for a run whose bubble was sent again later (`send`).
        var anchor: String?
        /// Thinking, reply text and tool rows, in the order the live region drew them.
        var rows: [ChatMessage]
        /// Tool call wire id -> its row id, so a result that lands later finds it
        /// (kept after the history takes the row, so its later frames stay here).
        var toolRows: [String: String] = [:]
        /// The reply text it holds and the history does not yet, whole (its row
        /// may show it clipped).
        var text = ""
        /// Opened while a turn was streaming (it holds live content, or would have).
        let whileStreaming: Bool
        /// Its turn has ended: the next transcript read carries everything in it.
        var settled = false
    }

    private(set) var runs: [Run] = []
    /// Bubbles drawn after the live region: their run's rows were replaced by a
    /// snapshot of the turn, which re-seeds the live region with everything in it.
    private(set) var afterLive: [String] = []

    var isEmpty: Bool { runs.isEmpty && afterLive.isEmpty }
    // Read-only checks for the callers: `sentRuns` is observed, and calling a
    // mutating method on it notifies its readers even when the method changes
    // nothing, so the 5s poll and every repeated status must ask first.
    var hasSettled: Bool { runs.contains(where: \.settled) }
    var hasUnsettled: Bool { runs.contains { !$0.settled } || !afterLive.isEmpty }
    var reseedMoves: Bool { runs.contains { $0.whileStreaming && !$0.settled } }
    var afterLiveIDs: Set<String> { Set(afterLive) }

    /// The page's message list: history, then each run followed by its bubble, then
    /// the bubbles no run places (in send order).
    func ordered(history: [ChatMessage], pending: [ChatMessage]) -> [ChatMessage] {
        guard !runs.isEmpty else { return history + pending }
        var byID: [String: ChatMessage] = [:]
        for bubble in pending { byID[bubble.id] = bubble }
        var out = history
        out.reserveCapacity(history.count + pending.count + runs.reduce(0) { $0 + $1.rows.count })
        var placed = Set<String>()
        for run in runs {
            out.append(contentsOf: run.rows)
            if let anchor = run.anchor, let bubble = byID[anchor], placed.insert(anchor).inserted {
                out.append(bubble)
            }
        }
        out.append(contentsOf: pending.filter { !placed.contains($0.id) })
        return out
    }

    /// A message was sent: what the live region shows now goes above it. A bubble
    /// sent again (a retry after a failure) leaves its old place: the session
    /// receives it now, after everything shown since.
    mutating func send(_ bubbleID: String, runID: String,
                       rows: (rows: [ChatMessage], toolRows: [String: String]), text: String = "",
                       streaming: Bool) {
        for index in runs.indices where runs[index].anchor == bubbleID { runs[index].anchor = nil }
        afterLive.removeAll { $0 == bubbleID }
        runs.append(Run(id: runID, anchor: bubbleID, rows: rows.rows,
                        toolRows: rows.toolRows, text: text, whileStreaming: streaming))
    }


    /// The turn ended; `rows` is its last stretch (the provisional reply).
    mutating func endTurn(rows: (rows: [ChatMessage], toolRows: [String: String]), tailID: String) {
        if !rows.rows.isEmpty {
            runs.append(Run(id: tailID, anchor: nil, rows: rows.rows, toolRows: rows.toolRows,
                            whileStreaming: true))
        }
        settle()
        // No live region is left to stand below: these bubbles follow the turn.
        afterLive = []
    }

    /// The turn is over without a turn-end frame (an error, a terminal status).
    mutating func settle() {
        guard hasUnsettled else { return }
        for index in runs.indices { runs[index].settled = true }
        afterLive = []
    }

    /// A transcript read landed: settled runs are in it now.
    mutating func dropSettled() {
        guard runs.contains(where: \.settled) else { return }
        runs.removeAll(where: \.settled)
    }

    /// These bubbles' own rows are in the history now, so is everything before them.
    mutating func absorbed(_ bubbleIDs: Set<String>) {
        guard !bubbleIDs.isEmpty else { return }
        if let last = runs.lastIndex(where: { $0.anchor.map(bubbleIDs.contains) ?? false }) {
            runs.removeSubrange(...last)
        }
        if afterLive.contains(where: bubbleIDs.contains) {
            afterLive.removeAll(where: bubbleIDs.contains)
        }
    }

    /// The user deleted a failed bubble. Its run stays: that output was real.
    mutating func discarded(_ bubbleID: String) {
        if afterLive.contains(bubbleID) { afterLive.removeAll { $0 == bubbleID } }
    }

    /// A snapshot re-seeded the live region with the turn's unsaved output, which
    /// includes what the runs of this turn hold. Their bubbles move below it.
    mutating func reseeded() {
        guard let first = runs.firstIndex(where: { $0.whileStreaming && !$0.settled }) else { return }
        let moved = runs[first...].filter { !$0.settled }
        afterLive.append(contentsOf: moved.compactMap(\.anchor))
        runs.removeAll { run in moved.contains { $0.id == run.id } }
    }

    // MARK: - The running turn's text
    //
    // While a turn runs, its text reaches the page three ways: the runs (what
    // was on screen at each send), the live region (what streamed since), and
    // the history, which a read during the turn fills with the messages the
    // session has finished so far. Shown once, in order, they spell the turn's
    // text from its start, which is also what a snapshot carries. Compared
    // without whitespace: a snapshot joins blocks with blank lines, the stream
    // does not, and the history keeps each message apart.

    /// The runs' unsaved text, in screen order (the running turn's runs only).
    private var unsavedIndices: [Int] { runs.indices.filter { !runs[$0].settled && runs[$0].whileStreaming } }

    /// A read during the turn saved `rows`: the turn's text rows the page had not
    /// accounted for, oldest first, and `tools`, every tool row of the turn the
    /// history holds. The runs and the live text give up what those rows hold,
    /// from the front; a run whose text is gone gives up its reasoning and the
    /// calls the history has too. Returns the live text that is left.
    mutating func takeSaved(_ rows: [String], tools: [ChatMessage], live: String,
                            clip: (String) -> String) -> String {
        let indices = unsavedIndices
        let parts = indices.map { Self.stripped(runs[$0].text) } + [Self.stripped(live)]
        let shown = parts.flatMap { $0 }
        let saved = Self.Joined(rows)
        // The newest rows that the unsaved text starts with: the oldest of them
        // may predate it (a send cut a message in two), so try longest first.
        var take = 0
        for k in saved.starts.indices {
            let tail = saved.scalars[saved.starts[k]...]
            let n = min(tail.count, shown.count)
            if n > 0, tail.prefix(n).elementsEqual(shown.prefix(n)) { take = n; break }
        }
        guard take > 0 else { return live }
        var historyTools: [String: Int] = [:]
        for t in tools { historyTools[Self.toolKey(t), default: 0] += 1 }
        var left = take
        for (p, r) in indices.enumerated() {
            let length = parts[p].count
            let used = min(left, length)
            left -= used
            if used > 0 && used < length {
                runs[r].text = Self.dropping(used, of: runs[r].text)
                let row = runs[r].rows.firstIndex { $0.kind == nil }
                if let row {
                    let old = runs[r].rows[row]
                    runs[r].rows[row] = ChatMessage(id: old.id, role: old.role, text: clip(runs[r].text),
                                                    createdAt: old.createdAt, kind: nil)
                }
                continue
            }
            // Its text is saved (or it had none and the saved text runs past it).
            let gone = length > 0 ? used == length : take > parts[..<p].reduce(0) { $0 + $1.count }
            guard gone else { continue }
            runs[r].text = ""
            runs[r].rows.removeAll { row in
                switch row.kind {
                case nil, .thinking: return true
                case .tool:
                    let key = Self.toolKey(row)
                    guard let n = historyTools[key], n > 0 else { return false }
                    historyTools[key] = n - 1
                    return true
                default: return false
                }
            }
        }
        return left > 0 ? Self.dropping(left, of: live) : live
    }

    /// Where a snapshot's turn text `seed` picks up: it starts with the turn's
    /// saved text rows (`saved`, oldest first) and then the runs' unsaved text;
    /// the rest is the live region's. `anyStart`: the page did not see where the
    /// turn began, so the saved rows are the history's newest and the turn's are
    /// some run of them at the end (the longest that fits); such a match must
    /// end where the seed starts a new block, so a previous reply that merely
    /// reads like the turn's first words is not taken for it. Returns the live
    /// text and the index of the first saved row the turn holds; nil when the
    /// seed does not continue the page.
    func seedRest(_ seed: String, saved: [String], anyStart: Bool) -> (rest: String, start: Int)? {
        let turn = Self.stripped(seed)
        let unsaved = unsavedIndices.flatMap { Self.stripped(runs[$0].text) }
        let rows = Self.Joined(saved)
        let candidates = anyStart ? Array(rows.starts.indices) + [rows.starts.count] : [0]
        for k in candidates {
            let head = k < rows.starts.count ? rows.scalars[rows.starts[k]...] : []
            let need = head.count + unsaved.count
            guard need <= turn.count, turn.prefix(head.count).elementsEqual(head),
                  turn[head.count..<need].elementsEqual(unsaved) else { continue }
            if anyStart, !head.isEmpty, unsaved.isEmpty, !Self.blockEnds(seed, after: head.count) { continue }
            return (Self.dropping(need, of: seed), k)
        }
        return nil
    }

    /// Text rows run together without whitespace, and where each row starts.
    private struct Joined {
        var scalars: [Unicode.Scalar] = []
        var starts: [Int] = []
        init(_ rows: [String]) {
            for row in rows {
                let s = SessionSentRuns.stripped(row)
                guard !s.isEmpty else { continue }
                starts.append(scalars.count)
                scalars.append(contentsOf: s)
            }
        }
    }

    static func stripped(_ s: String) -> [Unicode.Scalar] { s.unicodeScalars.filter { !isSpace($0) } }

    /// `s` after its first `n` non-whitespace scalars, its leading whitespace dropped.
    static func dropping(_ n: Int, of s: String) -> String {
        var seen = 0
        var index = s.unicodeScalars.startIndex
        while index < s.unicodeScalars.endIndex, seen < n {
            if !isSpace(s.unicodeScalars[index]) { seen += 1 }
            index = s.unicodeScalars.index(after: index)
        }
        while index < s.unicodeScalars.endIndex, isSpace(s.unicodeScalars[index]) {
            index = s.unicodeScalars.index(after: index)
        }
        return String(s.unicodeScalars[index...])
    }

    /// After its first `n` non-whitespace scalars, does `s` end or start a new
    /// line (the snapshot's block separator)?
    private static func blockEnds(_ s: String, after n: Int) -> Bool {
        var seen = 0
        var index = s.unicodeScalars.startIndex
        while index < s.unicodeScalars.endIndex, seen < n {
            if !isSpace(s.unicodeScalars[index]) { seen += 1 }
            index = s.unicodeScalars.index(after: index)
        }
        while index < s.unicodeScalars.endIndex, isSpace(s.unicodeScalars[index]) {
            if CharacterSet.newlines.contains(s.unicodeScalars[index]) { return true }
            index = s.unicodeScalars.index(after: index)
        }
        return index == s.unicodeScalars.endIndex
    }

    private static func isSpace(_ s: Unicode.Scalar) -> Bool {
        CharacterSet.whitespacesAndNewlines.contains(s)
    }

    /// A call is matched by its name: the history's row may carry a different
    /// detail than the stream's, and a count per name keeps two of them apart.
    private static func toolKey(_ row: ChatMessage) -> String { row.text }

    /// Does a run hold this tool call (by its wire id)?
    func holdsTool(_ toolUseID: String) -> Bool {
        !toolUseID.isEmpty && runs.contains { $0.toolRows[toolUseID] != nil }
    }

    /// A tool call that started before a send finished after it: its row is in a run.
    mutating func finishTool(_ toolUseID: String, resultPreview: String?) {
        for r in runs.indices {
            guard let rowID = runs[r].toolRows[toolUseID],
                  let i = runs[r].rows.firstIndex(where: { $0.id == rowID }) else { continue }
            let old = runs[r].rows[i]
            guard let resultPreview, !resultPreview.isEmpty, old.resultPreview != resultPreview else { return }
            runs[r].rows[i] = ChatMessage(id: old.id, role: old.role, text: old.text,
                                          createdAt: old.createdAt, kind: .tool, detail: old.detail,
                                          resultPreview: resultPreview, inputPreview: old.inputPreview)
            return
        }
    }

    /// The rows a run holds, built from the live region as it is drawn now:
    /// reasoning, then the reply text, then the tool calls (`TimelineRowBuilder.liveRows`).
    static func rows(runID: String, createdAt: String, thinking: String, text: String,
                     tools: [LiveToolCall]) -> (rows: [ChatMessage], toolRows: [String: String]) {
        var rows: [ChatMessage] = []
        var toolRows: [String: String] = [:]
        let reasoning = thinking.trimmingCharacters(in: .whitespacesAndNewlines)
        if !reasoning.isEmpty {
            rows.append(ChatMessage(id: "\(runID)-thinking", role: "assistant",
                                    text: thinkingLine(reasoning), createdAt: createdAt,
                                    kind: .thinking, thinkingText: reasoning))
        }
        if !text.isEmpty {
            rows.append(ChatMessage(id: "\(runID)-text", role: "assistant", text: text,
                                    createdAt: createdAt, kind: nil))
        }
        for (index, call) in tools.enumerated() where !call.name.isEmpty {
            let id = "\(runID)-tool-\(index)"
            rows.append(ChatMessage(id: id, role: "assistant", text: call.name, createdAt: createdAt,
                                    kind: .tool, detail: call.detail, resultPreview: call.resultPreview,
                                    inputPreview: call.inputPreview ?? call.detail))
            if !call.id.isEmpty { toolRows[call.id] = id }
        }
        return (rows, toolRows)
    }

    /// The one-line reasoning a thinking row shows beside its label (the server's
    /// `thinkingLine`: whitespace folded, clipped).
    static func thinkingLine(_ text: String) -> String {
        let folded = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard folded.count > 160 else { return folded }
        return String(folded.prefix(160)) + "\u{2026}"
    }
}
