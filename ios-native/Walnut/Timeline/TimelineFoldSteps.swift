import Foundation

/// The line a fold of quiet steps reads: counts only, "Received 12 messages · Sent 2
/// · Ran 8 tools". Port of the web console's `fold-steps.ts`; the two must read the
/// same. Who sent each one and where it went are in the opened fold (2026-10-31, the
/// user: "just Received 1 message").
///
/// Every stretch of quiet steps between two things the person reads (messages
/// received and sent, finished tool calls, reasoning alone, the no-action line,
/// whole turns that needed nothing) is one folded row. Its line counts what came
/// in, what went out and what ran; the opened fold shows each step. 2026-10-28,
/// the user, of a line that named every sender, notice and command and ran past
/// the screen: show how many were received, sent and run, nothing more.
enum TimelineFoldSteps {
    enum Step: Equatable {
        /// A message, notice, reply or trigger the session received (the web's
        /// `envelopeSteps`). No sender: the line names no one, and a notice's `about`
        /// is its subject, not its sender (2026-10-31: Main's fold read "from CEO").
        case received
        /// Tool calls (not messages to someone), one per call.
        case calls(Int)
        /// A message to another task, one per target; `to`: its task's title when the
        /// server resolved it (`sentTo`).
        case sent(to: String?)
        /// A letter to the person's inbox.
        case inbox
        case thought
        /// A line the CLI put in (`TimelineInjectedLines`): a loaded skill's text or
        /// other context. Counted by nothing, as on the web: the line says what the
        /// steps did, and the opened fold shows the line by its label.
        case context(skill: Bool)
        case ack
        case update
        /// A line the runtime wrote (a turn interrupted, an error). An error one is
        /// counted by the fold's red "N failed", not on its line.
        case notice(error: Bool)
    }

    /// A row's steps.
    static func steps(_ m: ChatMessage) -> [Step] {
        if TimelineTurnShape.isInbound(m) { return received(m.text) }
        switch m.kind {
        case .tool:
            if TimelineTurnFold.isOutbound(m) {
                if m.text.range(of: #"__human_inbox_(send|reply)$"#, options: .regularExpression) != nil { return [.inbox] }
                guard let targets = m.sentTo, !targets.isEmpty else { return [.sent(to: nil)] }
                return targets.map { .sent(to: $0.title) }
            }
            return [.calls(1)]
        case .thinking:
            return [.thought]
        case .injected:
            return [.context(skill: m.source == "skill")]
        case .notification:
            return [.notice(error: TimelineTurnShape.isFailure(m))]
        case nil where !m.isUser:
            let reading = TimelineTurnMarker.read(m.text)
            if !reading.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [.update] }
            return reading.ack ? [.ack] : []
        default:
            return []
        }
    }

    /// What a received row holds: one message per envelope, and a row with none
    /// is one message from no one in particular.
    static func received(_ text: String) -> [Step] {
        let envelopes = TimelineInboundMessage.parse(text)?.envelopes ?? []
        return Array(repeating: .received, count: max(envelopes.count, 1))
    }

    /// A name as a send's chip and the opened drawer show it: a title's own " · " would
    /// read as the line's separator, so it shows as " / ".
    static func partyName(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"\s+·\s+"#, with: " / ", options: .regularExpression)
    }

    /// The fold's line. A stretch with none of the three counts reads by what it
    /// was: an update, a runtime notice, an acknowledgement, or "Thinking", the old empty-fold line
    /// (also a stretch of CLI lines alone, the web's `foldStepsPhrase` word for word).
    static func phrase(_ steps: [Step]) -> String {
        var received = 0, sent = 0, tools = 0, updates = 0, acks = 0, notices = 0, errorNotices = 0
        for step in steps {
            switch step {
            case .received: received += 1
            case .sent, .inbox: sent += 1
            case .calls(let n): tools += n
            case .update: updates += 1
            case .ack: acks += 1
            case .notice(let error): if error { errorNotices += 1 } else { notices += 1 }
            case .thought, .context: break
            }
        }
        var pieces: [String] = []
        if received > 0 { pieces.append("Received \(received) \(received == 1 ? "message" : "messages")") }
        if sent > 0 { pieces.append("Sent \(sent)") }
        if tools > 0 { pieces.append("Ran \(tools) \(tools == 1 ? "tool" : "tools")") }
        if notices > 0 { pieces.append(notices == 1 ? "1 notice" : "\(notices) notices") }
        if !pieces.isEmpty { return pieces.joined(separator: " \u{00B7} ") }
        if updates > 0 { return updates == 1 ? "An update" : "\(updates) updates" }
        if errorNotices > 0 { return errorNotices == 1 ? "1 notice" : "\(errorNotices) notices" }
        return acks > 0 ? "Acknowledged" : "Thinking"
    }

    /// The line as drawn and measured: a count never parts from its noun at a
    /// large text size ("Sent / 1" read as two things at AX-XXXL); the line may
    /// still wrap between "Received" and its count, and after each " · ", never
    /// before it (2026-10-30, the iOS gate: a wrapped line began "· Ran 50 tools").
    static func wrapping(_ phrase: String) -> String {
        phrase
            .replacingOccurrences(of: " \u{00B7} ", with: "\u{00A0}\u{00B7} ")
            .replacingOccurrences(of: #"(\d+) (messages?|tools?)\b"#, with: "$1\u{00A0}$2", options: .regularExpression)
            .replacingOccurrences(of: #"\b(Sent|Ran) (\d+)"#, with: "$1\u{00A0}$2", options: .regularExpression)
    }
}
