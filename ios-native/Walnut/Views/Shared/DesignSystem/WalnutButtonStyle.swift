import SwiftUI

/// Walnut's one button family on the phone, the twin of the web's `.btn` roles
/// (.claude/skills/walnut-ui-requirements/standard.md, "The button family", iOS column). Every
/// button that draws a shape takes one of these roles; a view never draws its own capsule or
/// corner around a button's words, and never uses the system's `.bordered` styles, whose shape the
/// OS picks (a capsule on iOS 26).
///
/// - `primary`: the one main action of a card or page: solid blue (`Theme.accent`), white words.
/// - `secondary`: any other action: quiet grey fill, primary words.
/// - `tool`: Snooze, pin, a pager arrow, a "Group ▾" menu: no fill, quiet words, a fill when pressed.
/// - `destructive`: Delete, Reject, Deny: the grey fill with red words (`Theme.dangerText`).
/// - `option`: a choice of a question, a full-width row with a hairline; the recommended one is
///   filled blue like `primary`.
///
/// All of them: round (a capsule, standard.md "Shapes"), a 44 pt control (a small one draws 32 pt and keeps a
/// 44 pt touch), `Theme.TextSize.control` words, 0.5 opacity when disabled.
struct WalnutButtonStyle: ButtonStyle {
    enum Role: Equatable {
        case primary, secondary, tool, destructive
        /// A question's choice; `recommended` fills it blue.
        case option(recommended: Bool)
    }

    enum Size { case regular, small }

    var role: Role
    var size: Size = .regular
    /// The button takes the whole width of its line (a page's main action, a sheet's choices).
    var fullWidth = false

    @Environment(\.isEnabled) private var enabled
    @Environment(\.dynamicTypeSize) private var typeSize

    func makeBody(configuration: Configuration) -> some View {
        let shape = Capsule(style: .continuous)
        let height = role == .tool
            ? (size == .small ? Theme.Control.toolHeight : Theme.Control.smallHeight)
            : (size == .small ? Theme.Control.smallHeight : Theme.Control.height)
        // The touch reaches 44 pt whatever is drawn.
        let reach = max(0, (Theme.Control.target - height) / 2)
        configuration.label
            .font(isOption ? Theme.TextSize.lg : Theme.TextSize.control)
            .foregroundStyle(ink)
            // Two lines at the usual sizes, so long words wrap rather than cut; more at an
            // accessibility size ("Unlock and Set Up" must still read).
            .lineLimit(typeSize.isAccessibilitySize ? 4 : (isOption ? 3 : 2))
            .multilineTextAlignment(isOption ? .leading : .center)
            .padding(.horizontal, role == .tool ? Theme.Space.s : Theme.Space.md)
            .padding(.vertical, isOption || typeSize.isAccessibilitySize ? Theme.Space.s : Theme.Space.xxs)
            .frame(maxWidth: fullWidth || isOption ? .infinity : nil,
                   minHeight: height,
                   alignment: isOption ? .leading : .center)
            .background(fill(pressed: configuration.isPressed), in: shape)
            .overlay {
                if case .option(recommended: false) = role {
                    shape.strokeBorder(Color(uiColor: .separator), lineWidth: 0.5)
                }
            }
            // A disabled main action turns grey with light grey words (a faded blue under faded
            // white read as a pale main action); a disabled quiet control fades.
            .opacity(enabled || isSolid ? (configuration.isPressed && isSolid ? 0.8 : 1) : 0.5)
            .contentShape(Rectangle().inset(by: -reach))
    }

    private var isOption: Bool { if case .option = role { true } else { false } }

    private var isSolid: Bool {
        switch role {
        case .primary, .option(recommended: true): true
        default: false
        }
    }

    private var ink: Color {
        // Disabled: the light grey of a control that cannot be pressed, so it never reads as an
        // enabled grey button (WCAG exempts a disabled control's words from the contrast rule).
        if isSolid && !enabled { return Color(uiColor: .tertiaryLabel) }
        return switch role {
        case .primary, .option(recommended: true): Theme.onTint
        case .secondary, .option(recommended: false): .primary
        case .tool: Theme.secondaryOnCard
        case .destructive: Theme.dangerText
        }
    }

