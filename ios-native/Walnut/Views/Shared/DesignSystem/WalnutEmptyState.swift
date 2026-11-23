import SwiftUI

/// Every place with nothing to show, the phone's twin of the web's `EmptyState`
/// (standard.md, "Empty, loading and unavailable states"): a title that says what this place is
/// and why it is empty ("No messages yet", "No tasks match ‘foo’", "Couldn't load tasks"), at most
/// one hint sentence, and at most one next step. Three sizes, one look: muted words, no box, no
/// border, no fill.
///
/// - `pane`: a whole page or sheet: centred, a 36 pt glyph, a 20 pt title, a 13 pt hint.
/// - `section`: a list, a card body: centred, a 28 pt glyph, a 15 pt title, a 12 pt hint.
/// - `row`: a line in a list, a menu, a form: leading, no glyph, 12 pt.
struct WalnutEmptyState: View {
    enum Size { case pane, section, row }

    let title: String
    var hint: String? = nil
    var systemImage: String? = nil
    var size: Size = .pane
    /// An identifier for the title alone (a test finds the state by it); never on the whole
    /// state, which would hand it to the button too.
    var titleIdentifier: String? = nil
    /// The one next step (Clear search, Retry, New task).
    var actionTitle: String? = nil
    var actionIdentifier: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        if size == .row {
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(title).font(Theme.TextSize.sm.weight(.medium))
                    .accessibilityIdentifier(titleIdentifier ?? "")
                    .accessibilityAddTraits(.isHeader)
                if let hint { Text(hint).font(Theme.TextSize.sm) }
                actionButton
            }
            .foregroundStyle(Theme.secondaryOnCard)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
        } else {
            VStack(spacing: size == .pane ? Theme.Space.sm : Theme.Space.s) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: size == .pane ? 36 : 28, weight: .regular))
                        .foregroundStyle(Theme.secondaryOnCard)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font((size == .pane ? Theme.TextSize.xxl : Theme.TextSize.lg).weight(.semibold))
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier(titleIdentifier ?? "")
                    .accessibilityAddTraits(.isHeader)
                if let hint {
                    Text(hint)
                        .font(size == .pane ? Theme.TextSize.md : Theme.TextSize.sm)
                        .foregroundStyle(Theme.secondaryOnCard)
                }
                actionButton.padding(.top, Theme.Space.xs)
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, size == .pane ? Theme.Space.xxxl : Theme.Space.lg)
            .padding(.horizontal, Theme.Space.lg)
            .accessibilityElement(children: .contain)
        }
    }

    @ViewBuilder private var actionButton: some View {
        if let actionTitle, let action {
            Button(actionTitle, action: action)
                .buttonStyle(.walnut(.secondary, size: .small))
                .accessibilityIdentifier(actionIdentifier ?? "emptyState.action")
        }
    }
}
