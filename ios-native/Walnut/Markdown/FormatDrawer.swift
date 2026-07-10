import UIKit

/// Apple Notes-style Format drawer: a floating rounded card set as the text
/// view's `inputView`, replacing the keyboard. Paragraph-style taps keep the
/// drawer open and just re-highlight; trait / list taps stay open too. The
/// current caret's paragraph kind and active traits drive the highlights.
final class FormatDrawerView: UIView {
    private unowned let coordinator: WysiwygEditor.Coordinator
    private unowned let textView: UITextView
    private let onDismiss: () -> Void

    /// Walnut walnut-brown tint (mirrors Theme.tint: light #8B5A2B / dark #C99659).
    private static let tint = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xC9 / 255, green: 0x96 / 255, blue: 0x59 / 255, alpha: 1)
            : UIColor(red: 0x8B / 255, green: 0x5A / 255, blue: 0x2B / 255, alpha: 1)
    }

    private enum ParagraphTag { case title, heading, subheading, body, monostyled }
    private struct ParagraphSpec {
        let tag: ParagraphTag
        let kind: WalnutBlockKind
        let font: UIFont
        let label: String
        let button: UIButton
    }
    /// Which list segment corresponds to which paragraph kind, for highlight.
    private enum ListTag { case bullet, numbered, task }

    private var paragraphSpecs: [ParagraphSpec] = []
    private var traitButtons: [(MarkdownAttributed.InlineTrait, UIButton)] = []
    private var listSegments: [(ListTag, ToggleSegment)] = []

    init(coordinator: WysiwygEditor.Coordinator, textView: UITextView, onDismiss: @escaping () -> Void) {
        self.coordinator = coordinator
        self.textView = textView
        self.onDismiss = onDismiss
        // inputView is sized from its frame height.
        super.init(frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: 288))
        autoresizingMask = [.flexibleWidth]
        backgroundColor = .clear // let the app content show around the floating card
        buildUI()
    }

    required init?(coder: NSCoder) { nil }

    private func buildUI() {
        // Floating rounded card, inset from the edges like Apple Notes.
        let card = UIView()
        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 24
        card.layer.cornerCurve = .continuous
        card.translatesAutoresizingMaskIntoConstraints = false
        addSubview(card)
        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            card.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            card.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            card.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])

        let outer = UIStackView()
        outer.axis = .vertical
        outer.spacing = 14
        outer.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(outer)
        NSLayoutConstraint.activate([
            outer.topAnchor.constraint(equalTo: card.topAnchor, constant: 18),
            outer.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 24),
            outer.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24),
        ])

        outer.addArrangedSubview(headerRow())
        outer.addArrangedSubview(paragraphRow())
        outer.addArrangedSubview(traitPill())
        outer.addArrangedSubview(listRow())
    }

    // MARK: - Header

    private func headerRow() -> UIView {
        let row = UIView()
        let title = UILabel()
        title.text = "Format"
        title.font = .systemFont(ofSize: 20, weight: .bold)
        title.textColor = .label
        title.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(title)

        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold))
        config.baseForegroundColor = .secondaryLabel
        config.background.backgroundColor = .tertiarySystemFill
        config.background.cornerRadius = 18
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0)
        let close = UIButton(configuration: config)
        close.accessibilityIdentifier = "editor.format.close"
        close.addAction(UIAction { [weak self] _ in self?.onDismiss() }, for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(close)

        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: row.leadingAnchor),
            title.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            close.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            close.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            close.widthAnchor.constraint(equalToConstant: 36),
            close.heightAnchor.constraint(equalToConstant: 36),
            row.heightAnchor.constraint(equalToConstant: 36),
        ])
        return row
    }

    // MARK: - Row 1: paragraph styles (plain text, horizontally scrollable)

    private func paragraphRow() -> UIView {
        let specs: [(ParagraphTag, String, UIFont, WalnutBlockKind)] = [
            (.title, "Title", .systemFont(ofSize: 20, weight: .bold), .heading(prefix: "# ")),
            (.heading, "Heading", .systemFont(ofSize: 17, weight: .semibold), .heading(prefix: "## ")),
            (.subheading, "Subheading", .systemFont(ofSize: 15, weight: .semibold), .heading(prefix: "### ")),
            (.body, "Body", .systemFont(ofSize: 15, weight: .regular), .body),
            (.monostyled, "Monostyled", .monospacedSystemFont(ofSize: 14, weight: .regular), .verbatim),
        ]
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 28
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        for (tag, label, font, kind) in specs {
            let button = paragraphButton(label: label, font: font, kind: kind)
            paragraphSpecs.append(ParagraphSpec(tag: tag, kind: kind, font: font, label: label, button: button))
            stack.addArrangedSubview(button)
        }

        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.heightAnchor.constraint(equalToConstant: 40),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])
        return scroll
    }

    private func paragraphButton(label: String, font: UIFont, kind: WalnutBlockKind) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.contentInsets = .zero
        var container = AttributeContainer()
        container.font = font
        container.foregroundColor = .label
        config.attributedTitle = AttributedString(label, attributes: container)
        let button = UIButton(configuration: config)
        button.setContentHuggingPriority(.required, for: .horizontal)
        // Inside a scroll view the content width is ambiguous until something
        // refuses to shrink — without this the buttons compress and overlap.
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.coordinator.applyParagraphStyle(kind, to: self.textView)
            self.refreshSelection()
        }, for: .touchUpInside)
        return button
    }

    // MARK: - Row 2: character traits (one segmented pill with separators)

    private func traitPill() -> UIView {
        let traits: [(String, MarkdownAttributed.InlineTrait)] = [
            ("bold", .bold), ("italic", .italic), ("underline", .underline), ("strikethrough", .strike),
        ]
        let buttons = traits.map { symbol, trait -> UIButton in
            let button = symbolButton(symbol) { [weak self] in
                guard let self else { return }
                self.coordinator.toggleTrait(trait, in: self.textView)
                self.refreshSelection()
            }
            traitButtons.append((trait, button))
            return button
        }
        return segmentedPill(buttons, separators: true)
    }

    // MARK: - Row 3: list styles + indent (+ quote), three pills side by side

    private func listRow() -> UIView {
        // Filled-selection segments for the three list styles.
        let bullet = ToggleSegment(symbol: "list.bullet") { [weak self] in self?.tapList(.bullet) }
        let numbered = ToggleSegment(symbol: "list.number") { [weak self] in self?.tapList(.numbered) }
        let checklist = ToggleSegment(symbol: "checklist") { [weak self] in self?.tapList(.task) }
        listSegments = [(.bullet, bullet), (.numbered, numbered), (.task, checklist)]
        let listPill = segmentedPill([bullet, numbered, checklist], separators: false)

        // Indent — plain symbol buttons, no selection.
        let outdent = symbolButton("decrease.indent") { [weak self] in
            guard let self else { return }
            self.coordinator.adjustIndent(-1, in: self.textView)
        }
        let indent = symbolButton("increase.indent") { [weak self] in
            guard let self else { return }
            self.coordinator.adjustIndent(1, in: self.textView)
        }
        let indentPill = segmentedPill([outdent, indent], separators: true)

        // Quote — single segment.
        let quote = symbolButton("text.quote") { [weak self] in
            guard let self else { return }
            self.coordinator.applyParagraphStyle(.quote(prefix: "> "), to: self.textView)
            self.refreshSelection()
        }
        let quotePill = segmentedPill([quote], separators: false)

        let row = UIStackView(arrangedSubviews: [listPill, indentPill, quotePill])
        row.axis = .horizontal
        row.spacing = 12
        row.distribution = .fill
        // List pill flexes to fill; indent/quote size to their segments.
        listPill.setContentHuggingPriority(.defaultLow, for: .horizontal)
        indentPill.setContentHuggingPriority(.required, for: .horizontal)
        quotePill.setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            indentPill.widthAnchor.constraint(equalToConstant: 104),
            quotePill.widthAnchor.constraint(equalToConstant: 56),
        ])
        return row
    }

    private func tapList(_ tag: ListTag) {
        // Tapping the already-active list style turns it off (Apple Notes).
        let current = listTag(for: currentParagraphKind())
        let kind: WalnutBlockKind
        if current == tag {
            kind = .body
        } else {
            switch tag {
            case .bullet: kind = .bullet(prefix: "- ")
            case .numbered: kind = .numbered(prefix: "1. ")
            case .task: kind = .task
            }
        }
        coordinator.applyParagraphStyle(kind, to: textView)
        refreshSelection()
    }

    // MARK: - Shared builders

    private func symbolButton(_ name: String, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(
            UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular)),
            for: .normal
        )
        button.tintColor = .label
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return button
    }

    /// Rounded grouped container of equal-width segments (>= 44pt targets),
    /// optionally with 0.5pt hairlines between segments — Apple Notes style.
    private func segmentedPill(_ segments: [UIView], separators: Bool) -> UIView {
        let container = UIView()
        container.backgroundColor = .tertiarySystemFill
        container.layer.cornerRadius = 14
        container.layer.cornerCurve = .continuous
        let stack = UIStackView(arrangedSubviews: segments)
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            container.heightAnchor.constraint(equalToConstant: 52),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        if separators, segments.count > 1 {
            for i in 1..<segments.count {
                let sep = UIView()
                sep.backgroundColor = .separator
                sep.isUserInteractionEnabled = false
                sep.translatesAutoresizingMaskIntoConstraints = false
                container.addSubview(sep)
                NSLayoutConstraint.activate([
                    sep.widthAnchor.constraint(equalToConstant: 0.5),
                    sep.centerXAnchor.constraint(equalTo: segments[i].leadingAnchor),
                    sep.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
                    sep.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
                ])
            }
        }
        return container
    }

    // MARK: - Selection highlight

    /// Re-probe the caret's paragraph kind + active traits and update every
    /// highlight: Row-1 tint text, Row-2 active trait tint, Row-3 filled segment.
    func refreshSelection() {
        let kind = currentParagraphKind()
        let paragraphTag = paragraphTag(for: kind)
        for spec in paragraphSpecs {
            let selected = spec.tag == paragraphTag
            var container = AttributeContainer()
            container.font = spec.font
            container.foregroundColor = selected ? Self.tint : .label
            spec.button.configuration?.attributedTitle = AttributedString(spec.label, attributes: container)
        }
        for (trait, button) in traitButtons {
            button.tintColor = traitActive(trait) ? Self.tint : .label
        }
        let activeList = listTag(for: kind)
        for (tag, segment) in listSegments {
            segment.setSelected(tag == activeList, tint: Self.tint)
        }
    }

    private func currentParagraphKind() -> WalnutBlockKind {
        let storage = textView.textStorage
        guard storage.length > 0 else { return .body }
        let caret = textView.selectedRange.location
        let lineRange = (storage.string as NSString).lineRange(for: NSRange(location: min(caret, storage.length), length: 0))
        let probe = min(lineRange.location, storage.length - 1)
        let attrs = storage.attributes(at: probe, effectiveRange: nil)
        return (attrs[.walnutBlock] as? WalnutBlockKind) ?? .body
    }

    private func paragraphTag(for kind: WalnutBlockKind) -> ParagraphTag {
        switch kind {
        case .heading(let prefix):
            switch prefix.trimmingCharacters(in: .whitespaces).count {
            case 1: return .title
            case 2: return .heading
            default: return .subheading
            }
        case .verbatim:
            return .monostyled
        default:
            // body / bullet / numbered / task / quote are all body-level text.
            return .body
        }
    }

    private func listTag(for kind: WalnutBlockKind) -> ListTag? {
        switch kind {
        case .bullet: return .bullet
        case .numbered: return .numbered
        case .task: return .task
        default: return nil
        }
    }

    private func traitActive(_ trait: MarkdownAttributed.InlineTrait) -> Bool {
        let range = textView.selectedRange
        let attrs: [NSAttributedString.Key: Any]
        if range.length == 0 {
            attrs = coordinator.stickyTypingAttrs ?? textView.typingAttributes
        } else {
            attrs = textView.textStorage.attributes(at: range.location, effectiveRange: nil)
        }
        switch trait {
        case .bold:
            return ((attrs[.font] as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitBold)) ?? false
        case .italic:
            return ((attrs[.font] as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitItalic)) ?? false
        case .underline:
            return ((attrs[.underlineStyle] as? Int) ?? 0) != 0
        case .strike:
            return ((attrs[.strikethroughStyle] as? Int) ?? 0) != 0
        }
    }
}

