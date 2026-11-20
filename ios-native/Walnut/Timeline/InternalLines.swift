import Foundation

/// Lines of Walnut's own formats that a reply never shows. Port of the server's
/// `src/lib/internal-lines.ts` (`stripInternalLines`), case for case: both run the
/// cases in `tests/fixtures/internal-lines/cases.json` (`InternalLinesTests` here,
/// `tests/lib/internal-lines.test.ts` there), so the two never drift apart.
///
/// Walnut asks a session for its status report in a side question of its own
/// (FOR_USER_STATE, FOR_USER_NOW, FOR_USER_ASK, ...), and until 2026-11-19 put a
/// version tag in front of every line of a rule block ("[v16908844] "). Models copy
/// both into their replies (2026-11-20, the user: "why it show?"). The server's
/// history parse leaves them out of every saved row; a reply still streaming has not
/// been through it, so the timeline drops them itself (`TimelineTurnMarker.stripLive`).
///
/// Only the report at the END of the text goes (field lines, the lines that carry a
/// value on, blank lines; Walnut's own `<walnut-` tag lines stay), and a version tag
/// at the start of a line is cut off. Outside code blocks only; a field line with
/// the session's words after it, a mention in a sentence and a text that opens with
/// the report (the answer to Walnut's own question) stay as written.
enum InternalLines {
    // `\z`, not `$`: ICU's `$` also matches before a final line break.
    // swiftlint:disable force_try
    /// A line of the report: a FOR_USER_ field name (any, "FOR_USER_THREAD t1:" too),
    /// optionally bold, then a colon (a full-width one too), or the bare name alone.
    private static let field = try! NSRegularExpression(
        pattern: #"^\s{0,3}(?:\*\*)?FOR_USER_[A-Z][A-Z0-9_]*(?:\*\*)?(?:(?:\s+[^\s:\x{FF1A}]{1,40})?\s*(?:\*\*)?[:\x{FF1A}]|\s*\z)"#)
    private static let versionTag = try! NSRegularExpression(pattern: #"^(\s{0,3})\[v[0-9a-f]{8}\]\s+"#)
    private static let walnutTag = try! NSRegularExpression(pattern: #"^\s{0,3}</?walnut-"#)
    private static let continuation = try! NSRegularExpression(pattern: #"^(?:\s+\S|\s{0,3}(?:[-*+]|\d+[.)])\s)"#)
    /// While a reply streams in, a last line that is so far only the start of a field name.
    private static let fieldStart = try! NSRegularExpression(
        pattern: #"^\s{0,3}(?:\*\*)?F(?:O(?:R(?:_(?:U(?:S(?:E(?:R(?:_[A-Z0-9_]*)?)?)?)?)?)?)?)?\z"#)
    private static let fence = try! NSRegularExpression(pattern: #"^\s{0,3}(`{3,}|~{3,})(.*)\z"#)
    private static let indentedCode = try! NSRegularExpression(pattern: #"^(?: {4}|\t)"#)
    private static let brief = try! NSRegularExpression(pattern: #"FOR_USER_BRIEF\b"#)
    private static let streamingTail = try! NSRegularExpression(pattern: #"F\S*\z"#)
    private static let trailingSpace = try! NSRegularExpression(pattern: #"\s+\z"#)
    // swiftlint:enable force_try

    /// The text without Walnut's internal lines. `streaming`: a last line that is only
    /// the start of a field name is held back, so it never flashes up.
    static func strip(_ text: String, streaming: Bool = false) -> String {
        guard text.contains("FOR_USER_") || text.contains("[v") || (streaming && test(streamingTail, text)) else { return text }
        // Foundation splits on "\n" alone, as the server's `split('\n')` cuts.
        let lines = text.components(separatedBy: "\n")
        let bare = { (l: String) -> String in l.hasSuffix("\r") ? String(l.dropLast()) : l }
        var code: [Bool] = []
        var open: String?
        var out: [String] = []
        for raw in lines {
            let line = bare(raw)
            if case let (mark, rest)? = fenceParts(line) {
                if open == nil { open = mark } else if let current = open, mark.first == current.first,
                    mark.utf16.count >= current.utf16.count, trimmed(rest).isEmpty { open = nil }
                code.append(true)
                out.append(raw)
                continue
            }
            let isCode = open != nil || test(indentedCode, line)
            code.append(isCode)
            out.append(isCode ? raw : replaceFirst(versionTag, in: raw, with: "$1"))
        }
        let isField = { (i: Int) -> Bool in !code[i] && test(field, bare(out[i])) }
        let first = out.firstIndex { !trimmed(bare($0)).isEmpty } ?? -1
        // A text that opens with the report: the answer to Walnut's own question, left whole.
        if first >= 0, isField(first) { return out.joined(separator: "\n") }
        // The report's start: the earliest field line from which, to the end, nothing but the report follows.
        var start = -1
        var i = out.count - 1
        while i > first {
            defer { i -= 1 }
            let line = bare(out[i])
            if trimmed(line).isEmpty || test(walnutTag, line) { continue }
            if isField(i) { start = i; continue }
            // While it streams in, the next field's name as far as it has come ("F", "FOR"): part of the report.
            // So is a tag line of Walnut's as far as it has come ("<walnut-ab"): it stays out until whole.
            if streaming, i == out.count - 1, !code[i], test(fieldStart, line) || isTagStart(line) { continue }
            // A value carried on, indented four spaces deep too (that is not code inside the report).
            if (!code[i] || test(indentedCode, line)) && test(continuation, line) { continue }
            break
        }
        // From the Brief's field on, everything is the Brief, whatever came after it.
        if let briefAt = out.indices.first(where: { $0 > first && isField($0) && test(brief, bare(out[$0])) }),
           briefAt > first, start < 0 || briefAt < start {
            start = briefAt
        }
        var kept = start < 0 ? out : Array(out[..<start]) + out[start...].filter { test(walnutTag, bare($0)) }
        if streaming, kept.count > 1, let last = kept.last, test(fieldStart, bare(last)),
           trimmed(last).utf16.count >= 4 {
            kept.removeLast()
        }
        let joined = kept.joined(separator: "\n")
        return joined == text ? text : replaceFirst(trailingSpace, in: joined, with: "")
    }

    /// While a reply streams in, a last line that is so far only the start of one of Walnut's tag lines.
    private static func isTagStart(_ line: String) -> Bool {
        let t = trimmed(line)
        return !t.isEmpty && t.utf16.count < 8 && "<walnut-".hasPrefix(t)
    }

    /// `^\s{0,3}(`{3,}|~{3,})(.*)$`: the fence's mark and what follows it.
    private static func fenceParts(_ line: String) -> (String, String)? {
        let ns = line as NSString
        guard let m = fence.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (ns.substring(with: m.range(at: 1)), ns.substring(with: m.range(at: 2)))
    }

    /// JS `trim()`: whitespace and line ends at both sides.
    private static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    private static func test(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    private static func replaceFirst(_ re: NSRegularExpression, in s: String, with template: String) -> String {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return s }
        return ns.replacingCharacters(in: m.range, with: re.replacementString(for: m, in: s, offset: 0, template: template))
    }
}
