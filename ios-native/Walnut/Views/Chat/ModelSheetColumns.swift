import SwiftUI

/// The model sheet's first card: the models on the left, the effort levels on the
/// right, side by side the way the web picker lays them out (design v2, the user,
/// 2026-11-21: "左边是 model，右边是 effort"). The effort column is as wide as its
/// longest level, so the model names get the rest of the card; a model with no
/// effort axis gets the whole card.
///
/// Both columns are plain stacks inside one List row, so a long catalog scrolls with
/// the sheet itself (no scroll view inside a scroll view). At the accessibility
/// text sizes the levels go under the models instead: two columns of AX5 text
/// would leave a model name a word per line.
struct ModelEffortColumns: View {
    let models: PillMenu.Section
    let effort: PillMenu.Section?
    let settled: Bool
    let onPick: (PillMenu.Item) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if let effort {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 0) {
                    column("Model", models)
                    Divider()
                    column("Effort", effort)
                }
            } else {
                HStack(alignment: .top, spacing: 0) {
                    column("Model", models)
                        .frame(maxWidth: .infinity)
                    Divider()
                    column("Effort", effort)
                        .fixedSize(horizontal: true, vertical: false)
                }
                // The divider runs the height of the taller column, and no taller.
                .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            column("Model", models)
        }
    }

    private func column(_ heading: String, _ section: PillMenu.Section) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(heading.uppercased())
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, Self.rowInsets.leading)
                .padding(.top, 10)
                .padding(.bottom, 6)
                .accessibilityAddTraits(.isHeader)
            ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                Divider()
                PillSheetRow(item: item, settled: settled, insets: Self.rowInsets, onPick: onPick)
                    // Many buttons in one List row: each takes only its own taps.
                    .buttonStyle(.plain)
            }
        }
    }

    static let rowInsets = EdgeInsets(top: 11, leading: 14, bottom: 11, trailing: 14)
}

/// One choice of the sheet: its title, the current one in the tint. Used by the
/// columns and by the sheet's other lists (an unknown model's Retry, a fixed model).
struct PillSheetRow: View {
    let item: PillMenu.Item
    let settled: Bool
    var insets = EdgeInsets()
    let onPick: (PillMenu.Item) -> Void
    @Environment(\.walnutPalette) private var palette

    var body: some View {
        Button {
            guard settled else { return }
            onPick(item)
        } label: {
            HStack(spacing: 8) {
                if let image = item.systemImage {
                    Image(systemName: image)
                }
                // The current one is its name in the tint, no checkmark (the user, 2026-11-14, on the
                // web picker: "just show the name, and colour the selected one").
                Text(item.title)
                    .fontWeight(item.checked ? .semibold : .regular)
                    .foregroundStyle(item.checked ? palette.tint : item.enabled ? Color.primary : Color.secondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
            }
            .padding(insets)
            .frame(maxWidth: .infinity, alignment: .leading)
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
