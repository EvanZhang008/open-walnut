import UIKit

/// Markdown blocks → pre-styled UIKit content pieces, built OFF the main
/// thread on the layout actor. Fonts/spacing mirror `MarkdownView` (the
/// SwiftUI renderer both chat pages used) so the swap is visually quiet.
///
/// Everything here is pure CPU work on thread-safe types (UIFont creation,
/// NSAttributedString construction and NSRegularExpression are all safe off
/// the main thread; nothing touches views).
enum TimelineTextStyler {

    /// A block group ready to become one timeline row. Consecutive prose
    /// blocks (heading / paragraph / list / task / quote / rule) merge into
    /// ONE attributed text piece; heavy constructs split out so they get
    /// purpose-built cells and exact heights.
    enum Piece {
        case text(NSAttributedString)
        case code(String)
        case image(raw: String, alt: String)
        case table(header: [AttributedString], rows: [[AttributedString]])
    }

    // MARK: - Fonts (mirrors MarkdownView / MessageRow)

    static let bodyFont = UIFont.preferredFont(forTextStyle: .body)
    static let captionFont = UIFont.preferredFont(forTextStyle: .caption1)
    static let caption2Font = UIFont.preferredFont(forTextStyle: .caption2)
    static let footnoteFont = UIFont.preferredFont(forTextStyle: .footnote)
    static let subheadlineFont = UIFont.preferredFont(forTextStyle: .subheadline)
    static let codeFont = UIFont.monospacedSystemFont(
        ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
    static let codePreviewFont = UIFont.monospacedSystemFont(
        ofSize: UIFont.preferredFont(forTextStyle: .caption2).pointSize, weight: .regular)

    static func headingFont(_ level: Int) -> UIFont {
        let base: UIFont
        switch level {
        case 1: base = .systemFont(ofSize: 28, weight: .bold)
        case 2: base = .systemFont(ofSize: 22, weight: .bold)
        case 3: base = .systemFont(ofSize: 20, weight: .semibold)
        default: base = .systemFont(ofSize: 17, weight: .semibold)
        }
        guard let descriptor = base.fontDescriptor.withDesign(.rounded) else { return base }
        return UIFont(descriptor: descriptor, size: base.pointSize)
    }

    // MARK: - Block groups

    /// Split parsed blocks into row-sized pieces (prose runs merged).
    static func pieces(from blocks: [MarkdownBlock]) -> [Piece] {
        var pieces: [Piece] = []
        var prose = NSMutableAttributedString()
        func flushProse() {
            guard prose.length > 0 else { return }
            pieces.append(.text(prose))
            prose = NSMutableAttributedString()
        }
        func appendProse(_ chunk: NSAttributedString) {
            if prose.length > 0 {
                prose.append(NSAttributedString(string: "\n", attributes: [
                    .font: bodyFont, .paragraphStyle: paragraphStyle(spacing: 6),
                ]))
            }
            prose.append(chunk)
        }
        for block in blocks {
            switch block.kind {
            case .heading(let level, let text):
                appendProse(styledInline(text, font: headingFont(level), color: .label,
                                         paragraph: paragraphStyle(spacing: 4, before: level <= 2 ? 10 : 6)))
            case .paragraph(let text):
                appendProse(styledInline(text, font: bodyFont, color: .label,
                                         paragraph: paragraphStyle(spacing: 6, lineSpacing: 4)))
            case .listItem(let indent, let marker, let text):
                let markerText: String
                switch marker {
                case .bullet: markerText = "•  "
                case .number(let n): markerText = "\(n). "
                }
                appendProse(prefixedLine(markerText, text, indent: indent, strike: false, secondary: false))
            case .taskItem(let indent, let checked, let text, _):
                appendProse(prefixedLine(checked ? "✓  " : "○  ", text, indent: indent,
                                         strike: checked, secondary: checked))
            case .quote(let lines):
                for line in lines {
                    let style = paragraphStyle(spacing: 2, lineSpacing: 3)
                    style.headIndent = 14
                    style.firstLineHeadIndent = 14
                    appendProse(styledInline(line, font: bodyFont, color: .secondaryLabel, paragraph: style))
                }
            case .rule:
                appendProse(NSAttributedString(string: "⸻", attributes: [
                    .font: bodyFont, .foregroundColor: UIColor.separator,
                    .paragraphStyle: paragraphStyle(spacing: 8, before: 8),
                ]))
            case .embed(let name):
                appendProse(NSAttributedString(string: "📄 \(name)", attributes: [
                    .font: subheadlineFont, .foregroundColor: UIColor.secondaryLabel,
                    .paragraphStyle: paragraphStyle(spacing: 4),
                ]))
            case .code(_, let text):
                flushProse()
                pieces.append(.code(text))
            case .image(let raw, let alt):
                flushProse()
                pieces.append(.image(raw: raw, alt: alt))
            case .table(let header, let rows):
                flushProse()
                pieces.append(.table(header: header, rows: rows))
            }
        }
        flushProse()
        return pieces
    }

    private static func prefixedLine(
        _ prefix: String, _ text: AttributedString, indent: Int, strike: Bool, secondary: Bool
    ) -> NSAttributedString {
        let style = paragraphStyle(spacing: 3, lineSpacing: 3)
        let prefixWidth = (prefix as NSString).size(withAttributes: [.font: bodyFont]).width
        style.firstLineHeadIndent = CGFloat(indent) * 18 + 4
        style.headIndent = style.firstLineHeadIndent + prefixWidth
        let out = NSMutableAttributedString(string: prefix, attributes: [
            .font: bodyFont,
            .foregroundColor: secondary ? UIColor.secondaryLabel : UIColor.secondaryLabel,
            .paragraphStyle: style,
        ])
        var attrs: [NSAttributedString.Key: Any] = [:]
        if strike { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        let body = styledInline(text, font: bodyFont,
                                color: secondary ? .secondaryLabel : .label, paragraph: style)
        let mutable = NSMutableAttributedString(attributedString: body)
        if !attrs.isEmpty {
            mutable.addAttributes(attrs, range: NSRange(location: 0, length: mutable.length))
        }
        out.append(mutable)
        return out
    }

    static func paragraphStyle(
        spacing: CGFloat, lineSpacing: CGFloat = 0, before: CGFloat = 0
    ) -> NSMutableParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.paragraphSpacing = spacing
        style.paragraphSpacingBefore = before
        style.lineSpacing = lineSpacing
        return style
    }

    // MARK: - Inline conversion (AttributedString → UIKit NSAttributedString)

    /// MarkdownParser.inline produces AttributedStrings carrying
    /// `inlinePresentationIntent` (bold/italic/code), `link` and SwiftUI-scoped
    /// color/underline. A plain NSAttributedString(_:) conversion drops the
    /// styling, so map runs explicitly onto UIKit attributes.
    static func styledInline(
        _ source: AttributedString, font: UIFont, color: UIColor,
        paragraph: NSParagraphStyle? = nil
    ) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for run in source.runs {
            let text = String(source[run.range].characters)
            var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
            if let paragraph { attrs[.paragraphStyle] = paragraph }
            if let intent = run.inlinePresentationIntent {
                var runFont = font
                if intent.contains(.stronglyEmphasized) { runFont = runFont.withTraits(.traitBold) }
                if intent.contains(.emphasized) { runFont = runFont.withTraits(.traitItalic) }
                if intent.contains(.code) {
                    runFont = UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.88, weight: .regular)
                    attrs[.backgroundColor] = UIColor.secondarySystemFill
                }
                if intent.contains(.strikethrough) {
                    attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                }
                attrs[.font] = runFont
            }
            if let link = run.link {
                attrs[.link] = link
                attrs[.foregroundColor] = UIColor.tintColor
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            if run.underlineStyle != nil {
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            out.append(NSAttributedString(string: text, attributes: attrs))
        }
        return out
    }

    /// Inline-markdown fast path for short plain rows (mirror of `Text(inline:)`).
    static func inlineText(_ text: String, font: UIFont = bodyFont,
                           color: UIColor = .label) -> NSAttributedString {
        if var attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            MarkdownParser.linkifyBareURLs(&attributed)
            let style = paragraphStyle(spacing: 0, lineSpacing: 3)
            return styledInline(attributed, font: font, color: color, paragraph: style)
        }
        return NSAttributedString(string: text, attributes: [
            .font: font, .foregroundColor: color,
            .paragraphStyle: paragraphStyle(spacing: 0, lineSpacing: 3),
        ])
    }
}
