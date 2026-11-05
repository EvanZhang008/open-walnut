import UIKit

/// Fenced code blocks: the header's language label, syntax colors, and the one
/// wrap preference every block follows. The web console does the same in
/// web/src/utils/code-block.ts; labels and colors match it.
///
/// Pure CPU work on thread-safe types (NSRegularExpression, NSAttributedString,
/// dynamic UIColors), run by the row builder on the layout actor.
enum CodeHighlighter {

    /// A block longer than this is drawn uncolored: a streaming reply rebuilds
    /// its live rows on every tick, and the live block is the one still growing.
    static let maxHighlightLength = 20_000

    // MARK: - Language

    struct Fence: Equatable {
        /// Grammar family to color with, nil = plain.
        let grammar: Grammar?
        /// What the header shows ("" when the fence named nothing).
        let label: String
    }

    enum Grammar: Equatable {
        case cLike(keywords: Set<String>, hashComments: Bool, templateStrings: Bool)
        case hash(keywords: Set<String>)
        case sql
        case json
        case markup
        case css
        case diff
    }

    private static let aliases: [String: String] = [
        "ts": "typescript", "mts": "typescript", "cts": "typescript", "js": "javascript", "mjs": "javascript",
        "cjs": "javascript", "node": "javascript", "py": "python", "python3": "python", "pyi": "python",
        "sh": "bash", "shell": "bash", "zsh": "bash", "console": "bash", "terminal": "bash", "shellsession": "bash",
        "yml": "yaml", "rb": "ruby", "rs": "rust", "golang": "go", "kt": "kotlin", "kts": "kotlin",
        "cs": "csharp", "c#": "csharp", "c++": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp", "h": "c",
        "objc": "objectivec", "objective-c": "objectivec", "htm": "html", "svg": "xml", "vue": "html",
        "jsonc": "json", "json5": "json", "jsonl": "json", "md": "markdown", "dockerfile": "docker",
        "containerfile": "docker", "make": "makefile", "mk": "makefile", "tf": "hcl", "terraform": "hcl",
        "ps1": "powershell", "pwsh": "powershell", "patch": "diff", "conf": "ini", "cfg": "ini",
    ]

    private static let labels: [String: String] = [
        "typescript": "TypeScript", "tsx": "TSX", "javascript": "JavaScript", "jsx": "JSX", "python": "Python",
        "bash": "Shell", "json": "JSON", "yaml": "YAML", "toml": "TOML", "ini": "INI", "css": "CSS",
        "scss": "SCSS", "less": "Less", "go": "Go", "rust": "Rust", "java": "Java", "kotlin": "Kotlin",
        "swift": "Swift", "c": "C", "cpp": "C++", "csharp": "C#", "ruby": "Ruby", "php": "PHP", "lua": "Lua",
        "perl": "Perl", "r": "R", "sql": "SQL", "diff": "Diff", "markdown": "Markdown", "makefile": "Makefile",
        "objectivec": "Objective-C", "docker": "Dockerfile", "graphql": "GraphQL", "powershell": "PowerShell",
        "hcl": "HCL", "html": "HTML", "xml": "XML", "dart": "Dart", "scala": "Scala",
    ]

    private static let plainWords: Set<String> = ["text", "txt", "plain", "plaintext", "output", "log", "none"]

    /// Extensions a fence written as a file name (```` ```src/app.py ````) maps to.
    private static let extensions: [String: String] = [
        "ts": "typescript", "tsx": "tsx", "js": "javascript", "jsx": "jsx", "py": "python", "go": "go",
        "rs": "rust", "rb": "ruby", "java": "java", "kt": "kotlin", "swift": "swift", "c": "c", "h": "c",
        "cc": "cpp", "cpp": "cpp", "hpp": "cpp", "cs": "csharp", "php": "php", "lua": "lua", "sh": "bash",
        "bash": "bash", "zsh": "bash", "json": "json", "yaml": "yaml", "yml": "yaml", "toml": "toml",
        "ini": "ini", "css": "css", "scss": "scss", "html": "html", "xml": "xml", "md": "markdown",
        "sql": "sql", "diff": "diff", "m": "objectivec", "dart": "dart", "scala": "scala",
    ]

