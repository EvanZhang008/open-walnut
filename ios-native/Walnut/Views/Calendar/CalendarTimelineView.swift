import SwiftUI

/// The hour-timeline surface behind BOTH the single-day and multi-day views —
/// they differ only in how many day columns a page carries (1 vs 2), so one
/// view renders both and the mode supplies `dayCount`.
///
/// Layout, top to bottom: an all-day band (only when something is in it), then
/// a vertically scrolling 24-hour grid with the current-time red line + bubble.
/// Horizontal paging is a TabView (page style), so left/right swipe moves a
/// whole page and the gesture never fights the vertical scroll.
///
/// All positioning math comes from CalendarLayout / CalendarTimeline (pure,
/// unit-tested); this file only maps minutes → points.
struct CalendarTimelineView: View {
    let dayCount: Int
    @Binding var selectedDay: Date
    let calendar: Calendar
    let taskBuckets: [String: [CalendarLogic.TaskItem]]
    let spanBuckets: [String: [CalendarTimeline.TaskSpan]]
    let eventsFor: (String) -> [DeviceCalendarEvent]
    let onTapTask: (WalnutTask) -> Void
    /// Notifies the parent which days are now on screen, so it can fetch their
    /// months' events.
    let onVisibleRangeChange: (Date, Date) -> Void

    /// Points per minute — 60 pt/hour, Apple's density on iPhone.
    private let minuteHeight: CGFloat = 1
    private let gutterWidth: CGFloat = 46
    /// Height of the now-line row (the time bubble sets it) — the line is
    /// centered on "now" by offsetting half of this.
    private let nowLineHeight: CGFloat = 14

    /// Fixed paging origin: page indices derived from a stable epoch survive
    /// midnight and re-renders (see CalendarLayout.pageIndex).
    @State private var epoch: Date = Calendar.current.startOfDay(for: Date())
    @State private var page: Int = 0
    /// Live clock for the red now-line (ticks once a minute).
    @State private var now = Date()
    /// One-shot scroll to the current hour on first appearance.
    @State private var didAutoScroll = false

    private var dayHeight: CGFloat { CGFloat(CalendarLayout.minutesPerDay) * minuteHeight }

