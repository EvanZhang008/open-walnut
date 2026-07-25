import UIKit

/// NSAttributedString → markdown. Mirrors MarkdownAttributed.parse exactly so
/// an unedited note round-trips byte-for-byte: block prefixes are literal
/// captured substrings, and inline delimiters fall back to the same defaults
/// the parser would have produced from plain markdown.
enum MarkdownSerializer {
    /// Accumulator for one oversized-table fallback block: the block occupies a
    /// single slot in the output, filled in once every one of its lines has been
    /// seen (so an edit anywhere inside it is visible before we choose between
    /// the pristine source and the user's text).
    private struct FallbackBlock {
        var slot: Int
        var source: String
        var display: String
        var tail: String?
        var liveLines: [String] = []
    }

    static func serialize(frontmatter: String?, attributed: NSAttributedString) -> String {
        let ns = attributed.string as NSString
        let fullLength = ns.length
        var lines: [String] = []
        var blocks: [String: FallbackBlock] = [:]
        var lineStart = 0
        var index = 0
        while index <= fullLength {
            if index == fullLength || ns.character(at: index) == 10 {
                let range = NSRange(location: lineStart, length: index - lineStart)
                let attrs = range.length > 0 ? attributed.attributes(at: range.location, effectiveRange: nil) : [:]
                if let fallbackID = attrs[.walnutTableFallbackID] as? String {
                    let text = attributed.attributedSubstring(from: range).string
                    if blocks[fallbackID] != nil {
                        blocks[fallbackID]?.liveLines.append(text)
                    } else {
                        lines.append("") // reserve the slot; resolved below
                        blocks[fallbackID] = FallbackBlock(
                            slot: lines.count - 1,
                            source: (attrs[.walnutTableFallbackSource] as? String) ?? text,
                            display: (attrs[.walnutTableFallbackDisplay] as? String) ?? text,
                            tail: attrs[.walnutTableFallbackTail] as? String,
                            liveLines: [text]
                        )
                    }
                } else {
                    lines.append(serializeLine(attributed, range: range))
                }
                lineStart = index + 1
            }
            index += 1
        }
        for block in blocks.values {
            lines[block.slot] = resolveFallback(block)
        }
        let body = lines.joined(separator: "\n")
        guard let frontmatter else { return body }
        return frontmatter + "\n" + body
    }

    /// Untouched block → the pristine full source (byte-identical round trip).
    /// Edited block → the user's text, with the "… N more rows" placeholder
    /// dropped and the un-rendered row tail re-appended, so neither the
    /// keystrokes nor the hidden rows are lost.
    private static func resolveFallback(_ block: FallbackBlock) -> String {
        let live = block.liveLines.joined(separator: "\n")
        if live == block.display { return block.source }
        let kept = block.liveLines.filter { !isOmittedRowsPlaceholder($0) }
        var out = kept.joined(separator: "\n")
        if let tail = block.tail, !tail.isEmpty {
            out += (out.isEmpty ? "" : "\n") + tail
        }
        return out
    }

    private static func isOmittedRowsPlaceholder(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("… ") && trimmed.hasSuffix("more rows")
    }

    private static func serializeLine(_ attributed: NSAttributedString, range: NSRange) -> String {
        guard range.length > 0 else { return "" }
        let firstAttrs = attributed.attributes(at: range.location, effectiveRange: nil)
        let kind = (firstAttrs[.walnutBlock] as? WalnutBlockKind) ?? .body

        switch kind {
        case .verbatim:
            return attributed.attributedSubstring(from: range).string
        case .heading(let prefix):
            // Heading prefixes are hidden in the editor (carried only in the
            // block attribute) — re-emit them here. Heading fonts are bold by
            // design, so bold must NOT be derived from the font trait (only a
            // source-preserved `**` delimiter survives).
            return prefix + serializeInline(attributed, range: range, baseTraits: .traitBold)
        default:
            // Bullet/task markers are attachments (serializeInline emits their
            // exact source); quote/numbered prefixes are literal text in the
            // line and serialize through unchanged.
            return serializeInline(attributed, range: range)
        }
    }

    private static func serializeInline(
        _ attributed: NSAttributedString, range: NSRange,
        baseTraits: UIFontDescriptor.SymbolicTraits = []
    ) -> String {
        guard range.length > 0 else { return "" }
        var result = ""
        attributed.enumerateAttributes(in: range, options: []) { attrs, subrange, _ in
            if let checkbox = attrs[.attachment] as? CheckboxAttachment {
                result += checkbox.source
                return
            }
            if let bullet = attrs[.attachment] as? BulletAttachment {
                result += bullet.source
                return
            }
            if let table = attrs[.attachment] as? TableAttachment {
                result += table.markdown
                return
            }
            if let image = attrs[.attachment] as? RemoteImageAttachment {
                result += image.source
                return
            }
            let text = attributed.attributedSubstring(from: subrange).string
            result += wrapStyled(text, attrs: attrs, baseTraits: baseTraits)
        }
        return result
    }

    /// Nesting order (outer→inner): strike, underline, bold, italic. Fixed
    /// convention for freshly combined traits; single-trait runs preserved
    /// from source (the common case) round-trip exactly regardless of order.
    private static func wrapStyled(
        _ text: String, attrs: [NSAttributedString.Key: Any],
        baseTraits: UIFontDescriptor.SymbolicTraits = []
    ) -> String {
        guard !text.isEmpty else { return text }
        let font = attrs[.font] as? UIFont
        let traits = (font?.fontDescriptor.symbolicTraits ?? []).subtracting(baseTraits)
        let isBold = traits.contains(.traitBold)
        let isItalic = traits.contains(.traitItalic)
        let hasUnderline = ((attrs[.underlineStyle] as? Int) ?? 0) != 0
        let hasStrike = ((attrs[.strikethroughStyle] as? Int) ?? 0) != 0
        let customOpen = attrs[.walnutDelimOpen] as? String
        let customClose = attrs[.walnutDelimClose] as? String

        var open = ""
        var close = ""
        if hasStrike {
            open = "~~" + open; close += "~~"
        }
        if hasUnderline {
            open = (customOpen ?? "<u>") + open; close += (customClose ?? "</u>")
        }
        if isBold {
            open = "**" + open; close += "**"
        }
        if isItalic {
            let marker = (customOpen == "_") ? "_" : "*"
            open = marker + open; close += (customClose == "_" ? "_" : "*")
        }
        return open + text + close
    }
}
