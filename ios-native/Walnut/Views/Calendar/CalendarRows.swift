import SwiftUI

/// Row + block views shared by the four calendar views (list, day, multi-day,
/// month). Kept in one file so each view file stays about layout, not chrome.

// MARK: - List / agenda rows

/// One task item in a day list: status circle, kind chip (Due/Starts/Ends),
/// title, and the clock time when the date carries one.
struct CalendarTaskRow: View {
    let item: CalendarLogic.TaskItem
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .center, spacing: 10) {
                StatusCircle(status: item.task.statusKind)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.task.title)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        Text(CalendarChrome.kindLabel(item.kind))
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1.5)
                            .background(CalendarChrome.kindColor(item).opacity(0.15), in: Capsule())
                            .foregroundStyle(CalendarChrome.kindColor(item))
                        if item.hasTime {
                            Text(item.date.formatted(date: .omitted, time: .shortened))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if !item.task.project.isEmpty {
                            Text(item.task.project)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("calendar.task.\(item.id)")
    }
}

/// One read-only device calendar event: source-calendar color bar, title,
/// time range — visually distinct from task rows (no status circle, no
/// chevron, not tappable).
struct CalendarEventRow: View {
    let event: DeviceCalendarEvent

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(CalendarChrome.eventColor(event))
                .frame(width: 4, height: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(CalendarChrome.eventTimeText(event))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let name = event.calendarTitle {
                        Text(name)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("calendar.event")
    }
}

// MARK: - Timeline blocks

/// One positioned block on an hour grid. Tasks are tappable (they open the
/// detail sheet); events are read-only. Flat corners on an edge mean the span
/// continues into the neighbouring day.
struct CalendarTimelineBlock: View {
    let block: CalendarTimeline.Block
    /// Compact styling for very short blocks (title only, no time line).
    let compact: Bool
    let onTapTask: (WalnutTask) -> Void

    var body: some View {
        Group {
            switch block.source {
            case .task(let item):
                Button { onTapTask(item.task) } label: { content }
                    .buttonStyle(.plain)
            case .event:
                content
            }
        }
        .accessibilityIdentifier("calendar.block.\(block.id)")
    }

    private var content: some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(accent)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(compact ? 1 : 3)
                    .multilineTextAlignment(.leading)
                if !compact, let detail = detailText {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.leading, 4)
            .padding(.trailing, 3)
            .padding(.vertical, 2)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(accent.opacity(0.16))
        .clipShape(
            .rect(
                topLeadingRadius: block.continuesBefore ? 0 : 5,
                bottomLeadingRadius: block.continuesAfter ? 0 : 5,
                bottomTrailingRadius: block.continuesAfter ? 0 : 5,
                topTrailingRadius: block.continuesBefore ? 0 : 5
            )
        )
        .contentShape(Rectangle())
    }

    private var accent: Color {
        switch block.source {
        case .task(let item): return CalendarChrome.kindColor(item)
        case .event(let event): return CalendarChrome.eventColor(event)
        }
    }

    private var title: String {
        switch block.source {
        case .task(let item): return item.task.title
        case .event(let event): return event.title
        }
    }

    private var detailText: String? {
        switch block.source {
        case .task(let item):
            let time = item.date.formatted(date: .omitted, time: .shortened)
            return "\(CalendarChrome.kindLabel(item.kind)) · \(time)"
        case .event(let event):
            return CalendarChrome.eventTimeText(event)
        }
    }
}

/// One banner in the all-day band above the hour grid.
struct CalendarAllDayChip: View {
    let row: CalendarTimeline.AllDayRow
    let onTapTask: (WalnutTask) -> Void

    var body: some View {
        Group {
            switch row.source {
            case .task(let item):
                Button { onTapTask(item.task) } label: { content }
                    .buttonStyle(.plain)
            case .event:
                content
            }
        }
        .accessibilityIdentifier("calendar.allday.\(row.id)")
    }

    private var content: some View {
        HStack(spacing: 3) {
            if row.continuesBefore {
                Image(systemName: "chevron.compact.left")
                    .font(.caption2)
                    .foregroundStyle(accent)
            }
            Text(title)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
            if row.continuesAfter {
                Image(systemName: "chevron.compact.right")
                    .font(.caption2)
                    .foregroundStyle(accent)
            }
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(accent.opacity(0.18), in: RoundedRectangle(cornerRadius: 4))
        .contentShape(Rectangle())
    }

    private var accent: Color {
        switch row.source {
        case .task(let item): return CalendarChrome.kindColor(item)
        case .event(let event): return CalendarChrome.eventColor(event)
        }
    }

    private var title: String {
        switch row.source {
        case .task(let item): return item.task.title
        case .event(let event): return event.title
        }
    }
}

// MARK: - Shared chrome helpers

/// Presentation-only helpers (labels, colors) shared by rows and blocks.
enum CalendarChrome {
    /// Bottom padding every scrolling calendar view adds so the floating
    /// "Today" pill never covers the last row (it sits over the content, as in
    /// Apple Calendar, rather than insetting the scroll view).
    static let floatingControlClearance: CGFloat = 56

    static func kindLabel(_ kind: CalendarLogic.TaskItem.Kind) -> String {
        switch kind {
        case .due: return "Due"
        case .start: return "Starts"
        case .end: return "Ends"
        }
    }

    static func kindColor(_ item: CalendarLogic.TaskItem) -> Color {
        switch item.kind {
        case .due: return item.task.isOverdue ? Theme.danger : Theme.tint
        case .start: return Theme.success
        case .end: return Theme.warning
        }
    }

    static func eventColor(_ event: DeviceCalendarEvent) -> Color {
        if let r = event.colorRed, let g = event.colorGreen, let b = event.colorBlue {
            return Color(red: r, green: g, blue: b)
        }
        return Color(.systemGray2)
    }

    static func eventTimeText(_ event: DeviceCalendarEvent) -> String {
        if event.isAllDay { return "All day" }
        let start = event.start.formatted(date: .omitted, time: .shortened)
        let end = event.end.formatted(date: .omitted, time: .shortened)
        return "\(start) – \(end)"
    }
}

// MARK: - Day-scoped quick add

/// One-line add for the selected day: Return creates the task with due_date
/// preset to that day (date-only — a due DAY, matching the PATCH contract).
/// Reuses TasksStore.createTask, so the optimistic insert, pending overlay,
/// and locate-me signal all apply; the row appears instantly because the
/// store's tasks array drives the bucketing.
struct CalendarQuickAddRow: View {
    let dayKey: String
    let dayLabel: String

    @Environment(TasksStore.self) private var tasks

    @State private var text = ""
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Image(systemName: "plus.circle.fill")
                    .font(.body)
                    .foregroundStyle(Theme.tint)
                TextField("Add task \(dayLabel == "today" ? "for today" : "on \(dayLabel)")…", text: $text)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(submit)
                    .accessibilityIdentifier("calendar.quickAdd.field")
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }
        }
        .padding(10)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.quickAdd")
    }

    private func submit() {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        text = ""
        errorMessage = nil
        focused = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let day = dayKey
        Task {
            do {
                _ = try await tasks.createTask(title: raw, dueDate: day)
            } catch {
                // Nothing typed is ever lost to a network error.
                if text.isEmpty { text = raw }
                errorMessage = error.localizedDescription
                focused = true
            }
        }
    }
}