    /// Read a fence's info string: `ts`, `TypeScript`, `src/app.py`,
    /// `ts title="a.ts"`, `{.python}`. Same reading as the web console's.
    static func fence(_ info: String?) -> Fence {
        let raw = (info ?? "").trimmingCharacters(in: .whitespaces)
        var word = String(raw.prefix { !$0.isWhitespace })
        word = word.trimmingCharacters(in: CharacterSet(charactersIn: "{}"))
        if word.hasPrefix(".") { word.removeFirst() }
        if let colon = word.firstIndex(of: ":"), colon != word.startIndex {
            word = String(word[..<colon])
        }
        let lower = word.lowercased()
        if lower.isEmpty { return Fence(grammar: nil, label: "Text") }
        if plainWords.contains(lower) { return Fence(grammar: nil, label: "Text") }
        // A file name: the file's own name is the label.
        if lower.contains("."), let ext = lower.split(separator: ".").last.map(String.init),
           ext.first?.isLetter == true, aliases[lower] == nil, labels[lower] == nil {
            if let lang = extensions[ext] { return Fence(grammar: grammar(for: lang), label: word) }
            return Fence(grammar: nil, label: word)
        }
        let lang = aliases[lower] ?? lower
        return Fence(grammar: grammar(for: lang), label: labels[lang] ?? word)
    }

    private static func grammar(for lang: String) -> Grammar? {
        switch lang {
        case "typescript", "tsx", "javascript", "jsx":
            return .cLike(keywords: jsKeywords, hashComments: false, templateStrings: true)
        case "java", "kotlin", "scala", "dart", "csharp":
            return .cLike(keywords: jvmKeywords, hashComments: false, templateStrings: false)
        case "swift": return .cLike(keywords: swiftKeywords, hashComments: false, templateStrings: false)
        case "go": return .cLike(keywords: goKeywords, hashComments: false, templateStrings: true)
        case "rust": return .cLike(keywords: rustKeywords, hashComments: false, templateStrings: false)
        case "c", "cpp", "objectivec": return .cLike(keywords: cKeywords, hashComments: false, templateStrings: false)
        case "php": return .cLike(keywords: jvmKeywords.union(["function", "echo", "foreach", "as", "array", "fn"]), hashComments: true, templateStrings: false)
        case "graphql", "hcl": return .cLike(keywords: ["query", "mutation", "type", "input", "enum", "fragment", "on", "resource", "variable", "module", "provider", "output", "locals", "data"], hashComments: true, templateStrings: false)
        case "python": return .hash(keywords: pythonKeywords)
        case "ruby": return .hash(keywords: rubyKeywords)
        case "bash", "powershell", "docker", "makefile": return .hash(keywords: shellKeywords)
        case "yaml", "toml", "ini", "perl", "r": return .hash(keywords: ["true", "false", "null", "yes", "no", "on", "off"])
        case "sql": return .sql
        case "json": return .json
        case "html", "xml", "markdown": return lang == "markdown" ? nil : .markup
        case "css", "scss", "less": return .css
        case "diff": return .diff
        default: return nil
        }
    }

    // MARK: - Keywords

