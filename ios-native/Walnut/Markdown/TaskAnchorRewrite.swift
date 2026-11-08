import Foundation

/// Display only: `MarkdownParser.replaceEntityRefs` stays the stores' normalization.
extension TaskAnchorHTML {
    /// `body` is set for an inline code span.
    struct CodeRegion {
        let range: NSRange
        let body: NSRange?
    }

    static func mayHaveTaskMarkup(_ ns: NSString) -> Bool {
        ns.range(of: "task", options: [.literal, .caseInsensitive]).location != NSNotFound
            && (ns.range(of: "<", options: .literal).location != NSNotFound
                || ns.range(of: "&lt;", options: [.literal, .caseInsensitive]).location != NSNotFound)
    }

    /// Anchors become `<task-ref/>` so `TaskMentions.rewriteRefs` sees one shape.
    static func canonicalizeMarkdown(_ text: String) -> String {
        let ns = text as NSString
        guard mayHaveTaskMarkup(ns) else { return text }
        let regions = codeRegions(ns)
        var edits: [(NSRange, String)] = []
        for region in regions {
            if let body = region.body, let ref = literalRef(ns.substring(with: body)) {
                edits.append((region.range, markdownMarkup(ref)))
            }
        }
        var i = 0
        var next = 0
        while i < ns.length {
            while next < regions.count, NSMaxRange(regions[next].range) <= i { next += 1 }
            if next < regions.count, regions[next].range.location <= i { i = NSMaxRange(regions[next].range); continue }
            if case let (range, ref)? = rawAnchor(ns, at: i) ?? escapedMention(ns, at: i, before: ns.length) {
                edits.append((range, ref.map(markdownMarkup) ?? ""))
                i = NSMaxRange(range)
                continue
            }
            i += 1
        }
        return splice(ns, edits)
    }

    /// A nil ref (no `</a>`): drop only the open tag, so no attribute shows.
    static func rawAnchor(_ ns: NSString, at i: Int) -> (NSRange, Ref?)? {
        guard ns.character(at: i) == 60, i + 2 < ns.length, ns.character(at: i + 1) | 0x20 == 97,
              [9, 10, 13, 32, 62].contains(ns.character(at: i + 2)) else { return nil }
        let end = tagEnd(ns, from: i)
        guard end > 0, isTaskOpenTag(ns.substring(with: NSRange(location: i, length: end - i))) else { return nil }
        guard case .closed(_, let close) = TaskAnchorHTML.close(length: ns.length, from: end, unit: ns.character(at:))
        else { return (NSRange(location: i, length: end - i), nil) }
        let range = NSRange(location: i, length: close - i)
        return (range, anchorRef(ns.substring(with: range)) ?? Ref(id: "", label: ""))
    }

    /// `&lt;a …&gt;label&lt;/a&gt;` or `&lt;task-ref …/&gt;` at `k`, ending before `end`.
    static func escapedMention(_ ns: NSString, at k: Int, before end: Int) -> (NSRange, Ref?)? {
        guard ns.character(at: k) == 38 else { return nil }
        let window = NSRange(location: k, length: min(end - k, labelLimit + 2000))
        for (open, closer) in [("&lt;a", "&lt;/a&gt;"), ("&lt;task-ref", "&gt;")] {
            guard ns.range(of: open, options: [.literal, .caseInsensitive, .anchored], range: window).location == k
            else { continue }
            let found = ns.range(of: closer, options: [.literal, .caseInsensitive], range: window)
            guard found.location != NSNotFound else { continue }
            let range = NSRange(location: k, length: NSMaxRange(found) - k)
            let source = ns.substring(with: range)
            if !source.contains("\n\n"), let ref = literalRef(source) { return (range, ref) }
        }
        return nil
    }

    static func markdownMarkup(_ ref: Ref) -> String {
        guard !ref.id.isEmpty else { return escapeMarkdown(ref.label) }
        func attr(_ s: String) -> String {
            s.replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;")
        }
        return "<task-ref id=\"\(attr(ref.id))\" label=\"\(attr(ref.label))\"/>"
    }

    static func escapeMarkdown(_ text: String) -> String {
        var out = ""
        for ch in text {
            if ch.isASCII, ch.isPunctuation || ch.isSymbol { out.append("\\") }
            out.append(ch)
        }
        return out
    }