/// A single icon segment with an inset rounded fill for its selected state —
/// the filled selected-segment look from Apple Notes' list control.
final class ToggleSegment: UIControl {
    private let selectionBackground = UIView()
    private let icon = UIImageView()
    private let onTap: () -> Void

    init(symbol: String, onTap: @escaping () -> Void) {
        self.onTap = onTap
        super.init(frame: .zero)

        selectionBackground.backgroundColor = .clear
        selectionBackground.layer.cornerRadius = 9
        selectionBackground.layer.cornerCurve = .continuous
        selectionBackground.isUserInteractionEnabled = false
        selectionBackground.translatesAutoresizingMaskIntoConstraints = false
        addSubview(selectionBackground)

        icon.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular))
        icon.tintColor = .label
        icon.contentMode = .center
        icon.isUserInteractionEnabled = false
        icon.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)

        NSLayoutConstraint.activate([
            selectionBackground.topAnchor.constraint(equalTo: topAnchor, constant: 5),
            selectionBackground.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5),
            selectionBackground.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            selectionBackground.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            icon.centerXAnchor.constraint(equalTo: centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        addTarget(self, action: #selector(handleTap), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { nil }

    @objc private func handleTap() { onTap() }

    func setSelected(_ selected: Bool, tint: UIColor) {
        selectionBackground.backgroundColor = selected ? tint : .clear
        icon.tintColor = selected ? .white : .label
    }
}
