import UIKit

/// Custom attribute keys carried on the WYSIWYG editor's NSAttributedString so
/// the serializer can reconstruct markdown byte-for-byte for anything the user
/// didn't touch.
extension NSAttributedString.Key {
    /// Per-paragraph block type + its EXACT source prefix (e.g. "## ", "  - ").
    static let walnutBlock = NSAttributedString.Key("walnutBlock")
    /// Exact opening/closing delimiter text for a styled inline run, captured
    /// from the source so `_x_` doesn't get rewritten to `*x*` on save.
    static let walnutDelimOpen = NSAttributedString.Key("walnutDelimOpen")
    static let walnutDelimClose = NSAttributedString.Key("walnutDelimClose")
    /// Oversized tables render as bounded plain text while preserving the full
    /// source for an unedited round trip. All four keys are carried on EVERY
    /// line of the block, not just the first: attributes vanish with the line
    /// that held them, so a single-line deletion used to take the whole table's
    /// source with it.
    static let walnutTableFallbackID = NSAttributedString.Key("walnutTableFallbackID")
    static let walnutTableFallbackSource = NSAttributedString.Key("walnutTableFallbackSource")
    /// The exact text the block was rendered with. When the block's live text
    /// differs the user edited it, so the edited text wins over the source.
    static let walnutTableFallbackDisplay = NSAttributedString.Key("walnutTableFallbackDisplay")
    /// Source rows past the render cap — re-appended after an edited block so
    /// editing a visible row can't delete the hidden ones.
    static let walnutTableFallbackTail = NSAttributedString.Key("walnutTableFallbackTail")
}

/// One line's block-level identity. `prefix` (when present) is always a literal
/// substring of the original line — so `prefix + content == line` by
/// construction, which is what makes unedited round-trip trivially correct.
enum WalnutBlockKind: Equatable {
    case body
    /// Table rows, HTML blocks, code fences, horizontal rules — displayed as
    /// literal monospaced text and serialized as-is, untouched.
    case verbatim
    case heading(prefix: String)
    case quote(prefix: String)
    case bullet(prefix: String)
    case numbered(prefix: String)
    /// Task line — the checkbox (with its own exact prefix) is a
    /// `CheckboxAttachment` at the start of the paragraph, not stored here.
    case task
}

enum MarkdownAttributed {
    struct Parsed {
        let frontmatter: String?
        let attributed: NSMutableAttributedString
    }

    // MARK: - Fonts / styling

    private static func font(for kind: WalnutBlockKind) -> UIFont {
        switch kind {
        case .heading(let prefix):
            let level = prefix.trimmingCharacters(in: .whitespaces).count
            switch level {
            case 1: return .systemFont(ofSize: 28, weight: .bold)
            case 2: return .systemFont(ofSize: 22, weight: .semibold)
            default: return .systemFont(ofSize: 18, weight: .semibold)
            }
        case .verbatim:
            return .monospacedSystemFont(ofSize: 13, weight: .regular)
        default:
            return .preferredFont(forTextStyle: .body)
        }
    }

    static func color(for kind: WalnutBlockKind) -> UIColor {
        switch kind {
        case .verbatim: return .secondaryLabel
        case .quote: return .secondaryLabel
        default: return .label
        }
    }

