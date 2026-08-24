import SwiftUI

/// List view (Apple Calendar's "List"): one continuous stream of days, each a
/// section header + that day's events and tasks. Empty days are skipped so the
/// list reads as "what's next" rather than a wall of blanks; the selected day is
/// always kept, so the Today button always has a target to scroll to.
///
/// Scrolling is windowed, not truly infinite: a range around the selected day is
/// rendered and extended when the user reaches either end. That keeps the view
/// hierarchy bounded (a phone list of a decade of days is a memory bug) while
/// feeling endless.
struct CalendarListView: View {
    @Binding var selectedDay: Date
    let calendar: Calendar
    let taskBuckets: [String: [CalendarLogic.TaskItem]]
    let eventsByDay: [String: [DeviceCalendarEvent]]
    let onTapTask: (WalnutTask) -> Void
    /// Per-day add (the section header's "+"): an all-day task on that day.
    let onCreate: (CalendarCreate.Draft) -> Void
    let onVisibleRangeChange: (Date, Date) -> Void

    /// Days rendered before / after the anchor, grown as the user scrolls out.
    /// Starts at ZERO back: the list must OPEN on the selected day (Apple's
    /// list opens on today, not a month of history), and past days arrive only
    /// when the user actually scrolls up. Pre-rendering history instead put the
    /// user weeks in the past on open, because the section for an empty selected
    /// day is suppressed and there was nothing to scroll to.
    @State private var daysBack = 0
    @State private var daysForward = 180
    /// Anchor is captured on appear so growing the window never re-centres the
    /// list under the user's finger.
    @State private var anchor = Date()
    @State private var didAutoScroll = false

    private var windowStart: Date {
        CalendarLayout.addDays(-daysBack, to: anchor, calendar: calendar)
    }

    /// The rendered day sections. A computed property (not a body local) so the
    /// post-layout auto-scroll can key on its count; bound ONCE per body pass
    /// below, never referenced twice.
    private var sections: [CalendarTimeline.ListSection] {
        CalendarTimeline.listSections(
            from: windowStart,
            dayCount: daysBack + daysForward,
            taskBuckets: taskBuckets,
            eventsByDay: eventsByDay,
            calendar: calendar,
            // Keep the selected day even when empty so the Today jump lands.
            alwaysInclude: [CalendarLogic.dayKey(selectedDay, calendar: calendar)]
        )
    }

    var body: some View {
        let sections = self.sections
        ScrollViewReader { proxy in
            List {
                // Explicit control, NOT an invisible sentinel: a zero-height
                // "grow" row at the TOP re-appears after every growth (the list
                // keeps it on screen), so it self-triggers and walks the user
                // backwards forever — measured as opening two months in the past.
                // A tapped button makes going back a decision.
                earlierButton(proxy)
                ForEach(sections) { section in
                    Section {
                        if section.isEmpty {
                            // An empty day is exactly where you want to add
                            // something — the row itself creates (dogfood R18:
                            // the List view had no create entry at all).
                            Button {
                                onCreate(CalendarCreate.allDayDraft(day: section.day, calendar: calendar))
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "plus.circle")
                                        .font(.caption)
                                        .foregroundStyle(Theme.tint)
                                    Text("Nothing on this day — add something")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("calendar.list.empty")
                        } else {
                            ForEach(section.rows) { row in
                                switch row {
                                case .task(let item):
                                    CalendarTaskRow(item: item) { onTapTask(item.task) }
                                case .event(let event):
                                    CalendarEventRow(event: event)
                                }
                            }
                        }
                    } header: {
                        sectionHeader(section.day)
                    }
                    .id("list-\(section.dayKey)")
                }
                growSentinel(edge: .bottom)
                // Clears the floating "Today" pill.
                Color.clear
                    .frame(height: CalendarChrome.floatingControlClearance)
                    .listRowSeparator(.hidden)
            }
            .listStyle(.plain)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("calendar.list")
            .onAppear {
                anchor = calendar.startOfDay(for: selectedDay)
                reportVisibleRange()
            }
            // Scroll AFTER the sections exist: on the first pass the rows aren't
            // built yet, so a scrollTo in onAppear is a no-op. Keyed on the
            // ALREADY-BOUND count (never a second derivation) so it runs on the
            // first non-empty layout.
            .onChange(of: sections.count, initial: true) { _, count in
                guard !didAutoScroll, count > 0 else { return }
                didAutoScroll = true
                scroll(proxy, to: selectedDay, animated: false)
            }
            // Today button / week strip / month tap changed the day: scroll to
            // it (or to the nearest later day that has content).
            .onChange(of: selectedDay) { _, day in
                scroll(proxy, to: day, animated: true)
            }
        }
    }

    // MARK: - Header

    private func sectionHeader(_ day: Date) -> some View {
        let isToday = calendar.isDateInToday(day)
        let key = CalendarLogic.dayKey(day, calendar: calendar)
        return HStack(spacing: 6) {
            Text(day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(isToday ? Theme.danger : .primary)
            if isToday {
                Text("Today")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.danger)
            }
            Spacer(minLength: 0)
            Text(day.formatted(.dateTime.year()))
                .font(.caption2)
                .foregroundStyle(.tertiary)
            // Add straight onto the day you are reading.
            Button {
                onCreate(CalendarCreate.allDayDraft(day: day, calendar: calendar))
            } label: {
                Image(systemName: "plus")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Theme.tint)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("calendar.list.add.\(key)")
        }
        .accessibilityIdentifier("calendar.list.header.\(key)")
    }

    // MARK: - Window growth

    private enum Edge { case top, bottom }

    /// Load-older control at the top of the list. Keeps the user's place: it
    /// pins the scroll back to where they were after the new days render, so
    /// tapping it doesn't teleport them to the new top.
    @ViewBuilder
    private func earlierButton(_ proxy: ScrollViewProxy) -> some View {
        if daysBack < 400 {
            Button {
                let keep = sections.first?.dayKey
                daysBack += 60
                reportVisibleRange()
                if let keep {
                    DispatchQueue.main.async { proxy.scrollTo("list-\(keep)", anchor: .top) }
                }
            } label: {
                Text("Show earlier")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.tint)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.plain)
            .listRowSeparator(.hidden)
            .accessibilityIdentifier("calendar.list.earlier")
        }
    }

    /// A zero-height row at the BOTTOM that extends the window as the user
    /// scrolls forward. Safe at that edge (reaching it is a real scroll), cheap
    /// (no geometry observation), and capped.
    @ViewBuilder
    private func growSentinel(edge: Edge) -> some View {
        Color.clear
            .frame(height: 1)
            .listRowSeparator(.hidden)
            .onAppear {
                guard edge == .bottom, daysForward < 800 else { return }
                daysForward += 120
                reportVisibleRange()
            }
    }

    // MARK: - Helpers

    private func scroll(_ proxy: ScrollViewProxy, to day: Date, animated: Bool) {
        let target = "list-\(CalendarLogic.dayKey(day, calendar: calendar))"
        if animated {
            withAnimation(.snappy(duration: 0.3)) { proxy.scrollTo(target, anchor: .top) }
        } else {
            proxy.scrollTo(target, anchor: .top)
        }
    }

    private func reportVisibleRange() {
        onVisibleRangeChange(
            windowStart,
            CalendarLayout.addDays(daysForward, to: anchor, calendar: calendar)
        )
    }
}
