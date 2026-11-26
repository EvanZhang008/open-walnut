import SwiftUI

/// Walnut's one button family on the phone, the twin of the web's `.btn` roles
/// (.claude/skills/walnut-ui-requirements/standard.md, "The button family", iOS column). Every
/// button that draws a shape takes one of these roles; a view never draws its own capsule or
/// corner around a button's words, and never uses the system's `.bordered` styles, whose shape the
/// OS picks (a capsule on iOS 26).
///
/// - `primary`: the one main action of a card or page: solid accent (`Theme.accent`, Walnut's brown), `Theme.onTint` words.
///   Inside a chat (`WalnutPalette.chat`) the accent is the chat's grey (`Theme.Chat.keyFill`, white
///   words), as every colour of the family: each style reads `\.walnutPalette`, so no call site changes.
/// - `secondary`: any other action: quiet grey fill, primary words.
/// - `tool`: Snooze, pin, a pager arrow, a "Group ▾" menu: no fill, quiet words, a fill when pressed.
/// - `destructive`: Delete, Reject, Deny: the grey fill with red words (`Theme.dangerText`).
/// - `option`: a choice of a question (a permission's, an ask's, a thread's, a letter's), a
///   full-width row with a hairline, its words a `WalnutOptionLabel`; the recommended one (a
///   plain permission list's strong yes too) is filled in the accent like `primary`.
///
/// Shape (standard.md "Shapes"): a small key is round (a capsule); a long one, an option row or a
/// full-width key, is a rounded rectangle at the field corner (`Theme.Radius.md`), as every long
/// block (Evan, 2026-11-22: "long and square is fine, small must be round"). `shape(_:fullWidth:)`
/// gives it, so a ring drawn over a key (an armed or picked option) follows its corner.
///
/// All of them: a 44 pt control (a small one draws 32 pt and keeps a
/// 44 pt touch), `Theme.TextSize.control` words, 0.5 opacity when disabled.
struct WalnutButtonStyle: ButtonStyle {
    enum Role: Equatable {
        case primary, secondary, tool, destructive
        /// A question's choice; `recommended` fills it with the accent.
        case option(recommended: Bool)
    }

    enum Size { case regular, small }

    var role: Role
    var size: Size = .regular
    /// The button takes the whole width of its line (a page's main action, a sheet's choices).
    var fullWidth = false

