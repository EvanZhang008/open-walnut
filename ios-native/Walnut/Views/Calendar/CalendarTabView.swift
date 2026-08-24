import SwiftUI

/// Calendar surface for the Tasks tab: four views over one data set, switched
/// from a top-right menu — List, Day, Multi-Day, Month (Apple Calendar's set).
///
/// Structure:
///   - This container owns the SELECTED DAY, the view mode, the data derivation
///     and the EventKit store; each view is a dumb renderer over what it's
///     handed. That's why switching views never loses your place in time.
///   - The chosen view is remembered in UserDefaults (CalendarViewPreference),
///     so reopening lands where you left off.
///   - Day / Multi-Day carry the top week strip; all four carry the floating
///     "Today" button at the bottom-left (Apple's position).
///
/// Data:
///   - Walnut tasks come from the already-loaded TasksStore (no new fetch).
///     Timed start/end/due values become timeline blocks; date-only values ride
///     the all-day band and the list.
///   - Device events (EventKit) are read-only. Permission is asked lazily on
///     first open; denial degrades to a Settings hint and never blocks tasks.
///   - The FILTER (CalendarFilter) is applied to the task list ONCE, before
///     bucketing, so every view narrows identically and the expensive walk runs
///     over the narrowed set.
///
/// Creating: every view can create. A tap on empty space carries the slot it
/// landed in (CalendarCreate), and the header "+" creates on the selected day.
/// Both open CalendarCreateSheet. A create into a project the filter hides
/// RELAXES the filter rather than swallowing the new task (dogfood R18).
struct CalendarTabView: View {
    /// DEBUG harness override (`-calendar-view <mode>`): pins the starting view
    /// so each one is screenshot-able without tapping through the menu. nil in
    /// normal use, where the persisted choice wins.
    var forcedMode: CalendarViewMode? = nil
    /// DEBUG harness override (`-calendar-day <yyyy-MM-dd>`): opens on a given
    /// day instead of today, so non-today selection states are screenshot-able.
    var forcedDay: Date? = nil

    @Environment(TasksStore.self) private var tasks
    @State private var deviceCalendar = DeviceCalendarStore()

    private let calendar = Calendar.current

    @State private var mode: CalendarViewMode = .day
    @State private var selectedDay = Calendar.current.startOfDay(for: Date())
    @State private var selectedTask: WalnutTask?
    /// One-time lazy permission ask, on first calendar open only.
    @State private var accessRequested = false
    /// Set once the persisted view mode has been restored, so the first
    /// onChange (restore) never writes the default back over it.
    @State private var restored = false
    /// What the calendar is allowed to show (persisted).
    @State private var filter = CalendarFilter.unrestricted
    @State private var showFilter = false
    /// The tapped slot awaiting a title — non-nil presents the create sheet.
    @State private var createDraft: CalendarCreate.Draft?

    private let preference = CalendarViewPreference()
    private let filterPreference = CalendarFilterPreference()