    private func fill(pressed: Bool) -> Color {
        switch role {
        case .primary, .option(recommended: true):
            return enabled ? Theme.accent : Theme.controlFill
        case .secondary, .destructive:
            return pressed ? Theme.controlFillPressed : Theme.controlFill
        case .tool:
            return pressed ? Color(uiColor: .tertiarySystemFill) : .clear
        case .option(recommended: false):
            return Color(uiColor: pressed ? .tertiarySystemFill : .systemBackground)
        }
    }
}

extension ButtonStyle where Self == WalnutButtonStyle {
    static var walnutPrimary: WalnutButtonStyle { WalnutButtonStyle(role: .primary) }
    static var walnutSecondary: WalnutButtonStyle { WalnutButtonStyle(role: .secondary) }
    static var walnutTool: WalnutButtonStyle { WalnutButtonStyle(role: .tool) }
    static var walnutDestructive: WalnutButtonStyle { WalnutButtonStyle(role: .destructive) }

    static func walnut(_ role: WalnutButtonStyle.Role, size: WalnutButtonStyle.Size = .regular,
                       fullWidth: Bool = false) -> WalnutButtonStyle {
        WalnutButtonStyle(role: role, size: size, fullWidth: fullWidth)
    }
}

/// An option row's words: its label, then its line of why in a smaller grey line (cut at its end),
/// and "Recommended" at the row's right end on the recommended one (web: `AskOptions`).
struct WalnutOptionLabel: View {
    let label: String
    var detail: String? = nil
    var recommended = false

    static let recommendedWord = "Recommended"

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.sm) {
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(label)
                    .font(Theme.TextSize.control)
                    .lineLimit(2)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(Theme.TextSize.sm)
                        .foregroundStyle(quiet)
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
            }
            .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            if recommended {
                Text(Self.recommendedWord)
                    .font(Theme.TextSize.sm)
                    .foregroundStyle(quiet)
                    .fixedSize()
            }
        }
    }

    /// Second words: the readable grey on a plain row, white on the blue one (a dimmed white
    /// read under 4.5:1 there).
    private var quiet: Color { recommended ? Theme.onTint : Theme.secondaryOnCard }
}

/// A chip: a filter, a view switch, a toggle among several (Inbox filters, the board's views, a
/// folder to pick). Round (a capsule), 32 pt drawn and a 44 pt touch; selected
/// is a light blue fill (`Theme.chipSelected`, a step stronger than `tintSoft` so it reads on a white
/// rail) with a blue hairline and primary words, never a solid block.
struct WalnutChipStyle: ButtonStyle {
    var selected = false

    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = Capsule(style: .continuous)
        configuration.label
            // One weight both ways, so picking a chip never changes its width.
            .font(Theme.TextSize.md.weight(.medium))
            .foregroundStyle(selected ? Color.primary : Theme.secondaryOnCard)
            .lineLimit(1)
            .padding(.horizontal, Theme.Space.m)
            .frame(minHeight: Theme.Control.smallHeight)
            .background(selected ? Theme.chipSelected : (configuration.isPressed ? Theme.controlFillPressed : Theme.controlFill),
                        in: shape)
            .overlay {
                if selected { shape.strokeBorder(Theme.tint, lineWidth: 1) }
            }
            .opacity(enabled ? 1 : 0.5)
            .contentShape(Rectangle().inset(by: -(Theme.Control.target - Theme.Control.smallHeight) / 2))
    }
}

extension ButtonStyle where Self == WalnutChipStyle {
    static func walnutChip(selected: Bool) -> WalnutChipStyle { WalnutChipStyle(selected: selected) }
}

/// "Snooze ▾", "Group ▾": the words of a tool that opens a menu, with its small chevron, so it
/// never reads as an action that happens at once.
struct WalnutMenuLabel: View {
    let title: String
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            if let systemImage { Image(systemName: systemImage).accessibilityHidden(true) }
            Text(title)
            Image(systemName: "chevron.down")
                .font(Theme.TextSize.xs.weight(.semibold))
                .accessibilityHidden(true)
        }
    }
}
