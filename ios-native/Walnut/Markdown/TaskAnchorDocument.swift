import Foundation

extension TaskAnchorHTML {
    /// `render` must return escaped HTML. `sample` shows a task anchor inside `<pre>`/`<code>`:
    /// the author's own inner markup, which the web keeps as a working link.
    static func rewriteHTML(_ html: String, render: (Ref) -> String,
                            sample: (Ref, String) -> String = { _, inner in inner }) -> String {
        let ns = html as NSString
        guard mayHaveTaskMarkup(ns) else { return html }
        var edits: [(NSRange, String)] = []
        var samples: [String] = []
        var i = 0
        var text = 0
        func rest(_ from: Int) -> NSRange { NSRange(location: from, length: ns.length - from) }
        while i < ns.length {
            let found = ns.range(of: "<", options: .literal, range: rest(i)).location
            let lt = found == NSNotFound ? ns.length : found
            let segment = text
            var k = text
            while samples.isEmpty, k < lt {
                if case let (range, ref?)? = escapedMention(ns, at: k, before: lt) {
                    edits.append((range, render(ref)))
                    k = NSMaxRange(range)
                } else {
                    k += 1
                }
            }
            guard lt < ns.length else { break }
            text = lt
            if ns.range(of: "<!--", options: [.literal, .anchored], range: rest(lt)).location == lt {
                let close = ns.range(of: "-->", options: .literal, range: rest(lt))
                i = close.location == NSNotFound ? ns.length : NSMaxRange(close)
                text = i
                continue
            }
            let end = tagEnd(ns, from: lt, limit: ns.length)
            guard end > 0, case let (name, closing)? = tagName(ns, lt) else { i = lt + 1; continue }
            let raw = ns.substring(with: NSRange(location: lt, length: end - lt))
            i = end
            text = end
            if !closing, samples.isEmpty, case let (hit, ref)? = mention(ns, lt: lt, end: end, name: name, raw: raw) {
                var range = hit
                var shown = ref.map(render) ?? ""
                // inlineMarkdown makes no code span around a tag, so a quoted mention arrives raw.
                if let ref, let code = backtickSpan(ns, around: hit, from: segment) {
                    let body = ns.substring(with: NSRange(location: code.location + 1, length: code.length - 2))
                    shown = body.trimmingCharacters(in: .whitespaces) == ns.substring(with: hit)
                        ? render(ref) : "<code>" + escapeHTML(body) + "</code>"
                    range = code
                }
                edits.append((range, shown))
                i = NSMaxRange(range)
                text = i
            } else if !closing, name == "a", !samples.isEmpty, !samples.contains("a"), !samples.contains("button"),
                      case let (hit, ref)? = rawAnchor(ns, at: lt) {
                // A raw relative `/tasks/` link inside a code sample opens nothing in a web view.
                let source = ns.substring(with: hit) as NSString
                let close = source.range(of: "</a", options: [.literal, .caseInsensitive, .backwards])
                let inner = ref == nil || close.location == NSNotFound || close.location < end - lt ? ""
                    : source.substring(with: NSRange(location: end - lt, length: close.location - (end - lt)))
                edits.append((hit, ref.map { sample($0, inner) } ?? ""))
                i = NSMaxRange(hit)
                text = i
            } else if ["style", "script", "textarea"].contains(name), !closing {
                let close = ns.range(of: "</" + name, options: [.literal, .caseInsensitive], range: rest(end))
                i = close.location == NSNotFound ? ns.length : close.location
                text = i
            } else if ["pre", "code", "a", "button"].contains(name), !raw.hasSuffix("/>") {
                if !closing { samples.append(name) } else if let at = samples.lastIndex(of: name) {
                    samples.removeSubrange(at...)
                }
            }
        }
        return splice(ns, edits)
    }

    private static func mention(_ ns: NSString, lt: Int, end: Int, name: String, raw: String) -> (NSRange, Ref?)? {
        switch name {
        case "task-ref":
            return literalRef(raw).map { (NSRange(location: lt, length: end - lt), $0) }
        case "a":
            return rawAnchor(ns, at: lt)
        case "code":
            let close = ns.range(of: "</code>", options: [.literal, .caseInsensitive],
                                 range: NSRange(location: end, length: ns.length - end))
            guard close.location != NSNotFound else { return nil }
            let body = ns.substring(with: NSRange(location: end, length: close.location - end))
            guard !body.contains("<"), let ref = literalRef(body) else { return nil }
            return (NSRange(location: lt, length: NSMaxRange(close) - lt), ref)
        default:
            return nil
        }
    }

    private static func backtickSpan(_ ns: NSString, around mention: NSRange, from start: Int) -> NSRange? {
        let before = ns.substring(with: NSRange(location: start, length: mention.location - start))
        guard before.filter({ $0 == "`" }).count % 2 == 1, let open = before.lastIndex(of: "`") else { return nil }
        let from = start + before[..<open].utf16.count
        var k = NSMaxRange(mention)
        while k < ns.length, ![60, 10].contains(ns.character(at: k)) {
            if ns.character(at: k) == 96 { return NSRange(location: from, length: k + 1 - from) }
            k += 1
        }
        return nil
    }

    private static func tagName(_ ns: NSString, _ lt: Int) -> (String, Bool)? {
        func letter(_ u: unichar) -> Bool { (65...90).contains(u) || (97...122).contains(u) }
        var i = lt + 1
        let closing = i < ns.length && ns.character(at: i) == 47
        if closing { i += 1 }
        guard i < ns.length, letter(ns.character(at: i)) else { return nil }
        let start = i
        while i < ns.length, letter(ns.character(at: i)) || (48...57).contains(ns.character(at: i))
            || ns.character(at: i) == 45 {
            i += 1
        }
        return (ns.substring(with: NSRange(location: start, length: i - start)).lowercased(), closing)
    }
}
