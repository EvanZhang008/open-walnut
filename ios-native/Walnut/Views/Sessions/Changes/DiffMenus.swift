import SwiftUI

/// One row of a `DiffMenu`.
struct DiffMenuItem: Identifiable {
    /// Also the row's accessibility identifier.
    let id: String
    let title: String
    var systemImage: String?
    var checked = false
    var destructive = false
    let action: () -> Void
}

/// The Changed page's menus: an opaque card with a border and a shadow, over
/// the page and never moving it. (A system menu on iOS 26 is see-through glass:
/// the diff's colors and the list's words showed through it.)
struct DiffMenu: View {
    /// Groups of rows, a line between groups.
    let sections: [[DiffMenuItem]]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        // Scrolls only when it is taller than the room the popover has.
        ViewThatFits(in: .vertical) {
            rows
            ScrollView { rows }
        }
        .frame(minWidth: 250, alignment: .leading)
        // Rows wrap rather than cut off; past this size they grow no more.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .presentationCompactAdaptation(.popover)
        // The border follows the popover's own outline (its container shape), so
        // its corners are not cut off; opaqueSeparator reads in light and dark.
        .presentationBackground {
            ZStack {
                Color(uiColor: .systemBackground)
                ContainerRelativeShape().strokeBorder(Color(uiColor: .opaqueSeparator), lineWidth: 1.5)
            }
        }
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(sections.enumerated()), id: \.offset) { index, items in
                if index > 0 { Divider() }
                ForEach(items) { row($0) }
            }
        }
        .padding(.vertical, 4)
    }

    private func row(_ item: DiffMenuItem) -> some View {
        Button {
            dismiss()
            // After the menu is down: what it opens (an alert, a page) must not
            // arrive while the menu is still leaving.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(300))
                item.action()
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "checkmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.tint)
                    .opacity(item.checked ? 1 : 0)
                    .frame(width: 16)
                    .accessibilityHidden(true)
                Text(item.title)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 12)
                if let symbol = item.systemImage {
                    Image(systemName: symbol).accessibilityHidden(true)
                }
            }
            .foregroundStyle(item.destructive ? Theme.dangerText : Color(uiColor: .label))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(item.checked ? .isSelected : [])
        .accessibilityIdentifier(item.id)
    }
}
