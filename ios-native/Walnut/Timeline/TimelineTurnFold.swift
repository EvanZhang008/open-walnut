import Foundation

/// The session timeline after turn shaping (`TimelineTurnShape`): the plan the
/// layout actor lays rows out from. Port of the web console's linear timeline
/// (`SessionChatHistory` turnShapes and its quiet folds, `fold-steps.ts`), over
/// the phone's rows. Pure, so the whole rule is testable
/// without measuring a row (`TurnFoldTests`).
///
/// What the reader gets:
///  · every stretch of quiet steps between two rows the person reads is ONE
///    folded row whatever turns it spans: turns that needed nothing, everything
///    before an answer, received and sent messages, finished steps, reasoning
///    alone. Its line counts what came in, went out and ran ("Received 12
///    messages · Sent 3 · Ran 8 tools ›", `TimelineFoldSteps`);
///  · a person's own message is always the user's bubble, holding only the
///    person's words. What Walnut added to it (its notes in front, the context
///    blocks it put first, its message hints) is hidden unless the person asked to
///    see it, for this message (the bubble's long-press item) or always (the
///    server's `ui.show_walnut_additions`); shown, each note reads as its one-line
///    description above the bubble and the rest as one "Walnut added: …" row under
///    it, which opens to each item's words (`Additions`);
///  · received messages with no step or send beside them are each their one-line
///    description, with nothing to open;
///  · a line the CLI put in itself (a loaded skill's text, a hook's added context,
///    `TimelineInjectedLines`) is a quiet step: it folds with the steps beside it,
///    and alone it is its own closed row ("Loaded skill release-notes ›").
/// Every fold starts closed and opens to its members, which keep their own rows;
/// a received member is its one-line description there too.
enum TimelineTurnFold {
    /// What a fold stands for. The row reads differently per kind.
    enum Kind: Equatable {
        /// A stretch of quiet steps: everything before a turn's answer, turns that
        /// needed nothing, received messages and finished steps between answers.
        case turn
    }

    struct Fold: Equatable {
        let kind: Kind
        /// Where the fold starts (see `locationKey`), unique in the plan.
        let key: String
        /// The closed row's words: counts of what the steps did (`TimelineFoldSteps`).
        let phrase: String
        let failCount: Int
        let members: [Part]
    }

    indirect enum Part: Equatable {
        /// A row drawn as itself.
        case message(ChatMessage)
        /// A folded tool run (`TimelineToolRunFold`), unchanged.
        case run(key: String, members: [ChatMessage])
        /// A received message, drawn as its one-line description.
        case inbound(ChatMessage)
        /// An answer that was the ack line alone, inside an opened fold.
        case ack(ChatMessage)
        case fold(Fold)
        /// What Walnut added to the person's message just above (hints, context
        /// blocks), shown: one "Walnut added: …" row that opens to each item.
        /// `key` names the message's place (`addedKey`), never its payload.
        case added(key: String, items: [WalnutAddedItem])
    }

    /// Whether what Walnut added to a person's message shows. `showAll` is the
    /// server's `ui.show_walnut_additions`; otherwise a message shows it only
    /// once the person revealed it from the bubble (`isRevealed` of its key).
    struct Additions {
        var showAll = false
        var isRevealed: (String) -> Bool = { _ in false }

        /// Read off a build's input: the setting, and the reveals the view keeps
        /// among its expanded row ids (`revealRowID`).
        static func of(_ input: TimelineInput) -> Additions {
            let expanded = input.expandedRowIDs
            let scope = input.scope
            return Additions(showAll: input.showWalnutAdditions,
                             isRevealed: { expanded.contains(TimelineTurnFold.revealRowID(scope: scope, key: $0)) })
        }
    }

    /// The row id a message's reveal is remembered under in `expandedRowIDs`
    /// (the bubble's long-press item toggles it). Not a drawn row.
    static func revealRowID(scope: String, key: String) -> String {
        "\(TimelineScope.namespace(scope, key))#reveal"
    }

    /// The words "Walnut added: Rich output · Context" the shown row reads.
    static func addedPhrase(_ items: [WalnutAddedItem]) -> String {
        "Walnut added: " + items.map(\.label).joined(separator: " \u{00B7} ")
    }

