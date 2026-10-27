import Foundation

/// The session timeline after turn shaping (`TimelineTurnShape`): the plan the
/// layout actor lays rows out from. Port of the web console's linear timeline
/// (`SessionChatHistory` turnShapes / pushTurnFold / flushHidden, and
/// `process-fold.ts`), over the phone's rows. Pure, so the whole rule is testable
/// without measuring a row (`TurnFoldTests`).
///
/// What the reader gets:
///  · consecutive hidden turns are ONE "Show N hidden turns" row;
///  · an answered turn is one folded row for everything before its answer
///    ("Received a message, used 2 tools ›"), then the answer;
///  · a person's own message is always the user's bubble, and Walnut's notes that
///    ride in front of it in the same row are one "Received a message ›" row
///    above it, the bubble holding only the person's words;
///  · in an open turn, received messages and the finished steps around them fold
///    into one muted row; a received message is never drawn outside a fold.
/// Every fold starts closed and opens to its members, which keep their own rows.
enum TimelineTurnFold {
    /// What a fold stands for. The row reads differently per kind.
    enum Kind: Equatable {
        /// Everything before a turn's answer.
        case turn
        /// Received messages and finished steps in a turn that did not fold whole.
        case process
        /// Turns that needed nothing from the person.
        case hidden
        /// Walnut's notes in front of a person's words.
        case rider
    }

    struct Fold: Equatable {
        let kind: Kind
        /// Where the fold starts (see `locationKey`), unique in the plan.
        let key: String
        /// The closed row's words; for `hidden`, the word after "Show"/"Hide".
        let phrase: String
        let failCount: Int
        let members: [Part]
    }

    indirect enum Part: Equatable {
        /// A row drawn as itself.
        case message(ChatMessage)
        /// A folded tool run (`TimelineToolRunFold`), unchanged.
        case run(key: String, members: [ChatMessage])
        /// A received message, drawn as a received card (only ever inside a fold).
        case inbound(ChatMessage)
        /// An answer that was the ack line alone, inside opened hidden turns.
        case ack(ChatMessage)
        case fold(Fold)
    }

    /// The fold's row id; `expandedRowIDs` remembers it across rebuilds and refetches.
    static func rowID(scope: String, key: String) -> String {
        "\(TimelineScope.namespace(scope, key))#fold"
    }

    /// The closed row's text.
    static func label(_ fold: Fold, expanded: Bool) -> String {
        guard fold.kind == .hidden else { return fold.phrase }
        return "\(expanded ? "Hide" : "Show") \(fold.phrase)"
    }

    static func plan(_ messages: [ChatMessage], turns: [TimelineTurnShape.Turn]) -> [Part] {
        Planner(messages: messages).run(turns, liveTail: false).parts
    }

    /// The live turn a received message started, while it runs: that message (and
    /// any finished steps history already holds after it) and the calls the
    /// session is making for it are ONE row, "Received a message, ran a command ›",
    /// keyed exactly like the turn fold it becomes once answered, so the row and
    /// its open state carry over when the turn ends (`liveTailStart` on the web).
    struct LiveTail: Equatable {
        let key: String
        /// History's rows in it, for the phrase (the live calls are added by the caller).
        let rows: [ChatMessage]
        let members: [Part]
    }

    /// `plan`, with the list's trailing received message(s) and finished runs held
    /// back as a `LiveTail` when there is one; the caller asks only while the live
    /// turn is making calls.
    static func planLive(_ messages: [ChatMessage], turns: [TimelineTurnShape.Turn]) -> (parts: [Part], tail: LiveTail?) {
        Planner(messages: messages).run(turns, liveTail: true)
    }

    /// A row's place, never its payload: a session row's id hashes its content,
    /// which changes when a slim read is replaced by the rich one, and a fold named
    /// by it would snap shut under the reader who opened it.
    static func locationKey(_ m: ChatMessage) -> String {
        "\(m.role)|\(m.createdAt)|\(m.kind?.rawValue ?? "")|\(m.kind == .tool ? m.text : "")"
    }

