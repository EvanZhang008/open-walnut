import Foundation

/// Finds `Text`, `Label` and `Button` titles that draw agent-written words without the shared
/// inline renderer, following taint through bindings, String helpers and view properties.
final class AgentTextTaint {
    struct Hit: Equatable {
        let key: String
        let line: Int
        let code: String
    }

    /// A func or property of a type ("" = top level), or a view property set through a labelled argument.
    private struct Key: Hashable {
        let type: String
        let name: String
    }

    private struct Scope: Hashable {
        let rel: String
        let region: Int
        let member: Int
    }

    private struct File {
        let rel: String
        let lines: [String]
        /// Per line, its top-level declaration (0 = file scope) and member of it (0 = the declaration
        /// itself): a name bound in one func never taints a same-named one in another.
        var region: [Int] = []
        var member: [Int] = []
        var regionType: [Int: String] = [:]
    }

    private struct Func {
        let file: Int, line: Int, name: String, attributed: Bool
        let params: Set<String>
        let body: [(Int, String)]
    }

    /// A func returning a tuple with String elements: which elements, by label and position, carry words.
    private struct TupleFunc {
        let file: Int, line: Int, name: String
        /// Per position, its label (nil when unlabelled) and whether it is a String.
        let fields: [(label: String?, text: Bool)]
        let body: [(Int, String)]
    }

    private struct Flow {
        let file: Int, line: Int, name: String, expr: String
    }

    private struct Argument {
        let file: Int, line: Int, key: Key, expr: String
    }

    static let sourceFields =
        #"(?<![A-Za-z0-9_])(?:item\.summary|need\.text|question\.answer|entry\.text|previewLine|displayBody|notDone|lastWords|waitingOn)\b"#
        // A field read on through another property (`answer?.device.name`) is that property, not the words.
        + #"|(?<!Date)(?<=[A-Za-z0-9_?)\]])\.(?:ask|now|next|summary|reply|answer)\b(?!\s*\()(?!\??\.(?!text\b)[A-Za-z_][A-Za-z0-9_]*\b(?!\s*\())"#
        + #"|\bresultReport\??\.result\b"#
    private static let typeDecl = #"\b(?:struct|class|enum|extension|actor)\s+([A-Za-z_][A-Za-z0-9_.]*)"#
    private static let funcDecl = #"\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(<]"#
    private static let computedDecl = #"\bvar\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[?String\??\]?\??\s*\{"#
    private static let bindDecl = #"\b(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=,{]+)?=\s*"#
    private static let sharedRenderer = #"\bMarkdownParser\.inline\("#
    /// Calls whose result is still the words; any other call's arguments do not flow (an id found in a reply is not the reply).
    private static let passThrough: Set<String> = [
        "String", "AttributedString", "ForEach", "map", "compactMap", "flatMap", "filter", "prefix", "suffix",
        "dropFirst", "dropLast", "joined", "trimmingCharacters", "replacingOccurrences", "lowercased", "uppercased",
        "capitalized", "first", "last", "components", "split", "sorted", "reversed", "Array",
    ]
    /// How many lines a call's arguments may span.
    private static let span = 40
    /// A trailing closure of these is the value: only what it returns flows, not its side effects.
    private static let mapping: Set<String> = ["map", "compactMap", "flatMap"]

    private var cache: [String: NSRegularExpression] = [:]
    private var files: [File] = []
    private var funcs: [Func] = []
    private var tupleFuncs: [TupleFunc] = []
    /// Tuple funcs and the positions of their String elements built from agent words.
    private var tupleHelpers: [Key: Set<Int>] = [:]
    private var tupleLabels: [Key: [String?]] = [:]
    private var computed: [Flow] = []
    private var flows: [Flow] = []
    private var arguments: [Argument] = []
    private var helpers: Set<Key> = []
    private var renderers: Set<Key> = []
    private var props: Set<Key> = []
    private var keep: Set<String> = []
    /// String funcs whose result is built from their parameters: their arguments flow.
    private var transforms: Set<String> = []
    private var taint: [Scope: Set<String>] = [:]

    // MARK: Text helpers

    private func rx(_ pattern: String, _ options: NSRegularExpression.Options) -> NSRegularExpression {
        let key = "\(options.rawValue)|\(pattern)"
        if let cached = cache[key] { return cached }
        let made = try! NSRegularExpression(pattern: pattern, options: options)
        cache[key] = made
        return made
    }

