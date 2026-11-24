import SwiftUI

/// A badge: a count or a tag (TASK, a host, "3"). Round (a capsule; a one-letter badge a circle),
/// one tone at a quiet strength with words readable on it, never several colours on one row. A state (Needs you, Working, Done) is a dot and a word, not a badge.
struct WalnutBadge: View {
    enum Tone { case neutral, accent, danger, warning, success }

    let text: String
    var tone: Tone = .neutral
    var systemImage: String? = nil
    /// A least width, so a column of one-letter badges (M, A, D) lines up.
    var minWidth: CGFloat? = nil

    var body: some View {
        HStack(spacing: Theme.Space.xxs) {
            if let systemImage { Image(systemName: systemImage).accessibilityHidden(true) }
            Text(text)
        }
        .font(Theme.TextSize.xs.weight(.semibold))
        .foregroundStyle(ink)
        .lineLimit(1)
        // A badge keeps its whole word at every text size; the line around it wraps instead.
        .fixedSize(horizontal: true, vertical: false)
        .padding(.horizontal, Theme.Space.s)
        .padding(.vertical, Theme.Space.xxs)
        .frame(minWidth: minWidth)
        .background(fill, in: Capsule(style: .continuous))
    }

    private var ink: Color {
        switch tone {
        case .neutral: Theme.secondaryOnCard
        case .accent: Theme.tint
        case .danger: Theme.dangerText
        case .warning: Theme.needsText
        case .success: Theme.doneText
        }
    }

    private var fill: Color {
        switch tone {
        case .neutral: Theme.controlFill
        case .accent: Theme.tintSoft
        case .danger: Theme.danger.opacity(0.12)
        case .warning: Theme.warning.opacity(0.16)
        case .success: Theme.success.opacity(0.14)
        }
    }
}

/// A state as a dot and a word (web `NoticeStatus`): "● Needs you".
struct WalnutStatusLabel: View {
    let text: String
    let color: Color
    var textColor: Color? = nil

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            Circle().fill(color).frame(width: 7, height: 7).accessibilityHidden(true)
            Text(text)
                .font(Theme.TextSize.sm.weight(.medium))
                .foregroundStyle(textColor ?? Theme.secondaryOnCard)
                .lineLimit(1)
        }
    }
}

extension View {
    /// A card on a page or in a list (a letter's block, an email card, a queue's line): the
    /// grouped fill, `Theme.Radius.card` corners and a hairline, 12 pt inside. A card that asks or
    /// tells takes the frosted one (`frosted: true`, the ask card's and the notices' glass).
    func walnutCard(padding: CGFloat = Theme.Space.md, frosted: Bool = false) -> some View {
        modifier(WalnutCardFrame(padding: padding, frosted: frosted))
    }

    /// A field or a box drawn by the family: the grey fill, `Theme.Radius.md` corners, a 44 pt line.
    func walnutFieldBox() -> some View {
        modifier(WalnutFieldBox())
    }
}

private struct WalnutCardFrame: ViewModifier {
    let padding: CGFloat
    let frosted: Bool

    func body(content: Content) -> some View {
        let shape = Theme.Radius.shape(Theme.Radius.card)
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                if frosted {
                    shape.fill(.ultraThinMaterial)
                } else {
                    shape.fill(Color(uiColor: .secondarySystemGroupedBackground))
                }
            }
            .overlay { shape.strokeBorder(Color(uiColor: .separator).opacity(0.6), lineWidth: 0.5) }
    }
}

private struct WalnutFieldBox: ViewModifier {
    func body(content: Content) -> some View {
        // The quiet fill AND a hairline, so the box reads on any surface: a card of the
        // same grouped grey, a bar, a page.
        let shape = Theme.Radius.shape(Theme.Radius.md)
        content
            .padding(.horizontal, Theme.Space.md)
            .frame(minHeight: Theme.Control.height)
            .background(Color(uiColor: .tertiarySystemFill), in: shape)
            .overlay { shape.strokeBorder(Color(uiColor: .separator), lineWidth: 0.5) }
    }
}

/// A plain field outside a list (setup, a sheet's own field): the family's field box.
struct WalnutFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration.walnutFieldBox()
    }
}

extension TextFieldStyle where Self == WalnutFieldStyle {
    static var walnut: WalnutFieldStyle { WalnutFieldStyle() }
}
