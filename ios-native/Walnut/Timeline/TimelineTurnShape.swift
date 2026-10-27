import Foundation

/// The agent acknowledgement line: how a session answers a message from another
/// agent (a peer, a notice, a reply, a trigger) that needs nothing the person
/// should hear about. Port of the web console's `turn-end-marker.ts`, case for case
/// (`TurnShapeTests` mirrors `tests/web/turn-end-marker.test.ts`).
///
/// The session prompt asks for `<walnut-turn status="agent-ack"/>` ALONE as the
/// answer to such a message, and the timeline then hides that whole turn
/// (`TimelineTurnShape`). It is never a label on an answer: a turn a person
/// started, or a line with words before it, shows as the answer it is, the line
/// stripped. Sessions spawned before the rename still write
/// `<walnut-turn status="no-action"/>` (a resume replays the old prompt), so both
/// read the same. The tag itself never prints.
///
/// It counts only as the last non-blank line of the text, outside any code fence,
/// exactly as written: a quote of it, a line in a code block, a line in the middle
/// is not the marker.
enum TimelineTurnMarker {
    static let tag = "<walnut-turn status=\"agent-ack\"/>"
    /// The line's first name, still written by sessions spawned on the old prompt.
    static let legacyTag = "<walnut-turn status=\"no-action\"/>"
    private static let tags = [tag, legacyTag]

    struct Reading: Equatable {
        /// The text without the marker line (trailing whitespace dropped).
        let text: String
        /// True when the text ended with the marker.
        let ack: Bool
    }

    static func read(_ text: String) -> Reading {
        guard tags.contains(where: { text.contains($0) }) else { return Reading(text: text, ack: false) }
        // Foundation splits on "\n" alone (a Swift `split` would keep "\r\n" whole,
        // a single Character), which is how the web's `split('\n')` cuts.
        let lines = text.components(separatedBy: "\n")
        var last = lines.count - 1
        while last >= 0, trimmed(lines[last]).isEmpty { last -= 1 }
        guard last >= 0, tags.contains(trimmed(lines[last])),
              !lines[last].hasPrefix("    "), !lines[last].hasPrefix("\t") else {
            return Reading(text: text, ack: false)
        }
        // Inside a fence? ``` and ~~~ close only themselves, and a closing fence
        // carries nothing after it ("```js" inside a block opens and closes nothing).
        var open: (mark: Character, length: Int)?
        for line in lines[..<last] {
            guard let fence = fence(line) else { continue }
            if let current = open {
                if fence.mark == current.mark, fence.length >= current.length, fence.rest.isEmpty { open = nil }
            } else {
                open = (fence.mark, fence.length)
            }
        }
        guard open == nil else { return Reading(text: text, ack: false) }
        let kept = lines[..<last].joined(separator: "\n")
        return Reading(text: String(kept.reversed().drop(while: \.isWhitespace).reversed()), ack: true)
    }

    /// The text as the screen shows it: the marker line never prints.
    static func strip(_ text: String) -> String {
        let reading = read(text)
        return reading.ack ? reading.text : text
    }

    /// The live turn's text: as `strip`, and a last line that is so far only the
    /// START of the marker is held back too, so the tag never flashes up character
    /// by character (`stripTurnMarker(text, true)` on the web).
    static func stripLive(_ text: String) -> String {
        let reading = read(text)
        if reading.ack { return reading.text }
        let cut = text.lastIndex(of: "\n")
        let tail = trimmed(String(text[(cut.map { text.index(after: $0) } ?? text.startIndex)...]))
        // Even a lone `<`: the tag's first chunk would otherwise print until the next one.
        guard !tail.isEmpty, tags.contains(where: { $0.hasPrefix(tail) }) else { return text }
        return cut.map { String(text[..<$0]) } ?? ""
    }