    private func matches(_ pattern: String, _ s: String, _ options: NSRegularExpression.Options = []) -> [NSTextCheckingResult] {
        rx(pattern, options).matches(in: s, range: NSRange(location: 0, length: (s as NSString).length))
    }

    private func firstMatch(_ pattern: String, _ s: String, _ options: NSRegularExpression.Options = []) -> NSTextCheckingResult? {
        rx(pattern, options).firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length))
    }

    private static func group(_ m: NSTextCheckingResult, _ i: Int, in s: String) -> String {
        let r = m.range(at: i)
        return r.location == NSNotFound ? "" : (s as NSString).substring(with: r)
    }

    /// The text after the `(` at UTF-16 offset `open`, up to its match; false when it runs out first.
    private static func balanced(_ s: NSString, from open: Int) -> (String, Bool) {
        var depth = 0
        var i = open
        while i < s.length {
            let c = s.character(at: i)
            if c == 40 {
                depth += 1
            } else if c == 41 {
                depth -= 1
                if depth == 0 { return (s.substring(with: NSRange(location: open + 1, length: i - open - 1)), true) }
            }
            i += 1
        }
        return (s.substring(from: open + 1), false)
    }

    /// A call's arguments, read on over the next lines when they do not close on its own.
    private static func callArguments(_ lines: [String], _ i: Int, open: Int) -> String {
        let (args, closed) = balanced(lines[i] as NSString, from: open)
        if closed { return args }
        let joined = lines[i..<min(lines.count, i + span)].joined(separator: "\n") as NSString
        return balanced(joined, from: open).0
    }

    private static func splitTopLevel(_ args: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var depth = 0
        for c in args {
            if "([{".contains(c) { depth += 1 } else if ")]}".contains(c) { depth -= 1 }
            if c == ",", depth == 0 { parts.append(current); current = "" } else { current.append(c) }
        }
        parts.append(current)
        return parts
    }

    private static func stripComment(_ line: String) -> String {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("//") || t.hasPrefix("*") || t.hasPrefix("/*") { return "" }
        let chars = Array(line)
        var quoted = false
        var i = 0
        while i < chars.count - 1 {
            let c = chars[i]
            if c == "\\" { i += 2; continue }
            if c == "\"" {
                quoted.toggle()
            } else if !quoted, c == "/", chars[i + 1] == "/" {
                return String(chars[..<i])
            }
            i += 1
        }
        return line
    }

    private static func count(_ c: Character, in s: String) -> Int { s.filter { $0 == c }.count }

    /// The line indices of the block that opens on line `j`.
    private static func block(_ lines: [String], from j: Int) -> [Int] {
        var depth = 0
        var out: [Int] = []
        for k in j..<lines.count {
            out.append(k)
            depth += count("{", in: lines[k]) - count("}", in: lines[k])
            if (depth <= 0 && k > j) || (depth == 0 && k == j && lines[k].contains("}")) { break }
        }
        return out
    }

    /// The block's lines, the first one from after its `{`.
    private func blockLines(_ f: File, _ indices: [Int], first: Int) -> [(Int, String)] {
        indices.map { k in
            let text = f.lines[k]
            guard k == first else { return (k, text) }
            return (k, text.components(separatedBy: "{").dropFirst().joined(separator: "{"))
        }
    }

    /// The parameter names of the func declared in `signature`.
    private func parameters(_ signature: String) -> Set<String> {
        guard let m = firstMatch(#"\bfunc\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:<[^>]*>)?\("#, signature) else { return [] }
        let inner = Self.balanced(signature as NSString, from: NSMaxRange(m.range) - 1).0
        return Set(Self.splitTopLevel(inner).compactMap { part in
            firstMatch(#"^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:"#, part).map { Self.group($0, 2, in: part) }
        })
    }

    /// What a closure or func body returns: its `return` expressions, else the body itself.
    private func returned(_ body: String) -> String {
        var text = body
        if let header = firstMatch(#"^\s*\(?[A-Za-z_$][A-Za-z0-9_$, ]*\)?\s*(?:->\s*[^{}]+?)?\s+in\b"#, text) {
            text = (text as NSString).substring(from: NSMaxRange(header.range))
        }
        let results = matches(#"\breturn\s+([^\n}]*)"#, text).map { Self.group($0, 1, in: text) }
        return results.isEmpty ? text : results.joined(separator: " ; ")
    }

    // MARK: Reading the source once

    private func parse(_ rel: String, _ source: String) -> File {
        var f = File(rel: rel, lines: source.components(separatedBy: "\n").map(Self.stripComment))
        var depth = 0, region = 0, made = 0, member = 0, members = 0
        for line in f.lines {
            if depth == 0 {
                if let m = firstMatch(Self.typeDecl, line) {
                    made += 1
                    region = made
                    member = 0
                    f.regionType[region] = Self.group(m, 1, in: line).components(separatedBy: ".").last ?? ""
                } else {
                    region = 0
                }
            }
            if depth == (region == 0 ? 0 : 1) {
                if line.contains("{") {
                    members += 1
                    member = members
                } else {
                    member = 0
                }
            } else if depth == 0 {
                member = 0
            }
            f.region.append(region)
            f.member.append(member)
            let opens = Self.count("{", in: line)
            depth = max(0, depth + opens - Self.count("}", in: line))
            if depth == 0, opens > 0 { region = 0 }
        }
        return f
    }

    private func collect(_ fi: Int) {
        let f = files[fi]
        let lines = f.lines
        for (i, line) in lines.enumerated() {
            if let m = firstMatch(Self.funcDecl, line), let end = signatureEnd(lines, i) {
                let (j, signature) = end
                let isString = firstMatch(#"->\s*\[?String\??\]?\??\s*(?:where|$)"#, signature) != nil
                let isAttributed = firstMatch(#"->\s*AttributedString\b"#, signature) != nil
                if isString || isAttributed {
                    let name = Self.group(m, 1, in: line)
                    funcs.append(Func(file: fi, line: i, name: name, attributed: !isString, params: parameters(signature),
                                      body: blockLines(f, Self.block(lines, from: j), first: j)))
                    if !isString { keep.insert(name) }
                } else if let fields = tupleReturn(signature) {
                    tupleFuncs.append(TupleFunc(file: fi, line: i, name: Self.group(m, 1, in: line), fields: fields,
                                                body: blockLines(f, Self.block(lines, from: j), first: j)))
                }
            }
            if let m = firstMatch(Self.computedDecl, line), firstMatch(Self.bindDecl, line) == nil {
                let body = blockLines(f, Self.block(lines, from: i), first: i)
                computed += body.map { Flow(file: fi, line: $0.0, name: Self.group(m, 1, in: line), expr: $0.1) }
            }
            for m in matches(Self.bindDecl, line) {
                var rest = (line as NSString).substring(from: NSMaxRange(m.range))
                if let cut = firstMatch(#",\s*(?:let|var)\b|\{\s*$"#, rest) { rest = (rest as NSString).substring(to: cut.range.location) }
                if rest.trimmingCharacters(in: .whitespaces).isEmpty, i + 1 < lines.count { rest = lines[i + 1] }
                // A closure opened here (`let lines = xs.map { r -> String in`) is read to its end.
                var k = i
                while Self.count("{", in: rest) > Self.count("}", in: rest), k + 1 < lines.count, k - i < Self.span {
                    k += 1
                    rest += "\n" + lines[k]
                }
                flows.append(Flow(file: fi, line: i, name: Self.group(m, 1, in: line), expr: rest))
            }
            for m in matches(#"\bfor\s+(?:case\s+let\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+?)\s*\{"#, line) {
                flows.append(Flow(file: fi, line: i, name: Self.group(m, 1, in: line), expr: Self.group(m, 2, in: line)))
            }
            for m in matches(#"\{\s*\(?\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*\s*\)?\s+in\b"#, line) {
                flows.append(Flow(file: fi, line: i, name: Self.group(m, 1, in: line),
                                  expr: (line as NSString).substring(to: m.range.location)))
            }
            for m in matches(#"\b([A-Z][A-Za-z0-9_]*)\("#, line) {
                let args = Self.callArguments(lines, i, open: NSMaxRange(m.range) - 1)
                for part in Self.splitTopLevel(args) {
                    guard let a = firstMatch(#"^\s*([a-z][A-Za-z0-9_]*)\s*:\s*(.+)$"#, part, .dotMatchesLineSeparators) else { continue }
                    arguments.append(Argument(file: fi, line: i, key: Key(type: Self.group(m, 1, in: line), name: Self.group(a, 1, in: part)),
                                              expr: Self.group(a, 2, in: part)))
                }
            }
        }
    }

    /// The line a declaration's `{` is on, and its signature up to it.
    private func signatureEnd(_ lines: [String], _ start: Int) -> (Int, String)? {
        var j = start
        var signature = ""
        while j < lines.count, !lines[j].contains("{") {
            signature += lines[j]
            j += 1
        }
        guard j < lines.count else { return nil }
        return (j, signature + lines[j].components(separatedBy: "{")[0])
    }

    /// The elements of a func's tuple return type, when it is one with a String element.
    private func tupleReturn(_ signature: String) -> [(label: String?, text: Bool)]? {
        guard let m = firstMatch(#"\bfunc\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:<[^>]*>)?\("#, signature) else { return nil }
        let s = signature as NSString
        let open = NSMaxRange(m.range) - 1
        let (params, closed) = Self.balanced(s, from: open)
        guard closed else { return nil }
        let rest = s.substring(from: open + (params as NSString).length + 2)
        guard let arrow = firstMatch(#"^\s*(?:async\s+)?(?:throws\s+|rethrows\s+)?->\s*\("#, rest) else { return nil }
        let r = rest as NSString
        let (inner, done) = Self.balanced(r, from: NSMaxRange(arrow.range) - 1)
        guard done else { return nil }
        // Past the tuple's closing parenthesis.
        let after = r.substring(from: NSMaxRange(arrow.range) + (inner as NSString).length + 1)
        guard firstMatch(#"^\s*[?!]?\s*(?:where\b.*)?$"#, after, .dotMatchesLineSeparators) != nil else { return nil }
        let parts = Self.splitTopLevel(inner)
        guard parts.count >= 2 else { return nil }
        let fields: [(label: String?, text: Bool)] = parts.map { part in
            let e = firstMatch(#"^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s*:(?!:))?\s*(.*?)\s*$"#, part, .dotMatchesLineSeparators)
            let label = e.map { Self.group($0, 1, in: part) } ?? ""
            let type = e.map { Self.group($0, 2, in: part) } ?? part
            return (label.isEmpty ? nil : label, firstMatch(#"^\[?String\??\]?\??$"#, type) != nil)
        }
        return fields.contains(where: \.text) ? fields : nil
    }

    /// An element's expression without its label (`text: words` is `words`).
    private func unlabelled(_ element: String) -> String {
        guard let m = firstMatch(#"^\s*[A-Za-z_][A-Za-z0-9_]*\s*:(?!:)"#, element) else { return element }
        return (element as NSString).substring(from: NSMaxRange(m.range))
    }

    /// One statement from the start of `s`: on across lines while a bracket is open or the next line
    /// goes on with an operator (`?`, `:`, `.`, `&&`, `||`, `+`); it ends at a `;` or at the `}` that
    /// closes the block around it.
    private static func statement(_ s: String) -> String {
        let c = Array(s.utf16)
        var depth = 0
        for i in c.indices {
            switch c[i] {
            case 40, 91, 123: depth += 1
            case 41, 93, 125:
                depth -= 1
                if depth < 0 { return String(decoding: c[..<i], as: UTF16.self) }
            case 59 where depth == 0: return String(decoding: c[..<i], as: UTF16.self)
            case 10 where depth == 0:
                let next = String(decoding: c[(i + 1)...], as: UTF16.self).drop { $0 == " " || $0 == "\t" || $0 == "\n" }
                if !["?", ":", ".", "&&", "||", "+"].contains(where: { next.hasPrefix($0) }) {
                    return String(decoding: c[..<i], as: UTF16.self)
                }
            default: break
            }
        }
        return s
    }

    /// The tuple literals the statement's value can be: the statement itself, a ternary branch, a
    /// parenthesized value, what a mapping closure returns. Never a call's arguments, an
    /// interpolation, a closure's parameter list or another closure's body.
    private static func tupleLiterals(_ s: String) -> [String] {
        let c = Array(s.utf16)
        func isIdentifier(_ ch: UInt16) -> Bool { (65...90).contains(ch) || (97...122).contains(ch) || (48...57).contains(ch) || ch == 95 }
        func isSpace(_ ch: UInt16) -> Bool { ch == 32 || ch == 9 || ch == 10 }
        func name(endingAt j: Int) -> String {
            var k = j
            while k >= 0, isIdentifier(c[k]) { k -= 1 }
            return j > k ? String(decoding: c[(k + 1)...j], as: UTF16.self) : ""
        }
        func close(_ open: Int) -> Int {
            let (o, cl): (UInt16, UInt16) = c[open] == 40 ? (40, 41) : (123, 125)
            var depth = 0
            for k in open..<c.count {
                if c[k] == o { depth += 1 } else if c[k] == cl { depth -= 1; if depth == 0 { return k } }
            }
            return c.count
        }
        var out: [String] = []
        var i = 0
        while i < c.count {
            let ch = c[i]
            guard ch == 40 || ch == 123 else { i += 1; continue }
            let end = close(i)
            if ch == 123 {
                var j = i - 1
                while j >= 0, isSpace(c[j]) { j -= 1 }
                if j >= 0, c[j] == 40 { j -= 1; while j >= 0, isSpace(c[j]) { j -= 1 } }
                i = j >= 0 && mapping.contains(name(endingAt: j)) ? i + 1 : end + 1
                continue
            }
            let prev: UInt16 = i > 0 ? c[i - 1] : 32
            if isIdentifier(prev) || [41, 93, 63, 33, 62, 92].contains(prev) {
                i = mapping.contains(name(endingAt: i - 1)) ? i + 1 : end + 1
                continue
            }
            let inner = String(decoding: c[(i + 1)..<min(end, c.count)], as: UTF16.self)
            let after = end + 1 < c.count ? String(decoding: c[(end + 1)...], as: UTF16.self) : ""
            if splitTopLevel(inner).count >= 2 {
                if after.range(of: #"^\s*in\b"#, options: .regularExpression) == nil { out.append(inner) }
                i = end + 1
            } else {
                i += 1
            }
        }
        return out
    }

    /// The String positions of the tuple func's result that carry words: per element of each tuple
    /// literal a returned statement can be, plus what a tuple func it returns whole carries.
    private func tupleCarried(_ tf: TupleFunc) -> Set<Int> {
        var exprs: [(Int, String)] = []
        for (n, (k, text)) in tf.body.enumerated() {
            for m in matches(#"\breturn\b"#, text) {
                let more = tf.body[(n + 1)..<min(tf.body.count, n + Self.span)].map { $0.1 }
                exprs.append((k, ([(text as NSString).substring(from: NSMaxRange(m.range))] + more).joined(separator: "\n")))
            }
        }
        // A single-expression body returns itself.
        if exprs.isEmpty, let first = tf.body.first {
            exprs.append((first.0, tf.body.map { $0.1 }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        var out: Set<Int> = []
        let textPositions = Set(tf.fields.indices.filter { tf.fields[$0].text })
        for (k, raw) in exprs {
            let e = Self.statement(raw.trimmingCharacters(in: .whitespacesAndNewlines))
            for literal in Self.tupleLiterals(e) {
                let elements = Self.splitTopLevel(literal)
                for idx in textPositions where idx < elements.count && tainted(tf.file, k, unlabelled(elements[idx])) != nil {
                    out.insert(idx)
                }
            }
            for call in tupleCalls(tf.file, k, visible(sanitize(tf.file, k, e))) where call.projection == nil {
                out.formUnion((tupleHelpers[call.key] ?? []).intersection(textPositions))
            }
        }
        return out
    }

    /// The calls to tuple funcs in `e` (already visible), each with the element it projects, if any:
    /// `f(x)?.text`, `f(x).0`, `f(x).map { $0.text }`, `f(x).map(\.text)`.
    private func tupleCalls(_ fi: Int, _ i: Int, _ e: String) -> [(key: Key, name: String, projection: String?)] {
        guard !tupleHelpers.isEmpty else { return [] }
        let own = ownerType(fi, i)
        let s = e as NSString
        var out: [(key: Key, name: String, projection: String?)] = []
        func add(_ key: Key, _ name: String, open: Int) {
            guard tupleHelpers[key] != nil else { return }
            let (args, _) = Self.balanced(s, from: open)
            let after = s.substring(from: min(s.length, open + (args as NSString).length + 2))
            let member = #"([A-Za-z_][A-Za-z0-9_]*|[0-9]+)"#
            // What the element goes through after it is read and is still its words (`.uppercased()`, `?? ""`).
            let chain = #"(?:\s*[?!]?\.\s*(?:"# + Self.passThrough.sorted().joined(separator: "|")
                + #")\b\s*(?:\((?:[^()]|\([^()]*\))*\))?)*(?:\s*\?\?\s*"[^"]*")?"#
            // A mapping closure (its parameter header is gone in `visible`) that reads one element and
            // returns it; one that reads none (`.map { f($0) }`) projects `map`, which nothing carries.
            let projection = firstMatch(#"^\s*[?!]?\s*\.\s*(?:map|flatMap|compactMap)\s*(?:\(\s*\\\."# + member
                                        + #"\s*\)|\(?\s*\{\s*(?:\$0|[a-z_][A-Za-z0-9_]*)\s*[?!]?\.\s*"# + member
                                        + #"\b(?!\s*\()"# + chain + #"\s*\}\s*\)?)"#, after)
                ?? firstMatch(#"^\s*[?!]?\s*\.\s*"# + member + #"\b(?!\s*\()"#, after)
            let picked = projection.flatMap { p in (1...p.numberOfRanges - 1).map { Self.group(p, $0, in: after) }.first { !$0.isEmpty } }
            out.append((key, name, picked))
        }
        for m in matches(#"\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\("#, e) {
            let type = Self.group(m, 1, in: e), name = Self.group(m, 2, in: e)
            add(Key(type: type == "Self" ? own : type, name: name), "\(type == "Self" ? own : type).\(name)", open: NSMaxRange(m.range) - 1)
        }
        for m in matches(#"(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\s*\("#, e) {
            let name = Self.group(m, 1, in: e)
            let key = !own.isEmpty && tupleHelpers[Key(type: own, name: name)] != nil ? Key(type: own, name: name) : Key(type: "", name: name)
            add(key, name, open: NSMaxRange(m.range) - 1)
        }
        return out
    }

    /// A tuple func's String element read off its call, when that element carries words.
    private func tupleProjection(_ fi: Int, _ i: Int, _ e: String) -> String? {
        for call in tupleCalls(fi, i, e) {
            guard let p = call.projection, let carried = tupleHelpers[call.key] else { continue }
            let labels = tupleLabels[call.key] ?? []
            if carried.contains(where: { String($0) == p || ($0 < labels.count && labels[$0] == p) }) { return "\(call.name).\(p)" }
        }
        return nil
    }

    // MARK: Taint

    private func ownerType(_ fi: Int, _ i: Int) -> String {
        files[fi].regionType[files[fi].region[i]] ?? ""
    }

    /// The expression without its calls to a renderer that links (the shared inline renderer,
    /// or an AttributedString helper that calls it).
    private func sanitize(_ fi: Int, _ i: Int, _ expr: String) -> String {
        let own = ownerType(fi, i)
        var alternatives = [Self.sharedRenderer]
        for r in renderers.sorted(by: { ($0.type, $0.name) < ($1.type, $1.name) }) {
            if !r.type.isEmpty { alternatives.append(#"\b"# + r.type + #"\."# + r.name + #"\("#) }
            if r.type == own || r.type.isEmpty { alternatives.append(#"(?<![A-Za-z0-9_.])(?:Self\.)?"# + r.name + #"\("#) }
        }
        let pattern = alternatives.joined(separator: "|")
        var out = expr as NSString
        while let m = firstMatch(pattern, out as String) {
            let (inner, _) = Self.balanced(out, from: NSMaxRange(m.range) - 1)
            let end = min(out.length, NSMaxRange(m.range) + (inner as NSString).length + 1)
            out = out.replacingCharacters(in: NSRange(location: m.range.location, length: end - m.range.location), with: "") as NSString
        }
        return out as String
    }

    /// What of the expression is its value: closure bodies and other calls' arguments are dropped.
    private func visible(_ expr: String) -> String {
        let e = Array(expr.utf16)
        var out: [UInt16] = []
        var i = 0
        func isIdentifier(_ c: UInt16) -> Bool { (65...90).contains(c) || (97...122).contains(c) || (48...57).contains(c) || c == 95 }
        func skip(_ open: UInt16, _ close: UInt16) {
            var depth = 0
            while i < e.count {
                if e[i] == open { depth += 1 } else if e[i] == close { depth -= 1; if depth == 0 { break } }
                i += 1
            }
            i += 1
        }
        while i < e.count {
            let c = e[i]
            if c == 123 {
                var j = i - 1
                while j >= 0, e[j] == 32 || e[j] == 9 || e[j] == 10 { j -= 1 }
                // A closure passed in parentheses (`.map({ ... })`) is the same mapping.
                if j >= 0, e[j] == 40 {
                    j -= 1
                    while j >= 0, e[j] == 32 || e[j] == 9 || e[j] == 10 { j -= 1 }
                }
                var k = j
                while k >= 0, isIdentifier(e[k]) { k -= 1 }
                if j > k, Self.mapping.contains(String(decoding: e[(k + 1)...j], as: UTF16.self)) {
                    let start = i
                    skip(123, 125)
                    let body = String(decoding: e[(start + 1)..<min(e.count, max(start + 1, i - 1))], as: UTF16.self)
                    out += [123] + Array(visible(returned(body)).utf16) + [125]
                    continue
                }
                skip(123, 125)
                out += [123, 125]
                continue
            }
            if c == 40 {
                var j = i - 1
                while j >= 0, isIdentifier(e[j]) { j -= 1 }
                let name = String(decoding: e[(j + 1)..<i], as: UTF16.self)
                if !name.isEmpty, !Self.passThrough.contains(name), !keep.contains(name), !transforms.contains(name),
                   !helpers.contains(where: { $0.name == name }) {
                    skip(40, 41)
                    out += [40, 41]
                    continue
                }
            }
            out.append(c)
            i += 1
        }
        return String(decoding: out, as: UTF16.self)
    }

    /// What carries agent words into `expr` on that line: a field, a helper or a tainted name.
    private func tainted(_ fi: Int, _ i: Int, _ expr: String) -> String? {
        let e = visible(sanitize(fi, i, expr))
        if let m = firstMatch(Self.sourceFields, e) {
            return Self.group(m, 0, in: e).trimmingCharacters(in: CharacterSet(charactersIn: "."))
        }
        let own = ownerType(fi, i)
        for m in matches(#"\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\("#, e) {
            let type = Self.group(m, 1, in: e), name = Self.group(m, 2, in: e)
            if type == "Self", !own.isEmpty, helpers.contains(Key(type: own, name: name)) { return name }
            if helpers.contains(Key(type: type, name: name)) { return "\(type).\(name)" }
        }
        for m in matches(#"(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\s*\("#, e) {
            let name = Self.group(m, 1, in: e)
            if (!own.isEmpty && helpers.contains(Key(type: own, name: name))) || helpers.contains(Key(type: "", name: name)) { return name }
        }
        if let projected = tupleProjection(fi, i, e) { return projected }
        let f = files[fi]
        let scopes = [Scope(rel: f.rel, region: f.region[i], member: f.member[i]),
                      Scope(rel: f.rel, region: f.region[i], member: 0), Scope(rel: f.rel, region: 0, member: 0)]
        let names = scopes.reduce(into: Set<String>()) { $0.formUnion(taint[$1] ?? []) }
        guard !names.isEmpty else { return nil }
        let used = Set(matches(#"(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*\b"#, e).map { Self.group($0, 0, in: e) })
        return names.sorted().first { used.contains($0) }
    }

    private func used(_ expr: String) -> Set<String> {
        let e = visible(expr)
        return Set(matches(#"(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*\b"#, e).map { Self.group($0, 0, in: e) })
    }

    /// Whether the func's result is built from its parameters (a transform such as `clause(_:)`).
    private func returnsItsParameters(_ fn: Func) -> Bool {
        var derived = fn.params
        guard !derived.isEmpty else { return false }
        for _ in 0..<3 {
            for (_, text) in fn.body {
                for m in matches(Self.bindDecl, text) where !used((text as NSString).substring(from: NSMaxRange(m.range))).isDisjoint(with: derived) {
                    derived.insert(Self.group(m, 1, in: text))
                }
            }
        }
        return !used(returned(fn.body.map { $0.1 }.joined(separator: "\n"))).isDisjoint(with: derived)
    }

    private func mark(_ name: String, _ fi: Int, region: Int, member: Int) -> Bool {
        taint[Scope(rel: files[fi].rel, region: region, member: member), default: []].insert(name).inserted
    }

    // MARK: The pass

    /// Keys are `<file>|<the field or name that carried the words>`; `line` is where the call opens.
    func plainSites(_ raw: [(rel: String, source: String)]) -> [Hit] {
        files = raw.map { parse($0.rel, $0.source) }
        for fi in files.indices { collect(fi) }
        var changed = true
        while changed {
            changed = false
            for fn in funcs {
                let key = Key(type: ownerType(fn.file, fn.line), name: fn.name)
                if fn.attributed, !renderers.contains(key), fn.body.contains(where: { sanitize(fn.file, $0.0, $0.1) != $0.1 }) {
                    renderers.insert(key)
                    changed = true
                }
                if !fn.attributed, !transforms.contains(fn.name), returnsItsParameters(fn) {
                    transforms.insert(fn.name)
                    changed = true
                }
                // A non-linking AttributedString helper that reads agent words is a source too.
                if !fn.attributed || !renderers.contains(key), !helpers.contains(key),
                   fn.body.contains(where: { tainted(fn.file, $0.0, $0.1) != nil }) {
                    helpers.insert(key)
                    changed = true
                }
            }
            for tf in tupleFuncs {
                let key = Key(type: ownerType(tf.file, tf.line), name: tf.name)
                if tupleLabels[key] == nil { tupleLabels[key] = tf.fields.map(\.label) }
                let carried = tupleCarried(tf)
                // Known even while it carries nothing, so a wrapper of it is read; an empty set never taints.
                let had = tupleHelpers[key]
                if had == nil || !carried.isSubset(of: had!) {
                    tupleHelpers[key] = (had ?? []).union(carried)
                    changed = true
                }
            }
            for c in computed where tainted(c.file, c.line, c.expr) != nil {
                if mark(c.name, c.file, region: files[c.file].region[c.line], member: 0) { changed = true }
            }
            for flow in flows where tainted(flow.file, flow.line, flow.expr) != nil {
                let f = files[flow.file]
                if mark(flow.name, flow.file, region: f.region[flow.line], member: f.member[flow.line]) { changed = true }
            }
            for arg in arguments where !props.contains(arg.key) && tainted(arg.file, arg.line, arg.expr) != nil {
                props.insert(arg.key)
                changed = true
            }
            for (fi, f) in files.enumerated() {
                for (region, type) in f.regionType {
                    let wanted = props.filter { $0.type == type }
                    guard !wanted.isEmpty else { continue }
                    let stored = f.lines.indices.filter { f.region[$0] == region && f.member[$0] == 0 }.map { f.lines[$0] }.joined(separator: "\n")
                    for prop in wanted
                    where firstMatch(#"\b(?:let|var)\s+"# + prop.name + #"\s*:\s*String\??(?:\s*=\s*nil)?\s*$"#, stored, .anchorsMatchLines) != nil {
                        if mark(prop.name, fi, region: region, member: 0) { changed = true }
                    }
                }
            }
        }
        var hits: [Hit] = []
        for (fi, f) in files.enumerated() {
            for (i, line) in f.lines.enumerated() {
                for m in matches(#"(?<![A-Za-z0-9_.])(Text|Label|Button)\("#, line) {
                    let args = Self.callArguments(f.lines, i, open: NSMaxRange(m.range) - 1)
                    var arg: String
                    if Self.group(m, 1, in: line) == "Text" {
                        arg = args
                        if let label = firstMatch(#"^\s*(?:verbatim|inline):\s*"#, arg) { arg = (arg as NSString).substring(from: NSMaxRange(label.range)) }
                    } else {
                        // A title only: a labelled first argument is an action, a role or a view builder.
                        arg = Self.splitTopLevel(args)[0]
                        if firstMatch(#"^\s*[a-z][A-Za-z0-9_]*\s*:"#, arg) != nil { continue }
                    }
                    if let name = tainted(fi, i, arg) {
                        hits.append(Hit(key: "\(f.rel)|\(name)", line: i + 1, code: line.trimmingCharacters(in: .whitespaces)))
                    }
                }
            }
        }
        return hits
    }
}
