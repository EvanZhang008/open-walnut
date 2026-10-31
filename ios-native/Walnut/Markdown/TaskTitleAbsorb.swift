import Foundation

/// A task link shows the task's title, so a title the model ALSO wrote beside the
/// mention would read twice: `**"Home task panel: Flat layout"**(mvu0ubnq-a02d)`.
/// This pass runs on the markdown source, before `TaskMentions.rewriteRefs`, and drops
/// the written title when it names the same task, so the link alone carries it.
///
/// A mirror of the web console's `web/src/utils/task-title-absorb.ts` (the rule, the
/// shapes, the limits) and the Board frame's copy; all three read the same cases,
/// `tests/fixtures/task-title-absorb.json` (WalnutTests/TaskTitleAbsorbTests).
/// Offsets are UTF-16, as the web's are.
enum TaskTitleAbsorb {
    struct Mention {
        let start: Int
        let end: Int
        let titles: [String]
    }

    private struct Edit {
        let from: Int
        let to: Int
        let text: String
    }

    private static let pairs: [(String, String)] = [
        ("**", "**"), ("__", "__"), ("*", "*"), ("_", "_"),
        ("\"", "\""), ("\u{201C}", "\u{201D}"), ("\u{300C}", "\u{300D}"), ("\u{300E}", "\u{300F}"),
        ("\u{2018}", "\u{2019}"), ("'", "'"),
    ]
    private static let maxWritten = 240

