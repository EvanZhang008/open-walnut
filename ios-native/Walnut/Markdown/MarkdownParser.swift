import Foundation

/// One rendered block of a markdown note. `sourceLine` indices always refer to
/// the ORIGINAL note content (frontmatter included) so task toggles can rewrite
/// the exact line and save without disturbing anything else.
struct MarkdownBlock: Identifiable, Equatable {
    let id: Int
    let kind: Kind

    enum Kind: Equatable {
        case heading(level: Int, text: AttributedString)
        case paragraph(AttributedString)
        case listItem(indent: Int, marker: ListMarker, text: AttributedString)
        case taskItem(indent: Int, checked: Bool, text: AttributedString, sourceLine: Int)
        case code(language: String?, text: String)
        case quote(lines: [AttributedString])
        case rule
        /// `raw` is the inner text of `![[...]]` or the URL of `![alt](url)`.
        case image(raw: String, alt: String)
        /// Non-image `![[...]]` embed (another note / synced block) — chip.
        case embed(name: String)
        case table(header: [AttributedString], rows: [[AttributedString]])
    }

    enum ListMarker: Equatable {
        case bullet
        case number(Int)
    }
}

/// Small hand-rolled block parser: splits a note into blocks, then uses
/// AttributedString(markdown:) for inline styling within each block.
enum MarkdownParser {
    static func parse(_ content: String) -> [MarkdownBlock] {
        let lines = content.components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var nextID = 0
        func add(_ kind: MarkdownBlock.Kind) {
            blocks.append(MarkdownBlock(id: nextID, kind: kind))
            nextID += 1
        }

        var index = 0

        // YAML frontmatter: hidden in rendered mode.
        if lines.first?.trimmingCharacters(in: .whitespaces) == "---" {
            var end = 1
            while end < lines.count, lines[end].trimmingCharacters(in: .whitespaces) != "---" {
                end += 1
            }
            if end < lines.count { index = end + 1 }
        }

        var paragraph: [String] = []
        func flushParagraph() {
            let text = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            paragraph = []
            guard !text.isEmpty else { return }
            for piece in splitImages(text) {
                switch piece {
                case .text(let t):
                    // HTML comments render as noise — drop pure-comment runs.
                    let stripped = t.replacingOccurrences(
                        of: #"<!--.*?-->"#, with: "", options: .regularExpression
                    ).trimmingCharacters(in: .whitespaces)
                    if !stripped.isEmpty { add(.paragraph(inline(stripped))) }
                case .image(let raw, let alt): add(.image(raw: raw, alt: alt))
                case .embed(let name): add(.embed(name: name))
                }
            }
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }

            // Code fence
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let fence = String(trimmed.prefix(3))
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                index += 1
                while index < lines.count,
                      !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    body.append(lines[index])
                    index += 1
                }
                index += 1 // skip closing fence (or run off the end)
                add(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n")))
                continue
            }

            // Heading
            if let (level, text) = headingParts(trimmed) {
                flushParagraph()
                add(.heading(level: level, text: inline(text)))
                index += 1
                continue
            }

            // Horizontal rule (frontmatter already consumed above)
            if isRule(trimmed) {
                flushParagraph()
                add(.rule)
                index += 1
                continue
            }

