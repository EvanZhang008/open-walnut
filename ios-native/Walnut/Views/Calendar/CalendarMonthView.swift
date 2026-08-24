import SwiftUI

/// Month grid (Apple Calendar's "Month"): full weeks of day cells with density
/// dots, chevron/swipe month navigation, and a day agenda under the grid.
///
/// Tapping a day cell DRILLS INTO that day's Day view (Apple's behavior) — the
/// month is a navigator, not a destination. The agenda below the grid stays as
/// a preview of the currently previewed day, so a tap is confirmable before you
/// commit to leaving the month.
struct CalendarMonthView: View {
    @Binding var selectedDay: Date
    let calendar: Calendar
    let taskBuckets: [String: [CalendarLogic.TaskItem]]
    let eventsFor: (String) -> [DeviceCalendarEvent]
    let showsDeniedHint: Bool
    let onTapTask: (WalnutTask) -> Void
    /// Full create sheet for a day (the agenda's "+"), alongside the one-line
    /// quick add below the grid.
    let onCreate: (CalendarCreate.Draft) -> Void
    /// Committed day tap: the container switches to the Day view.
    let onDrillIntoDay: (Date) -> Void
    let onVisibleRangeChange: (Date, Date) -> Void

    /// The month on screen. Tracks the selected day but moves independently
    /// while the user pages months without picking a day.
    @State private var anchorMonth = Date()
    /// The day previewed in the agenda below the grid (first tap); a second tap
    /// on the same day drills in.
    @State private var previewDay = Date()

    private var previewDayKey: String { CalendarLogic.dayKey(previewDay, calendar: calendar) }

    var body: some View {
        let weeks = CalendarLogic.monthGrid(containing: anchorMonth, calendar: calendar)
        let agenda = CalendarLogic.agendaRows(
            tasks: taskBuckets[previewDayKey] ?? [],
            events: eventsFor(previewDayKey)
        )
        ScrollView {
            VStack(spacing: 0) {
                monthHeader
                weekdayHeader
                monthGrid(weeks: weeks)
                    .padding(.horizontal, 8)
                Divider().padding(.top, 8)
                agendaSection(rows: agenda)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.month")
        .onAppear {
            anchorMonth = selectedDay
            previewDay = selectedDay
            reportVisibleRange()
        }
        .onChange(of: selectedDay) { _, day in
            // Today button / external selection: follow it into view.
            if !calendar.isDate(day, equalTo: anchorMonth, toGranularity: .month) {
                anchorMonth = day
            }
            previewDay = day
            reportVisibleRange()
        }
    }

    // MARK: - Header

    /// THIS is the authoritative month label — it tracks `anchorMonth`, which
    /// the chevrons move without touching the selection. (The container's own
    /// header therefore says "Calendar" in month mode; two month names stacked
    /// read as a rendering bug, and only this one can follow paging.)
    private var monthHeader: some View {
        HStack(spacing: 12) {
            Text(anchorMonth.formatted(.dateTime.month(.wide).year()))
                .font(.title3.weight(.semibold))
                .accessibilityIdentifier("calendar.monthTitle")
            Spacer()
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
        reportVisibleRange()
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

    private func monthGrid(weeks: [[CalendarLogic.GridDay]]) -> some View {
        VStack(spacing: 2) {
            ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                HStack(spacing: 0) {
                    ForEach(week) { day in
                        dayCell(
                            day,
                            taskCount: taskBuckets[day.dayKey]?.count ?? 0,
                            eventCount: eventsFor(day.dayKey).count
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
        let isPreviewed = day.dayKey == previewDayKey
        let isToday = calendar.isDateInToday(day.date)
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            // Second tap on the already-previewed day drills into Day view;
            // first tap just previews it below (so a mis-tap isn't a navigation).
            if isPreviewed {
                onDrillIntoDay(day.date)
            } else {
                previewDay = day.date
            }
        } label: {
            VStack(spacing: 3) {
                Text("\(day.dayNumber)")
                    .font(.subheadline.weight(isToday || isPreviewed ? .bold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(
                        isPreviewed ? Theme.onTint
                            : isToday ? Theme.danger
                            : day.inMonth ? Color.primary : Color(.tertiaryLabel)
                    )
                    .frame(width: 32, height: 32)
                    .background {
                        if isPreviewed {
                            Circle().fill(isToday ? Theme.danger : Theme.tint)
                        } else if isToday {
                            Circle().strokeBorder(Theme.danger, lineWidth: 1.5)
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
            HStack(spacing: 6) {
                Button {
                    onDrillIntoDay(previewDay)
                } label: {
                    HStack(spacing: 6) {
                        Text(previewDay.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                            .font(.headline)
                            .foregroundStyle(.primary)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("calendar.agendaTitle")
                // The full sheet (time, project) next to the one-line quick add
                // below — a timed task needs more than a title.
                Button {
                    onCreate(CalendarCreate.allDayDraft(day: previewDay, calendar: calendar))
                } label: {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.tint)
                        .frame(width: 30, height: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("calendar.agendaAdd")
            }
            .padding(.top, 12)

            if showsDeniedHint {
                CalendarAccessDeniedHint()
            }

            CalendarQuickAddRow(dayKey: previewDayKey, dayLabel: shortDayLabel)

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
                        CalendarTaskRow(item: item) { onTapTask(item.task) }
                    case .event(let event):
                        CalendarEventRow(event: event)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        // Clears the floating "Today" pill.
        .padding(.bottom, CalendarChrome.floatingControlClearance)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.agenda")
    }

    private var shortDayLabel: String {
        if calendar.isDateInToday(previewDay) { return "today" }
        return previewDay.formatted(.dateTime.month(.abbreviated).day())
    }

    private func reportVisibleRange() {
        guard let first = CalendarLogic.startOfMonth(anchorMonth, calendar: calendar) else { return }
        onVisibleRangeChange(
            CalendarLayout.addDays(-7, to: first, calendar: calendar),
            CalendarLayout.addDays(38, to: first, calendar: calendar)
        )
    }
}

/// EventKit-denied hint shared by the month agenda and the container's banner.
struct CalendarAccessDeniedHint: View {
    var body: some View {
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