    var body: some View {
        // Bind derived collections ONCE per body pass (TasksView discipline):
        // one bucketing walk feeds every view. The filter narrows the LIST
        // first, so the two bucketing walks run over the smaller set.
        let visibleTasks = filter.apply(toTasks: tasks.tasks)
        let taskBuckets = CalendarLogic.bucketTasks(visibleTasks, calendar: calendar)
        let spanBuckets = CalendarTimeline.bucketTaskSpans(visibleTasks, calendar: calendar)
        VStack(spacing: 0) {
            header
            if deviceCalendar.access == .denied, mode != .month {
                CalendarAccessDeniedHint()
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            }
            if mode.showsWeekStrip {
                CalendarWeekStrip(
                    selectedDay: $selectedDay,
                    calendar: calendar,
                    hasContent: { key in
                        !(taskBuckets[key] ?? []).isEmpty || !visibleEvents(key).isEmpty
                    }
                )
                Divider()
            }
            content(taskBuckets: taskBuckets, spanBuckets: spanBuckets)
        }
        // `.contain` so the id names a CONTAINER: a bare identifier on a
        // SwiftUI container propagates to every child element and clobbers the
        // per-day/per-row ids Maestro drives.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.view")
        // Floating "Today" — bottom-LEFT over the content, matching Apple
        // Calendar. Each view pads its own scroll content by
        // `CalendarChrome.floatingControlClearance` so the last row can still be
        // read and tapped under the pill.
        .overlay(alignment: .bottomLeading) { todayButton }
        .sheet(item: $selectedTask) { task in
            TaskDetailSheet(task: task)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $createDraft) { draft in
            CalendarCreateSheet(
                draft: draft,
                calendar: calendar,
                // One selected project = the obvious intent for a new task.
                suggestedProject: filter.projects.count == 1 ? (filter.projects.first ?? "") : "",
                onCreated: adoptCreated
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showFilter) {
            CalendarFilterSheet(filter: $filter, tasks: tasks.tasks)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        // Restore the remembered view + filter, lazy permission ask on open.
        .task {
            if !restored {
                mode = forcedMode ?? preference.load()
                filter = filterPreference.load()
                if let forcedDay { selectedDay = calendar.startOfDay(for: forcedDay) }
                restored = true
            }
            if !accessRequested {
                accessRequested = true
                await deviceCalendar.requestAccessIfNeeded()
            }
            await deviceCalendar.loadMonth(containing: selectedDay)
        }
        .onChange(of: mode) { _, newMode in
            guard restored else { return }
            preference.save(newMode)
        }
        .onChange(of: filter) { _, newFilter in
            guard restored else { return }
            filterPreference.save(newFilter)
        }
    }

    // MARK: - Create

    /// Open the create sheet for a tapped slot.
    private func startCreate(_ draft: CalendarCreate.Draft) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        createDraft = draft
    }

    /// A just-created task must be VISIBLE. Creating into a project the filter
    /// excludes would otherwise swallow it silently ("I added it and nothing
    /// happened" — the exact class of bug this whole change is fixing), so the
    /// filter widens to admit it and the day jumps to where it landed.
    private func adoptCreated(_ task: WalnutTask) {
        if !filter.projects.isEmpty, !filter.projects.contains(task.project) {
            filter.projects.insert(task.project)
        }
        if !filter.showsTasks { filter.showsTasks = true }
        if filter.hidesOverdue, task.isOverdue { filter.hidesOverdue = false }
        // Land on the day it was created for (a create from the header on a
        // different day, or an edited slot in the sheet).
        let landing = CalendarLogic.parseTaskDate(task.startDate, calendar: calendar)
            ?? CalendarLogic.parseTaskDate(task.dueDate, calendar: calendar)
        if let landing, !calendar.isDate(landing.date, inSameDayAs: selectedDay) {
            withAnimation(.snappy(duration: 0.25)) {
                selectedDay = calendar.startOfDay(for: landing.date)
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 12) {
            Text(titleText)
                .font(.title3.weight(.semibold))
                .accessibilityIdentifier("calendar.title")
            Spacer()
            CalendarFilterButton(activeCount: filter.activeCount) { showFilter = true }
            addButton
            viewMenu
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    /// Header create: an all-day task on the selected day. The unmissable entry
    /// that does NOT require knowing you can tap the grid — every view has it,
    /// including List and Month (dogfood R18: Day/Multi-Day/List had none).
    private var addButton: some View {
        Button {
            startCreate(CalendarCreate.allDayDraft(day: selectedDay, calendar: calendar))
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .foregroundStyle(Theme.tint)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("calendar.add")
    }

    /// Apple's switcher: a menu of the four views with the current one checked.
    private var viewMenu: some View {
        Menu {
            Picker("View", selection: $mode) {
                ForEach(CalendarViewMode.menuOrder) { candidate in
                    Label(candidate.title, systemImage: candidate.systemImage)
                        .tag(candidate)
                }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: mode.systemImage)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .font(.body.weight(.semibold))
            .foregroundStyle(Theme.tint)
            .frame(height: 32)
            .contentShape(Rectangle())
        }
        .accessibilityIdentifier("calendar.viewMenu")
    }

    /// The title tracks the view: a month name in Month, the day/range in the
    /// timeline views, "Calendar" for the open-ended list.
    private var titleText: String {
        switch mode {
        // Month mode's own header owns the month name: it follows the chevrons'
        // anchor month, which the selection deliberately does not.
        case .month, .list:
            return "Calendar"
        case .day:
            return selectedDay.formatted(.dateTime.month(.wide).day())
        case .multiDay:
            let end = CalendarLayout.addDays(mode.timelineDayCount - 1, to: selectedDay, calendar: calendar)
            let startText = selectedDay.formatted(.dateTime.month(.abbreviated).day())
            let endText = calendar.isDate(selectedDay, equalTo: end, toGranularity: .month)
                ? end.formatted(.dateTime.day())
                : end.formatted(.dateTime.month(.abbreviated).day())
            return "\(startText) – \(endText)"
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(
        taskBuckets: [String: [CalendarLogic.TaskItem]],
        spanBuckets: [String: [CalendarTimeline.TaskSpan]]
    ) -> some View {
        switch mode {
        case .list:
            CalendarListView(
                selectedDay: $selectedDay,
                calendar: calendar,
                taskBuckets: taskBuckets,
                eventsByDay: filter.showsEvents ? deviceCalendar.eventsByDay : [:],
                onTapTask: { selectedTask = $0 },
                onCreate: startCreate,
                onVisibleRangeChange: warmRange
            )
        case .day, .multiDay:
            CalendarTimelineView(
                dayCount: mode.timelineDayCount,
                selectedDay: $selectedDay,
                calendar: calendar,
                taskBuckets: taskBuckets,
                spanBuckets: spanBuckets,
                eventsFor: visibleEvents,
                onTapTask: { selectedTask = $0 },
                onCreate: startCreate,
                onVisibleRangeChange: warmRange
            )
        case .month:
            CalendarMonthView(
                selectedDay: $selectedDay,
                calendar: calendar,
                taskBuckets: taskBuckets,
                eventsFor: visibleEvents,
                showsDeniedHint: deviceCalendar.access == .denied,
                onTapTask: { selectedTask = $0 },
                onCreate: startCreate,
                onDrillIntoDay: { day in
                    let outcome = CalendarViewTransition.tappingMonthDay(day, calendar: calendar)
                    withAnimation(.snappy(duration: 0.25)) {
                        selectedDay = outcome.selectedDay
                        mode = outcome.mode
                    }
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                },
                onVisibleRangeChange: warmRange
            )
        }
    }

    // MARK: - Today

    private var todayButton: some View {
        Button {
            let outcome = CalendarViewTransition.jumpingToToday(
                now: Date(), mode: mode, calendar: calendar
            )
            withAnimation(.snappy(duration: 0.25)) { selectedDay = outcome.selectedDay }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } label: {
            Text("Today")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.tint)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.tint.opacity(0.25), lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .padding(.leading, 16)
        .padding(.bottom, 16)
        .accessibilityIdentifier("calendar.today")
    }

    // MARK: - Events

    /// One day's device events, after the filter. Every view reads events
    /// through here so "hide device events" can't be honoured in one view and
    /// ignored in another.
    private func visibleEvents(_ dayKey: String) -> [DeviceCalendarEvent] {
        filter.apply(toEvents: deviceCalendar.events(on: dayKey))
    }

    // MARK: - Event warming

    /// Views report the day range they can show; fetch those months' events.
    /// Fire-and-forget: the per-month cache collapses duplicates, and the task
    /// layer renders regardless.
    private func warmRange(_ from: Date, _ to: Date) {
        Task { await deviceCalendar.loadRange(from: from, to: to) }
    }
}
