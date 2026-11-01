import Foundation

/// Which tasks a reply in Main's, a VP's or a lead's chat is about. Port of the
/// server's `src/core/org/message-about.ts` (`readAboutTag`, `stripAboutTag`,
/// `aboutIds`), case for case; `MessageAboutTagTests` mirrors
/// `tests/core/org/message-about.test.ts`.
///
/// The node's session ends its reply with one line of its own,
/// `<walnut-about tasks="<id>,<id>"/>`. The server's history parse takes the line
/// off the row's text and puts the ids on the row (`ChatMessage.about`); the
/// timeline draws them under the reply as live task pills. A reply still
/// streaming has not been through that parse, so the timeline hides the line
/// itself, and while it streams in also holds back a last line that is so far
/// only the start of the tag, so it never flashes up.
///
/// The line counts only as a line of its own outside a code fence, among the
/// message's last three non-blank lines (before or after the agent-ack line); a
/// quote of it inside a sentence or a code block stays text.
enum MessageAboutTag {
    static let name = "walnut-about"
    /// How many ids one message may name: more is a list, not what it is about.
    static let max = 6

    struct Reading: Equatable {
        /// The text without the tag line.
        let text: String
        /// The ids it named (empty: no tag, or one naming none).
        let ids: [String]
        /// The message carried the tag.
        let tagged: Bool
    }

    // `\z`, not `$`: ICU's `$` also matches before a final line break, so "```\r" (a
    // CRLF line) would open a fence the server's JS regex does not see.
    // swiftlint:disable force_try
    private static let line = try! NSRegularExpression(pattern: #"^\s{0,3}<walnut-about\s+tasks="([^"]*)"\s*/>\s*\z"#)
    private static let fence = try! NSRegularExpression(pattern: #"^\s{0,3}(`{3,}|~{3,})(.*)\z"#)
    private static let idShape = try! NSRegularExpression(pattern: #"^[A-Za-z0-9][A-Za-z0-9_.:-]{2,80}\z"#)
    private static let idSeparator = try! NSRegularExpression(pattern: #"[\s,]+"#)
    // swiftlint:enable force_try

    /// The ids a tag lists: comma or space separated, each a task id's characters, in order, once.
    static func ids(_ list: String) -> [String] {
        let ns = list as NSString
        var parts: [String] = []
        var from = 0
        for m in idSeparator.matches(in: list, range: NSRange(location: 0, length: ns.length)) {
            parts.append(ns.substring(with: NSRange(location: from, length: m.range.location - from)))
            from = m.range.location + m.range.length
        }
        parts.append(ns.substring(from: from))
        var out: [String] = []
        for raw in parts {
            let id = trimmed(raw)
            if !id.isEmpty, matches(idShape, id), !out.contains(id) { out.append(id) }
        }
        return Array(out.prefix(max))
    }

    /// Read the tag off a message's text. Only within its last three non-blank lines.
    static func read(_ text: String?) -> Reading {
        let src = text ?? ""
        guard src.contains("<\(name)") else { return Reading(text: src, ids: [], tagged: false) }
        // Foundation splits on "\n" alone, as the server's `split('\n')` cuts.
        let lines = src.components(separatedBy: "\n")
        let outside = outsideFence(lines)
        var seen = 0
        var i = lines.count - 1
        while i >= 0, seen < 3 {
            defer { i -= 1 }
            if trimmed(lines[i]).isEmpty { continue }
            seen += 1
            guard outside[i], let list = capture(line, lines[i]) else { continue }
            var rest = lines
            rest.remove(at: i)
            let joined = rest.joined(separator: "\n")
            return Reading(text: String(joined.reversed().drop(while: \.isWhitespace).reversed()),
                           ids: ids(list), tagged: true)
        }
        return Reading(text: src, ids: [], tagged: false)
    }

    /// The text as the screen shows it: never the tag line. While a message still
    /// streams, a last line that is so far only the start of the tag is held back too.
    static func strip(_ text: String, streaming: Bool = false) -> String {
        let reading = read(text)
        if reading.tagged { return reading.text }
        guard streaming else { return text }
        // In UTF-16, as the server cuts: a Swift "\r\n" is one Character, which
        // `lastIndex(of: "\n")` would never find.
        let ns = text as NSString
        let cut = ns.range(of: "\n", options: .backwards).location
        let tail = trimmed(cut == NSNotFound ? text : ns.substring(from: cut + 1))
        let head = "<\(name)"
        guard tail.utf16.count >= 2, head.hasPrefix(tail) || tail.hasPrefix(head) else { return text }
        return cut == NSNotFound ? "" : ns.substring(to: cut)
    }

    /// The ids a row is about: the server's, else its own line's (a row still fresh).
    static func rowAbout(_ about: [String]?, text: String) -> [String] {
        if let about, !about.isEmpty { return Array(about.prefix(max)) }
        return read(text).ids
    }

    /// The lines outside any code fence (true), in order. ``` and ~~~ close only
    /// themselves, and a closing fence carries nothing after it.
    private static func outsideFence(_ lines: [String]) -> [Bool] {
        var out: [Bool] = []
        var open: String?
        for line in lines {
            let ns = line as NSString
            if let m = fence.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) {
                let mark = ns.substring(with: m.range(at: 1))
                let rest = ns.substring(with: m.range(at: 2))
                if let current = open {
                    if mark.first == current.first, mark.count >= current.count, trimmed(rest).isEmpty { open = nil }
                } else {
                    open = mark
                }
                out.append(false)
                continue
            }
            out.append(open == nil)
        }
        return out
    }

    private static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    private static func capture(_ re: NSRegularExpression, _ s: String) -> String? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: m.range(at: 1))
    }
}
