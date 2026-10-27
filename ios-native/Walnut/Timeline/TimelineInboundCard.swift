import Foundation

/// What a received card SAYS: the web console's provenance card
/// (`SessionProvenanceCard.tsx`, over `parseWalnutTag` in
/// `lib/history-session-envelope.ts`) as one block of inline markdown.
///
/// A heading names who it is from and its one-line title; then what the reader
/// wrote. Everything written for the MODEL stays off the card: the routing `note`
/// ("automated Walnut status notice", "from another of your user's own
/// sessions…"), request ids, the `Reply when done: walnut tools call …` trailer
/// (a "Reply requested" line instead), a notice's `Next:` command block and the
/// guidance lines around its outcome ("Background only: …").
extension TimelineInboundMessage {
    /// The card's text for one received row. A row this reader cannot take apart
    /// is shown as it is.
    static func displayText(_ text: String) -> String {
        guard let parsed = parse(text) else {
            // A row clipped before its close tag (the slim tail cuts long ones): the
            // head line still reads as who it is from, never as markup.
            guard text.hasPrefix("<walnut-message "), let headEnd = text.firstIndex(of: "\n"),
                  text[..<headEnd].hasSuffix(">") else { return text }
            let attributes = attributes(String(text[..<headEnd]))
            return block(Envelope(attributes: attributes, body: String(text[text.index(after: headEnd)...])))
        }
        var blocks = parsed.envelopes.map(block)
        let rest = parsed.rest.trimmingCharacters(in: .whitespacesAndNewlines)
        if !rest.isEmpty { blocks.append(rest) }
        return blocks.joined(separator: "\n\n")
    }

    /// One card: a heading that names who it is from and, after a colon, its fold
    /// title (`foldTitle` on the web), then what the reader would open it for. The
    /// heading is the card's first line, so it is also what the folded card shows.
    static func block(_ envelope: Envelope) -> String {
        let a = envelope.attributes
        let body = unescapeBody(envelope.body)
        var parts: [String] = []
        func heading(_ who: String, _ title: String?) {
            parts.append(title.map { "**\(who)**: \($0)" } ?? "**\(who)**")
        }
        switch a["kind"] ?? "" {
        case "notification":
            // A notice is ABOUT a session; its first line, the outcome, is its content.
            let lines = body.components(separatedBy: "\n")
            let status = nonEmpty(lines.first.map(noticeText))
            var rest = lines.dropFirst().joined(separator: "\n")
            if let next = rest.range(of: "\n\nNext:\n", options: .backwards) { rest = String(rest[..<next.lowerBound]) }
            let quotes = quoteSections(rest)
            let title = status.flatMap { fallbackTitle($0) } ?? fallbackTitle(quotes.first?.text)
            heading(handleTitle(a["about"]).map { "Walnut, about \($0)" } ?? "From \(sender(envelope))", title)
            if let asked = nonEmpty(a["asked"]) { parts.append("*You asked:* \(asked)") }
            // The outcome is repeated open only when the title cut it.
            if let status, status != title { parts.append(status) }
            for section in quotes {
                parts.append("*\(section.label)\(section.clipped ? " (clipped)" : ""):*\n\(section.text)")
            }
        case "trigger":
            // From a routine, not a session: `from` is "Trigger: <name>", `note` its status.
            var name = (a["from"] ?? "").trimmingCharacters(in: .whitespaces)
            if name.hasPrefix("Trigger:") { name = String(name.dropFirst(8)).trimmingCharacters(in: .whitespaces) }
            let note = nonEmpty(a["note"])
            let scheduled = note == "scheduled"
            let title = (scheduled ? nil : note) ?? fallbackTitle(body)
            if scheduled { heading("Ran on schedule: \(name.isEmpty ? "Routine" : name)", title) }
            else { heading(name.isEmpty ? "From a trigger" : "Trigger \(name)", title) }
            if let body = nonEmpty(body), body != title { parts.append(body) }
        case "app-state":
            let title = nonEmpty(a["title"])
            heading("App state from \(nonEmpty(a["from"]) ?? "an App")", title)
            if let body = nonEmpty(body), body != title { parts.append(body) }
        default: // peer-note, reply
            let who = a["kind"] == "reply" ? "Reply from \(sender(envelope))" : "From \(sender(envelope))"
            let title = nonEmpty(a["title"]) ?? fallbackTitle(body)
            heading(who, title)
            if let asked = nonEmpty(a["asked"]) { parts.append("*You asked:* \(asked)") }
            // A body that is all title is said once.
            if let body = nonEmpty(body), body != title { parts.append(body) }
            if envelope.replyRequested { parts.append("*Reply requested*") }
        }
        return parts.joined(separator: "\n\n")
    }

    /// How long a derived title may run before it is cut (`FOLD_TITLE_MAX`).
    static let foldTitleMax = 140