    private static func paragraphStyle(for kind: WalnutBlockKind) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.paragraphSpacing = 4
        // Apple Notes body rhythm: 17pt text on ~22pt lines.
        style.minimumLineHeight = 22
        switch kind {
        case .bullet(let prefix), .numbered(let prefix):
            // Two leading spaces in the source = one visual indent level.
            // headIndent must equal the marker's rendered width so wrapped
            // lines align under the first line's text, not under the marker.
            let level = CGFloat(prefix.prefix(while: { $0 == " " }).count) / 2
            style.firstLineHeadIndent = level * 16
            style.headIndent = BulletAttachment.canvasWidth + level * 16
            style.paragraphSpacing = 6
            style.minimumLineHeight = 24
        case .task:
            style.headIndent = CheckboxAttachment.canvasWidth
            style.firstLineHeadIndent = 0
            // Apple Notes checklist rows breathe — taller lines + row gap.
            style.paragraphSpacing = 8
            style.minimumLineHeight = 26
        case .quote:
            style.headIndent = 14
            style.firstLineHeadIndent = 14
        case .heading(let prefix):
            let level = prefix.trimmingCharacters(in: .whitespaces).count
            style.paragraphSpacingBefore = level == 1 ? 14 : 10
            style.paragraphSpacing = 6
            style.minimumLineHeight = 0
        case .verbatim:
            style.minimumLineHeight = 0
        default:
            break
        }
        return style
    }

    /// Attributes new text should inherit while the caret sits in a paragraph
    /// of this kind (used by the coordinator for typingAttributes).
    static func typingAttributes(for kind: WalnutBlockKind) -> [NSAttributedString.Key: Any] {
        [
            .font: font(for: kind),
            .foregroundColor: color(for: kind),
            .paragraphStyle: paragraphStyle(for: kind),
            .walnutBlock: kind,
        ]
    }

    /// Task-line attributes with a visual indent level. `.task` carries no
    /// prefix in the block enum (the checkbox attachment holds the source),
    /// so indent must be derived from the marker's leading spaces here.
    static func taskAttributes(leadingSpaces: Int) -> [NSAttributedString.Key: Any] {
        var attrs = typingAttributes(for: .task)
        let level = CGFloat(leadingSpaces) / 2
        let style = NSMutableParagraphStyle()
        style.setParagraphStyle(attrs[.paragraphStyle] as! NSParagraphStyle)
        style.firstLineHeadIndent = level * 16
        style.headIndent = CheckboxAttachment.canvasWidth + level * 16
        attrs[.paragraphStyle] = style
        return attrs
    }

    // MARK: - Parse

    static func parse(_ content: String, maxImageWidth: CGFloat) -> Parsed {
        var lines = content.components(separatedBy: "\n")
        var frontmatter: String?

        if lines.first?.trimmingCharacters(in: .whitespaces) == "---" {
            var end = 1
            while end < lines.count, lines[end].trimmingCharacters(in: .whitespaces) != "---" {
                end += 1
            }
            if end < lines.count {
                frontmatter = lines[0...end].joined(separator: "\n")
                lines = Array(lines[(end + 1)...])
            }
        }

        let result = NSMutableAttributedString()
        var index = 0
        var inFence = false
        var fenceMarker = ""

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if inFence {
                appendVerbatim(line, to: result)
                if trimmed.hasPrefix(fenceMarker) { inFence = false }
                index += 1
                appendNewlineIfNeeded(index, lines.count, to: result)
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                fenceMarker = String(trimmed.prefix(3))
                inFence = true
                appendVerbatim(line, to: result)
                index += 1
                appendNewlineIfNeeded(index, lines.count, to: result)
                continue
            }
            // Table → real grid attachment (tap to edit), not literal pipes.
            if trimmed.contains("|"), index + 1 < lines.count, isTableSeparator(lines[index + 1]) {
                var allTableLines = [lines[index], lines[index + 1]]
                index += 2
                while index < lines.count {
                    let t = lines[index].trimmingCharacters(in: .whitespaces)
                    guard t.contains("|"), !t.isEmpty else { break }
                    allTableLines.append(lines[index])
                    index += 1
                }
                let totalBodyRows = max(0, allTableLines.count - 2)
                let omittedRows = max(0, totalBodyRows - TableAttachment.maxRenderedRows)
                let fullSource = allTableLines.joined(separator: "\n")
                // Parse the FULL table. The attachment draws only the first
                // `maxRenderedRows` rows but must RETAIN every row: it is the
                // serialization source, so handing it a truncated model meant a
                // single cell edit (which drops `originalSource`) rewrote the
                // note with rows 101+ silently deleted.
                if let table = EditableTable.parse(lines: allTableLines),
                   !TableAttachment.wouldExceedBitmapLimit(
                       table: table, width: maxImageWidth, omittedRows: omittedRows
                   ) {
                    let attachment = TableAttachment(
                        table: table, maxWidth: maxImageWidth,
                        originalSource: fullSource
                    )
                    result.append(NSAttributedString(attachment: attachment))
                    result.addAttributes(
                        typingAttributes(for: .body),
                        range: NSRange(location: result.length - 1, length: 1)
                    )
                } else {
                    let renderedLines = Array(allTableLines.prefix(TableAttachment.maxRenderedRows + 2))
                    appendTableFallback(
                        renderedLines,
                        omittedRows: omittedRows,
                        tail: Array(allTableLines.dropFirst(renderedLines.count)),
                        originalSource: fullSource,
                        to: result
                    )
                }
                appendNewlineIfNeeded(index, lines.count, to: result)
                continue
            }
            if trimmed.hasPrefix("<") || isRule(trimmed) {
                appendVerbatim(line, to: result)
                index += 1
                appendNewlineIfNeeded(index, lines.count, to: result)
                continue
            }

            appendClassified(line, to: result, maxImageWidth: maxImageWidth)
            index += 1
            appendNewlineIfNeeded(index, lines.count, to: result)
        }

        return Parsed(frontmatter: frontmatter, attributed: result)
    }

    private static func appendNewlineIfNeeded(_ nextIndex: Int, _ count: Int, to result: NSMutableAttributedString) {
        guard nextIndex < count else { return }
        result.append(NSAttributedString(string: "\n", attributes: typingAttributes(for: .body)))
    }

    private static func appendVerbatim(_ line: String, to result: NSMutableAttributedString) {
        result.append(NSAttributedString(string: line, attributes: typingAttributes(for: .verbatim)))
    }

    /// A table too large to rasterize renders as bounded plain text. Every line
    /// carries the block's id, its full source, the display text and the row tail
    /// beyond the render cap, so the serializer can (a) still find the source
    /// after any single line is deleted and (b) tell an edited block from an
    /// untouched one.
    private static func appendTableFallback(
        _ lines: [String], omittedRows: Int, tail: [String], originalSource: String,
        to result: NSMutableAttributedString
    ) {
        let fallbackID = UUID().uuidString
        let displayLines = lines + (omittedRows > 0 ? ["… \(omittedRows) more rows"] : [])
        let display = displayLines.joined(separator: "\n")
        for (lineIndex, line) in displayLines.enumerated() {
            if lineIndex > 0 {
                var newlineAttrs = typingAttributes(for: .verbatim)
                newlineAttrs[.walnutTableFallbackID] = fallbackID
                result.append(NSAttributedString(string: "\n", attributes: newlineAttrs))
            }
            var attrs = typingAttributes(for: .verbatim)
            attrs[.walnutTableFallbackID] = fallbackID
            attrs[.walnutTableFallbackSource] = originalSource
            attrs[.walnutTableFallbackDisplay] = display
            if !tail.isEmpty { attrs[.walnutTableFallbackTail] = tail.joined(separator: "\n") }
            result.append(NSAttributedString(string: line, attributes: attrs))
        }
    }

    private static func appendClassified(_ line: String, to result: NSMutableAttributedString, maxImageWidth: CGFloat) {
        let ns = line as NSString
        let leadingWS = ns.substring(to: prefixLength(of: ns, matching: { $0 == " " || $0 == "\t" }))
        let afterWSStart = leadingWS.count
        let afterWS = ns.substring(from: afterWSStart)

        // Heading — the `# ` prefix is HIDDEN (carried in the block attribute)
        // so the editor shows a clean big title like Apple Notes. An empty
        // heading line ("## " with no text) stays verbatim: with no characters
        // on the line there would be nowhere to carry the attribute.
        if afterWS.hasPrefix("#") {
            let hashCount = prefixLength(of: afterWS as NSString, matching: { $0 == "#" })
            if hashCount >= 1 && hashCount <= 6 {
                let rest = (afterWS as NSString).substring(from: hashCount)
                if rest.hasPrefix(" ") || rest.isEmpty {
                    let hasSpace = rest.hasPrefix(" ")
                    let prefixLen = afterWSStart + hashCount + (hasSpace ? 1 : 0)
                    let prefix = ns.substring(to: prefixLen)
                    let content = ns.substring(from: prefixLen)
                    if content.isEmpty {
                        appendVerbatim(line, to: result)
                    } else {
                        let attrs = typingAttributes(for: .heading(prefix: prefix))
                        result.append(inlineAttributed(content, maxImageWidth: maxImageWidth, baseAttributes: attrs))
                    }
                    return
                }
            }
        }

        // Quote
        if afterWS.hasPrefix(">") {
            let rest = (afterWS as NSString).substring(from: 1)
            let hasSpace = rest.hasPrefix(" ")
            let prefixLen = afterWSStart + 1 + (hasSpace ? 1 : 0)
            let prefix = ns.substring(to: prefixLen)
            let content = ns.substring(from: prefixLen)
            appendPrefixedLine(prefix: prefix, content: content, kind: .quote(prefix: prefix), to: result, maxImageWidth: maxImageWidth)
            return
        }

        // Bullet / task
        if let first = afterWS.first, "-*+".contains(first), (afterWS as NSString).length > 1,
           (afterWS as NSString).substring(with: NSRange(location: 1, length: 1)) == " " {
            let afterMarker = (afterWS as NSString).substring(from: 2)
            if let checkboxRange = afterMarker.range(of: #"^\[( |x|X)\]"#, options: .regularExpression) {
                let checked = afterMarker[checkboxRange].lowercased().contains("x")
                var tokenLen = afterMarker.distance(from: afterMarker.startIndex, to: checkboxRange.upperBound)
                let afterToken = (afterMarker as NSString).substring(from: tokenLen)
                if afterToken.hasPrefix(" ") { tokenLen += 1 }
                let prefixLen = afterWSStart + 2 + tokenLen
                let prefix = ns.substring(to: prefixLen)
                let content = ns.substring(from: prefixLen)
                appendTaskLine(prefix: prefix, checked: checked, content: content, to: result, maxImageWidth: maxImageWidth)
                return
            }
            let prefixLen = afterWSStart + 2
            let prefix = ns.substring(to: prefixLen)
            let content = ns.substring(from: prefixLen)
            appendBulletLine(prefix: prefix, content: content, to: result, maxImageWidth: maxImageWidth)
            return
        }

        // Numbered
        if let match = afterWS.range(of: #"^\d{1,3}[.)] "#, options: .regularExpression) {
            let matchLen = afterWS.distance(from: afterWS.startIndex, to: match.upperBound)
            let prefixLen = afterWSStart + matchLen
            let prefix = ns.substring(to: prefixLen)
            let content = ns.substring(from: prefixLen)
            appendPrefixedLine(prefix: prefix, content: content, kind: .numbered(prefix: prefix), to: result, maxImageWidth: maxImageWidth)
            return
        }

        // Plain body paragraph (possibly empty)
        let attrs = typingAttributes(for: .body)
        let inline = inlineAttributed(line, maxImageWidth: maxImageWidth, baseAttributes: attrs)
        result.append(inline)
    }

    private static func appendPrefixedLine(
        prefix: String, content: String, kind: WalnutBlockKind, to result: NSMutableAttributedString, maxImageWidth: CGFloat
    ) {
        let attrs = typingAttributes(for: kind)
        result.append(NSAttributedString(string: prefix, attributes: attrs))
        result.append(inlineAttributed(content, maxImageWidth: maxImageWidth, baseAttributes: attrs))
    }

    /// Bullet line — the `- ` marker renders as a round dot attachment
    /// (Apple Notes look) carrying the exact source marker for round-trip.
    private static func appendBulletLine(
        prefix: String, content: String, to result: NSMutableAttributedString, maxImageWidth: CGFloat
    ) {
        let attrs = typingAttributes(for: .bullet(prefix: prefix))
        let attachment = BulletAttachment(source: prefix)
        result.append(NSAttributedString(attachment: attachment))
        result.addAttributes(attrs, range: NSRange(location: result.length - 1, length: 1))
        result.append(inlineAttributed(content, maxImageWidth: maxImageWidth, baseAttributes: attrs))
    }

    private static func appendTaskLine(
        prefix: String, checked: Bool, content: String, to result: NSMutableAttributedString, maxImageWidth: CGFloat
    ) {
        let attrs = taskAttributes(leadingSpaces: prefix.prefix(while: { $0 == " " }).count)
        let attachment = CheckboxAttachment(source: prefix, checked: checked)
        result.append(NSAttributedString(attachment: attachment))
        // Attachment run needs the block-kind attribute too, or the coordinator
        // can't tell what paragraph it's in when the caret lands right on it.
        result.addAttributes(attrs, range: NSRange(location: result.length - 1, length: 1))
        result.append(inlineAttributed(content, maxImageWidth: maxImageWidth, baseAttributes: attrs))
    }

    private static func prefixLength(of ns: NSString, matching predicate: (Character) -> Bool) -> Int {
        var count = 0
        for scalar in ns as String {
            guard predicate(scalar) else { break }
            count += 1
        }
        return count
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.contains("-"), t.contains("|") || t.hasPrefix(":") else { return false }
        return t.allSatisfy { "|-: ".contains($0) }
    }

    private static func isRule(_ trimmed: String) -> Bool {
        guard trimmed.count >= 3 else { return false }
        let set = Set(trimmed)
        return set == ["-"] || set == ["*"] || set == ["_"]
    }

    // MARK: - Inline styling (bold / italic / underline / strike / images)

    private static let inlinePattern = #"!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)|\*\*([^\*]+?)\*\*|<u>([^<]+?)</u>|~~([^~]+?)~~|\*([^\*\n]+?)\*|_([^_\n]+?)_"#

    private static func inlineAttributed(
        _ text: String, maxImageWidth: CGFloat, baseAttributes: [NSAttributedString.Key: Any]
    ) -> NSMutableAttributedString {
        guard !text.isEmpty else { return NSMutableAttributedString() }
        guard let regex = try? NSRegularExpression(pattern: inlinePattern, options: [.caseInsensitive]) else {
            return NSMutableAttributedString(string: text, attributes: baseAttributes)
        }
        let ns = text as NSString
        let result = NSMutableAttributedString()
        var cursor = 0

        func appendPlain(_ range: NSRange) {
            guard range.length > 0 else { return }
            result.append(NSAttributedString(string: ns.substring(with: range), attributes: baseAttributes))
        }

        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if match.range.location > cursor {
                appendPlain(NSRange(location: cursor, length: match.range.location - cursor))
            }
            if match.range(at: 1).location != NSNotFound {
                let inner = ns.substring(with: match.range(at: 1))
                let rawPath = inner.components(separatedBy: "|").first ?? inner
                if MarkdownParser.isImagePath(rawPath) {
                    let attachment = RemoteImageAttachment(
                        source: ns.substring(with: match.range), rawPath: rawPath, maxWidth: maxImageWidth
                    )
                    result.append(NSAttributedString(attachment: attachment))
                } else {
                    appendPlain(match.range)
                }
            } else if match.range(at: 2).location != NSNotFound {
                let raw = ns.substring(with: match.range)
                let url = ns.substring(with: match.range(at: 3))
                let attachment = RemoteImageAttachment(source: raw, rawPath: url, maxWidth: maxImageWidth)
                result.append(NSAttributedString(attachment: attachment))
            } else if let (delims, groupIdx, trait) = styleInfo(for: match) {
                let inner = ns.substring(with: match.range(at: groupIdx))
                var attrs = baseAttributes
                applyTrait(trait, to: &attrs)
                attrs[.walnutDelimOpen] = delims.0
                attrs[.walnutDelimClose] = delims.1
                result.append(NSAttributedString(string: inner, attributes: attrs))
            } else {
                appendPlain(match.range)
            }
            cursor = match.range.location + match.range.length
        }
        if cursor < ns.length {
            appendPlain(NSRange(location: cursor, length: ns.length - cursor))
        }
        return result
    }

    enum InlineTrait { case bold, underline, strike, italic }

    private static func styleInfo(for match: NSTextCheckingResult) -> ((String, String), Int, InlineTrait)? {
        if match.range(at: 4).location != NSNotFound { return (("**", "**"), 4, .bold) }
        if match.range(at: 5).location != NSNotFound { return (("<u>", "</u>"), 5, .underline) }
        if match.range(at: 6).location != NSNotFound { return (("~~", "~~"), 6, .strike) }
        if match.range(at: 7).location != NSNotFound { return (("*", "*"), 7, .italic) }
        if match.range(at: 8).location != NSNotFound { return (("_", "_"), 8, .italic) }
        return nil
    }

    static func applyTrait(_ trait: InlineTrait, to attrs: inout [NSAttributedString.Key: Any]) {
        switch trait {
        case .bold:
            let base = (attrs[.font] as? UIFont) ?? .preferredFont(forTextStyle: .body)
            attrs[.font] = base.withTraits(.traitBold)
        case .italic:
            let base = (attrs[.font] as? UIFont) ?? .preferredFont(forTextStyle: .body)
            attrs[.font] = base.withTraits(.traitItalic)
        case .underline:
            attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
        case .strike:
            attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        }
    }

    /// Kick off async loads for every image attachment now that a UITextView
    /// (needed for the authed fetch + relayout) exists.
    static func kickOffImageLoads(in textView: UITextView, maxWidth: CGFloat) {
        let storage = textView.textStorage
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, _, _ in
            (value as? RemoteImageAttachment)?.loadIfNeeded(maxWidth: maxWidth, in: textView)
        }
    }
}

extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        let combined = fontDescriptor.symbolicTraits.union(traits)
        guard let descriptor = fontDescriptor.withSymbolicTraits(combined) else { return self }
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
