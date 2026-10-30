import UIKit

/// Non-editable, non-scrolling TextKit 2 text view used by the text cells.
/// Configuration MUST stay in lockstep with TimelineTextMeasurer (padding 0,
/// zero insets, TextKit 2) — that pair is the height-parity contract.
final class TimelineTextView: UITextView {
    weak var actionDelegate: TimelineCellActionDelegate?

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

/// Code block: monospace text inside a horizontal UIScrollView, rounded
/// secondary background. Content size is pre-measured (no wrapping).
final class TimelineCodeCell: UICollectionViewCell {
    static let reuseID = "code"
    private let scroll = UIScrollView()
    private let card = UIView()
    private let label = UILabel()
    private var contentSize: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 10
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        scroll.showsHorizontalScrollIndicator = false
        label.font = TimelineTextStyler.codeFont
        label.numberOfLines = 0
        label.textColor = .label
        contentView.addSubview(card)
        card.addSubview(scroll)
        scroll.addSubview(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func configure(text: String, contentSize: CGSize) {
        label.text = text
        self.contentSize = contentSize
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        card.frame = contentView.bounds.inset(by: UIEdgeInsets(
            top: TimelineMetrics.codeVMargin, left: TimelineMetrics.hMargin,
            bottom: TimelineMetrics.codeVMargin, right: TimelineMetrics.hMargin
        ))
        scroll.frame = card.bounds
        label.frame = CGRect(x: TimelineMetrics.codePadding, y: TimelineMetrics.codePadding,
                             width: contentSize.width, height: contentSize.height)
        scroll.contentSize = CGSize(
            width: contentSize.width + TimelineMetrics.codePadding * 2,
            height: contentSize.height + TimelineMetrics.codePadding * 2
        )
    }
}