    @Environment(\.isEnabled) private var enabled
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.walnutPalette) private var palette

    /// The family's shape for a key of this role and width.
    static func shape(_ role: Role, fullWidth: Bool = false) -> AnyShape {
        if case .option = role { return AnyShape(optionShape) }
        return fullWidth ? AnyShape(optionShape) : AnyShape(Capsule(style: .continuous))
    }

    /// A long key's shape: an option row, a full-width key, and the ring drawn over one.
    /// Nonisolated, so a `Shape`'s path (`WalnutPickerKeyShape`) can draw it.
    nonisolated static var optionShape: RoundedRectangle { Theme.Radius.shape(Theme.Radius.md) }

    func makeBody(configuration: Configuration) -> some View {
        let shape = Self.shape(role, fullWidth: fullWidth)
        let height = role == .tool
            ? (size == .small ? Theme.Control.toolHeight : Theme.Control.smallHeight)
            : (size == .small ? Theme.Control.smallHeight : Theme.Control.height)
        // The touch reaches 44 pt whatever is drawn.
        let reach = max(0, (Theme.Control.target - height) / 2)
        configuration.label
            // An option label's second words read on the row's fill (`WalnutOptionLabel`).
            .environment(\.walnutOnSolid, isSolid)
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
                    // An option row's own shape (an inset border needs the concrete shape).
                    Self.optionShape.strokeBorder(Color(uiColor: .separator), lineWidth: 0.5)
                }
            }
            // A disabled main action turns grey with light grey words (a faded accent under faded
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
        case .primary, .option(recommended: true): palette.onTint
        case .secondary, .option(recommended: false): .primary
        case .tool: Theme.secondaryOnCard
        case .destructive: Theme.dangerText
        }
    }

    private func fill(pressed: Bool) -> Color {
        switch role {
        case .primary, .option(recommended: true):
            return enabled ? palette.keyFill : Theme.controlFill
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
///
/// A label that ends in " (Recommended)" (an agent's AskUserQuestion writes it so) shows without
/// it and takes the mark instead, as the Threads card's recommended choice does: the mark is said
/// once, at the right (`shown(_:)`). Only what is shown changes; the caller still sends its own
/// label. The mark never fills the row: the row's role says that (`.option(recommended:)`).
struct WalnutOptionLabel: View {
    let label: String
    var detail: String? = nil
    var recommended = false
    /// Lines the label and the detail may each take before they are cut at their end; nil shows
    /// them whole (a question's options are read in full before one is picked).
    var lines: Int? = 2
    /// The detail says what the next tap does (a rule armed to be saved): the accent, semibold.
    var detailAlert = false
    /// Words of their own in place of `label`'s (a deny that waits for a spoken note says so).
    var title: AnyView? = nil

    static let recommendedWord = "Recommended"

    @Environment(\.walnutPalette) private var palette
    /// The row is filled (a recommended option, a plain list's strong yes).
    @Environment(\.walnutOnSolid) private var onSolid

    /// The words shown for `label`, and whether it carried its own trailing "(Recommended)".
    /// A label that is only the mark keeps its words. Pure, unit-tested.
    nonisolated static func shown(_ label: String) -> (label: String, marked: Bool) {
        guard let range = label.range(of: #"\s*\(recommended\)\s*$"#, options: [.regularExpression, .caseInsensitive]) else {
            return (label, false)
        }
        let head = label[..<range.lowerBound].trimmingCharacters(in: .whitespaces)
        return head.isEmpty ? (label, false) : (head, true)
    }

    var body: some View {
        let shown = Self.shown(label)
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.sm) {
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Group {
                    if let title { title } else { Text(shown.label) }
                }
                .font(Theme.TextSize.control)
                .lineLimit(lines)
                .fixedSize(horizontal: false, vertical: true)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(detailAlert ? Theme.TextSize.sm.weight(.semibold) : Theme.TextSize.sm)
                        .foregroundStyle(detailAlert ? palette.tint : quiet)
                        .lineLimit(lines)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            if recommended || (title == nil && shown.marked) {
                Text(Self.recommendedWord)
                    .font(Theme.TextSize.sm)
                    .foregroundStyle(quiet)
                    .fixedSize()
            }
        }
    }

    /// Second words: the readable grey on a plain row, `onTint` on a filled one (a dimmed white
    /// read under 4.5:1 there).
    private var quiet: Color { onSolid ? palette.onTint : Theme.secondaryOnCard }
}

extension EnvironmentValues {
    /// The family's button below draws a solid fill (`WalnutButtonStyle`): its second words take
    /// `onTint`.
    @Entry var walnutOnSolid = false
}

/// A small picker key on a tool row: the composer's Mode and Model, the new-session row's folder,
/// project, sync, mode and model keys and its quick folders. Round, as every small key (a
/// capsule beside the round +, mic and send); a key whose words wrap onto more lines (the
/// accessibility sizes) is a long block and takes the 12 pt corner (`WalnutButtonStyle.optionShape`),
/// as a capsule around five lines read as a circle with the words spilling past it.
/// `active`: a picked value (a folder chosen, the current quick folder): the light accent fill
/// with an accent hairline, as a selected chip (the fill alone sat 1.04:1 from the bar in dark).
/// The words' colour stays the caller's (`ComposerPillInk` measures its own).
struct WalnutPickerKey: ViewModifier {
    var active = false
    var wraps = false

    @Environment(\.walnutPalette) private var palette

    func body(content: Content) -> some View {
        let shape = WalnutPickerKeyShape(wraps: wraps)
        content
            .font(Theme.TextSize.sm.weight(.medium))
            .padding(.horizontal, Theme.Space.m)
            .padding(.vertical, Theme.Space.s)
            .background(active ? palette.tintSoft : Color(uiColor: Theme.pickerKeyFillColor), in: shape)
            .overlay {
                if active { shape.strokeBorder(palette.tint, lineWidth: 1) }
            }
            .contentShape(shape)
    }
}

/// The picker key's shape: a capsule on one line, the long key's 12 pt corner once it wraps.
struct WalnutPickerKeyShape: InsettableShape {
    var wraps = false
    var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let inner = rect.insetBy(dx: insetAmount, dy: insetAmount)
        return wraps ? WalnutButtonStyle.optionShape.path(in: inner) : Capsule(style: .continuous).path(in: inner)
    }

    func inset(by amount: CGFloat) -> WalnutPickerKeyShape {
        var shape = self
        shape.insetAmount += amount
        return shape
    }
}

extension View {
    /// Draw this label as a small picker key (`WalnutPickerKey`).
    func walnutPickerKey(active: Bool = false, wraps: Bool = false) -> some View {
        modifier(WalnutPickerKey(active: active, wraps: wraps))
    }
}

/// A chip: a filter, a view switch, a toggle among several (Inbox filters, the board's views, a
/// folder to pick). Round (a capsule), 32 pt drawn and a 44 pt touch; selected
/// is a light accent fill (`Theme.chipSelected`, a step stronger than `tintSoft` so it reads on a white
/// rail) with an accent hairline and primary words, never a solid block; the chat's greys in a chat.
struct WalnutChipStyle: ButtonStyle {
    var selected = false

    @Environment(\.isEnabled) private var enabled
    @Environment(\.walnutPalette) private var palette

    func makeBody(configuration: Configuration) -> some View {
        let shape = Capsule(style: .continuous)
        configuration.label
            // One weight both ways, so picking a chip never changes its width.
            .font(Theme.TextSize.md.weight(.medium))
            .foregroundStyle(selected ? Color.primary : Theme.secondaryOnCard)
            .lineLimit(1)
            .padding(.horizontal, Theme.Space.m)
            .frame(minHeight: Theme.Control.smallHeight)
            .background(selected ? palette.chipSelected : (configuration.isPressed ? Theme.controlFillPressed : Theme.controlFill),
                        in: shape)
            .overlay {
                if selected { shape.strokeBorder(palette.tint, lineWidth: 1) }
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
