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
    // Block parsing is expensive: several regex passes plus a per-block
    // AttributedString(markdown:) inline parse. Chat re-evaluates EVERY visible
    // row's body each time the streaming text ticks (~8Hz) — without
    // memoization every tick re-parsed all on-screen history on the main
    // thread, saturating it enough to freeze the UI and trip the 0x8BADF00D
    // watchdog kill on long threads. Cache by exact content so a stable row
    // parses exactly once; NSCache bounds growth (live streaming feeds a fresh
    // string each tick) and purges under memory pressure. parse is a pure
    // function of `content`, so caching can never go stale.
    private final class Parsed { let blocks: [MarkdownBlock]; init(_ b: [MarkdownBlock]) { blocks = b } }
    private static let cache: NSCache<NSString, Parsed> = {
        let c = NSCache<NSString, Parsed>()
        // Must cover a full rendered page WITH HEADROOM: SessionConversationStore
        // renders up to hardMaxRenderedRows = 400, and at 256 a 400-row
        // all-assistant page THRASHED the cache — every re-render re-parsed
        // ~150 rows from scratch (measured 760ms/pass in the perf harness).
        // 512 "barely fit" one page: NSCache's eviction order under count
        // pressure is UNDEFINED, so a page plus a few hundred incidental
        // entries (a previous page, notes previews) could evict the visible
        // rows themselves — the round-trip-scroll re-parse freeze. 1024 =
        // page + churn; bytes are bounded by the cost cap below either way.
        c.countLimit = 1024
        // countLimit alone is not enough — cost bounds the bytes. With
        // clipOversized capping every shared entry at ~oversizedRowClipLimit
        // chars, the cap is sized so a FULL 400-row page of worst-case
        // (clip-limit CJK) rows always fits: cost-cap eviction on a coverable
        // page was the "round-trip scroll re-parses everything" freeze
        // mechanism (2026-08-07 repro: 400x64KB rows = 25s round trip).
        // Realistic pages (4KB server-clipped rows) use <1M of this budget;
        // memory pressure still purges via NSCache.
        c.totalCostLimit = 8_000_000
        return c
    }()

    /// Cache routing for `parse`. `.skip` exists for the STREAMING tail
    /// (LiveMarkdownBody): every ~120ms tick parses a fresh unique string, and
    /// pushing those one-shot entries through the shared cache evicted the
    /// visible history rows (countLimit) — the next scroll re-parsed the whole
    /// page (the "scrolling a streaming session freezes" mechanism).
    enum CacheMode { case shared, skip }

    /// Defensive clip for oversized rows (Characters). Transcript rows are
    /// server-clipped at 4KB, so anything past this is legacy/foreign data —
    /// clip to keep one row's parse cost AND its cache cost bounded. Above
    /// LiveMarkdownWindow.windowKeep would defeat the point; live segments
    /// opt out instead (clipOversized: false) since the window already bounds
    /// them.
    static let oversizedRowClipLimit = 16_000

    /// Test hook: cache-behavior tests (ScrollPerfTests) need a KNOWN cache
    /// population; entries left by earlier suites otherwise make count-based
    /// eviction (undefined order in NSCache) nondeterministic.
    static func resetCacheForTesting() {
        cache.removeAllObjects()
    }

    /// `clipOversized`: defends against oversized legacy rows (see
    /// oversizedRowClipLimit). Live window segments pass false — the window
    /// bounds them already, and clipping the live head would visibly drop
    /// mid-reply content. Clipping BEFORE keying means all >16K variants of
    /// the same prefix share one cache entry (render is a pure function of
    /// the clipped text, so collisions are correct by construction).
    static func parse(_ content: String, cache mode: CacheMode = .shared,
                      clipOversized: Bool = true) -> [MarkdownBlock] {
        var content = content
        // O(1) byte pre-check (bytes >= Characters), then an O(clipLimit)
        // forward index walk — never an O(n) full count on a giant row.
        // nil / endIndex from the walk = under the limit in Characters.
        if clipOversized, content.utf8.count > oversizedRowClipLimit,
           let cut = content.index(content.startIndex, offsetBy: oversizedRowClipLimit,
                                   limitedBy: content.endIndex),
           cut < content.endIndex {
            content = String(content[..<cut]) + "…"
        }
        guard mode == .shared else { return parseUncached(content) }
        let key = content as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let blocks = parseUncached(content)
        cache.setObject(Parsed(blocks), forKey: key, cost: key.length)
        return blocks
    }

    private static func parseUncached(_ content: String) -> [MarkdownBlock] {
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
        linkifyBareURLs(&attributed)
        linkifyPreviewableFilePaths(&attributed)
        return attributed
    }

    /// AttributedString(markdown:) only links `[text](url)` — a bare
    /// "https://example.com" in agent output stayed dead text, so websites
    /// couldn't be opened from chat. Mark plain http(s) runs as tappable links.
    /// Internal (not private): the chat `Text(inline:)` fast path applies it
    /// too — short plain messages never reach the block parser.
    private static let bareURLRegex = try? NSRegularExpression(
        pattern: #"https?://[^\s<>()\[\]{}"']+"#
    )

    static func linkifyBareURLs(_ attributed: inout AttributedString) {
        guard let regex = bareURLRegex else { return }
        let plain = String(attributed.characters)
        let ns = plain as NSString
        for match in regex.matches(in: plain, range: NSRange(location: 0, length: ns.length)) {
            guard let range = Range(match.range, in: plain),
                  let lower = AttributedString.Index(range.lowerBound, within: attributed),
                  let upper = AttributedString.Index(range.upperBound, within: attributed) else { continue }
            // Skip runs the markdown parser already linked ([text](url)).
            if attributed[lower..<upper].runs.contains(where: { $0.link != nil }) { continue }
            // Trim trailing punctuation that reads as prose, not URL.
            var urlText = ns.substring(with: match.range)
            while let last = urlText.last, ".,;:!?".contains(last) { urlText.removeLast() }
            guard let url = URL(string: urlText),
                  let trimmedUpper = AttributedString.Index(
                    plain.index(range.lowerBound, offsetBy: urlText.count), within: attributed
                  ) else { continue }
            attributed[lower..<trimmedUpper].link = url
            attributed[lower..<trimmedUpper].foregroundColor = .accentColor
            attributed[lower..<trimmedUpper].underlineStyle = .single
        }
    }

    /// Bare absolute `.html`/`.htm` paths become tappable walnut-file:// links
    /// (the timeline opens them as the in-app WKWebView preview) — the HTML
    /// counterpart of splitBarePathImages: agents write "report saved to
    /// /tmp/x/report.html" constantly, and the web console makes those paths
    /// clickable, so must the phone. Same segment charset and URL-tail
    /// boundary guard as barePathRegex.
    private static let bareHTMLPathRegex = try? NSRegularExpression(
        pattern: #"/[\w.\-]+(?:/[\w.\- ]*[\w.\-])+\.html?\b"#,
        options: [.caseInsensitive]
    )

    static func linkifyPreviewableFilePaths(_ attributed: inout AttributedString) {
        guard let regex = bareHTMLPathRegex else { return }
        let plain = String(attributed.characters)
        guard plain.range(of: ".htm", options: .caseInsensitive) != nil else { return }
        let ns = plain as NSString
        for match in regex.matches(in: plain, range: NSRange(location: 0, length: ns.length)) {
            // Reject a match that is really the tail of a URL/longer token
            // (same boundary rule as splitBarePathImages).
            if match.range.location > 0 {
                let prev = ns.character(at: match.range.location - 1)
                let urlish = Unicode.Scalar(prev).map {
                    CharacterSet.alphanumerics.contains($0)
                        || $0 == "/" || $0 == "." || $0 == "-" || $0 == "%"
                } ?? true
                if urlish { continue }
            }
            guard let range = Range(match.range, in: plain),
                  let lower = AttributedString.Index(range.lowerBound, within: attributed),
                  let upper = AttributedString.Index(range.upperBound, within: attributed) else { continue }
            // Skip runs already linked ([text](url) or a bare URL above).
            if attributed[lower..<upper].runs.contains(where: { $0.link != nil }) { continue }
            guard let url = FilePreviewLink.url(for: ns.substring(with: match.range)) else { continue }
            attributed[lower..<upper].link = url
            attributed[lower..<upper].foregroundColor = .accentColor
            attributed[lower..<upper].underlineStyle = .single
        }
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

    /// heic/heif included: what an iPhone camera writes. Without them a photo
    /// imported straight off a phone rendered as literal `![[IMG.heic]]` text
    /// instead of an image.
    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"]

    static func isImagePath(_ raw: String) -> Bool {
        imageExtensions.contains((raw as NSString).pathExtension.lowercased())
    }

    /// Split a text run around `![[embed]]` and `![alt](url)` images, plus
    /// bare absolute image paths ("/tmp/x/shot.png" — agents write these
    /// constantly; the web console inlines them, so must we).
    static func splitImages(_ text: String) -> [TextOrImage] {
        let pattern = #"!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [.text(text)] }
        let ns = text as NSString
        var pieces: [TextOrImage] = []
        func appendText(_ t: String) {
            guard !t.trimmingCharacters(in: .whitespaces).isEmpty else { return }
            pieces.append(contentsOf: splitBarePathImages(t))
        }
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if match.range.location > cursor {
                appendText(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
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
            appendText(ns.substring(from: cursor))
        }
        return pieces.isEmpty ? [.text(text)] : pieces
    }

    /// Bare absolute Unix path ending in an image extension (2+ segments,
    /// optionally wrapped in backticks) — mirrors the web console's
    /// IMAGE_PATH_RE so "/tmp/demo/shot.png" inlines instead of reading as text.
    private static let barePathRegex = try? NSRegularExpression(
        pattern: #"`?(/[\w.\-]+(?:/[\w.\- ]*[\w.\-])+\.(?:png|jpe?g|gif|webp))`?"#,
        options: [.caseInsensitive]
    )

    private static func splitBarePathImages(_ text: String) -> [TextOrImage] {
        guard let regex = barePathRegex else { return [.text(text)] }
        let ns = text as NSString
        var pieces: [TextOrImage] = []
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            // Boundary guard: the ONLY thing this must reject is a path that is
            // really the tail of a URL/longer token ("https://example.com/x.png"
            // — the "//" supplies the leading "/"), where the preceding char is
            // URL-ish (letter, digit, ':', '/', '.', '-', '%'). The old
            // allowlist (whitespace/backtick/paren only) also rejected CJK
            // punctuation — "截图:`/tmp/shot.png`" and "、`/tmp/x.png`" are how
            // agents actually write, and those images silently rendered as text
            // on the phone while the web console (no boundary check on its
            // absolute-path regex) inlined them fine.
            // (No ':' in the set: a URL's path can never match at its leading
            // "//" — the regex needs a word char after "/" — so any URL-tail
            // match is already guarded by the '/' or alphanumeric before it,
            // while "截图:`/tmp/x.png`" has ':' before the backtick and must pass.)
            if match.range.location > 0 {
                let prev = ns.character(at: match.range.location - 1)
                let urlish = Unicode.Scalar(prev).map {
                    CharacterSet.alphanumerics.contains($0)
                        || $0 == "/" || $0 == "." || $0 == "-" || $0 == "%"
                } ?? true
                if urlish { continue }
            }
            if match.range.location > cursor {
                let before = ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
                if !before.trimmingCharacters(in: .whitespaces).isEmpty { pieces.append(.text(before)) }
            }
            let raw = ns.substring(with: match.range(at: 1))
            pieces.append(.image(raw: raw, alt: (raw as NSString).lastPathComponent))
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