    /// A message to someone else (a send to another task, to the lead, to the inbox).
    static func isOutbound(_ m: ChatMessage) -> Bool {
        guard m.kind == .tool else { return false }
        if m.text.hasPrefix("mcp__"), outboundOps.contains(where: { m.text.hasSuffix("__\($0)") }) { return true }
        return TimelineToolRunFold.staysOutOfRuns(name: m.text, detail: m.detail, inputPreview: m.inputPreview)
            && m.text != "ExitPlanMode" && m.text != "Write"
    }

    private static let outboundOps = ["task_send", "session_send", "org_send", "human_inbox_send",
                                      "human_inbox_reply", "board_post"]

    /// "Received a message, ran 2 commands, sent a message": the web's process line.
    static func phrase(tools: [ChatMessage], received: Int) -> String {
        let sent = tools.filter(isOutbound).count
        let calls = tools.filter { !isOutbound($0) }
            .map { TimelineToolRunPhrase.Member(name: $0.text, detail: $0.detail) }
        var pieces: [String] = []
        if received > 0 { pieces.append(received == 1 ? "received a message" : "received \(received) messages") }
        let callPhrase = TimelineToolRunPhrase.phrase(calls)
        if let first = callPhrase.first { pieces.append(first.lowercased() + callPhrase.dropFirst()) }
        if sent > 0 { pieces.append(sent == 1 ? "sent a message" : "sent \(sent) messages") }
        return capitalized(pieces.joined(separator: ", "))
    }

    static func capitalized(_ s: String) -> String {
        guard let first = s.first else { return s }
        return first.uppercased() + s.dropFirst()
    }

