import SwiftUI
import UIKit

/// The model pill's picker: a sheet titled "Select model", the way the Claude
/// app picks a model (user, 2026-10-04: "a drawer where I pick the model and the
/// effort"). Its first card holds the models on the left and the effort levels on
/// the right (`ModelEffortColumns`; design v2, 2026-11-21: "左边是 model，右边是
/// effort"), as the web picker lays them out. Under it, for a session, three rows
/// open the details (`ModelSheetFoldRows`): what it cost, how fast its last turn
/// ran, its context.
///
/// The sheet renders the same `PillMenu` the menus did, so every state the model
/// pill has (a catalog, a just-failed write's reason, the Retry of an unknown
/// model, a fixed model) reads the same here: anything that is not the model list
/// or the levels is its own list, headed by its reason.
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
    /// The session's cost, speed and context; nil for the new-session draft.
    @State private var facts: ModelSheetFacts?

    /// `sessionID`: the session the menu configures, whose facts the rows under the
    /// columns show; nil (the draft) shows none.
    init(
        title: String, menu: PillMenu, sessionID: String? = nil,
        onSelect: @escaping (PillMenu.Choice, ComposerControlsModel.MenuToken) -> Void
    ) {
        self.title = title
        self.menu = menu
        self.onSelect = onSelect
        _facts = State(initialValue: sessionID.map { ModelSheetFacts(sessionID: $0) })
    }

    /// Measured from the sheet's first appearance: longer than its slide up.
    static let settleDelay: Duration = .milliseconds(600)

    /// The pages the rows under the columns open.
    enum Page: Hashable { case cost, speed, details }

    /// How the sheet lays a menu out: the model list beside the effort levels (its
    /// rows are `.effort` choices); every other section is a list of its own.
    struct Layout: Equatable {
        var models: PillMenu.Section?
        var effort: PillMenu.Section?
        var lists: [PillMenu.Section]

        init(_ menu: PillMenu) {
            let effortIndex = menu.sections.firstIndex(where: Self.isEffort)
            let modelIndex = menu.sections.indices.first { $0 != effortIndex && Self.isModelList(menu.sections[$0]) }
            effort = effortIndex.map { menu.sections[$0] }
            models = modelIndex.map { menu.sections[$0] }
            lists = menu.sections.indices.filter { $0 != effortIndex && $0 != modelIndex }.map { menu.sections[$0] }
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
                            PillSheetRow(item: item, settled: settled, onPick: pick)
                        }
                    } header: {
                        // Its title is its reason (an unknown model's "Can't reach…",
                        // a fixed model's why).
                        if !section.title.isEmpty {
                            Text(section.title)
                        }
                    }
                }
                if let models = layout.models {
                    Section {
                        ModelEffortColumns(models: models, effort: layout.effort, settled: settled, onPick: pick)
                            .listRowInsets(EdgeInsets())
                    }
                }
                if let facts {
                    ModelSheetFoldRows(facts: facts)
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
            .navigationDestination(for: Page.self) { page in
                if let facts {
                    ModelSheetFoldPage(page: page, facts: facts, menu: menu)
                }
            }
        }
        .allowsHitTesting(settled)
        .task {
            try? await Task.sleep(for: Self.settleDelay)
            settled = true
        }
        .task {
            await facts?.load()
        }
    }

    private func pick(_ item: PillMenu.Item) {
        guard settled else { return }
        onSelect(item.choice, menu.token)
        dismiss()
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
