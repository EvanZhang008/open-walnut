import UIKit

/// Non-editable, non-scrolling TextKit 2 text view used by the text cells.
/// Configuration MUST stay in lockstep with TimelineTextMeasurer (padding 0,
/// zero insets, TextKit 2) — that pair is the height-parity contract.
extension NSAttributedString.Key {
    /// What VoiceOver reads for a row whose drawing carries meaning its characters do
    /// not (a pill's status dot): set over the whole string, read by the text cell.
    static let timelineSpoken = NSAttributedString.Key("walnut.timelineSpoken")
}

final class TimelineTextView: UITextView {
    weak var actionDelegate: TimelineCellActionDelegate?
    /// Replaces the text VoiceOver reads (`NSAttributedString.Key.timelineSpoken`).
    var spokenText: String?

    override var accessibilityValue: String? {
        get { spokenText ?? super.accessibilityValue }
        set { super.accessibilityValue = newValue }
    }

    init() {
        // usingTextLayoutManager: true → TextKit 2, same stack the measurer runs.
        super.init(frame: .zero, textContainer: nil)
        isEditable = false
        isScrollEnabled = false
        backgroundColor = .clear
        textContainerInset = .zero
        textContainer.lineFragmentPadding = 0
        adjustsFontForContentSizeCategory = false
        linkTextAttributes = [:] // styling rides the attributed string itself
        isSelectable = true
        delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }
}

extension TimelineTextView: UITextViewDelegate {
    func textView(_ textView: UITextView, shouldInteractWith URL: URL,
                  in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
        guard interaction == .invokeDefaultAction else { return true }
        actionDelegate?.timelineCell(didRequest: .openURL(URL))
        return false
    }
}

/// Cells raise user actions through this (controller implements it).
protocol TimelineCellActionDelegate: AnyObject {
    func timelineCell(didRequest action: TimelineRowAction)
}