    /// The ack line alone: a text row with nothing else to draw.
    static func isAckOnly(_ m: ChatMessage) -> Bool {
        guard !m.isUser, m.kind == nil else { return false }
        let reading = TimelineTurnMarker.read(m.text)
        return reading.ack && reading.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// One pass over the shaped list. Tool runs are folded ONCE over the whole list
/// (a run never crosses a sent row or an answer, so it never crosses a turn), so
/// their keys stay exactly what `TimelineToolRunFold` gives them everywhere else.
private final class Planner {
    typealias Part = TimelineTurnFold.Part
    let messages: [ChatMessage]
    /// The list's parts with the index of their first row.
    private var parts: [(start: Int, part: TimelineToolRunFold.Part)] = []
    private var keyCounts: [String: Int] = [:]

    init(messages: [ChatMessage]) {
        self.messages = messages
        var at = 0
        for part in TimelineToolRunFold.fold(messages) {
            parts.append((at, part))
            if case .run(_, let members) = part { at += members.count } else { at += 1 }
        }
    }

    func run(_ turns: [TimelineTurnShape.Turn], liveTail: Bool) -> (parts: [Part], tail: TimelineTurnFold.LiveTail?) {
        // Where the live tail starts: back over received messages and runs, at least one received.
        var end = parts.count
        if liveTail {
            var s = parts.count
            var inbound = false
            while s > 0 {
                let part = parts[s - 1].part
                if case .message(let m) = part, TimelineTurnShape.isInbound(m) { inbound = true }
                else if case .run = part {} else { break }
                s -= 1
            }
            if inbound { end = s }
        }
        var out: [Part] = []
        var hidden: [TimelineToolRunFold.Part] = []
        var hiddenTurns = 0
        var p = 0
        func flushHidden() {
            guard let first = hidden.first else { return }
            let count = hiddenTurns
            out.append(.fold(fold(.hidden, first: first,
                                  phrase: count == 1 ? "1 hidden turn" : "\(count) hidden turns",
                                  members: hidden.map { member($0, acks: true) }, failCount: 0)))
            hidden = []
            hiddenTurns = 0
        }
        for turn in turns {
            var mine: [(start: Int, part: TimelineToolRunFold.Part)] = []
            while p < end, parts[p].start < turn.end { mine.append(parts[p]); p += 1 }
            guard !mine.isEmpty else { continue }
            if turn.kind == .hidden {
                hidden += mine.map(\.part)
                hiddenTurns += 1
                continue
            }
            flushHidden()
            let answer = turn.kind == .answered ? mine.firstIndex(where: { $0.start == turn.answer }) : nil
            guard var ans = answer else { out += defaultParts(mine.map(\.part)); continue }
            // The person's own message always shows.
            let lead = turn.byPerson && mine[0].start == turn.start ? 1 : 0
            // The answer's own reasoning (the same message, split into its own row on
            // the phone) stays with the answer, as one message does on the web.
            if ans - 1 >= lead, case .message(let prev) = mine[ans - 1].part, prev.kind == .thinking,
               prev.createdAt == messages[turn.answer].createdAt { ans -= 1 }
            if lead == 1 { out += defaultParts([mine[0].part]) }
            let before = mine[lead..<ans].map(\.part)
            if before.count == 1, case .run = before[0] {
                out += before.map { member($0) } // already one folded row
            } else if !before.isEmpty {
                out.append(.fold(turnFold(before)))
            }
            out += defaultParts(mine[ans...].map(\.part))
        }
        flushHidden()
        if p < end { out += defaultParts(parts[p..<end].map(\.part)) }
        guard end < parts.count else { return (out, nil) }
        let tail = parts[end...].map(\.part)
        let key = fold(.turn, first: tail[0], phrase: "", members: [], failCount: 0).key
        return (out, TimelineTurnFold.LiveTail(key: key, rows: tail.flatMap(Self.rows),
                                               members: tail.map { member($0) }))
    }

    /// A part drawn as itself, not regrouped: what an opened fold holds. The ack
    /// line alone reads "Acknowledged" only inside hidden turns, where the turn rule
    /// agreed; anywhere else it has nothing to draw (its row strips to nothing).
    private func member(_ part: TimelineToolRunFold.Part, acks: Bool = false) -> Part {
        switch part {
        case .run(let key, let members): return .run(key: key, members: members)
        case .message(let m):
            if TimelineTurnShape.isInbound(m) { return .inbound(m) }
            if acks, TimelineTurnFold.isAckOnly(m) { return .ack(m) }
            return .message(m)
        }
    }

    /// Everything before an answer, as one row. Opened, the rows show as they are.
    private func turnFold(_ before: [TimelineToolRunFold.Part]) -> TimelineTurnFold.Fold {
        let rows = before.flatMap(Self.rows)
        let tools = rows.filter { $0.kind == .tool }
        var pieces = [TimelineTurnFold.phrase(tools: tools, received: rows.filter(TimelineTurnShape.isInbound).count)]
        let notes = rows.filter {
            !$0.isUser && $0.kind == nil
                && !TimelineTurnMarker.strip($0.text).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }.count
        if notes > 0 { pieces.append(notes == 1 ? "an update" : "\(notes) updates") }
        let phrase = TimelineTurnFold.capitalized(pieces.filter { !$0.isEmpty }.joined(separator: ", "))
        return fold(.turn, first: before[0], phrase: phrase.isEmpty ? "Thinking" : phrase,
                    members: before.map { member($0) }, failCount: rows.filter(TimelineTurnShape.isFailure).count)
    }

    /// The default rendering: a person's row with riders splits, and received
    /// messages with the finished steps around them group into one process row.
    private func defaultParts(_ items: [TimelineToolRunFold.Part]) -> [Part] {
        var out: [Part] = []
        var group: [TimelineToolRunFold.Part] = []
        var carries = false // a received or sent message is in the group
        func flush() {
            if group.count >= 2 || (group.count == 1 && carries) {
                let rows = group.flatMap(Self.rows)
                let tools = rows.filter { $0.kind == .tool }
                let phrase = TimelineTurnFold.phrase(tools: tools, received: rows.filter(TimelineTurnShape.isInbound).count)
                out.append(.fold(fold(.process, first: group[0], phrase: phrase, members: group.map { member($0) },
                                      failCount: rows.filter(TimelineTurnShape.isFailure).count)))
            } else {
                out += group.map { member($0) }
            }
            group = []
            carries = false
        }
        for item in items {
            switch item {
            case .run(_, let members) where members.allSatisfy(Self.isFinishedStep):
                group.append(item)
                if members.contains(where: TimelineTurnFold.isOutbound) { carries = true }
            case .run:
                // A failed call or a question is never folded away unread.
                flush()
                out.append(member(item))
            case .message(let m) where TimelineTurnShape.isInbound(m) || TimelineTurnFold.isOutbound(m):
                group.append(item)
                carries = true
            case .message(let m):
                flush()
                if TimelineTurnShape.isPerson(m), m.sentBy != nil,
                   let split = TimelineInboundMessage.splitRiders(m.text) {
                    let riders = split.riders.enumerated().map { n, rider in
                        // Named by place: the row's own id hashes its text, which a rich read replaces.
                        Part.inbound(ChatMessage(id: "rider|\(m.createdAt)|\(n)", role: "user", text: rider,
                                                 createdAt: m.createdAt, kind: nil))
                    }
                    let count = riders.count
                    out.append(.fold(fold(.rider, first: item,
                                          phrase: count == 1 ? "Received a message" : "Received \(count) messages",
                                          members: riders, failCount: 0)))
                    out.append(.message(m.replacingText(split.body)))
                } else {
                    out.append(member(item))
                }
            }
        }
        flush()
        return out
    }

    /// A step a process row may fold: not a failure (a routed question is an
    /// answer), not a question to the person (`processToolsOf` on the web).
    private static func isFinishedStep(_ m: ChatMessage) -> Bool {
        guard m.kind == .tool else { return true }
        if m.text == "AskUserQuestion" { return false }
        return !TimelineTurnShape.isFailure(m)
    }

    private static func rows(_ part: TimelineToolRunFold.Part) -> [ChatMessage] {
        switch part {
        case .run(_, let members): return members
        case .message(let m): return [m]
        }
    }

    private func fold(_ kind: TimelineTurnFold.Kind, first: TimelineToolRunFold.Part, phrase: String,
                      members: [Part], failCount: Int) -> TimelineTurnFold.Fold {
        let head = Self.rows(first)[0]
        let prefix: String
        switch kind {
        case .turn: prefix = "turn"
        case .process: prefix = "proc"
        case .hidden: prefix = "hidden"
        case .rider: prefix = "rider"
        }
        let base = "\(prefix)|\(TimelineTurnFold.locationKey(head))"
        let n = keyCounts[base, default: 0]
        keyCounts[base] = n + 1
        return TimelineTurnFold.Fold(kind: kind, key: "\(base)#\(n)", phrase: phrase,
                                     failCount: failCount, members: members)
    }
}

extension ChatMessage {
    /// The same row drawing other words (a person's message without Walnut's riders).
    func replacingText(_ text: String) -> ChatMessage {
        var copy = ChatMessage(id: id, role: role, text: text, createdAt: createdAt, kind: kind,
                               source: source, detail: detail, resultPreview: resultPreview, agent: agent,
                               thinkingText: thinkingText, inputPreview: inputPreview, detailRef: detailRef,
                               inFlight: inFlight, answeredBy: answeredBy, isError: isError)
        copy.messageId = messageId
        copy.sentBy = sentBy
        copy.pending = pending
        copy.failed = failed
        copy.localImages = localImages
        copy.localFiles = localFiles
        copy.uploadHeld = uploadHeld
        copy.clientMessageId = clientMessageId
        copy.retryNotice = retryNotice
        return copy
    }
}
