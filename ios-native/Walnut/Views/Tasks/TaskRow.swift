import SwiftUI

/// Reminders-style task cell: leading status circle (read-only), title, and a
/// secondary line of project · priority flag · due date. Done tasks strike
/// through and dim. The circle is NOT a toggle in v1.
struct TaskRow: View {
    let task: WalnutTask
    /// Focus tier label for pinned tasks ("Focus"/"Satellite"/…) — shown as a
    /// small badge next to the pin so the phone says WHERE it's pinned, not
    /// just that it is. nil = no badge (unpinned rows, callers without the
    /// tier map).
    var tierBadge: String? = nil
    /// Where a search found the query, when it says more than the title (a
    /// description or transcript hit). nil everywhere but the search results.
    var matchSnippet: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StatusCircle(status: task.statusKind)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if task.pinned == true {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.tint)
                        if let tierBadge {
                            Text(tierBadge)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Theme.tint)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Theme.tint.opacity(0.12), in: Capsule())
                                .accessibilityIdentifier("task.tierBadge")
                        }
                    }
                    Text(task.title)
                        .foregroundStyle(task.isDone ? .secondary : .primary)
                        .strikethrough(task.isDone, color: .secondary)
                        .lineLimit(2)
                }
                secondaryLine
                if let matchSnippet {
                    Text(matchSnippet)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .accessibilityIdentifier("task.matchSnippet")
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var secondaryLine: some View {
        HStack(spacing: 8) {
            if !task.project.isEmpty {
                Text(task.project)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let flag = priorityFlag {
                Image(systemName: "flag.fill")
                    .foregroundStyle(flag)
            }
            if let due = task.dueDateValue {
                Text(Self.dueText(due))
                    .foregroundStyle(task.isOverdue ? Theme.danger : .secondary)
            }
        }
        .font(.caption)
    }

    /// Red for immediate, orange for important, nothing otherwise.
    private var priorityFlag: Color? {
        switch task.priorityKind {
        case .immediate: return Theme.danger
        case .important: return Theme.warning
        default: return nil
        }
    }

    static func dueText(_ date: Date) -> String {
        if AppClock.isToday(date) { return "Today" }
        if AppClock.isYesterday(date) { return "Yesterday" }
        if AppClock.isTomorrow(date) { return "Tomorrow" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

/// Read-only status indicator — open circle (todo), tinted half circle
/// (in progress), filled checkmark (done). VoiceOver reads the status, not the
/// symbol's name ("circle.lefthalf.filled", gate r4, F10).
struct StatusCircle: View {
    let status: TaskStatus

    /// What VoiceOver says for a status.
    static func spoken(_ status: TaskStatus) -> String {
        switch status {
        case .done: return "Done"
        case .inProgress: return "In progress"
        case .todo, .unknown: return "To do"
        }
    }

    /// The status toggle's VoiceOver label, value and hint: one tap flips
    /// to do and done.
    static func toggleAccessibility(_ status: TaskStatus) -> (label: String, value: String, hint: String) {
        ("Status", spoken(status), status == .done ? "Marks the task as to do." : "Marks the task as done.")
    }

    var body: some View {
        symbol.accessibilityLabel(Self.spoken(status))
    }

    @ViewBuilder
    private var symbol: some View {
        switch status {
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Theme.success)
        case .inProgress:
            Image(systemName: "circle.lefthalf.filled")
                .foregroundStyle(Theme.tint)
        case .todo, .unknown:
            Image(systemName: "circle")
                .foregroundStyle(.secondary)
        }
    }
}