    private static let literals: Set<String> = ["true", "false", "null", "nil", "None", "True", "False", "undefined", "NaN", "self", "this", "super"]
    private static let jsKeywords: Set<String> = [
        "import", "export", "from", "default", "const", "let", "var", "function", "return", "if", "else", "for",
        "while", "do", "switch", "case", "break", "continue", "new", "class", "extends", "implements", "interface",
        "type", "enum", "async", "await", "yield", "try", "catch", "finally", "throw", "typeof", "instanceof", "in",
        "of", "as", "void", "delete", "static", "public", "private", "protected", "readonly", "declare", "namespace",
        "keyof", "satisfies", "get", "set",
    ]
    private static let jvmKeywords: Set<String> = [
        "package", "import", "class", "interface", "enum", "extends", "implements", "public", "private", "protected",
        "static", "final", "abstract", "void", "return", "if", "else", "for", "while", "do", "switch", "case",
        "break", "continue", "new", "try", "catch", "finally", "throw", "throws", "int", "long", "double", "float",
        "boolean", "char", "byte", "short", "var", "val", "fun", "object", "when", "is", "in", "override", "data",
        "sealed", "using", "namespace", "async", "await", "string", "def", "lazy", "const", "late", "required",
    ]
    private static let swiftKeywords: Set<String> = [
        "import", "let", "var", "func", "return", "if", "else", "guard", "for", "in", "while", "repeat", "switch",
        "case", "default", "break", "continue", "struct", "class", "enum", "protocol", "extension", "init",
        "deinit", "public", "private", "fileprivate", "internal", "open", "static", "final", "override", "mutating",
        "throws", "throw", "try", "catch", "do", "async", "await", "actor", "some", "any", "where", "typealias",
        "associatedtype", "weak", "unowned", "lazy", "inout", "defer", "as", "is", "subscript", "nonisolated",
    ]
    private static let goKeywords: Set<String> = [
        "package", "import", "func", "return", "if", "else", "for", "range", "switch", "case", "default", "break",
        "continue", "go", "defer", "select", "chan", "map", "struct", "interface", "type", "var", "const",
        "fallthrough", "goto",
    ]
    private static let rustKeywords: Set<String> = [
        "fn", "let", "mut", "pub", "use", "mod", "crate", "struct", "enum", "impl", "trait", "for", "in", "if",
        "else", "match", "loop", "while", "return", "break", "continue", "as", "ref", "move", "async", "await",
        "dyn", "where", "type", "const", "static", "unsafe", "extern", "Self",
    ]
    private static let cKeywords: Set<String> = [
        "int", "char", "float", "double", "void", "long", "short", "unsigned", "signed", "const", "static",
        "struct", "union", "enum", "typedef", "return", "if", "else", "for", "while", "do", "switch", "case",
        "default", "break", "continue", "sizeof", "include", "define", "class", "public", "private", "protected",
        "namespace", "using", "template", "typename", "virtual", "new", "delete", "auto", "bool",
    ]
    private static let pythonKeywords: Set<String> = [
        "import", "from", "as", "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not",
        "and", "or", "is", "with", "try", "except", "finally", "raise", "pass", "break", "continue", "lambda",
        "yield", "async", "await", "global", "nonlocal", "assert", "del", "print",
    ]
    private static let rubyKeywords: Set<String> = [
        "def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do",
        "return", "yield", "begin", "rescue", "ensure", "require", "include", "attr_accessor", "puts", "then",
    ]
    private static let shellKeywords: Set<String> = [
        "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac",
        "function", "return", "export", "local", "readonly", "source", "echo", "cd", "exit", "set", "unset",
        "sudo", "FROM", "RUN", "COPY", "ADD", "CMD", "ENTRYPOINT", "ENV", "ARG", "WORKDIR", "EXPOSE", "USER",
    ]

