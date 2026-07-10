import UIKit
import PhotosUI

/// The editor's `inputAccessoryView` — a floating glass capsule (Apple Notes
/// style): Aa format drawer, checklist, table skeleton, photo, keyboard-down.
/// "Aa" swaps the text view's `inputView` to a Format drawer that REPLACES the
/// keyboard (this bar stays visible above it), exactly like Apple Notes.
final class AccessoryBar: UIView {
    private unowned let coordinator: WysiwygEditor.Coordinator
    private unowned let hostTextView: UITextView
    private var formatDrawer: FormatDrawerView?

    private static let capsuleHeight: CGFloat = 48

    init(coordinator: WysiwygEditor.Coordinator, textView: UITextView) {
        self.coordinator = coordinator
        self.hostTextView = textView
        super.init(frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: Self.capsuleHeight + 12))
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
        return UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    }

    private func buildBar() {
        // Floating capsule: inset from the screen edges with continuous
        // corners, hairline border and a soft shadow — the whole bar view
        // itself stays transparent so the note shows through around it.
        let capsule = UIView()
        capsule.translatesAutoresizingMaskIntoConstraints = false
        capsule.layer.cornerRadius = Self.capsuleHeight / 2
        capsule.layer.cornerCurve = .continuous
        capsule.layer.borderWidth = 0.5
        capsule.layer.borderColor = UIColor.separator.withAlphaComponent(0.35).cgColor
        capsule.layer.shadowColor = UIColor.black.cgColor
        capsule.layer.shadowOpacity = 0.12
        capsule.layer.shadowRadius = 12
        capsule.layer.shadowOffset = CGSize(width: 0, height: 4)
        addSubview(capsule)
        NSLayoutConstraint.activate([
            capsule.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            capsule.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            capsule.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            capsule.heightAnchor.constraint(equalToConstant: Self.capsuleHeight),
        ])

        let glass = Self.glassView()
        glass.translatesAutoresizingMaskIntoConstraints = false
        glass.layer.cornerRadius = Self.capsuleHeight / 2
        glass.layer.cornerCurve = .continuous
        glass.clipsToBounds = true
        capsule.addSubview(glass)
        NSLayoutConstraint.activate([
            glass.leadingAnchor.constraint(equalTo: capsule.leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: capsule.trailingAnchor),
            glass.topAnchor.constraint(equalTo: capsule.topAnchor),
            glass.bottomAnchor.constraint(equalTo: capsule.bottomAnchor),
        ])

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        capsule.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: capsule.leadingAnchor, constant: 20),
            stack.centerYAnchor.constraint(equalTo: capsule.centerYAnchor),
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
        capsule.addSubview(doneButton)
        NSLayoutConstraint.activate([
            doneButton.trailingAnchor.constraint(equalTo: capsule.trailingAnchor, constant: -20),
            doneButton.centerYAnchor.constraint(equalTo: capsule.centerYAnchor),
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
