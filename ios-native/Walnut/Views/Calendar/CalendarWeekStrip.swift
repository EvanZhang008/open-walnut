import SwiftUI

/// The horizontal week strip above the day / multi-day timelines (Apple
/// Calendar's top bar): one week of dates, the selected day filled, today's
/// number in red, a dot under days that carry anything. Swiping left/right
/// pages by a whole week.
struct CalendarWeekStrip: View {
    @Binding var selectedDay: Date
    let calendar: Calendar
    /// True when the day has at least one task item or event — drives the dot.
    let hasContent: (String) -> Bool

    var body: some View {
        let days = CalendarLayout.weekDays(containing: selectedDay, calendar: calendar)
        VStack(spacing: 2) {
            HStack(spacing: 0) {
                ForEach(CalendarLogic.orderedWeekdaySymbols(calendar: calendar), id: \.self) { symbol in
                    Text(symbol)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            HStack(spacing: 0) {
                ForEach(days) { day in
                    dayButton(day)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
        // Horizontal swipe = week page turn. High minimum distance so it can't
        // steal a vertical scroll from the timeline below.
        .gesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    guard abs(value.translation.width) > abs(value.translation.height) * 1.5,
                          abs(value.translation.width) > 40 else { return }
                    shiftWeek(value.translation.width < 0 ? 1 : -1)
                }
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.weekStrip")
    }

    @ViewBuilder
    private func dayButton(_ day: CalendarLogic.GridDay) -> some View {
        let isSelected = calendar.isDate(day.date, inSameDayAs: selectedDay)
        let isToday = calendar.isDateInToday(day.date)
        Button {
            let outcome = CalendarViewTransition.tappingStripDay(day.date, mode: .day, calendar: calendar)
            selectedDay = outcome.selectedDay
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } label: {
            VStack(spacing: 2) {
                Text("\(day.dayNumber)")
                    .font(.subheadline.weight(isSelected || isToday ? .bold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(
                        isSelected ? Color(.systemBackground)
                            : isToday ? Theme.danger
                            : Color.primary
                    )
                    .frame(width: 30, height: 30)
                    .background {
                        if isSelected {
                            Circle().fill(isToday ? Theme.danger : Color.primary)
                        }
                    }
                Circle()
                    .fill(hasContent(day.dayKey) ? Theme.tint : Color.clear)
                    .frame(width: 4, height: 4)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("calendar.strip.\(day.dayKey)")
    }

    private func shiftWeek(_ delta: Int) {
        withAnimation(.snappy(duration: 0.2)) {
            selectedDay = CalendarLayout.addWeeks(delta, to: selectedDay, calendar: calendar)
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}
