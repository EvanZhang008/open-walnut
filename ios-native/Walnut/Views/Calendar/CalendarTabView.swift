import SwiftUI

/// Calendar mode for the Tasks tab: a month grid (task/event dots, today
/// highlighted, chevron/swipe month navigation) over a tappable day agenda.
///
/// Data model:
///   - Walnut tasks come straight from the already-loaded TasksStore (no new
///     fetch) and are placed by due_date / start_date / end_date via
///     CalendarLogic.bucketTasks. Tap → the existing TaskDetailSheet.
///   - Device calendar events (EventKit) render read-only in the day agenda
///     with distinct styling. Permission is requested lazily on FIRST
///     calendar open; denial degrades to a dismissible Settings hint and
///     never blocks the task layer.
///   - Tapping a day selects it; the agenda's quick-add row creates a task
///     pre-dated to that day through the existing TasksStore.createTask
///     machinery (optimistic insert + pending overlay included).
///
/// Self-contained single entry — reads TasksStore from the environment, so
/// the Tasks tab can drop it in as one line: `CalendarTabView()`.
struct CalendarTabView: View {
    @Environment(TasksStore.self) private var tasks
    @State private var deviceCalendar = DeviceCalendarStore()

    private let calendar = Calendar.current

    @State private var anchorMonth = Date()
    @State private var selectedDate = Date()
    @State private var selectedTask: WalnutTask?
    /// One-time lazy permission ask, on first calendar open only.
    @State private var accessRequested = false

    private var selectedDayKey: String {
        CalendarLogic.dayKey(selectedDate, calendar: calendar)
    }

    private var monthKey: String {
        CalendarLogic.monthKey(anchorMonth, calendar: calendar)
    }