/// Assistant / prose text row: attach = assign the pre-built attributed
/// string. O(text-in-this-cell) glyph layout for on-screen cells only.
final class TimelineTextCell: UICollectionViewCell {
    static let reuseID = "text"
    private let textView = TimelineTextView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.addSubview(textView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func configure(text: NSAttributedString, delegate: TimelineCellActionDelegate?) {
        textView.attributedText = text
        textView.actionDelegate = delegate
        textView.spokenText = text.length > 0
            ? text.attribute(.timelineSpoken, at: 0, effectiveRange: nil) as? String : nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        textView.frame = contentView.bounds.inset(by: UIEdgeInsets(
            top: TimelineMetrics.textVPad, left: TimelineMetrics.hMargin,
            bottom: TimelineMetrics.textVPad,
            right: TimelineMetrics.hMargin + TimelineMetrics.assistantTrailingGap
        ))
    }
}

/// Right-aligned user bubble (soft tint, hugs its text width).
final class TimelineUserBubbleCell: UICollectionViewCell {
    static let reuseID = "bubble"
    private let bubble = UIView()
    private let textView = TimelineTextView()
    private var textSize: CGSize = .zero
    private var messageID: String?
    private var failed = false
    private var rawText: String = ""
    /// The long-press item that shows or hides what Walnut added to this message.
    private var added: TimelineAddedMenu?
    private weak var delegate: TimelineCellActionDelegate?
    /// True from the menu's appearance until its closing animation ends.
    private var menuOnScreen = false
    /// A chosen item that changes the rows (show/hide, retry, delete), sent only
    /// once the menu has closed. The list reloads on such a change and reuses this
    /// cell for another message, while UIKit still animates and hides the bubble
    /// it lifted: that message's words showed in the closing preview, its own row
    /// went blank, and a stand-in picture of this bubble only moved the glitch.
    private var heldAction: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        bubble.layer.cornerRadius = TimelineMetrics.bubbleCorner
        bubble.layer.cornerCurve = .continuous
        contentView.addSubview(bubble)
        bubble.addSubview(textView)
        let interaction = UIContextMenuInteraction(delegate: self)
        bubble.addInteraction(interaction)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func configure(text: NSAttributedString, textSize: CGSize, failed: Bool,
                   pending: Bool, messageID: String, added: TimelineAddedMenu? = nil,
                   delegate: TimelineCellActionDelegate?) {
        textView.attributedText = text
        textView.actionDelegate = delegate
        self.textSize = textSize
        self.messageID = messageID
        self.failed = failed
        self.rawText = text.string
        self.added = added
        self.delegate = delegate
        // VoiceOver reads the text view, not the bubble: the same item is offered
        // there as an action, since a long press is not how it opens menus.
        textView.accessibilityCustomActions = added.map { added in
            [UIAccessibilityCustomAction(name: added.title) { [weak self] _ in
                self?.delegate?.timelineCell(didRequest: .toggleExpanded(rowID: added.toggleRowID))
                return true
            }]
        }
        bubble.backgroundColor = failed
            ? UIColor(Theme.danger).withAlphaComponent(0.08)
            : UIColor(Theme.tintSoft)
        bubble.layer.borderWidth = failed ? 1 : 0
        bubble.layer.borderColor = failed
            ? UIColor(Theme.danger).withAlphaComponent(0.5).cgColor : nil
        bubble.alpha = pending ? 0.65 : 1
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let bubbleW = textSize.width + TimelineMetrics.bubbleHPad * 2
        let bubbleH = textSize.height + TimelineMetrics.bubbleVPad * 2
        bubble.frame = CGRect(
            x: contentView.bounds.width - TimelineMetrics.hMargin - bubbleW,
            y: TimelineMetrics.textVPad, width: bubbleW, height: bubbleH
        )
        textView.frame = bubble.bounds.insetBy(dx: TimelineMetrics.bubbleHPad,
                                               dy: TimelineMetrics.bubbleVPad)
    }
}

extension TimelineUserBubbleCell: UIContextMenuInteractionDelegate {
    func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        configurationForMenuAtLocation location: CGPoint
    ) -> UIContextMenuConfiguration? {
        let messageID = self.messageID
        let failed = self.failed
        let rawText = self.rawText
        let added = self.added
        weak var delegate = self.delegate
        let send: (TimelineRowAction) -> Void = { [weak self] action in
            self?.sendAfterMenuCloses { delegate?.timelineCell(didRequest: action) }
        }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in
            var actions: [UIAction] = []
            if failed, let messageID {
                actions.append(UIAction(title: "Retry",
                                        image: UIImage(systemName: "arrow.clockwise")) { _ in
                    send(.retry(messageID: messageID))
                })
            }
            actions.append(UIAction(title: "Copy",
                                    image: UIImage(systemName: "doc.on.doc")) { _ in
                UIPasteboard.general.string = rawText
            })
            if let added {
                // What Walnut put around the person's words, for this message only.
                actions.append(UIAction(title: added.title,
                                        image: UIImage(systemName: added.shown ? "eye.slash" : "eye")) { _ in
                    send(.toggleExpanded(rowID: added.toggleRowID))
                })
            }
            if failed, let messageID {
                actions.append(UIAction(title: "Delete",
                                        image: UIImage(systemName: "trash"),
                                        attributes: .destructive) { _ in
                    send(.discard(messageID: messageID))
                })
            }
            return UIMenu(children: actions)
        }
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                willDisplayMenuFor configuration: UIContextMenuConfiguration,
                                animator: UIContextMenuInteractionAnimating?) {
        menuOnScreen = true
    }

    /// Close with a plain fade where the menu is: it ends sooner than the lifted
    /// bubble shrinking back to its place, and the held change waits for its end.
    func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration)
        -> UITargetedPreview? {
        nil
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                willEndFor configuration: UIContextMenuConfiguration,
                                animator: UIContextMenuInteractionAnimating?) {
        let finish: () -> Void = { [weak self] in
            guard let self else { return }
            self.menuOnScreen = false
            let held = self.heldAction
            self.heldAction = nil
            held?()
        }
        if let animator { animator.addCompletion(finish) } else { DispatchQueue.main.async(execute: finish) }
    }

    /// Run `send` now, or when the menu's closing animation ends if it is still on screen.
    private func sendAfterMenuCloses(_ send: @escaping () -> Void) {
        if menuOnScreen { heldAction = send } else { send() }
    }
}