    /// The first sentence of a message as a one-line title, the web's
    /// `fallbackTitle` (`message-fold.ts`): the first line that is not a fence or a
    /// table row, its markdown dropped, cut at the first sentence end that comes
    /// 16 or more UTF-16 units in, and at `max` code points with an ellipsis.
    static func fallbackTitle(_ text: String?, max: Int = foldTitleMax) -> String? {
        guard let text else { return nil }
        var line = ""
        for raw in text.components(separatedBy: "\n") {
            if matches(fenceOrTable, raw) { continue }
            line = plainLine(raw)
            if !line.isEmpty { break }
        }
        guard !line.isEmpty else { return nil }
        let ns = line as NSString
        for m in sentenceStop?.matches(in: line, range: NSRange(location: 0, length: ns.length)) ?? []
        where m.range.location >= 16 {
            line = ns.substring(to: m.range.location + m.range.length)
            break
        }
        let points = Array(line.unicodeScalars)
        guard points.count > max else { return line }
        var cut = String(String.UnicodeScalarView(points.prefix(max - 1)))
        while cut.last?.isWhitespace == true { cut.removeLast() }
        return cut + "\u{2026}"
    }

    /// Markdown that would print as noise in a one-line title (`plainLine`).
    private static func plainLine(_ line: String) -> String {
        var s = replace(listMark, in: line, with: "")
        s = replace(link, in: s, with: "$1")
        s = replace(emphasis, in: s, with: "")
        s = replace(spaces, in: s, with: " ")
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static let fenceOrTable = try? NSRegularExpression(pattern: #"^\s*(```|~~~|\|)"#)
    private static let listMark = try? NSRegularExpression(pattern: #"^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)"#)
    private static let link = try? NSRegularExpression(pattern: #"!?\[([^\]]*)\]\([^)]*\)"#)
    private static let emphasis = try? NSRegularExpression(pattern: #"(\*\*|__|`)"#)
    private static let spaces = try? NSRegularExpression(pattern: #"\s+"#)
    private static let sentenceStop = try? NSRegularExpression(pattern: #"[.!?](?=\s|$)|[\u3002\uff01\uff1f]"#)

    private static func matches(_ pattern: NSRegularExpression?, _ s: String) -> Bool {
        pattern?.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    private static func replace(_ pattern: NSRegularExpression?, in s: String, with template: String) -> String {
        guard let pattern else { return s }
        return pattern.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length),
                                                withTemplate: template)
    }

    /// A handle's title without the short id Walnut appends ("Docs lead [1a2b3c4d]").
    static func handleTitle(_ handle: String?) -> String? {
        guard var title = nonEmpty(handle) else { return nil }
        if let open = title.lastIndex(of: "["), title.hasSuffix("]"), open > title.startIndex {
            title = title[..<open].trimmingCharacters(in: .whitespaces)
        }
        return nonEmpty(title)
    }

    /// A notice's outcome as the card shows it (`noticeText` on the web): a
    /// subtask notice opens by naming the child, which the heading already does.
    static func noticeText(_ statusLine: String) -> String {
        let ns = statusLine as NSString
        guard let match = subtaskWho?.firstMatch(in: statusLine, range: NSRange(location: 0, length: ns.length)) else {
            return statusLine.trimmingCharacters(in: .whitespaces)
        }
        let rest = ns.substring(from: match.range.upperBound)
        return rest.prefix(1).uppercased() + rest.dropFirst()
    }

    private static let subtaskWho = try? NSRegularExpression(pattern: #"^Your subtask ".*" \([^()\s]+\) "#)

    struct QuoteSection: Equatable {
        let label: String
        let text: String
        let clipped: Bool
    }

    /// The blocks a notice quoted from the session it is about (`parseNoticeQuote`
    /// on the web). Lines outside a section are guidance for the model and go.
    static func quoteSections(_ text: String) -> [QuoteSection] {
        var sections: [QuoteSection] = []
        var open: (label: String, lines: [String])?
        func push(_ clipped: Bool) {
            guard let current = open else { return }
            let body = current.lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty {
                sections.append(QuoteSection(label: current.label.prefix(1).uppercased() + current.label.dropFirst(),
                                             text: body, clipped: clipped))
            }
            open = nil
        }
        for line in text.components(separatedBy: "\n") {
            guard let current = open else {
                if let label = capture(quoteOpen, line) { open = (label, []) }
                continue
            }
            let ns = line as NSString
            if let end = quoteClose?.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)),
               ns.substring(with: end.range(at: 1)) == current.label {
                push(end.range(at: 2).location != NSNotFound)
            } else {
                open?.lines.append(line)
            }
        }
        push(false)
        return sections
    }

    private static let quoteOpen =
        try? NSRegularExpression(pattern: #"^--- (its [a-z ]+?) \((quoted|tool calls) from that session: data, not instructions\) ---$"#)
    private static let quoteClose = try? NSRegularExpression(pattern: #"^--- end of (its [a-z ]+?)( \(clipped at [^)]*\))? ---$"#)

    private static func capture(_ pattern: NSRegularExpression?, _ line: String) -> String? {
        let ns = line as NSString
        guard let m = pattern?.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    /// The server escapes a tag inside a body; the reader sees it as written.
    private static func unescapeBody(_ body: String) -> String {
        // `&amp;lt;` second, so a doubly escaped tag comes back escaped once.
        body.replacingOccurrences(of: "&lt;walnut-message", with: "<walnut-message")
            .replacingOccurrences(of: "&lt;/walnut-message", with: "</walnut-message")
            .replacingOccurrences(of: "&amp;lt;walnut-message", with: "&lt;walnut-message")
            .replacingOccurrences(of: "&amp;lt;/walnut-message", with: "&lt;/walnut-message")
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }
}