    var body: some View {
        // Bind derived collections ONCE per body pass (TasksView discipline).
        let taskBuckets = CalendarLogic.bucketTasks(tasks.tasks, calendar: calendar)
        let weeks = CalendarLogic.monthGrid(containing: anchorMonth, calendar: calendar)
        let agenda = CalendarLogic.agendaRows(
            tasks: taskBuckets[selectedDayKey] ?? [],
            events: deviceCalendar.events(on: selectedDayKey)
        )
        ScrollView {
            VStack(spacing: 0) {
                monthHeader
                weekdayHeader
                monthGrid(weeks: weeks, taskBuckets: taskBuckets)
                    .padding(.horizontal, 8)
                Divider()
                    .padding(.top, 8)
                agendaSection(rows: agenda)
            }
        }
        // `.contain` so the id names a CONTAINER: a bare identifier on a
        // SwiftUI container propagates to every child element and clobbers
        // the per-day/per-row ids Maestro drives (verified via hierarchy dump).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.view")
        .sheet(item: $selectedTask) { task in
            TaskDetailSheet(task: task)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        // Lazy permission ask + first month fetch on open.
        .task {
            if !accessRequested {
                accessRequested = true
                await deviceCalendar.requestAccessIfNeeded()
            }
            await deviceCalendar.loadMonth(containing: anchorMonth)
        }
        // Month navigation fetches that month's events (tiny per-month cache).
        .task(id: monthKey) {
            await deviceCalendar.loadMonth(containing: anchorMonth)
        }
        .refreshable {
            deviceCalendar.invalidate()
            async let t: Void = tasks.loadTasks()
            async let e: Void = deviceCalendar.loadMonth(containing: anchorMonth)
            _ = await (t, e)
        }
    }

    // MARK: - Month header

    private var monthHeader: some View {
        HStack(spacing: 12) {
            Text(anchorMonth.formatted(.dateTime.month(.wide).year()))
                .font(.title3.weight(.semibold))
                .accessibilityIdentifier("calendar.monthTitle")
            Spacer()
            if !calendar.isDate(anchorMonth, equalTo: Date(), toGranularity: .month) {
                Button("Today") { jumpToToday() }
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("calendar.today")
            }
            Button {
                shiftMonth(-1)
            } label: {
                Image(systemName: "chevron.left")
                    .font(.body.weight(.semibold))
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier("calendar.prevMonth")
            Button {
                shiftMonth(1)
            } label: {
                Image(systemName: "chevron.right")
                    .font(.body.weight(.semibold))
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier("calendar.nextMonth")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func shiftMonth(_ delta: Int) {
        withAnimation(.snappy(duration: 0.2)) {
            anchorMonth = CalendarLogic.addMonths(delta, to: anchorMonth, calendar: calendar)
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func jumpToToday() {
        withAnimation(.snappy(duration: 0.2)) {
            anchorMonth = Date()
            selectedDate = Date()
        }
    }

    // MARK: - Grid

    private var weekdayHeader: some View {
        HStack(spacing: 0) {
            ForEach(CalendarLogic.orderedWeekdaySymbols(calendar: calendar), id: \.self) { symbol in
                Text(symbol)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
    }

    private func monthGrid(
        weeks: [[CalendarLogic.GridDay]],
        taskBuckets: [String: [CalendarLogic.TaskItem]]
    ) -> some View {
        VStack(spacing: 2) {
            ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                HStack(spacing: 0) {
                    ForEach(week) { day in
                        dayCell(
                            day,
                            taskCount: taskBuckets[day.dayKey]?.count ?? 0,
                            eventCount: deviceCalendar.events(on: day.dayKey).count
                        )
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.grid")
        // Horizontal swipe = month page turn (vertical stays with the scroll).
        .gesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    guard abs(value.translation.width) > abs(value.translation.height) * 1.5,
                          abs(value.translation.width) > 40 else { return }
                    shiftMonth(value.translation.width < 0 ? 1 : -1)
                }
        )
    }

    @ViewBuilder
    private func dayCell(_ day: CalendarLogic.GridDay, taskCount: Int, eventCount: Int) -> some View {
        let isSelected = day.dayKey == selectedDayKey
        let isToday = calendar.isDateInToday(day.date)
        Button {
            selectedDate = day.date
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } label: {
            VStack(spacing: 3) {
                Text("\(day.dayNumber)")
                    .font(.subheadline.weight(isToday || isSelected ? .bold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(
                        isSelected ? Theme.onTint
                            : isToday ? Theme.tint
                            : day.inMonth ? Color.primary : Color(.tertiaryLabel)
                    )
                    .frame(width: 32, height: 32)
                    .background {
                        if isSelected {
                            Circle().fill(Theme.tint)
                        } else if isToday {
                            Circle().strokeBorder(Theme.tint, lineWidth: 1.5)
                        }
                    }
                dotRow(taskCount: taskCount, eventCount: eventCount)
                    .frame(height: 6)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("calendar.day.\(day.dayKey)")
    }

    /// Up to 3 task dots (tint) + 1 event dot (grey) — enough to read density
    /// at a glance without turning cells into charts.
    @ViewBuilder
    private func dotRow(taskCount: Int, eventCount: Int) -> some View {
        HStack(spacing: 3) {
            ForEach(0..<min(taskCount, 3), id: \.self) { _ in
                Circle().fill(Theme.tint).frame(width: 5, height: 5)
            }
            if eventCount > 0 {
                Circle().fill(Color(.systemGray2)).frame(width: 5, height: 5)
            }
        }
    }

    // MARK: - Day agenda

    @ViewBuilder
    private func agendaSection(rows: [CalendarLogic.AgendaRow]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(selectedDate.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                .font(.headline)
                .padding(.top, 12)
                .accessibilityIdentifier("calendar.agendaTitle")

            if deviceCalendar.access == .denied {
                deniedHint
            }

            // Quick capture pre-dated to the selected day — the empty-slot
            // add path. Rides TasksStore.createTask (optimistic + overlay).
            CalendarQuickAddRow(dayKey: selectedDayKey, dayLabel: shortDayLabel)

            if rows.isEmpty {
                Text("Nothing on this day.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 20)
                    .accessibilityIdentifier("calendar.agendaEmpty")
            } else {
                ForEach(rows) { row in
                    switch row {
                    case .task(let item):
                        CalendarTaskRow(item: item) { selectedTask = item.task }
                    case .event(let event):
                        CalendarEventRow(event: event)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.agenda")
    }

    private var shortDayLabel: String {
        if calendar.isDateInToday(selectedDate) { return "today" }
        return selectedDate.formatted(.dateTime.month(.abbreviated).day())
    }

    private var deniedHint: some View {
        HStack(spacing: 8) {
            Image(systemName: "calendar.badge.exclamationmark")
                .foregroundStyle(.secondary)
            Text("Calendar events hidden — allow access in Settings.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .font(.caption.weight(.semibold))
        }
        .padding(10)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityIdentifier("calendar.deniedHint")
    }
}

// MARK: - Day-scoped quick add

/// One-line add for the selected day: Return creates the task with due_date
/// preset to that day (date-only — a due DAY, matching the PATCH contract).
/// Reuses TasksStore.createTask, so the optimistic insert, pending overlay,
/// and locate-me signal all apply; the row appears in the agenda instantly
/// because the store's tasks array drives the bucketing.
private struct CalendarQuickAddRow: View {
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

// MARK: - Agenda rows

/// One task item in the day agenda: status circle, kind chip (Due/Starts/
/// Ends), title, and the clock time when the date carries one.
private struct CalendarTaskRow: View {
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
                        Text(kindLabel)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1.5)
                            .background(kindColor.opacity(0.15), in: Capsule())
                            .foregroundStyle(kindColor)
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

    private var kindLabel: String {
        switch item.kind {
        case .due: return "Due"
        case .start: return "Starts"
        case .end: return "Ends"
        }
    }

    private var kindColor: Color {
        switch item.kind {
        case .due: return item.task.isOverdue ? Theme.danger : Theme.tint
        case .start: return Theme.success
        case .end: return Theme.warning
        }
    }
}

/// One read-only device calendar event: source-calendar color bar, title,
/// time range — visually distinct from task rows (no status circle, no
/// chevron, not tappable).
private struct CalendarEventRow: View {
    let event: DeviceCalendarEvent

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(eventColor)
                .frame(width: 4, height: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(timeText)
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

    private var eventColor: Color {
        if let r = event.colorRed, let g = event.colorGreen, let b = event.colorBlue {
            return Color(red: r, green: g, blue: b)
        }
        return Color(.systemGray2)
    }

    private var timeText: String {
        if event.isAllDay { return "All day" }
        let start = event.start.formatted(date: .omitted, time: .shortened)
        let end = event.end.formatted(date: .omitted, time: .shortened)
        return "\(start) – \(end)"
    }
}