    /// Fenced blocks, indented blocks (after a blank line) and inline code spans, by location.
    static func codeRegions(_ ns: NSString) -> [CodeRegion] {
        var blocks: [NSRange] = []
        var fence: (start: Int, marker: unichar, count: Int)?
        var indented: Int?
        var previousBlank = true
        var pos = 0
        while pos < ns.length {
            let line = ns.lineRange(for: NSRange(location: pos, length: 0))
            let text = ns.substring(with: line)
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let lead = text.prefix { $0 == " " || $0 == "\t" }
            let marker = trimmed.first.flatMap { $0 == "`" || $0 == "~" ? $0 : nil }
            let run = marker.map { m in trimmed.prefix { $0 == m }.count } ?? 0
            pos = NSMaxRange(line)
            if let f = fence {
                if run >= f.count, trimmed.first?.utf16.first == f.marker,
                   trimmed.dropFirst(run).allSatisfy(\.isWhitespace) {
                    blocks.append(NSRange(location: f.start, length: pos - f.start))
                    fence = nil
                }
                continue
            }
            let blank = trimmed.isEmpty
            let isIndented = !blank && (lead.contains("\t") || lead.count >= 4)
            if let start = indented, !blank, !isIndented {
                blocks.append(NSRange(location: start, length: line.location - start))
                indented = nil
            }
            if indented == nil, run >= 3, lead.count < 4, let m = marker?.utf16.first {
                fence = (line.location, m, run)
            } else if indented == nil, isIndented, previousBlank {
                indented = line.location
            }
            previousBlank = blank
        }
        if let f = fence { blocks.append(NSRange(location: f.start, length: ns.length - f.start)) }
        if let start = indented { blocks.append(NSRange(location: start, length: ns.length - start)) }
        return (blocks.map { CodeRegion(range: $0, body: nil) } + inlineSpans(ns, outside: blocks))
            .sorted { $0.range.location < $1.range.location }
    }

    /// A backtick run closed by one of the same length, within one paragraph.
    private static func inlineSpans(_ ns: NSString, outside blocks: [NSRange]) -> [CodeRegion] {
        var spans: [CodeRegion] = []
        func inBlock(_ i: Int) -> Bool { blocks.contains { NSLocationInRange(i, $0) } }
        func runLength(_ i: Int) -> Int {
            var k = i
            while k < ns.length, ns.character(at: k) == 96 { k += 1 }
            return k - i
        }
        var i = 0
        while i < ns.length {
            guard ns.character(at: i) == 96, !inBlock(i), i == 0 || ns.character(at: i - 1) != 92 else { i += 1; continue }
            let run = runLength(i)
            var k = i + run
            var close = -1
            scan: while k < ns.length, !inBlock(k) {
                switch ns.character(at: k) {
                case 96:
                    let other = runLength(k)
                    if other == run { close = k; break scan }
                    k += other
                    continue
                case 10:
                    var j = k + 1
                    while j < ns.length, [9, 13, 32].contains(ns.character(at: j)) { j += 1 }
                    if j == ns.length || ns.character(at: j) == 10 { break scan }
                default:
                    break
                }
                k += 1
            }
            guard close >= 0 else { i += run; continue }
            spans.append(CodeRegion(range: NSRange(location: i, length: close + run - i),
                                    body: NSRange(location: i + run, length: close - i - run)))
            i = close + run
        }
        return spans
    }

    static func inCode(_ range: NSRange, _ regions: [CodeRegion]) -> Bool {
        regions.contains { NSIntersectionRange($0.range, range).length > 0 }
    }

    /// Edits in location order; one overlapping an earlier edit is dropped.
    static func splice(_ ns: NSString, _ edits: [(NSRange, String)]) -> String {
        guard !edits.isEmpty else { return ns as String }
        var out = ""
        var last = 0
        for (range, text) in edits.sorted(by: { $0.0.location < $1.0.location }) where range.location >= last {
            out += ns.substring(with: NSRange(location: last, length: range.location - last)) + text
            last = NSMaxRange(range)
        }
        return out + ns.substring(from: last)
    }
}
