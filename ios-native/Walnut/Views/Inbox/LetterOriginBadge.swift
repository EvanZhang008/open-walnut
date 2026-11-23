import SwiftUI

/// Who a letter is from, first and in Walnut's own tint (2026-11-04: a task's
/// decision whose subject named a company read as that company's new mail).
/// Every inbox surface leads a letter with it: the envelope row and the
/// reader's header. Nothing in the inbox is outside mail; the badge (the
/// Walnut leaf and the kind: Task, Triage, Walnut, Plugin) says so at a glance,
/// then the sender's name. The web twin is `web/src/components/inbox/LetterOriginBadge.tsx`.
struct LetterOriginBadge: View {
    let origin: LetterOrigin
    /// The reader reads "From" before the badge.
    var leadingFrom = false

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At an accessibility size the badge takes its own line above the name: beside it, a big
        // kind tag left the name one word a line, and dropping the word lost what sent it.
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Theme.Space.xxs))
            : AnyLayout(HStackLayout(spacing: Theme.Space.s))
        layout {
            if leadingFrom {
                Text("From").font(Theme.TextSize.sm).foregroundStyle(Theme.secondaryOnCard)
            }
            HStack(spacing: Theme.Space.xxs) {
                Image(systemName: "leaf.fill").font(Theme.Glyph.xs.font(.semibold))
                // "WALNUT Walnut" says it twice: the leaf alone leads a name that is the kind.
                if origin.kindLabel.lowercased() != origin.name.lowercased() {
                    Text(origin.kindLabel.uppercased()).font(Theme.TextSize.xs.weight(.bold))
                }
            }
            .padding(.horizontal, Theme.Space.s)
            .padding(.vertical, Theme.Space.xxs)
            .background(badgeFill, in: Capsule())
            .foregroundStyle(badgeTint)
            Text(Letter.oneLine(origin.name, limit: 120))
                .font(Theme.TextSize.sm.weight(.semibold))
                .foregroundStyle(origin.isWalnutWork ? badgeTint : Theme.secondaryOnCard)
                .lineLimit(typeSize.isAccessibilitySize ? 3 : (leadingFrom ? 2 : 1))
                .truncationMode(.tail)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("From \(origin.kindLabel.lowercased()) \(origin.name)")
        .accessibilityIdentifier("inbox.letter.origin")
    }

    /// Each kind its own tint, as on the web: a task or session in the app tint, Inbox Triage
    /// in green, Walnut itself, a plugin and an API caller in grey.
    /// The tag's fill: the soft accent under the accent's words (4.5:1), a quiet wash otherwise.
    private var badgeFill: Color {
        switch origin.kind {
        case "task", "session": return Theme.tintSoft
        case "triage": return Theme.success.opacity(0.14)
        default: return Theme.controlFill
        }
    }

    private var badgeTint: Color {
        switch origin.kind {
        case "task", "session": return Theme.tint
        case "triage": return Theme.doneText
        default: return Theme.secondaryOnCard
        }
    }
}