    private static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// `^\s{0,3}(`{3,}|~{3,})(.*)$`: the fence's mark, its length, what follows it.
    private static func fence(_ line: String) -> (mark: Character, length: Int, rest: String)? {
        var i = line.startIndex
        var indent = 0
        while i < line.endIndex, line[i] == " " || line[i] == "\t", indent < 3 { i = line.index(after: i); indent += 1 }
        guard i < line.endIndex, line[i] == "`" || line[i] == "~" else { return nil }
        let mark = line[i]
        var length = 0
        while i < line.endIndex, line[i] == mark { i = line.index(after: i); length += 1 }
        guard length >= 3 else { return nil }
        return (mark, length, trimmed(String(line[i...])))
    }
}

/// What of each finished turn the reader sees. Port of the web console's
/// `turn-shape.ts` (+ the clean-turn rule of `noActionRows`), over the phone's rows.
///
/// A coordinating session takes in notices, peer messages and replies all day, and
/// works through each with tool calls and sends; shown row by row, that crowds out
/// the few answers that are for the person ("the user only gets the information
/// they need most"). So every finished turn takes one of three shapes:
///  · hidden: a turn something else started that ended cleanly with the ack line
///    alone: none of it shows, a "Show N hidden turns" row stands in its place;
///  · answered: everything before the answer (the message that started it unless a
///    person wrote it, tools, sends, narration) is one folded row, the answer shows;
///  · open: anything else (it ended in a tool call, an error, nothing, or it is the
///    live turn): rows render as they always did.
/// Turns split at every row sent into the session; a delivery that came in while
/// the session was still working (the rows before it end in a tool call, not an
/// answer) belongs to the turn it interrupted.
///
/// The phone's rows are finer than the web's messages: one message's reasoning,
/// text and tool calls arrive as separate rows, in that order. So "the message
/// ended in an answer" reads "the last row is a text row" (a tool row after it
/// would be the same message's call), and the answer is that one text row.
///
/// WHO SENT A ROW is the server's word (`ChatMessage.sentBy`): a list without it
/// comes from a server that predates the field, and is not shaped at all.
enum TimelineTurnShape {
    enum Kind: Equatable { case hidden, answered, open }

    struct Turn: Equatable {
        /// Index of the row that opened the turn; -1 when the list starts inside it.
        let start: Int
        /// First index after the turn.
        let end: Int
        /// A person wrote the opening row: it always shows.
        let byPerson: Bool
        let kind: Kind
        /// The answer row, for `answered`; -1 otherwise.
        let answer: Int
    }

    /// Tools that put something in front of the person: their turn never hides.
    private static let personFacingTools: Set<String> = ["AskUserQuestion", "ExitPlanMode"]

    /// Does the list carry the sender fact at all (a server new enough to say)?
    static func knowsSenders(_ messages: [ChatMessage]) -> Bool {
        messages.contains { $0.sentBy != nil }
    }

    /// A row sent into the session: a person's (a local, not yet echoed bubble
    /// has no `sentBy` and is one), or a delivery. Not a line the CLI wrote itself.
    static func isSent(_ m: ChatMessage) -> Bool { m.isUser && m.kind == nil && m.sentBy != "cli" }
    static func isPerson(_ m: ChatMessage) -> Bool { isSent(m) && m.sentBy != "agent" }
    /// A message or notice the session received: never the user's bubble.
    static func isInbound(_ m: ChatMessage) -> Bool { isSent(m) && m.sentBy == "agent" }

    /// A question the team routed to the session's lead: answered, not failed.
    static func isRoutedQuestion(_ m: ChatMessage) -> Bool {
        m.kind == .tool && m.text == "AskUserQuestion"
            && (m.resultPreview ?? "").drop(while: \.isWhitespace)
                .hasPrefix("In this team your questions go to your leader")
    }

    /// A failed step the reader must be able to see: a tool error, an error card.
    static func isFailure(_ m: ChatMessage) -> Bool {
        if m.kind == .tool { return m.isError == true && !isRoutedQuestion(m) }
        return m.kind == .notification && NotificationStyling(message: m).isError
    }

