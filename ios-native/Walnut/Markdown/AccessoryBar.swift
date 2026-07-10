import UIKit
import PhotosUI

/// The editor's `inputAccessoryView` — a single restrained row (Apple Notes
/// style): Aa format drawer, checklist, table skeleton, photo, keyboard-down.
/// "Aa" swaps the text view's `inputView` to a Format drawer that REPLACES the
/// keyboard (this bar stays visible above it), exactly like Apple Notes.
final class AccessoryBar: UIView {
    private unowned let coordinator: WysiwygEditor.Coordinator
    private unowned let hostTextView: UITextView
    private var formatDrawer: FormatDrawerView?

    init(coordinator: WysiwygEditor.Coordinator, textView: UITextView) {
        self.coordinator = coordinator
        self.hostTextView = textView
        super.init(frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: 44))
        autoresizingMask = [.flexibleWidth]
        backgroundColor = .clear
        buildBar()
    }

    required init?(coder: NSCoder) { nil }

    /// Liquid Glass on iOS 26+, chrome blur on earlier.
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
        aaButton.addTarget(self, action: #selector(toggleFormatDrawer), for: .touchUpInside)
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

    /// Toggle the Format drawer in place of the keyboard. `inputView` + a
    /// `reloadInputViews()` is exactly how Apple Notes swaps between the
    /// keyboard and its Format panel.
    @objc private func toggleFormatDrawer() {
        if formatDrawer != nil {
            dismissFormatDrawer()
            return
        }
        let drawer = FormatDrawerView(coordinator: coordinator, textView: hostTextView) { [weak self] in
            self?.dismissFormatDrawer()
        }
        formatDrawer = drawer
        hostTextView.inputView = drawer
        hostTextView.reloadInputViews()
        drawer.refreshSelection()
    }

    private func dismissFormatDrawer() {
        formatDrawer = nil
        hostTextView.inputView = nil
        hostTextView.reloadInputViews()
    }

    @objc private func insertTask() {
        coordinator.insertTaskLine(in: hostTextView)
    }

    @objc private func insertTable() {
        coordinator.insertTableSkeleton(in: hostTextView)
    }

    @objc private func pickPhoto() {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        topMostViewController()?.present(picker, animated: true)
    }

    @objc private func dismissKeyboard() {
        // Reset the input view first so the next focus shows the keyboard,
        // not a lingering Format drawer.
        dismissFormatDrawer()
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
