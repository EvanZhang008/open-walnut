import SwiftUI

/// What the Select mode bar can do with the rows on screen. Pure, so the rules
/// are unit-tested without a view:
///
///  - nothing selected: Mark All Read, over every row the filter shows (Mail's
///    Mark All), enabled while one of them is unread;
///  - something selected: Mark Read over the selected unread rows, Mark Unread
///    over the selected read ones, each enabled only when it would change one.
///
/// Selected ids that are no longer rows are ignored, and the order is the list's.
struct InboxSelectionPlan: Equatable {
    let selectedCount: Int
    /// Ids a Mark Read would set, in list order.
    let toRead: [String]
    /// Ids a Mark Unread would set, in list order. Always empty with no selection.
    let toUnread: [String]

    init(rows: [Letter], selection: Set<String>) {
        let picked = selection.isEmpty ? rows : rows.filter { selection.contains($0.id) }
        selectedCount = selection.isEmpty ? 0 : picked.count
        toRead = picked.filter { !$0.isRead }.map(\.id)
        toUnread = selection.isEmpty ? [] : picked.filter(\.isRead).map(\.id)
    }

    var marksAll: Bool { selectedCount == 0 }
}

/// The bottom bar in Select mode: how many are picked, then Mark Read and Mark
/// Unread (or Mark All Read while nothing is picked).
struct InboxSelectionBar: View {
    let plan: InboxSelectionPlan
    let onMark: (_ ids: [String], _ read: Bool) -> Void

    var body: some View {
        // Widest first. At the large text sizes the count goes, then the words
        // shorten, then only the icons are left (VoiceOver still hears the full
        // title), so neither button is ever cut to an ellipsis. The last one must
        // fit: ViewThatFits falls back to it even when it does not, and a bar wider
        // than the screen widened the whole page (measured at AX5: the list sat at
        // x = -51 and the row checkmarks went off the edge).
        ViewThatFits(in: .horizontal) {
            row(showCount: true, style: .full)
            row(showCount: false, style: .full)
            row(showCount: false, style: .short)
            row(showCount: false, style: .iconOnly)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox.selection.bar")
    }

    private enum TitleStyle { case full, short, iconOnly }

    private func row(showCount: Bool, style: TitleStyle) -> some View {
        HStack(spacing: 16) {
            if showCount {
                Text(plan.marksAll ? "No letters selected" : "\(plan.selectedCount) selected")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityIdentifier("inbox.selection.count")
            }
            Spacer(minLength: 8)
            if plan.marksAll {
                button("Mark All Read", short: "All Read", style: style, icon: "envelope.open",
                       ids: plan.toRead, read: true, id: "inbox.selection.markAllRead")
            } else {
                button("Mark Unread", short: "Unread", style: style, icon: "envelope.badge",
                       ids: plan.toUnread, read: false, id: "inbox.selection.markUnread")
                button("Mark Read", short: "Read", style: style, icon: "envelope.open",
                       ids: plan.toRead, read: true, id: "inbox.selection.markRead")
            }
        }
    }

    private func button(_ title: String, short: String, style: TitleStyle, icon: String,
                        ids: [String], read: Bool, id: String) -> some View {
        Button {
            onMark(ids, read)
        } label: {
            Group {
                if style == .iconOnly {
                    Label(title, systemImage: icon).labelStyle(.iconOnly)
                } else {
                    Label(style == .short ? short : title, systemImage: icon)
                }
            }
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .fixedSize()
        }
        .disabled(ids.isEmpty)
        .accessibilityLabel(title)
        .accessibilityIdentifier(id)
    }
}
