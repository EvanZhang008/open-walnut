import Foundation

/// The line a fold of quiet steps reads: counts only, "Received 12 messages ·
/// Sent 3 · Ran 8 tools". Port of the web console's `fold-steps.ts`; the two must
/// read the same.
///
/// Every stretch of quiet steps between two things the person reads (messages
/// received and sent, finished tool calls, reasoning alone, the no-action line,
/// whole turns that needed nothing) is one folded row. Its line counts what came
/// in, what went out and what ran; the opened fold shows each step. 2026-10-28,
/// the user, of a line that named every sender, notice and command and ran past
/// the screen: show how many were received, sent and run, nothing more.
enum TimelineFoldSteps {
    enum Step: Equatable {
        /// A message, notice, reply or trigger the session received.
        case received
        /// Tool calls (not messages to someone), one per call.
        case calls(Int)
        case sent
        /// A letter to the person's inbox.
        case inbox
        case thought
        /// A line the CLI put in (`TimelineInjectedLines`): a loaded skill's text or
        /// other context. Counted by nothing, as on the web: the line says what the
        /// steps did, and the opened fold shows the line by its label.
        case context(skill: Bool)
        case ack
        case update
    }

    /// A row's steps.
    static func steps(_ m: ChatMessage) -> [Step] {
        if TimelineTurnShape.isInbound(m) { return received(m.text) }
        switch m.kind {
        case .tool:
            if TimelineTurnFold.isOutbound(m) {
                return m.text.range(of: #"__human_inbox_(send|reply)$"#, options: .regularExpression) != nil ? [.inbox] : [.sent]
            }
            return [.calls(1)]
        case .thinking:
            return [.thought]
        case .injected:
            return [.context(skill: m.source == "skill")]
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
        let count = TimelineInboundMessage.parse(text)?.envelopes.count ?? 0
        return Array(repeating: .received, count: max(1, count))
    }

    /// The fold's line. A stretch with none of the three counts reads by what it
    /// was: an update, an acknowledgement, or "Thinking", the old empty-fold line
    /// (also a stretch of CLI lines alone, the web's `foldStepsPhrase` word for word).
    static func phrase(_ steps: [Step]) -> String {
        var received = 0, sent = 0, tools = 0, updates = 0, acks = 0
        for step in steps {
            switch step {
            case .received: received += 1
            case .sent, .inbox: sent += 1
            case .calls(let n): tools += n
            case .update: updates += 1
            case .ack: acks += 1
            case .thought, .context: break
            }
        }
        var pieces: [String] = []
        if received > 0 { pieces.append("Received \(received) \(received == 1 ? "message" : "messages")") }
        if sent > 0 { pieces.append("Sent \(sent)") }
        if tools > 0 { pieces.append("Ran \(tools) \(tools == 1 ? "tool" : "tools")") }
        if !pieces.isEmpty { return pieces.joined(separator: " \u{00B7} ") }
        if updates > 0 { return updates == 1 ? "An update" : "\(updates) updates" }
        return acks > 0 ? "Acknowledged" : "Thinking"
    }

    /// The line as drawn and measured: a count never parts from its noun at a
    /// large text size ("Sent / 1" read as two things at AX-XXXL); the line may
    /// still wrap between "Received" and its count, and at each " · ".
    static func wrapping(_ phrase: String) -> String {
        phrase
            .replacingOccurrences(of: #"(\d+) (messages?|tools?)\b"#, with: "$1\u{00A0}$2", options: .regularExpression)
            .replacingOccurrences(of: #"\b(Sent|Ran) (\d+)"#, with: "$1\u{00A0}$2", options: .regularExpression)
    }
}