    // MARK: - Colors (GitHub light / dark, as on the web)

    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) }
    }
    private static func rgb(_ v: UInt32) -> UIColor {
        UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
    static let commentColor = dynamic(0x6e7781, 0x8b949e)
    static let keywordColor = dynamic(0xcf222e, 0xff7b72)
    static let stringColor = dynamic(0x0a3069, 0xa5d6ff)
    static let numberColor = dynamic(0x0550ae, 0x79c0ff)
    static let functionColor = dynamic(0x8250df, 0xd2a8ff)
    static let variableColor = dynamic(0x953800, 0xffa657)
    static let tagColor = dynamic(0x116329, 0x7ee787)

    // MARK: - Tokens

    private enum Kind { case comment, string, number, keyword, function, type, variable, tag, attr, added, removed, hunk }

    private static func regex(_ pattern: String) -> NSRegularExpression {
        // Patterns are literals below; a typo is a crash in the first test run.
        try! NSRegularExpression(pattern: pattern, options: [])
    }

    private static let number = #"\b(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b"#
    private static let ident = #"[A-Za-z_$][\w$]*"#
    private static let dq = #""(?:\\.|[^"\\\n])*""#
    private static let sq = #"'(?:\\.|[^'\\\n])*'"#

    private static let cLikeRe = regex(#"(?<c>//[^\n]*|/\*[\s\S]*?(?:\*/|$))|(?<s>"""[\s\S]*?(?:"""|$)|"# + dq + "|" + sq + #")|(?<n>"# + number + #")|(?<i>"# + ident + ")")
    private static let cLikeTemplateRe = regex(#"(?<c>//[^\n]*|/\*[\s\S]*?(?:\*/|$))|(?<s>`(?:\\.|[^`\\])*`?|"# + dq + "|" + sq + #")|(?<n>"# + number + #")|(?<i>"# + ident + ")")
    private static let cLikeHashRe = regex(#"(?<c>//[^\n]*|#[^\n]*|/\*[\s\S]*?(?:\*/|$))|(?<s>"# + dq + "|" + sq + #")|(?<n>"# + number + #")|(?<i>"# + ident + ")")
    private static let hashRe = regex(#"(?<c>(?:^|(?<=\s))#[^\n]*)|(?<s>"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"# + dq + "|" + sq + #")|(?<v>\$\{[^}\n]*\}|\$\w+)|(?<n>"# + number + #")|(?<i>[A-Za-z_][\w-]*)"#)
    private static let sqlRe = regex(#"(?<c>--[^\n]*|/\*[\s\S]*?(?:\*/|$))|(?<s>"# + sq + "|" + dq + #")|(?<n>"# + number + #")|(?<i>"# + ident + ")")
    private static let jsonRe = regex(#"(?<k>"(?:\\.|[^"\\\n])*"(?=\s*:))|(?<s>"# + dq + #")|(?<n>-?"# + number + #")|(?<i>true|false|null)"#)
    private static let markupRe = regex(#"(?<c><!--[\s\S]*?(?:-->|$))|(?<t></?[A-Za-z][\w:.-]*|/?>)|(?<a>\b[\w:-]+(?==))|(?<s>"# + dq + "|" + sq + ")")
    private static let cssRe = regex(#"(?<c>/\*[\s\S]*?(?:\*/|$))|(?<s>"# + dq + "|" + sq + #")|(?<a>@[\w-]+|[\w-]+(?=\s*:[^:]))|(?<n>#[0-9a-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg)?\b)"#)

    private static let sqlKeywords: Set<String> = [
        "select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete",
        "create", "table", "drop", "alter", "index", "join", "left", "right", "inner", "outer", "on", "group",
        "by", "order", "having", "limit", "offset", "as", "distinct", "union", "all", "case", "when", "then",
        "else", "end", "null", "is", "in", "like", "primary", "key", "default", "with", "returning", "exists",
    ]

    /// `code` drawn in `font`, colored for `grammar` (plain when nil or too long).
    static func attributed(_ code: String, grammar: Grammar?, font: UIFont) -> NSAttributedString {
        let out = NSMutableAttributedString(string: code, attributes: [.font: font, .foregroundColor: UIColor.label])
        guard let grammar, code.utf16.count <= maxHighlightLength, !code.isEmpty else { return out }
        let ns = code as NSString
        let full = NSRange(location: 0, length: ns.length)
        func paint(_ range: NSRange, _ kind: Kind) {
            let color: UIColor
            switch kind {
            case .comment: color = commentColor
            case .string: color = stringColor
            case .number: color = numberColor
            case .keyword, .removed: color = keywordColor
            case .function, .type: color = functionColor
            case .variable, .attr: color = variableColor
            case .tag, .added: color = tagColor
            case .hunk: color = numberColor
            }
            out.addAttribute(.foregroundColor, value: color, range: range)
        }
        /// The character after `range`, skipping spaces (is this a call?).
        func nextIsParen(_ range: NSRange) -> Bool {
            var i = range.location + range.length
            while i < ns.length, ns.character(at: i) == 0x20 { i += 1 }
            return i < ns.length && ns.character(at: i) == 0x28
        }
        func scan(_ re: NSRegularExpression, keywords: Set<String>, caseInsensitive: Bool = false, types: Bool) {
            for m in re.matches(in: code, range: full) {
                if m.range(withName: "c").location != NSNotFound { paint(m.range, .comment); continue }
                if m.range(withName: "s").location != NSNotFound { paint(m.range, .string); continue }
                if m.range(withName: "n").location != NSNotFound { paint(m.range, .number); continue }
                let iRange = m.range(withName: "i")
                guard iRange.location != NSNotFound else { continue }
                let word = ns.substring(with: iRange)
                if keywords.contains(caseInsensitive ? word.lowercased() : word) { paint(iRange, .keyword) }
                else if literals.contains(word) { paint(iRange, .number) }
                else if nextIsParen(iRange) { paint(iRange, .function) }
                else if types, let first = word.unicodeScalars.first, CharacterSet.uppercaseLetters.contains(first),
                        word.count > 1 { paint(iRange, .type) }
            }
        }
        switch grammar {
        case .cLike(let keywords, let hashComments, let templateStrings):
            scan(hashComments ? cLikeHashRe : (templateStrings ? cLikeTemplateRe : cLikeRe), keywords: keywords, types: true)
        case .hash(let keywords):
            for m in hashRe.matches(in: code, range: full) {
                if m.range(withName: "c").location != NSNotFound { paint(m.range, .comment); continue }
                if m.range(withName: "s").location != NSNotFound { paint(m.range, .string); continue }
                if m.range(withName: "v").location != NSNotFound { paint(m.range, .variable); continue }
                if m.range(withName: "n").location != NSNotFound { paint(m.range, .number); continue }
                let r = m.range(withName: "i")
                guard r.location != NSNotFound else { continue }
                let word = ns.substring(with: r)
                if keywords.contains(word) { paint(r, .keyword) }
                else if literals.contains(word) { paint(r, .number) }
                else if nextIsParen(r) { paint(r, .function) }
            }
        case .sql:
            scan(sqlRe, keywords: sqlKeywords, caseInsensitive: true, types: false)
        case .json:
            for m in jsonRe.matches(in: code, range: full) {
                if m.range(withName: "k").location != NSNotFound { paint(m.range, .tag) }
                else if m.range(withName: "s").location != NSNotFound { paint(m.range, .string) }
                else { paint(m.range, .number) }
            }
        case .markup:
            for m in markupRe.matches(in: code, range: full) {
                if m.range(withName: "c").location != NSNotFound { paint(m.range, .comment) }
                else if m.range(withName: "t").location != NSNotFound { paint(m.range, .tag) }
                else if m.range(withName: "a").location != NSNotFound { paint(m.range, .attr) }
                else { paint(m.range, .string) }
            }
        case .css:
            for m in cssRe.matches(in: code, range: full) {
                if m.range(withName: "c").location != NSNotFound { paint(m.range, .comment) }
                else if m.range(withName: "s").location != NSNotFound { paint(m.range, .string) }
                else if m.range(withName: "a").location != NSNotFound { paint(m.range, .number) }
                else { paint(m.range, .variable) }
            }
        case .diff:
            ns.enumerateSubstrings(in: full, options: [.byLines, .substringNotRequired]) { _, range, _, _ in
                guard range.length > 0 else { return }
                switch ns.character(at: range.location) {
                case 0x2B: paint(range, .added)    // +
                case 0x2D: paint(range, .removed)  // -
                case 0x40: paint(range, .hunk)     // @
                default: break
                }
            }
        }
        return out
    }
}

extension CodeHighlighter {
    /// Which block this is for its Wrap state: its fence word and first line.
    /// Row ids do not do: a streaming reply's rows move between the live head,
    /// tail and the received message, each with its own id prefix, and the
    /// state must ride along through all of them.
    static func blockKey(code: String, language: String?) -> String {
        let firstLine = code.prefix { $0 != "\n" }
        return "\(language ?? "")\n\(firstLine)"
    }

    /// Wrapped, a line's continuation starts two columns deeper than the line
    /// itself (a tab counts to the next stop of 4), so it never reads as a new,
    /// outer line. Measured and drawn from the same string (the builder).
    static func hangingIndents(_ text: NSAttributedString, font: UIFont) -> NSAttributedString {
        let ns = text.string as NSString
        guard ns.length > 0 else { return text }
        let out = NSMutableAttributedString(attributedString: text)
        let column = (" " as NSString).size(withAttributes: [.font: font]).width
        var start = 0
        while start < ns.length {
            let line = ns.lineRange(for: NSRange(location: start, length: 0))
            var cols = 0
            var i = line.location
            while i < NSMaxRange(line) {
                let c = ns.character(at: i)
                if c == 32 { cols += 1 } else if c == 9 { cols += 4 - cols % 4 } else { break }
                i += 1
            }
            let style = NSMutableParagraphStyle()
            style.headIndent = CGFloat(min(cols, 40) + 2) * column
            out.addAttribute(.paragraphStyle, value: style, range: line)
            start = NSMaxRange(line)
        }
        return out
    }
}