    /// The person's own text of a row: without the context blocks when the server
    /// took them off (`textWithoutContext`), Walnut's notes in front still in it.
    /// The whole text when nothing came off, or when nothing of the person's is
    /// left without them (a row that is only Walnut's context is drawn as before).
    static func ownText(_ m: ChatMessage) -> String {
        guard let own = m.textWithoutContext,
              !own.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return m.text }
        return own
    }

    /// The fold's row id; `expandedRowIDs` remembers it across rebuilds and refetches.
    static func rowID(scope: String, key: String) -> String {
        "\(TimelineScope.namespace(scope, key))#fold"
    }

    static func plan(_ messages: [ChatMessage], turns: [TimelineTurnShape.Turn],
                     additions: Additions = Additions()) -> [Part] {
        Planner(messages: messages, additions: additions).run(turns, liveTail: false).parts
    }

    /// The live turn a received message started, while it runs: that message (and
    /// any finished steps history already holds after it) and the calls the
    /// session is making for it are ONE row, "Received 1 message · Ran 1 tool ›",
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
    static func planLive(_ messages: [ChatMessage], turns: [TimelineTurnShape.Turn],
                         additions: Additions = Additions()) -> (parts: [Part], tail: LiveTail?) {
        Planner(messages: messages, additions: additions).run(turns, liveTail: true)
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

    /// The web's sends (`detectOutboundSend` + `MESSAGE_OPS`); a Board post is a tool there.
    private static let outboundOps = ["task_send", "session_send", "org_send", "human_inbox_send",
                                      "human_inbox_reply"]

    /// What a tool chip calls a Walnut send: the web's words for it, never the MCP
    /// name (`mcp__walnut__task_send` read as raw code on an opened trigger turn).
    /// Any other tool keeps its own name.
    static func toolLabel(_ name: String) -> String {
        guard name.hasPrefix("mcp__"), let cut = name.range(of: "__", options: .backwards),
              cut.lowerBound > name.index(name.startIndex, offsetBy: 4) else { return name }
        switch String(name[cut.upperBound...]) {
        case "task_send", "session_send", "org_send": return "Sent a message"
        case "human_inbox_send": return "Wrote to your inbox"
        case "human_inbox_reply": return "Replied in your inbox"
        case "board_post": return "Posted on the Board"
        default: return name
        }
    }

    /// A send's chip names the tasks it went to ("Sent to Brief task, Task status
    /// foundation") when the server resolved them (`sentTo`); nil for any other row.
    /// 2026-10-30, the user, of a send that said "another session": which session?
    static func sendLabel(_ m: ChatMessage) -> String? {
        guard isOutbound(m), let titles = m.sentTo?.compactMap(\.title), !titles.isEmpty else { return nil }
        return "Sent to " + titles.joined(separator: ", ")
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
    let additions: TimelineTurnFold.Additions
    /// The list's parts with the index of their first row.
    private var parts: [(start: Int, part: TimelineToolRunFold.Part)] = []
    private var keyCounts: [String: Int] = [:]

    init(messages: [ChatMessage], additions: TimelineTurnFold.Additions) {
        self.messages = messages
        self.additions = additions
        var at = 0
        for part in TimelineToolRunFold.fold(messages) {
            parts.append((at, part))
            if case .run(_, let members) = part { at += members.count } else { at += 1 }
        }
    }

    func run(_ turns: [TimelineTurnShape.Turn], liveTail: Bool) -> (parts: [Part], tail: TimelineTurnFold.LiveTail?) {
        // Where the live tail starts: back over quiet rows, at least one received.
        var end = parts.count
        // A stretch that ends on an ack is a turn already answered: the live turn
        // was started by a row history does not hold yet (the person's message
        // from another device, say), so its calls ride no earlier row.
        let answered: Bool = {
            if case .message(let m)? = parts.last?.part { return TimelineTurnFold.isAckOnly(m) }
            return false
        }()
        if liveTail, !answered {
            var s = parts.count
            var inbound = false
            while s > 0, Self.isQuiet(parts[s - 1].part) {
                if case .message(let m) = parts[s - 1].part, TimelineTurnShape.isInbound(m) { inbound = true }
                s -= 1
            }
            if inbound { end = s }
        }
        var out: [Part] = []
        // The quiet steps since the last row the person reads: ONE row whatever
        // turns they span (2026-10-27, the user: "if it is collapsed near collapsed,
        // need to combine").
        var quiet: [TimelineToolRunFold.Part] = []
        func flushQuiet() {
            defer { quiet = [] }
            guard let first = quiet.first else { return }
            // Received messages with nothing beside them are not steps to count:
            // each reads as its one-line description, with nothing to open.
            if Self.onlyReceived(quiet) {
                out += quiet.map { member($0) }
                return
            }
            if quiet.count == 1 {
                // One run or one reasoning row already is one row; a message received
                // or sent folds, also a send inside a run (the web's `sends(part)`).
                let folds = Self.rows(first).contains { TimelineTurnShape.isInbound($0) || TimelineTurnFold.isOutbound($0) }
                if !folds {
                    out.append(member(first))
                    return
                }
            }
            let rows = quiet.flatMap(Self.rows)
            out.append(.fold(fold(.turn, first: first, phrase: TimelineFoldSteps.phrase(rows.flatMap(TimelineFoldSteps.steps)),
                                  members: quiet.map { member($0, acks: true) },
                                  failCount: rows.filter(TimelineTurnShape.isFailure).count)))
        }
        func place(_ item: TimelineToolRunFold.Part) {
            if Self.isQuiet(item) { quiet.append(item); return }
            flushQuiet()
            out += defaultParts([item])
        }
        var p = 0
        for turn in turns {
            var mine: [(start: Int, part: TimelineToolRunFold.Part)] = []
            while p < end, parts[p].start < turn.end { mine.append(parts[p]); p += 1 }
            guard !mine.isEmpty else { continue }
            if turn.kind == .hidden { quiet += mine.map(\.part); continue }
            let answer = turn.kind == .answered ? mine.firstIndex(where: { $0.start == turn.answer }) : nil
            guard let answerAt = answer else { mine.forEach { place($0.part) }; continue }
            var ans = answerAt
            // The person's own message always shows.
            let lead = turn.byPerson && mine[0].start == turn.start ? 1 : 0
            if lead == 1 { flushQuiet(); out += defaultParts([mine[0].part]) }
            // The answer's own reasoning (the same message, split into its own row on
            // the phone) stays with the answer when nothing quiet comes before it;
            // after quiet steps it is their last one.
            if ans - 1 == lead, quiet.isEmpty, case .message(let prev) = mine[ans - 1].part, prev.kind == .thinking,
               prev.createdAt == messages[turn.answer].createdAt { ans -= 1 }
            quiet += mine[lead..<ans].map(\.part)
            flushQuiet()
            out += defaultParts(mine[ans...answerAt].map(\.part))
            // After the answer: each row by the one rule (a line the CLI put in, a
            // notice, a call joins the quiet steps that follow; words show).
            mine[(answerAt + 1)...].forEach { place($0.part) }
        }
        if p < end { parts[p..<end].forEach { place($0.part) } }
        // Quiet steps right before the live turn (a hidden turn's narration, which
        // the walk back stops at) open its row, as they will once the turn ends, so
        // the row keeps its key and open state across the turn's end.
        let lead = end < parts.count ? quiet : []
        if !lead.isEmpty { quiet = [] }
        flushQuiet()
        guard end < parts.count else { return (out, nil) }
        let tail = lead + parts[end...].map(\.part)
        let key = fold(.turn, first: tail[0], phrase: "", members: [], failCount: 0).key
        return (out, TimelineTurnFold.LiveTail(key: key, rows: tail.flatMap(Self.rows),
                                               members: tail.map { member($0, acks: true) }))
    }

    /// A quiet row, the web's one rule (`fold-rows.ts`): every step of the work
    /// joins the stretch around it, in every kind of turn: a finished call (a
    /// failed one too: the fold's header counts it, "1 failed"), a message
    /// received or sent, reasoning alone, the no-action line, a line the CLI put
    /// in, a notice the runtime wrote (a turn interrupted). Only a row the person
    /// reads ends a stretch: words, the person's message, a question to them.
    /// 2026-10-30, the user's fourth report: a failed command split one stretch
    /// into three rows. Every `ChatMessage.Kind` is named here
    /// (tests/web/fold-rows.test.ts reads this switch).
    private static func isQuiet(_ part: TimelineToolRunFold.Part) -> Bool {
        switch part {
        case .run(_, let members): return members.allSatisfy(isFinishedStep)
        case .message(let m):
            if TimelineTurnShape.isInbound(m) || TimelineTurnFold.isAckOnly(m) { return true }
            switch m.kind {
            case .tool: return TimelineTurnFold.isOutbound(m) && isFinishedStep(m)
            case .thinking, .injected, .notification: return true
            case nil: return false
            }
        }
    }

    /// A part drawn as itself, not regrouped: what an opened fold holds. The ack
    /// line alone reads "Acknowledged" only inside a fold; anywhere else it has
    /// nothing to draw (its row strips to nothing).
    private func member(_ part: TimelineToolRunFold.Part, acks: Bool = false) -> Part {
        switch part {
        case .run(let key, let members): return .run(key: key, members: members)
        case .message(let m):
            if TimelineTurnShape.isInbound(m) { return .inbound(m) }
            if acks, TimelineTurnFold.isAckOnly(m) { return .ack(m) }
            return .message(m)
        }
    }

    /// A row the person reads, as itself. A person's row draws only the person's
    /// words in its bubble; what Walnut added to it (its notes in front, `added`)
    /// shows only when `additions` says so: each note as its one-line description
    /// above the bubble, the rest as one row under it. Hidden, the bubble carries
    /// the long-press item that shows them (`walnutAddedToggle`).
    private func defaultParts(_ items: [TimelineToolRunFold.Part]) -> [Part] {
        var out: [Part] = []
        for item in items {
            guard case .message(let m) = item, TimelineTurnShape.isPerson(m), m.sentBy != nil else {
                out.append(member(item))
                continue
            }
            let own = TimelineTurnFold.ownText(m)
            let split = TimelineInboundMessage.splitRiders(own)
            let added = m.added ?? []
            let count = (split?.riders.count ?? 0) + added.count
            guard count > 0 else {
                out.append(.message(own == m.text ? m : m.replacingText(own)))
                continue
            }
            let key = addedKey(m)
            let shown = additions.showAll || additions.isRevealed(key)
            var bubble = m.replacingText(split?.body ?? own)
            if !additions.showAll {
                bubble.walnutAddedToggle = WalnutAddedToggle(count: count, shown: shown, key: key)
            }
            if shown {
                out += (split?.riders ?? []).enumerated().map { n, rider in
                    // Named by place: the row's own id hashes its text, which a rich read replaces.
                    Part.inbound(ChatMessage(id: "rider|\(m.createdAt)|\(n)", role: "user", text: rider,
                                             createdAt: m.createdAt, kind: nil))
                }
            }
            out.append(.message(bubble))
            if shown, !added.isEmpty { out.append(.added(key: key, items: added)) }
        }
        return out
    }

    /// A person's message's place, for its reveal and its "Walnut added" row: the
    /// row's own id hashes its text, which a rich read replaces.
    private func addedKey(_ m: ChatMessage) -> String {
        let base = "added|\(TimelineTurnFold.locationKey(m))"
        let n = keyCounts[base, default: 0]
        keyCounts[base] = n + 1
        return "\(base)#\(n)"
    }

    /// Parts that are all received messages: no step and no send to merge them with.
    private static func onlyReceived(_ parts: [TimelineToolRunFold.Part]) -> Bool {
        !parts.isEmpty && parts.allSatisfy {
            if case .message(let m) = $0 { return TimelineTurnShape.isInbound(m) }
            return false
        }
    }

    /// A step a quiet row may fold: anything but a question to the person
    /// (`toolRole` on the web). A failed call is a step; its fold says "N failed".
    private static func isFinishedStep(_ m: ChatMessage) -> Bool {
        guard m.kind == .tool else { return true }
        return m.text != "AskUserQuestion"
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
        copy.added = added
        copy.textWithoutContext = textWithoutContext
        copy.injectedAfter = injectedAfter
        copy.injectedBefore = injectedBefore
        copy.walnutAddedToggle = walnutAddedToggle
        return copy
    }
}
