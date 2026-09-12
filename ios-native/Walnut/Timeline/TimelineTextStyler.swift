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

    /// These used to be `static let`, i.e. FROZEN at whatever the text size was
    /// the first time anything touched them. A fresh launch at XXXL was therefore
    /// correct and a live text-size change was not: the SwiftUI-hosted cells adopt
    /// the new size at once while every height in the memo still described the old
    /// one, which on the phone is rows overlapping and labels sliced.
    ///
    /// They are resolved per CATEGORY now, memoized so the hot measurement paths
    /// still pay a dictionary hit rather than a UIKit font lookup, and dropped by
    /// `adopt(_:)` when the category moves. The layout actor calls `adopt` at the
    /// top of every build from `TimelineInput.sizeCategory`, and invalidates its
    /// own row memo on the same value — one signal, both halves.
    static var bodyFont: UIFont { fonts.resolve(.body) }
    static var captionFont: UIFont { fonts.resolve(.caption1) }
    static var caption2Font: UIFont { fonts.resolve(.caption2) }
    static var footnoteFont: UIFont { fonts.resolve(.footnote) }
    static var subheadlineFont: UIFont { fonts.resolve(.subheadline) }
    static var codeFont: UIFont { fonts.resolveMonospaced(.footnote) }
    static var codePreviewFont: UIFont { fonts.resolveMonospaced(.caption2) }

    /// A fixed point size, scaled by whatever the ADOPTED text size did to
    /// `textStyle` — `UIFontMetrics`, read through the same box the fonts are.
    ///
    /// WHY: the chips' chevron was a literal `.font(.system(size: 8))`, so at XXXL
    /// the caption beside it had nearly doubled while the one glyph that says the
    /// row OPENS stayed 8pt and all but vanished. A glyph paired with text has to
    /// move with that text; a magic number in the cell cannot.
    static func scaled(_ value: CGFloat, relativeTo textStyle: UIFont.TextStyle) -> CGFloat {
        fonts.scaled(value, relativeTo: textStyle)
    }

    /// The category the fonts are currently resolved FOR (`.unspecified` = whatever
    /// the system is set to). Read by the row builder so a row's SHAPE and its
    /// measured height come off one value — see `TimelineChipLayout`.
    static var adoptedCategory: UIContentSizeCategory { fonts.current }

    /// Adopt a content size category: a no-op unless it actually changed.
    ///
    /// Called from the layout actor, and the fonts are read from the actor AND
    /// from the main thread (cells), which is why the box locks rather than
    /// relying on either being the only caller.
    static func adopt(_ category: UIContentSizeCategory) {
        fonts.adopt(category)
    }

    private static let fonts = FontBox()

    /// Text-style → font, for ONE content size category at a time.
    private final class FontBox {
        private let lock = NSLock()
        private var category: UIContentSizeCategory = .unspecified
        private var resolved: [UIFont.TextStyle: UIFont] = [:]
        private var monospaced: [UIFont.TextStyle: UIFont] = [:]

        /// Deliberately NOT resolved against the system when `.unspecified`: this is
        /// read from the layout actor, and every API that knows the device's setting
        /// (`UIApplication`, `UIScreen.traitCollection`) is main-actor only. The app
        /// always adopts a real category (`TimelineHost` reads the hosting
        /// controller's trait collection), so `.unspecified` means "a test that did
        /// not set one" — and `TimelineChipLayout` treats it as an ordinary size.
        var current: UIContentSizeCategory {
            lock.lock()
            defer { lock.unlock() }
            return category
        }

        func adopt(_ next: UIContentSizeCategory) {
            lock.lock()
            defer { lock.unlock() }
            guard next != category else { return }
            category = next
            resolved.removeAll(keepingCapacity: true)
            monospaced.removeAll(keepingCapacity: true)
        }

        func resolve(_ style: UIFont.TextStyle) -> UIFont {
            lock.lock()
            defer { lock.unlock() }
            return locked(style)
        }

        func resolveMonospaced(_ style: UIFont.TextStyle) -> UIFont {
            lock.lock()
            defer { lock.unlock() }
            if let font = monospaced[style] { return font }
            // Derived UNDER the same lock as its base size: released in between,
            // an `adopt` could land and this would bank a monospaced font sized
            // for the previous text size, which nothing would clear again.
            let font = UIFont.monospacedSystemFont(ofSize: locked(style).pointSize,
                                                   weight: .regular)
            monospaced[style] = font
            return font
        }

        /// Scale a fixed point size for the adopted category (see
        /// `TimelineTextStyler.scaled`). Same lock and same `category` the fonts
        /// use, so a glyph and the text beside it can never be sized for two
        /// different text sizes.
        func scaled(_ value: CGFloat, relativeTo style: UIFont.TextStyle) -> CGFloat {
            lock.lock()
            defer { lock.unlock() }
            let metrics = UIFontMetrics(forTextStyle: style)
            guard category != .unspecified else { return metrics.scaledValue(for: value) }
            return metrics.scaledValue(
                for: value,
                compatibleWith: UITraitCollection { $0.preferredContentSizeCategory = category })
        }

        /// Caller holds the lock.
        ///
        /// Resolved FOR the adopted category rather than from the ambient system
        /// one, so the number the actor invalidates on and the font it then
        /// measures with cannot disagree — and so a test can drive a text size
        /// without touching the simulator's settings. `.unspecified` means
        /// "whatever the system is set to", which is `preferredFont`'s own answer
        /// with no trait collection.
        private func locked(_ style: UIFont.TextStyle) -> UIFont {
            if let font = resolved[style] { return font }
            let traits: UITraitCollection? = category == .unspecified
                ? nil
                : UITraitCollection { $0.preferredContentSizeCategory = category }
            let font = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
            resolved[style] = font
            return font
        }
    }

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
            MarkdownParser.linkifyPreviewableFilePaths(&attributed)
            let style = paragraphStyle(spacing: 0, lineSpacing: 3)
            return styledInline(attributed, font: font, color: color, paragraph: style)
        }
        return NSAttributedString(string: text, attributes: [
            .font: font, .foregroundColor: color,
            .paragraphStyle: paragraphStyle(spacing: 0, lineSpacing: 3),
        ])
    }
}
