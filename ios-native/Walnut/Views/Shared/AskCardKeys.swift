import SwiftUI

/// The ask card's button family, the phone's copy of the web's (web/src/components/actions/ask-card.css,
/// "The button family" in .claude/skills/walnut-ui-requirements/standard.md). 2026-11-21, the user's
/// pick of ten whole-card designs ("2 is good"): the options as a list of rows, the card's one main
/// action solid blue, every other key quiet grey, the words box under them at the keys' height, and
/// the pager, Snooze and pin as quiet tools on the last line at the right. Every card draws its
/// buttons with these: a task's ask (`ActionNeededView`) and a thread's card (`OrgThreadCard`).
enum AskCardKeys {
    /// A key's and an option row's corner, and the words box's (`ReplyBox`).
    static let corner: CGFloat = 8
    /// A key's and an option row's least height: the phone's touch target (the web gives its keys
    /// 44 px on a phone too), and the words box's own height (`LetterReplyField`'s one line).
    static let height: CGFloat = 44
    /// A tool's (pager arrow, Snooze, pin) least height.
    static let toolHeight: CGFloat = 28
    /// The word at the right end of the recommended option's row.
    static let recommendedWord = "Recommended"
}

/// A key: quiet grey, or (`main`) the card's one main action filled blue (Acknowledge, an approval's
/// Review). At most one main key per card.
struct AskChipStyle: ButtonStyle {
    var main = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: AskCardKeys.corner, style: .continuous)
        configuration.label
            .font(.subheadline.weight(.medium))
            .foregroundStyle(main ? Color.white : Color.primary)
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(minHeight: AskCardKeys.height)
            .background(main ? Theme.askAccent : Color(uiColor: .tertiarySystemFill), in: shape)
            .opacity(configuration.isPressed ? 0.75 : enabled ? 1 : 0.5)
            .contentShape(shape)
    }
}

/// An option of a card (a question's options, a letter's actions, a thread's choices): a row of its
/// own, full width, a hairline on the card; the recommended one filled blue.
struct AskOptionStyle: ButtonStyle {
    var recommended = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: AskCardKeys.corner, style: .continuous)
        configuration.label
            .foregroundStyle(recommended ? Color.white : Color.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: AskCardKeys.height, alignment: .leading)
            .background(recommended ? Theme.askAccent : Color(uiColor: .systemBackground), in: shape)
            .overlay {
                if !recommended { shape.strokeBorder(Color(uiColor: .separator), lineWidth: 0.5) }
            }
            .opacity(configuration.isPressed ? 0.75 : enabled ? 1 : 0.5)
            .contentShape(shape)
    }
}

/// An option row's words: its label, then its line of why in a smaller grey line beside it (one
/// line, cut at its end), and "Recommended" at the row's right end on the recommended one.
struct AskOptionLabel: View {
    let label: String
    var detail: String? = nil
    var recommended = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .layoutPriority(1)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(quiet)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
            if recommended {
                Text(AskCardKeys.recommendedWord)
                    .font(.caption)
                    .foregroundStyle(quiet)
                    .fixedSize()
            }
        }
    }

    /// The row's second words: grey on a plain row, white a little dimmed on the blue one.
    private var quiet: AnyShapeStyle {
        recommended ? AnyShapeStyle(Color.white.opacity(0.85)) : AnyShapeStyle(.secondary)
    }
}

/// "Snooze ▾": the card's Snooze menu's label, quiet text with a small chevron.
struct AskSnoozeLabel: View {
    var text = "Snooze"

    var body: some View {
        HStack(spacing: 3) {
            Text(text)
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.semibold))
                .accessibilityHidden(true)
        }
        .font(.footnote.weight(.medium))
        .frame(minHeight: AskCardKeys.toolHeight)
        .contentShape(Rectangle())
    }
}
