import UIKit

/// NSAttributedString → markdown. Mirrors MarkdownAttributed.parse exactly so
/// an unedited note round-trips byte-for-byte: block prefixes are literal
/// captured substrings, and inline delimiters fall back to the same defaults
/// the parser would have produced from plain markdown.
enum MarkdownSerializer {
    static func serialize(frontmatter: String?, attributed: NSAttributedString) -> String {
        let ns = attributed.string as NSString
        let fullLength = ns.length
        var lines: [String] = []
        var lineStart = 0
        var index = 0
        while index <= fullLength {
            if index == fullLength || ns.character(at: index) == 10 {
                lines.append(serializeLine(attributed, range: NSRange(location: lineStart, length: index - lineStart)))
                lineStart = index + 1
            }
            index += 1
        }
        let body = lines.joined(separator: "\n")
        guard let frontmatter else { return body }
        return frontmatter + "\n" + body
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