    private static func regex(_ pattern: String) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern)
    }
    private static let ellipsisEnd = regex(#"[ \t]*(?:\u2026|\.\.\.)$"#)
    private static let ellipsisStart = regex(#"^[ \t]*(?:\u2026|\.\.\.)"#)
    private static let parenBefore = regex(#"([ \t]*)([(\uFF08])[ \t]*$"#)
    private static let closeAfter = regex(#"^[ \t]*[)\uFF09]"#)
    private static let listSepAfter = regex(#"^[ \t]*[,\uFF0C\u3001;\uFF1B][ \t]*"#)
    private static let dashBefore = regex(#"(?:[ \t]*[\u2014\u2013][ \t]*|[ \t]+-{1,2}[ \t]+)$"#)
    private static let dashAfter = regex(#"^(?:[ \t]*[\u2014\u2013][ \t]*|[ \t]+-{1,2}[ \t]+)"#)
    private static let parenAfter = regex(#"^[ \t]*[(\uFF08]([^\n()\uFF08\uFF09]{1,240})[)\uFF09]"#)
    private static let spaceAfter = regex(#"^[ \t]+"#)
    private static let whitespaceRun = regex(#"\s+"#)
    private static let taskRef = regex(#"<task-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*/?>"#)
    private static let legacyRef = regex(#"\[([a-z0-9]{7,10}-[a-f0-9]{4})\|([^\]\n]+)\]"#)
    private static let codeSpan = regex(#"(^|[^`])(`+)(?!`)([\s\S]*?[^`])\2(?!`)"#)
    private static let fenceLine = regex(#"^[ \t]*(`{3,}|~{3,})"#)
    private static let token = regex(TaskMentions.tokenPattern)
    private static let notLinked = [
        regex(#"\[[^\[\]\n]*\]\((?:[^()\s]|\([^()\s]*\))*\)"#),
        regex(#"https?://[^\s<>"')\]]+"#),
        regex(#"<[^<>\n]+>"#),
    ]

    // MARK: - Small string helpers (UTF-16 offsets)

    private static func len(_ s: String) -> Int { (s as NSString).length }
    private static func sub(_ s: String, _ from: Int, _ to: Int) -> String {
        (s as NSString).substring(with: NSRange(location: from, length: max(0, to - from)))
    }
    private static func first(_ r: NSRegularExpression?, _ s: String) -> NSTextCheckingResult? {
        r?.firstMatch(in: s, range: NSRange(location: 0, length: len(s)))
    }
    private static func isASCIIWord(_ s: String, at i: Int) -> Bool {
        guard i >= 0, i < len(s) else { return false }
        let c = (s as NSString).character(at: i)
        return (48...57).contains(c) || (65...90).contains(c) || (97...122).contains(c)
    }
    private static func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
    private static func trimEnd(_ s: String) -> String {
        var out = s
        while let last = out.last, last.isWhitespace { out.removeLast() }
        return out
    }
    private static func norm(_ s: String) -> String {
        let folded = s.precomposedStringWithCompatibilityMapping.lowercased()
        let spaced = whitespaceRun?.stringByReplacingMatches(
            in: folded, range: NSRange(location: 0, length: len(folded)), withTemplate: " "
        ) ?? folded
        return trim(spaced)
    }

    // MARK: - The rule

    private static func unwrap(_ s: String) -> String {
        var t = trim(s)
        for _ in 0..<4 {
            let current = t
            guard let pair = pairs.first(where: { pair in
                len(current) > len(pair.0) + len(pair.1) && current.hasPrefix(pair.0) && current.hasSuffix(pair.1)
            }) else { break }
            t = trim(sub(t, len(pair.0), len(t) - len(pair.1)))
        }
        return t
    }

    private static func isNameCut(_ head: String, _ full: Int, _ cut: Bool) -> Bool {
        let h = trim(head)
        let words = h.split(whereSeparator: { $0.isWhitespace }).count
        return cut || Double(len(h)) >= 0.6 * Double(full) || (len(h) >= 10 && words >= 2)
    }

    /// Does a written phrase name this title?
    static func writtenTitleMatches(_ written: String, _ title: String) -> Bool {
        var w = unwrap(written)
        let cut = first(ellipsisEnd, w) != nil
        if cut, let m = first(ellipsisEnd, w) { w = unwrap(sub(w, 0, m.range.location)) }
        let nw = norm(w), nt = norm(title)
        if len(nw) < 3 || nt.isEmpty { return false }
        if nw == nt { return true }
        guard (nt as NSString).hasPrefix(nw) else { return false }
        if isASCIIWord(nt, at: len(nw)) && isASCIIWord(nw, at: len(nw) - 1) { return false }
        return isNameCut(nw, len(nt), cut)
    }

    private static func unitBefore(_ head: String) -> Int {
        let ns = head as NSString
        for (open, close) in pairs {
            guard ns.hasSuffix(close) else { continue }
            if len(close) == 1, ns.hasSuffix(close + close), close == "*" || close == "_" { continue }
            let from = ns.length - len(close) - 1
            guard from >= 0 else { continue }
            let found = ns.range(of: open, options: .backwards,
                                 range: NSRange(location: 0, length: min(ns.length, from + len(open))))
            guard found.location != NSNotFound else { continue }
            let start = found.location
            if ns.length - start > maxWritten || sub(head, start, ns.length).contains("\n") { continue }
            if ns.length - start <= len(open) + len(close) { continue }
            return start
        }
        return -1
    }

    private static func unitAfter(_ tail: String) -> Int {
        let ns = tail as NSString
        for (open, close) in pairs {
            guard ns.hasPrefix(open) else { continue }
            if len(open) == 1, ns.hasPrefix(open + open), open == "*" || open == "_" { continue }
            let from = len(open) + 1
            guard from <= ns.length else { continue }
            let found = ns.range(of: close, range: NSRange(location: from, length: ns.length - from))
            guard found.location != NSNotFound else { continue }
            let end = found.location
            if end + len(close) > maxWritten || sub(tail, 0, end).contains("\n") { continue }
            return end + len(close)
        }
        return 0
    }

    private static func cutLengths(_ title: String, _ cut: Bool) -> [Int] {
        var out: [Int] = []
        let n = len(title)
        guard n >= 3 else { return out }
        for k in stride(from: n, through: 3, by: -1) {
            if k < n && isASCIIWord(title, at: k) && isASCIIWord(title, at: k - 1) { continue }
            if k == n || isNameCut(sub(title, 0, k), n, cut) { out.append(k) }
        }
        return out
    }

    private static func plainBefore(_ head: String, _ title: String) -> Int {
        let ell = first(ellipsisEnd, head)
        let core = ell.map { sub(head, 0, $0.range.location) } ?? head
        let lower = core.lowercased() as NSString
        // Offsets are taken on `core`: a case fold that changes the length cannot be mapped back.
        guard lower.length == len(core) else { return -1 }
        let t = trim(title).lowercased()
        for k in cutLengths(t, ell != nil) {
            let cand = trimEnd(sub(t, 0, k))
            guard len(cand) >= 3, lower.hasSuffix(cand) else { continue }
            let start = len(core) - len(cand)
            if start > 0 && isASCIIWord(cand, at: 0) && isASCIIWord(core, at: start - 1) { continue }
            return start
        }
        return -1
    }

    private static func plainAfter(_ tail: String, _ title: String) -> Int {
        let lower = tail.lowercased() as NSString
        let t = trim(title).lowercased()
        for k in cutLengths(t, true) {
            let cand = trimEnd(sub(t, 0, k))
            guard len(cand) >= 3, lower.hasPrefix(cand) else { continue }
            var end = len(cand)
            let ell = first(ellipsisStart, sub(tail, end, len(tail)))
            if let ell { end += ell.range.length } else if k < len(t) && !isNameCut(cand, len(t), false) { continue }
            if ell == nil && isASCIIWord(cand, at: len(cand) - 1) && isASCIIWord(tail, at: end) { continue }
            return end
        }
        return 0
    }

    private static func writtenBefore(_ head: String, _ titles: [String]) -> Int {
        let u = unitBefore(head)
        if u >= 0 {
            let unit = sub(head, u, len(head))
            return titles.contains(where: { writtenTitleMatches(unit, $0) }) ? u : -1
        }
        for t in titles {
            let p = plainBefore(head, t)
            if p >= 0 { return p }
        }
        return -1
    }

    private static func edit(_ text: String, _ m: Mention, lo: Int, hi: Int) -> Edit? {
        let mention = sub(text, m.start, m.end)
        let before = sub(text, lo, m.start)
        let after = sub(text, m.end, hi)
        let ns = before as NSString

        // Title (M) / Title (M, more)
        if let paren = first(parenBefore, before) {
            let close = first(closeAfter, after)
            let sep = close == nil ? first(listSepAfter, after) : nil
            if close != nil || sep != nil {
                let at = writtenBefore(sub(before, 0, paren.range.location), m.titles)
                if at >= 0 {
                    if let close {
                        return Edit(from: lo + at, to: m.end + close.range.length, text: mention)
                    }
                    let spaces = ns.substring(with: paren.range(at: 1))
                    let open = ns.substring(with: paren.range(at: 2))
                    return Edit(from: lo + at, to: m.end + (sep?.range.length ?? 0), text: mention + spaces + open)
                }
            }
        }
        // Title - M
        if let dash = first(dashBefore, before) {
            let at = writtenBefore(sub(before, 0, dash.range.location), m.titles)
            if at >= 0 { return Edit(from: lo + at, to: m.start, text: "") }
        }
        // M (Title)
        if let paren = first(parenAfter, after) {
            let inner = (after as NSString).substring(with: paren.range(at: 1))
            if m.titles.contains(where: { writtenTitleMatches(inner, $0) }) {
                return Edit(from: m.end, to: m.end + paren.range.length, text: "")
            }
        }
        // M - Title
        if let dash = first(dashAfter, after) {
            let tail = sub(after, dash.range.length, len(after))
            let u = unitAfter(tail)
            var length = u > 0 && m.titles.contains(where: { writtenTitleMatches(sub(tail, 0, u), $0) }) ? u : 0
            if length == 0 && u == 0 {
                for t in m.titles where length == 0 { length = plainAfter(tail, t) }
            }
            if length > 0 { return Edit(from: m.end, to: m.end + dash.range.length + length, text: "") }
        }
        // M "Title" / M **Title**
        if let space = first(spaceAfter, after) {
            let tail = sub(after, space.range.length, len(after))
            let u = unitAfter(tail)
            if u > 0 && m.titles.contains(where: { writtenTitleMatches(sub(tail, 0, u), $0) }) {
                return Edit(from: m.end, to: m.end + space.range.length + u, text: "")
            }
        }
        return nil
    }

    /// Drop each title written beside a mention of the same task; every other character stays.
    static func absorb(_ text: String, mentions: [Mention]) -> String {
        guard !mentions.isEmpty else { return text }
        let ns = text as NSString
        let sorted = mentions.sorted { $0.start < $1.start }
        var edits: [Edit] = []
        for (i, m) in sorted.enumerated() {
            if m.titles.allSatisfy({ trim($0).isEmpty }) { continue }
            let back = ns.range(of: "\n", options: .backwards, range: NSRange(location: 0, length: m.start))
            let lineStart = back.location == NSNotFound ? 0 : back.location + 1
            let fwd = ns.range(of: "\n", range: NSRange(location: m.end, length: ns.length - m.end))
            let lineEnd = fwd.location == NSNotFound ? ns.length : fwd.location
            let lo = max(lineStart, i > 0 ? sorted[i - 1].end : 0)
            let hi = min(lineEnd, i + 1 < sorted.count ? sorted[i + 1].start : ns.length)
            guard let e = edit(text, m, lo: lo, hi: hi) else { continue }
            if !edits.contains(where: { $0.from < e.to && e.from < $0.to }) { edits.append(e) }
        }
        var out = ns
        for e in edits.sorted(by: { $0.from > $1.from }) {
            out = out.replacingCharacters(in: NSRange(location: e.from, length: e.to - e.from), with: e.text) as NSString
        }
        return out as String
    }

    /// The names a writer may use for a task its link shows as `shown` (a lead's
    /// "X lead" shows as "X VP", Main shows as "CEO"; `TaskMentions.shownTitle`).
    static func pillNames(_ shown: String) -> [String] {
        var out = [shown]
        if shown.range(of: #" VP$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            out.append(shown.replacingOccurrences(of: #" VP$"#, with: " lead", options: [.regularExpression, .caseInsensitive]))
        }
        if shown == "CEO" { out.append("Main") }
        return out
    }

    // MARK: - The mentions of a markdown source

    /// Find the mentions `TaskMentions` will link (a `<task-ref/>`, `[id|title]`, a whole
    /// code span holding an id, a bare id) and drop the titles written beside them.
    /// Fenced blocks and longer code are left as written.
    static func absorbWrittenTitles(_ text: String, resolver: TaskMentionResolver = .shared) -> String {
        guard len(text) >= TaskMentions.minPrefixLength, !resolver.isEmpty else { return text }
        let ns = text as NSString
        let all = NSRange(location: 0, length: ns.length)
        var blocked: [NSRange] = fencedBlocks(text)
        var mentions: [Mention] = []
        func taken(_ r: NSRange) -> Bool { blocked.contains { NSIntersectionRange($0, r).length > 0 } }
        func add(_ r: NSRange, _ token: String) {
            let t = trim(token)
            guard !t.isEmpty, let hit = resolver.resolve(t) else { return }
            mentions.append(Mention(start: r.location, end: r.location + r.length,
                                    titles: pillNames(hit.title.isEmpty ? hit.id : hit.title)))
        }
        for m in codeSpan?.matches(in: text, range: all) ?? [] {
            let pre = m.range(at: 1).length
            let span = NSRange(location: m.range.location + pre, length: m.range.length - pre)
            if taken(span) { continue }
            blocked.append(span)
            let body = ns.substring(with: m.range(at: 3))
            if !body.contains("\n") && TaskMentions.isCandidate(trim(body)) { add(span, body) }
        }
        for r in [taskRef, legacyRef] {
            for m in r?.matches(in: text, range: all) ?? [] {
                if taken(m.range) { continue }
                add(m.range, ns.substring(with: m.range(at: 1)))
                blocked.append(m.range)
            }
        }
        // Never a link of ours, so never a mention: a markdown link (its text and URL), a URL,
        // any other tag.
        for r in notLinked {
            for m in r?.matches(in: text, range: all) ?? [] { blocked.append(m.range) }
        }
        for m in token?.matches(in: text, range: all) ?? [] {
            let t = ns.substring(with: m.range)
            if !TaskMentions.isCandidate(t) || taken(m.range) { continue }
            add(m.range, t)
        }
        return absorb(text, mentions: mentions)
    }

    /// Fenced code blocks (``` or ~~~ lines), each from its opening line to its closing one.
    private static func fencedBlocks(_ text: String) -> [NSRange] {
        let ns = text as NSString
        var out: [NSRange] = []
        var open: (start: Int, marker: String)?
        var pos = 0
        while pos < ns.length {
            let line = ns.lineRange(for: NSRange(location: pos, length: 0))
            let body = ns.substring(with: line)
            if let m = first(fenceLine, body) {
                let marker = (body as NSString).substring(with: m.range(at: 1))
                if let o = open {
                    if marker.hasPrefix(o.marker) {
                        out.append(NSRange(location: o.start, length: line.location + line.length - o.start))
                        open = nil
                    }
                } else {
                    open = (line.location, marker)
                }
            }
            pos = line.location + line.length
        }
        if let o = open { out.append(NSRange(location: o.start, length: ns.length - o.start)) }
        return out
    }
}
