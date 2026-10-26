import Foundation

/// A message the session RECEIVED (a peer's note, a reply, Walnut's notice, a
/// trigger), read just far enough to draw it as what it is: a received card,
/// never the user's bubble, never raw XML.
///
/// The current wire format is one tag per delivered message:
///
///     <walnut-message kind="peer-note" from="Title [8hex]" title="…" …>
///     BODY
///     </walnut-message>
///
/// Attribute values are XML-escaped and a body can never hold an open or close tag
/// (the server escapes them), so "from the open tag to the FIRST
/// `\n</walnut-message>`" is the body. The web console's parser
/// (`lib/history-session-envelope.ts`) also reads four legacy prose shapes; the
/// phone does not need to: WHO sent a row is the server's word (`sentBy`), and a
/// row this reader cannot take apart is shown as its text, inside a fold.
enum TimelineInboundMessage {
    struct Envelope: Equatable {
        let attributes: [String: String]
        let body: String
    }

    private static let head = "<walnut-message "
    private static let close = "\n</walnut-message>"

    /// The envelopes a stored row holds, top-down, and whatever text follows them
    /// (a "Reply when done: …" line). nil when the row does not open with one.
    static func parse(_ text: String) -> (envelopes: [Envelope], rest: String)? {
        var envelopes: [Envelope] = []
        var pos = text.startIndex
        while text[pos...].hasPrefix(head) {
            guard let one = envelope(in: text, at: pos) else { break }
            envelopes.append(one.envelope)
            pos = one.end
            while pos < text.endIndex, text[pos].isWhitespace { pos = text.index(after: pos) }
        }
        guard !envelopes.isEmpty else { return nil }
        return (envelopes, String(text[pos...]))
    }

    /// One complete tag starting at `pos`: its attributes, its body, where it ends.
    private static func envelope(in text: String, at pos: String.Index) -> (envelope: Envelope, end: String.Index)? {
        guard let headEnd = text[pos...].firstIndex(of: "\n") else { return nil }
        let headLine = text[pos..<headEnd]
        guard headLine.hasSuffix(">"),
              let closeRange = text.range(of: close, range: headEnd..<text.endIndex) else { return nil }
        // An empty body puts the close right at the head's own newline.
        let bodyStart = text.index(after: headEnd)
        let body = bodyStart <= closeRange.lowerBound ? text[bodyStart..<closeRange.lowerBound] : ""[...]
        // A tag inside means this one never closed and the close belongs to a later one.
        guard !body.contains("\n<walnut-message") else { return nil }
        return (Envelope(attributes: attributes(String(headLine)), body: String(body)), closeRange.upperBound)
    }

    /// `name="value"`, first occurrence wins, values unescaped.
    static func attributes(_ head: String) -> [String: String] {
        var out: [String: String] = [:]
        let ns = head as NSString
        for match in attributePattern?.matches(in: head, range: NSRange(location: 0, length: ns.length)) ?? [] {
            let name = ns.substring(with: match.range(at: 1))
            if out[name] == nil { out[name] = unescape(ns.substring(with: match.range(at: 2))) }
        }
        return out
    }

    private static let attributePattern = try? NSRegularExpression(pattern: #"([a-z][a-z0-9-]*)="([^"]*)""#)

    private static func unescape(_ s: String) -> String {
        s.replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    /// Who it is from, as a reader names it: the sender's title without the short
    /// id Walnut appends ("Docs lead [1a2b3c4d]" → "Docs lead").
    static func sender(_ envelope: Envelope) -> String {
        let from = (envelope.attributes["from"] ?? "").trimmingCharacters(in: .whitespaces)
        if from.isEmpty { return envelope.attributes["kind"] == "trigger" ? "a trigger" : "Walnut" }
        if let open = from.lastIndex(of: "["), from.hasSuffix("]"), open > from.startIndex {
            return from[..<open].trimmingCharacters(in: .whitespaces)
        }
        return from
    }

    /// The card's text for one received row: who it is from, its one-line title
    /// when the sender gave one, then its body. A row this reader cannot take
    /// apart is shown as it is.
    static func displayText(_ text: String) -> String {
        guard let parsed = parse(text) else {
            // A row clipped before its close tag (the slim tail cuts long ones): the
            // head line still reads as who it is from, never as markup.
            guard text.hasPrefix(head), let headEnd = text.firstIndex(of: "\n"),
                  text[..<headEnd].hasSuffix(">") else { return text }
            let attributes = attributes(String(text[..<headEnd]))
            return block(Envelope(attributes: attributes, body: String(text[text.index(after: headEnd)...])))
        }
        var blocks = parsed.envelopes.map(block)
        let rest = parsed.rest.trimmingCharacters(in: .whitespacesAndNewlines)
        if !rest.isEmpty { blocks.append(rest) }
        return blocks.joined(separator: "\n\n")
    }

    private static func block(_ envelope: Envelope) -> String {
        var heading = "**From \(sender(envelope))**"
        if let title = envelope.attributes["title"], !title.isEmpty { heading += ": \(title)" }
        else if let note = envelope.attributes["note"], !note.isEmpty { heading += ": \(note)" }
        let body = envelope.body.trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty ? heading : "\(heading)\n\n\(body)"
    }

    /// The card a received row draws as, inside a fold: a notification card under
    /// the row's own id (so its expansion is remembered like any card's).
    static func card(_ message: ChatMessage) -> ChatMessage {
        ChatMessage(id: message.id, role: message.role, text: displayText(message.text),
                    createdAt: message.createdAt, kind: .notification, source: inboundSource)
    }

    /// `ChatMessage.source` of a received card (see `NotificationStyling`).
    static let inboundSource = "inbound"

    // MARK: - Riders

    /// The notes Walnut puts IN FRONT OF a message in the same stored row (its
    /// task moved, the org changed, the routing rules, an App's state), so that a
    /// person's words arrive behind them. Port of `splitLeadingRiders`
    /// (`lib/history-walnut-riders.ts`): a CLOSED list, each rider a complete tag
    /// followed by exactly one blank line, and a non-blank body after them, or no
    /// split at all.
    static func splitRiders(_ text: String) -> (riders: [String], body: String)? {
        guard text.hasPrefix(head) else { return nil }
        var riders: [String] = []
        var pos = text.startIndex
        while text[pos...].hasPrefix(head) {
            guard let one = envelope(in: text, at: pos), isRider(one.envelope.attributes),
                  text[one.end...].hasPrefix("\n\n") else { break }
            riders.append(String(text[pos..<one.end]))
            pos = text.index(one.end, offsetBy: 2)
        }
        let body = String(text[pos...])
        guard !riders.isEmpty, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return (riders, body)
    }

    private static let riderOutcomes: Set<String> = ["moved", "org-update", "task-routing-policy"]

    private static func isRider(_ attributes: [String: String]) -> Bool {
        if attributes["kind"] == "app-state" { return true }
        return attributes["kind"] == "notification" && attributes["from"] == "Walnut"
            && riderOutcomes.contains(attributes["outcome"] ?? "")
    }
}
