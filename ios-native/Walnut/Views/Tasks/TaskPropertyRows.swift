import SwiftUI

// MARK: - The row shells the task properties list is built from
//
// One rule they all encode: a row that CAN be changed carries an affordance
// glyph and a tinted value, and a row that cannot carries neither. The defect
// being fixed was chips that were Menus but looked like labels, so "does this
// respond to a tap" now has exactly one visual answer in both directions.

/// Trailing affordance on a property row.
enum TaskPropertyAffordance {
    /// A menu opens in place (up/down chevrons, the system's own menu glyph).
    case menu
    /// A picker is presented (right chevron).
    case disclosure
    /// Read-only: no glyph, secondary value. Never on a row that writes.
    case readOnly
}

/// Label on the left, current value on the right, affordance at the trailing
/// edge. 44pt minimum so the whole row is the hit target, not just the value.
///
/// At accessibility sizes the two halves STACK. Side by side, each half gets
/// roughly a third of the width and both wrap mid-word ("Boa/rd", "Pri/ority",
/// verified at XXXL on device) — a stacked row is what iOS itself does and it
/// lets the value wrap whole instead of truncating.
struct TaskPropertyRowLabel: View {
    let label: String
    let value: String
    var icon: String? = nil
    var tint: Color = Theme.tint
    var affordance: TaskPropertyAffordance = .menu

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize { stacked } else { inline }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    private var inline: some View {
        HStack(spacing: 8) {
            labelText
            Spacer(minLength: 12)
            valuePair(alignment: .trailing)
            affordanceGlyph
        }
    }

    private var stacked: some View {
        VStack(alignment: .leading, spacing: 4) {
            labelText
            HStack(spacing: 8) {
                valuePair(alignment: .leading)
                Spacer(minLength: 8)
                affordanceGlyph
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var labelText: some View {
        Text(label)
            .font(.body)
            .foregroundStyle(.primary)
    }

    private var valueColor: Color {
        affordance == .readOnly ? Color.secondary : tint
    }

    /// Shrink-then-truncate, never hyphenate: the line budget comes from
    /// `valueLineLimit` (one line for a single word, so there is nothing to
    /// break), and 0.8 is how a long word still fits that one line.
    private func valuePair(alignment: TextAlignment) -> some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon)
                    .font(.footnote)
                    .foregroundStyle(valueColor)
            }
            Text(value)
                .font(.body)
                .foregroundStyle(valueColor)
                .lineLimit(TaskPropertyLogic.valueLineLimit(value))
                .minimumScaleFactor(0.8)
                .truncationMode(.tail)
                .multilineTextAlignment(alignment)
        }
    }

    @ViewBuilder
    private var affordanceGlyph: some View {
        switch affordance {
        case .menu:
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        case .disclosure:
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        case .readOnly:
            EmptyView()
        }
    }
}

/// One inset-grouped card of property rows.
///
/// Fill + hairline rather than fill alone: `secondarySystemGroupedBackground` is
/// WHITE in light mode, and the sheet it sits on is white too, so without the
/// stroke the card is invisible in exactly half the appearances. Dark mode gets
/// a real elevation step from the fill and the stroke just tidies the edge.
struct TaskPropertyCard<Content: View>: View {
    @ViewBuilder var content: Content

    private static var corner: CGFloat { 12 }

    var body: some View {
        VStack(spacing: 0) { content }
            .background(
                Color(.secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                    .strokeBorder(Color(.separator).opacity(0.55), lineWidth: 0.5)
            )
    }
}

/// Hairline between rows, inset to the label's leading edge like a system list.
struct TaskPropertyDivider: View {
    var body: some View {
        Divider().padding(.leading, 16)
    }
}

/// Created / Updated / Completed. Captions, not rows: they are facts about the
/// task, and giving them row chrome was half of why the editable settings did
/// not read as editable.
struct TaskMetaCaptions: View {
    let task: WalnutTask

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(lines, id: \.self) { line in
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .accessibilityIdentifier("task.meta")
    }

    private var lines: [String] {
        var out: [String] = []
        if let created = task.createdAtValue {
            out.append("Created \(TaskDetailSheet.fullDate(created))")
        }
        if let updated = task.updatedAtValue {
            out.append("Updated \(TaskDetailSheet.fullDate(updated))")
        }
        if let completed = task.completedAtValue {
            out.append("Completed \(TaskDetailSheet.fullDate(completed))")
        }
        return out
    }
}
