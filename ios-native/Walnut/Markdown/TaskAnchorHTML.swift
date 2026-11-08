import Foundation

/// Only a local `/tasks/<id>` with an agreeing `data-task-id` names a task, so markup cannot open another one.
enum TaskAnchorHTML {
    /// An empty `id`: show `label` only.
    struct Ref: Equatable {
        let id: String
        let label: String
    }

    enum Close: Equatable {
        case closed(at: Int, end: Int)
        case pending
        case unclosed
    }

    static let labelLimit = 400

    private static func regex(_ pattern: String) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }

    private static let attrRegex = regex(#"([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#)
    private static let anchorRegex = regex(#"^<a(\s(?:[^>"']|"[^"]*"|'[^']*')*)?>([\s\S]*)</a\s*>$"#)
    private static let refRegex = regex(#"^<task-ref(\s(?:[^>"']|"[^"]*"|'[^']*')*?)?\s*/?>$"#)
    private static let nestedRegex = regex(#"<a[\s>]|</a"#)
    private static let hrefRegex = regex(#"^/tasks/([a-z0-9-]+)/?$"#)
    private static let tagRegex = regex(#"<[^>]*>"#)
    private static let entityRegex = regex(#"&(?:quot|apos|lt|gt|amp|#[0-9]{1,7}|#x[0-9a-f]{1,6});"#)

    static func isTaskOpenTag(_ raw: String) -> Bool {
        guard raw.count > 2, raw.lowercased().hasPrefix("<a"), raw.hasSuffix(">") else { return false }
        let inside = String(raw.dropFirst(2).dropLast())
        guard inside.isEmpty || inside.first?.isWhitespace == true else { return false }
        return ref(attributes(inside), inner: "") != nil
    }

    /// A whole `<a …>label</a>`; nil when it is no task anchor.
    static func anchorRef(_ source: String) -> Ref? {
        guard let m = first(anchorRegex, source) else { return nil }
        let inner = group(m, 2, source)
        if first(nestedRegex, inner) != nil { return nil }
        return ref(attributes(group(m, 1, source)), inner: inner)
    }

    /// Quoted text (a code span, an escaped run), decoded once: a task anchor or a `<task-ref/>`.
    static func literalRef(_ source: String) -> Ref? {
        let decoded = decode(source).trimmingCharacters(in: .whitespacesAndNewlines)
        guard decoded.hasPrefix("<") else { return nil }
        if let anchor = anchorRef(decoded) { return anchor }
        guard let m = first(refRegex, decoded) else { return nil }
        let attrs = attributes(group(m, 1, decoded))
        return Ref(id: attrs["id"] ?? "", label: clean(attrs["label"] ?? ""))
    }

    private static func ref(_ attrs: [String: String], inner: String) -> Ref? {
        let dataID = attrs["data-task-id"]?.trimmingCharacters(in: .whitespaces) ?? ""
        let marked = !dataID.isEmpty || (attrs["class"] ?? "")
            .split(whereSeparator: \.isWhitespace).contains { $0.lowercased() == "task-link" }
        let href = (attrs["href"] ?? "").trimmingCharacters(in: .whitespaces)
        let destination = first(hrefRegex, href).map { group($0, 1, href) }
        guard marked || destination != nil else { return nil }
        guard let destination, dataID.isEmpty || dataID == destination else {
            return Ref(id: "", label: clean(inner))
        }
        return Ref(id: destination, label: clean(inner))
    }

    /// Monotone under append: `pending` only ever becomes `closed` or `unclosed`.
    static func close(length: Int, from: Int, unit: (Int) -> unichar) -> Close {
        func isSpace(_ u: unichar) -> Bool { u == 32 || u == 9 || u == 13 }
        func isA(_ u: unichar) -> Bool { u == 97 || u == 65 }
        var k = from
        while k < length {
            if k - from > labelLimit { return .unclosed }
            let c = unit(k)
            if c == 10 {
                var j = k + 1
                while j < length, isSpace(unit(j)) { j += 1 }
                if j < length, unit(j) == 10 { return .unclosed }
            } else if c == 60 {
                guard k + 2 < length else { return .pending }
                let next = unit(k + 1)
                if next == 47, isA(unit(k + 2)) {
                    var j = k + 3
                    while j < length, isSpace(unit(j)) || unit(j) == 10 { j += 1 }
                    guard j < length else { return .pending }
                    if unit(j) == 62 { return .closed(at: k, end: j + 1) }
                } else if isA(next), isSpace(unit(k + 2)) || unit(k + 2) == 10 || unit(k + 2) == 62 {
                    return .unclosed
                }
            }
            k += 1
        }
        return .pending
    }

    /// Quote-aware end of the tag at `start`; -1 while it is still arriving.
    static func tagEnd(_ ns: NSString, from start: Int, limit: Int = 2000) -> Int {
        var quote: unichar = 0
        var i = start
        let stop = min(ns.length, start + limit)
        while i < stop {
            let c = ns.character(at: i)
            if quote != 0 {
                if c == quote { quote = 0 }
            } else if c == 34 || c == 39 {
                quote = c
            } else if c == 62 {
                return i + 1
            }
            i += 1
        }
        return -1
    }

    /// First of a repeated name wins, as in HTML.
    static func attributes(_ text: String) -> [String: String] {
        var out: [String: String] = [:]
        guard let re = attrRegex else { return out }
        let ns = text as NSString
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let key = ns.substring(with: m.range(at: 1)).lowercased()
            guard out[key] == nil else { continue }
            let value = (2...4).lazy.map { m.range(at: $0) }.first { $0.location != NSNotFound }
            out[key] = decode(value.map { ns.substring(with: $0) } ?? "")
        }
        return out
    }

    static func clean(_ inner: String) -> String {
        var text = inner
        if let re = tagRegex {
            text = re.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length),
                                               withTemplate: "")
        }
        return decode(text).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    static func decode(_ text: String) -> String {
        guard text.contains("&"), let re = entityRegex else { return text }
        let ns = text as NSString
        var out = ""
        var last = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let entity = ns.substring(with: m.range)
            out += character(for: entity.lowercased()) ?? entity
            last = NSMaxRange(m.range)
        }
        return out + ns.substring(from: last)
    }

    private static func character(for entity: String) -> String? {
        switch entity {
        case "&quot;": return "\""
        case "&apos;": return "'"
        case "&lt;": return "<"
        case "&gt;": return ">"
        case "&amp;": return "&"
        default:
            let body = entity.dropFirst(2).dropLast()
            let value = body.hasPrefix("x") ? UInt32(body.dropFirst(), radix: 16) : UInt32(body)
            guard let value, value > 0, let scalar = Unicode.Scalar(value) else { return nil }
            return String(Character(scalar))
        }
    }

    static func escapeHTML(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    static func first(_ re: NSRegularExpression?, _ text: String) -> NSTextCheckingResult? {
        re?.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length))
    }

    private static func group(_ m: NSTextCheckingResult, _ i: Int, _ text: String) -> String {
        let r = m.range(at: i)
        return r.location == NSNotFound ? "" : (text as NSString).substring(with: r)
    }
}