            // Block quote — accumulate consecutive `>` lines
            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quoteLines: [AttributedString] = []
                while index < lines.count {
                    let t = lines[index].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix(">") else { break }
                    quoteLines.append(inline(String(t.dropFirst()).trimmingCharacters(in: .whitespaces)))
                    index += 1
                }
                add(.quote(lines: quoteLines))
                continue
            }

            // Table: header row + `|---|` separator on the next line
            if trimmed.contains("|"), index + 1 < lines.count,
               isTableSeparator(lines[index + 1]) {
                flushParagraph()
                let header = tableCells(lines[index])
                var rows: [[AttributedString]] = []
                index += 2
                while index < lines.count,
                      lines[index].trimmingCharacters(in: .whitespaces).contains("|"),
                      !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(tableCells(lines[index]))
                    index += 1
                }
                add(.table(header: header, rows: rows))
                continue
            }

            // Task / bullet / ordered list items
            if let item = listItemParts(line) {
                flushParagraph()
                var text = item.text
                var images: [(String, String)] = []
                for piece in splitImages(text) {
                    if case .image(let raw, let alt) = piece { images.append((raw, alt)) }
                }
                if !images.isEmpty || text.contains("![[") {
                    text = removeImages(from: text)
                }
                if let checked = item.checked {
                    add(.taskItem(indent: item.indent, checked: checked, text: inline(text), sourceLine: index))
                } else {
                    add(.listItem(indent: item.indent, marker: item.marker, text: inline(text)))
                }
                for (raw, alt) in images { add(.image(raw: raw, alt: alt)) }
                index += 1
                continue
            }

            paragraph.append(trimmed)
            index += 1
        }
        flushParagraph()
        return blocks
    }

    /// Flip a `- [ ]`/`- [x]` on `sourceLine` of the original content.
    /// Returns nil when the line no longer looks like a task (stale render).
    static func togglingTask(in content: String, sourceLine: Int, to checked: Bool) -> String? {
        var lines = content.components(separatedBy: "\n")
        guard sourceLine < lines.count else { return nil }
        let line = lines[sourceLine]
        guard let range = line.range(of: #"\[( |x|X)\]"#, options: .regularExpression) else { return nil }
        lines[sourceLine] = line.replacingCharacters(in: range, with: checked ? "[x]" : "[ ]")
        return lines.joined(separator: "\n")
    }

    /// First lines of body text (frontmatter + markdown syntax stripped) for
    /// Apple Notes-style list previews.
    static func preview(of content: String, limit: Int = 90) -> String {
        for block in parse(content).prefix(6) {
            let text: String
            switch block.kind {
            case .paragraph(let t), .heading(_, let t): text = String(t.characters)
            case .listItem(_, _, let t), .taskItem(_, _, let t, _): text = String(t.characters)
            case .quote(let lines): text = lines.map { String($0.characters) }.joined(separator: " ")
            case .code(_, let t): text = t
            default: continue
            }
            let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty { return String(cleaned.prefix(limit)) }
        }
        return ""
    }

    // MARK: - Inline styling

    /// Inline markdown → AttributedString; wikilinks display their alias.
    static func inline(_ text: String) -> AttributedString {
        var source = text
        // [[Note|alias]] → alias, [[path/To/Note]] → Note (display text only)
        source = source.replacingOccurrences(
            of: #"\[\[([^\]|]+)\|([^\]]+)\]\]"#, with: "$2", options: .regularExpression
        )
        while let range = source.range(of: #"\[\[([^\]]+)\]\]"#, options: .regularExpression) {
            let inner = String(source[range].dropFirst(2).dropLast(2))
            let title = inner.components(separatedBy: "/").last ?? inner
            source.replaceSubrange(range, with: title)
        }
        // AttributedString(markdown:) doesn't know `<u>` — mark the ranges
        // ourselves, then strip the tags before handing off to the parser.
        var underlineRanges: [Range<String.Index>] = []
        while let openRange = source.range(of: "<u>"),
              let closeRange = source.range(of: "</u>", range: openRange.upperBound..<source.endIndex) {
            let innerText = String(source[openRange.upperBound..<closeRange.lowerBound])
            source.replaceSubrange(openRange.lowerBound..<closeRange.upperBound, with: innerText)
            if let newRange = source.range(of: innerText, range: openRange.lowerBound..<source.endIndex) {
                underlineRanges.append(newRange)
            }
        }
        var attributed: AttributedString
        if let parsed = try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            attributed = parsed
        } else {
            attributed = AttributedString(source)
        }
        for stringRange in underlineRanges {
            if let lower = AttributedString.Index(stringRange.lowerBound, within: attributed),
               let upper = AttributedString.Index(stringRange.upperBound, within: attributed) {
                attributed[lower..<upper].underlineStyle = .single
            }
        }
        return attributed
    }

    // MARK: - Line classification helpers

    private static func headingParts(_ trimmed: String) -> (Int, String)? {
        guard trimmed.hasPrefix("#") else { return nil }
        let hashes = trimmed.prefix(while: { $0 == "#" })
        let level = hashes.count
        guard level <= 6 else { return nil }
        let rest = trimmed.dropFirst(level)
        guard rest.first == " " || rest.isEmpty else { return nil }
        return (level, rest.trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ trimmed: String) -> Bool {
        guard trimmed.count >= 3 else { return false }
        let set = Set(trimmed)
        return set == ["-"] || set == ["*"] || set == ["_"]
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.contains("-"), t.contains("|") || t.hasPrefix(":") else { return false }
        return t.allSatisfy { "|-: ".contains($0) }
    }

    private static func tableCells(_ line: String) -> [AttributedString] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { inline($0.trimmingCharacters(in: .whitespaces)) }
    }

    private struct ListItem {
        let indent: Int
        let marker: MarkdownBlock.ListMarker
        let checked: Bool? // non-nil = task item
        let text: String
    }

    private static func listItemParts(_ line: String) -> ListItem? {
        let indentChars = line.prefix(while: { $0 == " " || $0 == "\t" })
        let indent = indentChars.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) } / 2
        let rest = String(line.dropFirst(indentChars.count))

        // Bullet (and task) items: -, *, +
        if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            var text = String(rest.dropFirst(2))
            // Task checkbox?
            if text.hasPrefix("[ ] ") || text == "[ ]" {
                text = String(text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                return ListItem(indent: indent, marker: .bullet, checked: false, text: text)
            }
            if text.lowercased().hasPrefix("[x] ") || text.lowercased() == "[x]" {
                text = String(text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                return ListItem(indent: indent, marker: .bullet, checked: true, text: text)
            }
            return ListItem(indent: indent, marker: .bullet, checked: nil, text: text)
        }

        // Ordered items: 1. or 1)
        if let match = rest.range(of: #"^\d{1,3}[.)] "#, options: .regularExpression) {
            let numberText = rest[rest.startIndex..<match.upperBound].dropLast(2)
            let number = Int(numberText) ?? 1
            let text = String(rest[match.upperBound...])
            return ListItem(indent: indent, marker: .number(number), checked: nil, text: text)
        }
        return nil
    }

    // MARK: - Image extraction

    enum TextOrImage {
        case text(String)
        case image(raw: String, alt: String)
        /// `![[...]]` whose target is NOT an image (note / synced block embed).
        case embed(name: String)
    }

    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]

    static func isImagePath(_ raw: String) -> Bool {
        imageExtensions.contains((raw as NSString).pathExtension.lowercased())
    }

    /// Split a text run around `![[embed]]` and `![alt](url)` images.
    static func splitImages(_ text: String) -> [TextOrImage] {
        let pattern = #"!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [.text(text)] }
        let ns = text as NSString
        var pieces: [TextOrImage] = []
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if match.range.location > cursor {
                let before = ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
                if !before.trimmingCharacters(in: .whitespaces).isEmpty { pieces.append(.text(before)) }
            }
            if match.range(at: 1).location != NSNotFound {
                // ![[inner]] — inner may carry an Obsidian size suffix like "|300"
                let inner = ns.substring(with: match.range(at: 1))
                let raw = inner.components(separatedBy: "|").first ?? inner
                if isImagePath(raw) {
                    pieces.append(.image(raw: raw, alt: ""))
                } else {
                    pieces.append(.embed(name: (raw as NSString).lastPathComponent))
                }
            } else {
                let alt = ns.substring(with: match.range(at: 2))
                let url = ns.substring(with: match.range(at: 3))
                pieces.append(.image(raw: url, alt: alt))
            }
            cursor = match.range.location + match.range.length
        }
        if cursor < ns.length {
            let after = ns.substring(from: cursor)
            if !after.trimmingCharacters(in: .whitespaces).isEmpty { pieces.append(.text(after)) }
        }
        return pieces.isEmpty ? [.text(text)] : pieces
    }

    private static func removeImages(from text: String) -> String {
        text
            .replacingOccurrences(of: #"!\[\[[^\]]+\]\]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"!\[[^\]]*\]\([^)]+\)"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }
}