    var body: some View {
        VStack(spacing: 0) {
            allDayBand
            timelinePager
        }
        .onAppear {
            epoch = calendar.startOfDay(for: selectedDay)
            page = 0
            reportVisibleRange()
        }
        // Selection changed from outside (week strip, Today button, month tap):
        // page to the page that day lives on.
        .onChange(of: selectedDay) { _, day in
            let target = CalendarLayout.pageIndex(
                for: day, dayCount: dayCount, epoch: epoch, calendar: calendar
            )
            if target != page {
                withAnimation(.snappy(duration: 0.25)) { page = target }
            }
            reportVisibleRange()
        }
        // Swiped to another page: move the selection with it.
        .onChange(of: page) { _, newPage in
            let next = CalendarLayout.selection(
                forPage: newPage, dayCount: dayCount, epoch: epoch,
                currentSelection: selectedDay, calendar: calendar
            )
            if !calendar.isDate(next, inSameDayAs: selectedDay) { selectedDay = next }
            reportVisibleRange()
        }
        // Mode switch (1 ⇄ 2 columns) re-anchors the pager on the selection.
        .onChange(of: dayCount) { _, _ in
            epoch = calendar.startOfDay(for: selectedDay)
            page = 0
            reportVisibleRange()
        }
        .task {
            // Minute tick for the now-line. Cheap (one Date per minute) and
            // stops with the view.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                if Task.isCancelled { break }
                now = Date()
            }
        }
    }

    // MARK: - All-day band

    /// The band spans the visible page's columns so a banner sits above its own
    /// day. Hidden entirely when nothing is all-day (Apple does the same).
    @ViewBuilder
    private var allDayBand: some View {
        let days = visibleDays
        let layouts = days.map { layout(for: $0) }
        if layouts.contains(where: { !$0.allDay.isEmpty }) {
            HStack(alignment: .top, spacing: 0) {
                Text("all-day")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(width: gutterWidth, alignment: .trailing)
                    .padding(.trailing, 4)
                ForEach(Array(zip(days, layouts)), id: \.0.dayKey) { _, dayLayout in
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(dayLayout.allDay.prefix(3)) { row in
                            CalendarAllDayChip(row: row, onTapTask: onTapTask)
                        }
                        if dayLayout.allDay.count > 3 {
                            Text("+\(dayLayout.allDay.count - 3) more")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 2)
                }
            }
            .padding(.vertical, 4)
            .background(Color(.secondarySystemGroupedBackground))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("calendar.allDayBand")
        }
    }

    // MARK: - Pager

    private var timelinePager: some View {
        // ScrollViewReader wraps the pager so the one-shot "scroll to the
        // current hour" can target the hour anchors inside each page.
        TabView(selection: $page) {
            // A bounded window of pages around the current one keeps the swipe
            // infinite in practice without building unbounded views.
            ForEach((page - 2)...(page + 2), id: \.self) { index in
                pageBody(index: index)
                    .tag(index)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .accessibilityIdentifier("calendar.timeline")
    }

    @ViewBuilder
    private func pageBody(index: Int) -> some View {
        let days = CalendarLayout.pageDays(
            pageIndex: index, dayCount: dayCount, epoch: epoch, calendar: calendar
        )
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: true) {
                ZStack(alignment: .topLeading) {
                    hourGrid
                    HStack(alignment: .top, spacing: 0) {
                        Color.clear.frame(width: gutterWidth)
                        ForEach(days) { day in
                            dayColumn(day)
                        }
                    }
                    // Red now-line rides ON TOP of the columns so it reads
                    // across the whole page, like Apple's.
                    nowLine(days: days)
                }
                .frame(height: dayHeight)
                // Clears the floating "Today" pill.
                .padding(.bottom, CalendarChrome.floatingControlClearance)
            }
            .onAppear {
                guard !didAutoScroll, index == page else { return }
                didAutoScroll = true
                // Land on the hour ABOVE the current one so "now" is visible
                // with context, not pinned to the very top edge.
                let hour = max(calendar.component(.hour, from: now) - 1, 0)
                proxy.scrollTo("hour-\(hour)", anchor: .top)
            }
        }
    }

    // MARK: - Grid + columns

    private var hourGrid: some View {
        VStack(spacing: 0) {
            ForEach(Array(CalendarLayout.hourLabels(calendar: calendar).enumerated()), id: \.offset) { hour, label in
                HStack(alignment: .top, spacing: 4) {
                    Text(label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(width: gutterWidth, alignment: .trailing)
                        // Half-line nudge so the label reads as sitting ON the
                        // gridline, matching Apple.
                        .offset(y: -5)
                    Rectangle()
                        .fill(Color(.separator).opacity(0.5))
                        .frame(height: 0.5)
                    Spacer(minLength: 0)
                }
                .frame(height: 60 * minuteHeight, alignment: .top)
                .id("hour-\(hour)")
            }
        }
    }

    @ViewBuilder
    private func dayColumn(_ day: CalendarLogic.GridDay) -> some View {
        let dayLayout = layout(for: day)
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                // Column separator (multi-day only — a single day needs none).
                if dayCount > 1 {
                    Rectangle()
                        .fill(Color(.separator).opacity(0.4))
                        .frame(width: 0.5)
                }
                ForEach(dayLayout.blocks) { block in
                    let laneWidth = geo.size.width / CGFloat(max(block.columnCount, 1))
                    CalendarTimelineBlock(
                        block: block,
                        compact: block.heightMinutes < 34 || laneWidth < 90,
                        onTapTask: onTapTask
                    )
                    .frame(width: max(laneWidth - 2, 12), height: CGFloat(block.heightMinutes) * minuteHeight)
                    .offset(
                        x: laneWidth * CGFloat(block.column) + 1,
                        y: CGFloat(block.startMinutes) * minuteHeight
                    )
                }
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.column.\(day.dayKey)")
    }

    /// Current-time line: a red bubble in the gutter plus a hairline across the
    /// day it belongs to. Absent on pages that don't contain today.
    @ViewBuilder
    private func nowLine(days: [CalendarLogic.GridDay]) -> some View {
        if let todayIndex = days.firstIndex(where: { calendar.isDate($0.date, inSameDayAs: now) }),
           let minutes = CalendarLayout.nowMinutes(now: now, day: days[todayIndex].date, calendar: calendar) {
            GeometryReader { geo in
                let columnWidth = (geo.size.width - gutterWidth) / CGFloat(max(days.count, 1))
                HStack(spacing: 0) {
                    // Hour:minute only (no AM/PM): the full shortened form
                    // truncates inside the gutter, and Apple's bubble is the
                    // bare clock time too.
                    Text(nowBubbleText)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white)
                        .fixedSize()
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Theme.danger, in: Capsule())
                        .frame(width: gutterWidth, alignment: .trailing)
                    // Leading spacer skips the day columns before today's.
                    Color.clear.frame(width: columnWidth * CGFloat(todayIndex))
                    Rectangle()
                        .fill(Theme.danger)
                        .frame(width: columnWidth, height: 1.5)
                    Spacer(minLength: 0)
                }
                // Pin the row to a fixed height and to the TOP before offsetting:
                // an HStack handed the full 1440 pt column centers its children,
                // which put the line ~12 hours late (caught in the simulator).
                .frame(height: nowLineHeight)
                .offset(y: CGFloat(minutes) * minuteHeight - nowLineHeight / 2)
                .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            }
            .allowsHitTesting(false)
            .accessibilityIdentifier("calendar.nowLine")
        }
    }

    // MARK: - Data

    /// Bare clock time for the now bubble, in the calendar's locale
    /// (12-hour "9:09" in en_US, 24-hour "09:09" in de_DE — no AM/PM either way).
    private var nowBubbleText: String {
        let f = DateFormatter()
        f.locale = calendar.locale ?? .current
        f.timeZone = calendar.timeZone
        f.setLocalizedDateFormatFromTemplate("jm")
        return f.string(from: now)
            .replacingOccurrences(of: f.amSymbol, with: "")
            .replacingOccurrences(of: f.pmSymbol, with: "")
            .trimmingCharacters(in: .whitespaces)
    }

    private var visibleDays: [CalendarLogic.GridDay] {
        CalendarLayout.pageDays(pageIndex: page, dayCount: dayCount, epoch: epoch, calendar: calendar)
    }

    private func layout(for day: CalendarLogic.GridDay) -> CalendarTimeline.DayLayout {
        CalendarTimeline.layout(
            day: day.date,
            allDayTasks: taskBuckets[day.dayKey] ?? [],
            spans: spanBuckets[day.dayKey] ?? [],
            events: eventsFor(day.dayKey),
            calendar: calendar
        )
    }

    /// Report the widest range the pager can show without a refetch (±2 pages),
    /// so the parent warms those months' events before a swipe lands.
    private func reportVisibleRange() {
        let from = CalendarLayout.pageStart(
            pageIndex: page - 2, dayCount: dayCount, epoch: epoch, calendar: calendar
        )
        let to = CalendarLayout.addDays(
            dayCount * 3,
            to: CalendarLayout.pageStart(pageIndex: page, dayCount: dayCount, epoch: epoch, calendar: calendar),
            calendar: calendar
        )
        onVisibleRangeChange(from, to)
    }
}