    static func shape(_ messages: [ChatMessage], streaming: Bool) -> [Turn] {
        var bounds: [Int] = []
        for (i, m) in messages.enumerated() where isSent(m) { bounds.append(i) }
        var segs: [(from: Int, to: Int)] = []
        if !messages.isEmpty, bounds.first.map({ $0 > 0 }) ?? true {
            segs.append((-1, bounds.first ?? messages.count))
        }
        for (k, b) in bounds.enumerated() {
            segs.append((b, k + 1 < bounds.count ? bounds[k + 1] : messages.count))
        }
        /// The turn's last word: an info card after it does not count, an error does.
        func lastRow(_ from: Int, _ to: Int) -> Int {
            var i = to - 1
            while i > from {
                let m = messages[i]
                if m.kind == .notification, !NotificationStyling(message: m).isError { i -= 1; continue }
                return i
            }
            return -1
        }
        func endsInAnswer(_ from: Int, _ to: Int) -> Bool {
            let i = lastRow(from, to)
            return i >= 0 && !messages[i].isUser && messages[i].kind == nil
        }
        // Chains of segments: a delivery mid-work joins the turn it interrupted.
        var chains: [(from: Int, to: Int)] = []
        for (k, seg) in segs.enumerated() {
            let person = seg.from >= 0 && isPerson(messages[seg.from])
            if let prev = chains.last, !person, !endsInAnswer(segs[k - 1].from, segs[k - 1].to) {
                chains[chains.count - 1] = (prev.from, seg.to)
            } else {
                chains.append(seg)
            }
        }
        return chains.enumerated().map { k, c in
            let byPerson = c.from >= 0 && isPerson(messages[c.from])
            let open = Turn(start: c.from, end: c.to, byPerson: byPerson, kind: .open, answer: -1)
            if k == chains.count - 1 && streaming { return open }
            let last = lastRow(c.from, c.to)
            guard last >= 0, !messages[last].isUser, messages[last].kind == nil else { return open }
            let reading = TimelineTurnMarker.read(messages[last].text)
            let answered = Turn(start: c.from, end: c.to, byPerson: byPerson, kind: .answered, answer: last)
            if reading.ack, reading.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // The line alone hides the turn, except a turn a person started, one
                // whose start is outside the list, or one holding a failure, a
                // question or a plan: those stay open, the line drawing nothing.
                guard !byPerson, c.from >= 0, isClean(messages, c.from, c.to) else { return open }
                return Turn(start: c.from, end: c.to, byPerson: false, kind: .hidden, answer: -1)
            }
            guard !reading.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return open }
            return answered
        }
    }

    /// No failed tool, no question to the person, no plan, no error in the turn.
    private static func isClean(_ messages: [ChatMessage], _ from: Int, _ to: Int) -> Bool {
        for m in messages[(from + 1)..<to] {
            if m.kind == .tool, personFacingTools.contains(m.text) { return false }
            if isFailure(m) { return false }
        }
        return true
    }

    /// Where a turn starts, for the shape it settled into (see `settle`): its
    /// place, never its text, which a slim read clips shorter than a rich one.
    static func turnKey(_ turn: Turn, in messages: [ChatMessage]) -> String {
        guard turn.start >= 0 else { return "head" }
        let m = messages[turn.start]
        return "\(m.role)|\(m.createdAt)|\(m.kind?.rawValue ?? "")"
    }

    /// A shape settled while the session was quiet holds while the next turn
    /// streams. That turn's own rows are not in the list yet (a peer note that
    /// started it lands with the refetch), so without this the previous answer
    /// would open up for the whole turn and fold back at its end. Any other last
    /// turn is the live one and stays open. `settled` is the caller's memo.
    static func settle(_ shapes: [Turn], in messages: [ChatMessage], streaming: Bool,
                       settled: inout [String: Kind]) -> [Turn] {
        guard streaming else {
            settled = Dictionary(shapes.map { (turnKey($0, in: messages), $0.kind) },
                                 uniquingKeysWith: { _, last in last })
            return shapes
        }
        guard let last = shapes.last, settled[turnKey(last, in: messages)] != last.kind else { return shapes }
        var out = shapes
        out[out.count - 1] = Turn(start: last.start, end: last.end, byPerson: last.byPerson,
                                  kind: .open, answer: -1)
        return out
    }
}
