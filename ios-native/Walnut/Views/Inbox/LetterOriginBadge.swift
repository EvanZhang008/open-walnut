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
        HStack(spacing: 6) {
            if leadingFrom {
                Text("From").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 3) {
                Image(systemName: "leaf.fill").font(.system(size: 9, weight: .semibold))
                // "WALNUT Walnut" says it twice: the leaf alone leads a name that is the kind.
                if origin.kindLabel.lowercased() != origin.name.lowercased() {
                    Text(origin.kindLabel.uppercased()).font(.caption2.weight(.bold))
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(badgeTint.opacity(0.15), in: Capsule())
            .foregroundStyle(badgeTint)
            Text(Letter.oneLine(origin.name, limit: 120))
                .font(.caption.weight(.semibold))
                .foregroundStyle(origin.isWalnutWork ? badgeTint : Color.secondary)
                .lineLimit(typeSize.isAccessibilitySize ? 3 : (leadingFrom ? 2 : 1))
                .truncationMode(.tail)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("From \(origin.kindLabel.lowercased()) \(origin.name)")
        .accessibilityIdentifier("inbox.letter.origin")
    }

    /// Each kind its own tint, as on the web: a task or session in the app tint, Inbox Triage
    /// in green, Walnut itself, a plugin and an API caller in grey.
    private var badgeTint: Color {
        switch origin.kind {
        case "task", "session": return Theme.tint
        case "triage": return .green
        default: return .secondary
        }
    }
}
