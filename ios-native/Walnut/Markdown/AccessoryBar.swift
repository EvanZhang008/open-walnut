import UIKit
import PhotosUI

/// The editor's `inputAccessoryView` — a single restrained row (Apple Notes
/// style): Aa format panel, checklist, table skeleton, photo, keyboard-down.
/// "Aa" opens a floating card above the bar rather than growing the bar
/// itself, so the row height never changes under the keyboard.
final class AccessoryBar: UIView {
    private unowned let coordinator: WysiwygEditor.Coordinator
    private unowned let hostTextView: UITextView
    private var formatCard: FormatCardView?

    init(coordinator: WysiwygEditor.Coordinator, textView: UITextView) {
        self.coordinator = coordinator
        self.hostTextView = textView
        super.init(frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: 44))
        autoresizingMask = [.flexibleWidth]
        backgroundColor = .clear
        buildBar()
    }

    required init?(coder: NSCoder) { nil }

    func closeFormatCardIfOpen() {
        dismissFormatCard()
    }

    /// Liquid Glass on iOS 26+, chrome blur on earlier — one shared factory
    /// so the bar and the format card always match.
    static func glassView() -> UIVisualEffectView {
        if #available(iOS 26.0, *) {
            return UIVisualEffectView(effect: UIGlassEffect())
        }
        return UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
    }

    private func buildBar() {
        let glass = Self.glassView()
        glass.frame = bounds
        glass.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(glass)

        let hairline = UIView()
        hairline.backgroundColor = .separator
        hairline.frame = CGRect(x: 0, y: 0, width: bounds.width, height: 0.5)
        hairline.autoresizingMask = [.flexibleWidth]
        addSubview(hairline)

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 26
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        let aaButton = UIButton(type: .system)
        aaButton.setTitle("Aa", for: .normal)
        aaButton.titleLabel?.font = .systemFont(ofSize: 18, weight: .semibold)
        aaButton.tintColor = .label
        aaButton.addTarget(self, action: #selector(toggleFormatCard), for: .touchUpInside)
        aaButton.accessibilityIdentifier = "editor.format"

        let taskButton = iconButton("checklist", action: #selector(insertTask))
        let tableButton = iconButton("tablecells", action: #selector(insertTable))
        let photoButton = iconButton("photo", action: #selector(pickPhoto))
        [aaButton, taskButton, tableButton, photoButton].forEach { stack.addArrangedSubview($0) }

        let doneButton = UIButton(type: .system)
        doneButton.setImage(UIImage(systemName: "keyboard.chevron.compact.down"), for: .normal)
        doneButton.tintColor = .secondaryLabel
        doneButton.addTarget(self, action: #selector(dismissKeyboard), for: .touchUpInside)
        doneButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(doneButton)
        NSLayoutConstraint.activate([
            doneButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            doneButton.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    private func iconButton(_ systemName: String, action: Selector) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(
            UIImage(systemName: systemName, withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular)),
            for: .normal
        )
        button.tintColor = .label
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    @objc private func toggleFormatCard() {
        if formatCard != nil {
            dismissFormatCard()
            return
        }
        // The card must be a SUBVIEW of the bar, floating above it at a
        // negative y. Anything window-attached loses the z-order fight: with
        // the keyboard up, the accessory bar and the key surface live in
        // system windows above the app window, so a card added to any window
        // renders under the keys and taps land on the keyboard instead.
        let width = min(340, bounds.width - 16)
        let height: CGFloat = 176
        let card = FormatCardView(coordinator: coordinator, textView: hostTextView) { [weak self] in
            self?.dismissFormatCard()
        }
        card.frame = CGRect(
            x: (bounds.width - width) / 2,
            y: -height - 8,
            width: width,
            height: height
        )
        addSubview(card)
        formatCard = card
    }

    /// The floating card sits OUTSIDE the bar's bounds — hit-testing skips
    /// out-of-bounds subviews by default, so extend the hit area to cover it.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        if let card = formatCard, card.frame.contains(point) { return true }
        return super.point(inside: point, with: event)
    }

    private func dismissFormatCard() {
        formatCard?.removeFromSuperview()
        formatCard = nil
    }

    @objc private func insertTask() {
        dismissFormatCard()
        coordinator.insertTaskLine(in: hostTextView)
    }

    @objc private func insertTable() {
        dismissFormatCard()
        coordinator.insertTableSkeleton(in: hostTextView)
    }

    @objc private func pickPhoto() {
        dismissFormatCard()
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        topMostViewController()?.present(picker, animated: true)
    }

    @objc private func dismissKeyboard() {
        dismissFormatCard()
        hostTextView.resignFirstResponder()
    }

    private func topMostViewController() -> UIViewController? {
        guard var top = hostTextView.window?.rootViewController else { return nil }
        while let presented = top.presentedViewController { top = presented }
        return top
    }
}

extension AccessoryBar: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider, provider.canLoadObject(ofClass: UIImage.self) else { return }
        provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
            guard let image = object as? UIImage else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.coordinator.uploadAndInsert(image, into: self.hostTextView)
            }
        }
    }
}

/// Floating format card shown above the accessory bar when "Aa" is tapped:
/// paragraph styles (close the card on tap, matching Apple Notes), list
/// styles, and toggleable character styles (stay open for combos).
final class FormatCardView: UIView {
    private unowned let coordinator: WysiwygEditor.Coordinator
    private weak var textView: UITextView?
    private let onDismiss: () -> Void

    init(coordinator: WysiwygEditor.Coordinator, textView: UITextView, onDismiss: @escaping () -> Void) {
        self.coordinator = coordinator
        self.textView = textView
        self.onDismiss = onDismiss
        super.init(frame: .zero)
        buildUI()
    }

    required init?(coder: NSCoder) { nil }

    private func buildUI() {
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.18
        layer.shadowRadius = 14
        layer.shadowOffset = CGSize(width: 0, height: 4)

        let blur = AccessoryBar.glassView()
        blur.layer.cornerRadius = 14
        blur.layer.cornerCurve = .continuous
        blur.clipsToBounds = true
        blur.translatesAutoresizingMaskIntoConstraints = false
        addSubview(blur)
        NSLayoutConstraint.activate([
            blur.leadingAnchor.constraint(equalTo: leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: trailingAnchor),
            blur.topAnchor.constraint(equalTo: topAnchor),
            blur.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        let outer = UIStackView()
        outer.axis = .vertical
        outer.spacing = 4
        outer.translatesAutoresizingMaskIntoConstraints = false
        blur.contentView.addSubview(outer)
        NSLayoutConstraint.activate([
            outer.leadingAnchor.constraint(equalTo: blur.contentView.leadingAnchor, constant: 10),
            outer.trailingAnchor.constraint(equalTo: blur.contentView.trailingAnchor, constant: -10),
            outer.topAnchor.constraint(equalTo: blur.contentView.topAnchor, constant: 8),
            outer.bottomAnchor.constraint(equalTo: blur.contentView.bottomAnchor, constant: -8),
        ])

        outer.addArrangedSubview(paragraphStyleRow())
        outer.addArrangedSubview(divider())
        outer.addArrangedSubview(listStyleRow())
        outer.addArrangedSubview(divider())
        outer.addArrangedSubview(traitRow())
    }

    private func divider() -> UIView {
        let line = UIView()
        line.backgroundColor = .separator
        line.heightAnchor.constraint(equalToConstant: 0.5).isActive = true
        return line
    }

    private func paragraphStyleRow() -> UIStackView {
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        let styles: [(String, UIFont, WalnutBlockKind)] = [
            ("Title", .systemFont(ofSize: 17, weight: .bold), .heading(prefix: "# ")),
            ("Heading", .systemFont(ofSize: 15, weight: .semibold), .heading(prefix: "## ")),
            ("Subheading", .systemFont(ofSize: 14, weight: .medium), .heading(prefix: "### ")),
            ("Body", .systemFont(ofSize: 14, weight: .regular), .body),
        ]
        for (label, font, kind) in styles {
            let button = UIButton(type: .system)
            button.setTitle(label, for: .normal)
            button.setTitleColor(.label, for: .normal)
            button.titleLabel?.font = font
            button.titleLabel?.adjustsFontSizeToFitWidth = true
            button.addAction(UIAction { [weak self] _ in
                guard let self, let tv = self.textView else { return }
                self.coordinator.applyParagraphStyle(kind, to: tv)
                self.onDismiss()
            }, for: .touchUpInside)
            row.addArrangedSubview(button)
        }
        return row
    }

    private func listStyleRow() -> UIStackView {
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        let styles: [(String, WalnutBlockKind)] = [
            ("list.bullet", .bullet(prefix: "- ")),
            ("list.number", .numbered(prefix: "1. ")),
        ]
        for (symbol, kind) in styles {
            let button = UIButton(type: .system)
            button.setImage(UIImage(systemName: symbol), for: .normal)
            button.tintColor = .label
            button.addAction(UIAction { [weak self] _ in
                guard let self, let tv = self.textView else { return }
                self.coordinator.applyParagraphStyle(kind, to: tv)
                self.onDismiss()
            }, for: .touchUpInside)
            row.addArrangedSubview(button)
        }
        return row
    }

    private func traitRow() -> UIStackView {
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        let traits: [(String, MarkdownAttributed.InlineTrait)] = [
            ("bold", .bold), ("italic", .italic), ("underline", .underline), ("strikethrough", .strike),
        ]
        for (symbol, trait) in traits {
            let button = UIButton(type: .system)
            button.setImage(UIImage(systemName: symbol), for: .normal)
            button.tintColor = .label
            button.addAction(UIAction { [weak self] _ in
                guard let self, let tv = self.textView else { return }
                self.coordinator.toggleTrait(trait, in: tv)
            }, for: .touchUpInside)
            row.addArrangedSubview(button)
        }
        return row
    }
}
