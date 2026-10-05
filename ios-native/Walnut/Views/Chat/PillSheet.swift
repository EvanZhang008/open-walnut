import SwiftUI
import UIKit

/// The model pill's picker: a sheet titled "Select model", the way the Claude
/// app picks a model (user, 2026-10-04: "a drawer where I pick the model and the
/// effort", every list vertical). The models are one vertical list; the effort
/// is one row ("Effort  High") that opens its own vertical list, so a long
/// catalog and the levels never fight for the same space. It replaced a UIKit
/// menu that mixed a row of effort tiles with the model list.
///
/// The sheet renders the same `PillMenu` the menus did, so every state the model
/// pill has (a catalog, a just-failed write's reason, the Retry of an unknown
/// model, a fixed model) reads the same here.
///
/// Every pick closes the sheet. Taps are taken only once the sheet has settled
/// (`settleDelay`): a double tap on the pill must not land its second tap on a
/// row sliding up under the finger (gate r2 D1 was that bug on the menu).
struct PillMenuSheet: View {
    let title: String
    let menu: PillMenu
    let onSelect: (PillMenu.Choice, ComposerControlsModel.MenuToken) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var settled = false
    @State private var path: [Page] = []

    /// Measured from the sheet's first appearance: longer than its slide up.
    static let settleDelay: Duration = .milliseconds(600)

    enum Page: Hashable { case effort }

    /// How the sheet lays a menu out: the effort section (its rows are `.effort`
    /// choices) becomes one row on the first page; every other section is a list.
    struct Layout: Equatable {
        var lists: [PillMenu.Section]
        var effort: PillMenu.Section?

        init(_ menu: PillMenu) {
            lists = menu.sections.filter { !Self.isEffort($0) }
            effort = menu.sections.first(where: Self.isEffort)
        }

        static func isModelList(_ section: PillMenu.Section) -> Bool {
            section.items.contains {
                if case .model = $0.choice { return true }
                return false
            }
        }

        static func isEffort(_ section: PillMenu.Section) -> Bool {
            !section.items.isEmpty && section.items.allSatisfy {
                if case .effort = $0.choice { return true }
                return false
            }
        }

        /// What the Effort row says: the checked level, or the CLI's default
        /// when the session reports none.
        var effortValue: String? {
            guard let effort else { return nil }
            return effort.items.first(where: \.checked)?.title ?? "Default"
        }
    }

    var body: some View {
        let layout = Layout(menu)
        NavigationStack(path: $path) {
            List {
                if !menu.title.isEmpty {
                    Section {
                        Label(menu.title, systemImage: "exclamationmark.triangle")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(Array(layout.lists.enumerated()), id: \.offset) { _, section in
                    Section {
                        ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                            row(item)
                        }
                    } header: {
                        // A list of models needs no heading under "Select model";
                        // any other section's title is its reason (an unknown
                        // model's "Can't reach…", a fixed model's why).
                        if !Layout.isModelList(section), !section.title.isEmpty {
                            Text(section.title)
                        }
                    }
                }
                if let value = layout.effortValue {
                    Section {
                        NavigationLink(value: Page.effort) {
                            LabeledContent("Effort", value: value)
                        }
                        .accessibilityIdentifier("composer.modelSheet.effort")
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                    .accessibilityIdentifier("composer.modelSheet.close")
                }
            }
            .navigationDestination(for: Page.self) { _ in
                List {
                    Section {
                        ForEach(Array((layout.effort?.items ?? []).enumerated()), id: \.offset) { _, item in
                            row(item)
                        }
                    }
                }
                .navigationTitle("Effort")
                .navigationBarTitleDisplayMode(.inline)
            }
        }
        .allowsHitTesting(settled)
        .task {
            try? await Task.sleep(for: Self.settleDelay)
            settled = true
        }
    }

    private func row(_ item: PillMenu.Item) -> some View {
        Button {
            guard settled else { return }
            onSelect(item.choice, menu.token)
            dismiss()
        } label: {
            HStack {
                if let image = item.systemImage {
                    Image(systemName: image)
                }
                Text(item.title)
                    .foregroundStyle(item.enabled ? Color.primary : Color.secondary)
                Spacer(minLength: 8)
                if item.checked {
                    Image(systemName: "checkmark")
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.tint)
                }
            }
            .contentShape(Rectangle())
        }
        .disabled(!item.enabled)
        // The row is named by its title alone; the check is a trait, so a test or
        // VoiceOver finds "Sonnet 5" whether or not it is the current one.
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(item.checked ? .isSelected : [])
        .accessibilityIdentifier(item.accessibilityID ?? item.title)
    }
}

// MARK: - The pill's button when it opens a sheet

/// The transparent button over a pill whose picker is a sheet: one tap opens it,
/// keyboard up or not. A UIKit button for the same reasons as `PillMenuButton`
/// (one accessibility element carrying the id, label and value; the pressed look;
/// SwiftUI's `disabled` reaching `isEnabled`).
///
/// With the keyboard up, the tap puts it away and the sheet opens at once (a
/// sheet needs no room above the pill, unlike the menu, which needed two taps).
/// When the sheet closes the text view gets the focus back, so typing goes on.
struct PillSheetButton: UIViewRepresentable {
    var accessibilityID: String
    var accessibilityLabel: String
    var accessibilityValue: String?
    var focus: PillSheetFocus
    var onTap: () -> Void
    var onHighlightChange: (Bool) -> Void

    func makeUIView(context: Context) -> PillSheetUIButton {
        let button = PillSheetUIButton(frame: .zero)
        configure(button)
        return button
    }

    func updateUIView(_ button: PillSheetUIButton, context: Context) {
        configure(button)
    }

    private func configure(_ button: PillSheetUIButton) {
        button.accessibilityIdentifier = accessibilityID
        button.accessibilityLabel = accessibilityLabel
        button.accessibilityValue = accessibilityValue
        button.focus = focus
        button.onTap = onTap
        button.onHighlightChange = onHighlightChange
    }
}

final class PillSheetUIButton: UIButton {
    var onTap: (() -> Void)?
    var onHighlightChange: ((Bool) -> Void)?
    var focus: PillSheetFocus?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isAccessibilityElement = true
        addAction(UIAction { [weak self] _ in self?.tapped() }, for: .primaryActionTriggered)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var accessibilityTraits: UIAccessibilityTraits {
        get {
            var traits = super.accessibilityTraits.union(.button)
            if isEnabled { traits.remove(.notEnabled) } else { traits.insert(.notEnabled) }
            return traits
        }
        set { super.accessibilityTraits = newValue }
    }

    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != oldValue else { return }
            onHighlightChange?(isHighlighted)
        }
    }

    private func tapped() {
        if let text = window?.textFocus {
            focus?.putAway = text
            _ = text.resignFirstResponder()
        }
        onTap?()
    }
}

/// The text view a pill tap took the focus from, given back when its sheet
/// closes (unless it left the screen or something else took the focus).
final class PillSheetFocus {
    weak var putAway: UIView?

    func giveBack() {
        let view = putAway
        putAway = nil
        guard let view, view.window != nil, view.window?.textFocus == nil else { return }
        _ = view.becomeFirstResponder()
    }
}