/// Code block: a header strip (language label, Wrap, Copy) over colored
/// monospace text. Unwrapped, the text sits in a horizontal UIScrollView at its
/// pre-measured widest line; wrapped (its own Wrap, per block), it is laid out at
/// the card's width. The builder measures both (the cell never sizes itself).
/// The text is a `TimelineTextView`, the stack the measurer matches, so part of
/// a block can be selected and copied as well.
final class TimelineCodeCell: UICollectionViewCell {
    static let reuseID = "code"
    private let scroll = UIScrollView()
    private let card = UIView()
    private let header = UIView()
    private let rule = UIView()
    private let languageLabel = UILabel()
    private let wrapButton = UIButton(type: .system)
    private let copyButton = UIButton(type: .system)
    private let textView = TimelineTextView()
    private var block: TimelineCodeBlock?
    private weak var delegate: TimelineCellActionDelegate?
    private var copiedReset: DispatchWorkItem?
    /// The top of the timeline's visible area in this cell's coordinates, last
    /// told by `pinHeader`: the header moves down the card to stay under it
    /// while the block's middle is read, as the web header sticks.
    private var visibleTop: CGFloat = -.greatestFiniteMagnitude

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.backgroundColor = .secondarySystemBackground
        // Opaque: pinned, it covers the code scrolling under it.
        header.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 10
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        scroll.showsHorizontalScrollIndicator = true
        scroll.alwaysBounceHorizontal = false
        textView.isSelectable = true
        rule.backgroundColor = .separator
        languageLabel.font = .monospacedSystemFont(ofSize: 12, weight: .medium)
        languageLabel.textColor = .secondaryLabel
        languageLabel.lineBreakMode = .byTruncatingMiddle
        configureButton(wrapButton, title: "Wrap", symbol: "arrow.turn.down.left", label: "Wrap long lines")
        configureButton(copyButton, title: "Copy", symbol: "doc.on.doc", label: "Copy code")
        wrapButton.addAction(UIAction { [weak self] _ in
            guard let self, let key = self.block?.key else { return }
            self.delegate?.timelineCell(didRequest: .toggleCodeWrap(key: key))
        }, for: .touchUpInside)
        copyButton.addAction(UIAction { [weak self] _ in self?.copyCode() }, for: .touchUpInside)
        wrapButton.accessibilityIdentifier = "timeline.code.wrap"
        copyButton.accessibilityIdentifier = "timeline.code.copy"
        contentView.addSubview(card)
        card.addSubview(scroll)
        card.addSubview(header)
        header.addSubview(languageLabel)
        header.addSubview(wrapButton)
        header.addSubview(copyButton)
        header.addSubview(rule)
        scroll.addSubview(textView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private func configureButton(_ button: UIButton, title: String?, symbol: String, label: String) {
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .medium))
        config.imagePadding = 4
        config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8)
        config.baseForegroundColor = .secondaryLabel
        if let title {
            var attrs = AttributeContainer()
            attrs.font = UIFont.systemFont(ofSize: 13, weight: .medium)
            config.attributedTitle = AttributedString(title, attributes: attrs)
        }
        config.background.cornerRadius = 7
        button.configuration = config
        button.accessibilityLabel = label
    }

    func configure(_ block: TimelineCodeBlock, delegate: TimelineCellActionDelegate?) {
        self.block = block
        self.delegate = delegate
        textView.attributedText = block.attributed
        languageLabel.text = block.label
        languageLabel.isHidden = block.label.isEmpty
        var wrapConfig = wrapButton.configuration
        wrapConfig?.baseForegroundColor = block.wrapped ? .label : .secondaryLabel
        wrapConfig?.background.backgroundColor = block.wrapped ? UIColor.label.withAlphaComponent(0.1) : .clear
        wrapButton.configuration = wrapConfig
        wrapButton.isSelected = false
        wrapButton.accessibilityLabel = block.wrapped ? "Stop wrapping long lines" : "Wrap long lines"
        wrapButton.accessibilityTraits = block.wrapped ? [.button, .selected] : .button
        // Nothing to wrap: no Wrap (a wrapped block keeps it, to undo).
        wrapButton.isHidden = block.fits && !block.wrapped
        scroll.isScrollEnabled = !block.wrapped
        if block.wrapped { scroll.contentOffset = .zero }
        showCopied(false)
        setNeedsLayout()
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        copiedReset?.cancel()
        copiedReset = nil
        scroll.contentOffset = .zero
        visibleTop = -.greatestFiniteMagnitude
    }

    /// Keep the header (Copy, Wrap) in view: `visibleTop` is the top of the
    /// timeline's visible area in this cell's coordinates. The header rides
    /// down the card no further than its last line, so it leaves with the block.
    func pinHeader(visibleTop: CGFloat) {
        self.visibleTop = visibleTop
        let pin = headerPin
        if abs(pin - header.frame.minY) > 0.25 { header.frame.origin.y = pin }
    }

    /// Where the header sits in the card now (tests).
    var headerOffset: CGFloat { header.frame.minY }

    private var headerPin: CGFloat {
        let maxPin = max(0, card.bounds.height - TimelineMetrics.codeHeaderHeight)
        return min(max(0, visibleTop - card.frame.minY), maxPin)
    }

    private func copyCode() {
        guard let block else { return }
        UIPasteboard.general.string = block.text
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        showCopied(true)
        copiedReset?.cancel()
        let reset = DispatchWorkItem { [weak self] in self?.showCopied(false) }
        copiedReset = reset
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: reset)
    }

    private func showCopied(_ copied: Bool) {
        var config = copyButton.configuration
        var attrs = AttributeContainer()
        attrs.font = UIFont.systemFont(ofSize: 13, weight: .medium)
        config?.attributedTitle = AttributedString(copied ? "Copied" : "Copy", attributes: attrs)
        config?.image = UIImage(systemName: copied ? "checkmark" : "doc.on.doc",
                                withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
        config?.baseForegroundColor = copied ? .systemGreen : .secondaryLabel
        copyButton.configuration = config
        copyButton.accessibilityLabel = copied ? "Copied" : "Copy code"
        if copied { UIAccessibility.post(notification: .announcement, argument: "Copied") }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        card.frame = contentView.bounds.inset(by: UIEdgeInsets(
            top: TimelineMetrics.codeVMargin, left: TimelineMetrics.hMargin,
            bottom: TimelineMetrics.codeVMargin, right: TimelineMetrics.hMargin
        ))
        let headerH = TimelineMetrics.codeHeaderHeight
        header.frame = CGRect(x: 0, y: headerPin, width: card.bounds.width, height: headerH)
        rule.frame = CGRect(x: 0, y: headerH - 1 / max(1, traitCollection.displayScale),
                            width: card.bounds.width, height: 1 / max(1, traitCollection.displayScale))
        let copySize = copyButton.sizeThatFits(CGSize(width: 200, height: headerH))
        let wrapSize = wrapButton.sizeThatFits(CGSize(width: 200, height: headerH))
        // At least 36pt wide, the header's full height: a fingertip's target.
        let copyW = max(copySize.width, 36), wrapW = max(wrapSize.width, 40)
        copyButton.frame = CGRect(x: card.bounds.width - 4 - copyW, y: 0, width: copyW, height: headerH)
        wrapButton.frame = CGRect(x: copyButton.frame.minX - wrapW, y: 0, width: wrapW, height: headerH)
        languageLabel.frame = CGRect(x: TimelineMetrics.codePadding, y: 0,
                                     width: max(0, wrapButton.frame.minX - TimelineMetrics.codePadding - 4),
                                     height: headerH)
        scroll.frame = CGRect(x: 0, y: headerH, width: card.bounds.width,
                              height: max(0, card.bounds.height - headerH))
        let size = block?.contentSize ?? .zero
        // Wrapped, the text breaks at exactly the width it was measured at;
        // unwrapped, a little slack past the widest line keeps TextKit from
        // wrapping a line the builder measured as fitting.
        let textWidth = (block?.wrapped ?? false) ? size.width : size.width + TimelineMetrics.codeUnwrappedSlack
        textView.frame = CGRect(x: TimelineMetrics.codePadding, y: TimelineMetrics.codePadding,
                                width: textWidth, height: size.height)
        scroll.contentSize = CGSize(
            width: (block?.wrapped ?? false) ? scroll.bounds.width : textWidth + TimelineMetrics.codePadding * 2,
            height: size.height + TimelineMetrics.codePadding * 2
        )
    }
}
