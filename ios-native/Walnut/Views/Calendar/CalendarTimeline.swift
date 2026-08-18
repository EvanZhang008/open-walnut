import Foundation

/// Pure projection of one day's tasks + device events into what the day /
/// multi-day timelines draw: a stack of all-day banners plus lane-packed timed
/// blocks. Like CalendarLayout, everything is static and calendar-parameterized
/// so the tests drive the production code with fixed zones.
///
/// Task placement rules (a task is not an event, so this is a deliberate map):
///   - A timed `start_date` opens a WORK span, ending at `end_date` when that
///     is later, otherwise at start + `defaultTaskMinutes`.
///   - A timed `due_date` is a DEADLINE point, drawn only when it doesn't
///     already sit inside that work span (otherwise it's the same block twice).
///   - Date-only values carry no clock, so they ride the all-day band —
///     matching Apple, where a day-granular item is never given a fake hour.
///   - Done tasks never appear (CalendarLogic.bucketTasks owns that rule).
enum CalendarTimeline {

    /// Height floor for a rendered block: a 0-5 minute item still needs to be
    /// readable and tappable. Only the DRAWN end is inflated; lane packing uses
    /// the true end, so two back-to-back short events stay full width.
    static let minimumBlockMinutes: Double = 24
    /// Span given to a task that has a time but no explicit end.
    static let defaultTaskMinutes: Double = 60

    // MARK: - Rows

    /// What a block/banner represents. Tasks stay distinguishable from events
    /// all the way to the view (tasks are tappable, events are read-only).
    enum Source: Equatable {
        case task(CalendarLogic.TaskItem)
        case event(DeviceCalendarEvent)
    }

    /// One all-day banner in the band above the hour grid.
    struct AllDayRow: Equatable, Identifiable {
        let id: String
        let source: Source
        /// Multi-day event/task continuing in from an earlier day.
        let continuesBefore: Bool
        let continuesAfter: Bool
    }

    /// One positioned block on the hour grid. `startMinutes`/`endMinutes` are
    /// the TRUE clipped bounds (used for the time label); `displayEndMinutes`
    /// applies the height floor.
    struct Block: Equatable, Identifiable {
        let id: String
        let source: Source
        let startMinutes: Double
        let endMinutes: Double
        let displayEndMinutes: Double
        let column: Int
        let columnCount: Int
        let continuesBefore: Bool
        let continuesAfter: Bool

        var heightMinutes: Double { max(displayEndMinutes - startMinutes, 1) }
    }

    /// One day column's full layout.
    struct DayLayout: Equatable {
        let dayKey: String
        let allDay: [AllDayRow]
        let blocks: [Block]

        static let empty = DayLayout(dayKey: "", allDay: [], blocks: [])
    }

    // MARK: - Task spans

    /// A task's timed footprint. Two kinds can come off one task (work span +
    /// deadline point), each keyed like CalendarLogic.TaskItem ids so a block
    /// id is greppable across layers.
    struct TaskSpan: Equatable {
        let kind: CalendarLogic.TaskItem.Kind
        let task: WalnutTask
        let start: Date
        let end: Date
        var id: String { "\(kind.rawValue):\(task.id)" }
    }

    /// Derive every timed span a task contributes. Empty for done tasks and for
    /// tasks whose dates are all date-only (those ride the all-day band).
    static func taskSpans(_ task: WalnutTask, calendar: Calendar) -> [TaskSpan] {
        guard !task.isDone else { return [] }
        let start = CalendarLogic.parseTaskDate(task.startDate, calendar: calendar)
        let end = CalendarLogic.parseTaskDate(task.endDate, calendar: calendar)
        let due = CalendarLogic.parseTaskDate(task.dueDate, calendar: calendar)

        var spans: [TaskSpan] = []
        if let start, start.hasTime {
            let finish: Date
            if let end, end.hasTime, end.date > start.date {
                finish = end.date
            } else {
                finish = start.date.addingTimeInterval(defaultTaskMinutes * 60)
            }
            spans.append(TaskSpan(kind: .start, task: task, start: start.date, end: finish))
        }
        if let due, due.hasTime {
            // Skip a deadline already covered by the work span — one task
            // shouldn't paint two blocks over the same minutes.
            let coveredByWork = spans.first.map { due.date >= $0.start && due.date <= $0.end } ?? false
            if !coveredByWork {
                spans.append(TaskSpan(
                    kind: .due, task: task,
                    start: due.date,
                    end: due.date.addingTimeInterval(defaultTaskMinutes * 60)
                ))
            }
        }
        return spans
    }

    /// Fan every task's spans out to the local days they touch, so a day
    /// column can be laid out from one pass over the store's task list.
    /// Capped like CalendarLogic.bucketEvents so a corrupt span can't loop.
    static func bucketTaskSpans(_ tasks: [WalnutTask], calendar: Calendar) -> [String: [TaskSpan]] {
        var buckets: [String: [TaskSpan]] = [:]
        let spanCapDays = 62
        for task in tasks {
            for span in taskSpans(task, calendar: calendar) {
                var cursor = calendar.startOfDay(for: span.start)
                var hops = 0
                while cursor <= span.end, hops <= spanCapDays {
                    if hops > 0, cursor == span.end { break } // midnight-exclusive end
                    buckets[CalendarLogic.dayKey(cursor, calendar: calendar), default: []].append(span)
                    guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
                    cursor = next
                    hops += 1
                }
            }
        }
        return buckets
    }

    // MARK: - Day layout

    /// Lay one day out. `allDayTasks` are that day's date-only task items
    /// (CalendarLogic.bucketTasks output, filtered to `!hasTime` here),
    /// `spans` that day's timed task spans, `events` that day's device events.
    static func layout(
        day: Date,
        allDayTasks: [CalendarLogic.TaskItem],
        spans: [TaskSpan],
        events: [DeviceCalendarEvent],
        calendar: Calendar
    ) -> DayLayout {
        var allDay: [AllDayRow] = []
        var packables: [CalendarLayout.Packable] = []
        var sourceById: [String: Source] = [:]
        var boundsById: [String: CalendarLayout.DayBounds] = [:]

        for event in events {
            let id = "event-\(event.id)"
            guard let bounds = CalendarLayout.clipToDay(
                start: event.start, end: event.end, day: day, calendar: calendar
            ) else { continue }
            // An all-day event, or a timed one that swallows the whole column,
            // becomes a banner — a full-height block would just hide the grid.
            if event.isAllDay || bounds.coversWholeDay {
                allDay.append(AllDayRow(
                    id: id, source: .event(event),
                    continuesBefore: bounds.continuesBefore, continuesAfter: bounds.continuesAfter
                ))
                continue
            }
            sourceById[id] = .event(event)
            boundsById[id] = bounds
            packables.append(CalendarLayout.Packable(
                id: id, startMinutes: bounds.startMinutes, endMinutes: packEnd(bounds)
            ))
        }

        for span in spans {
            let id = "task-\(span.id)"
            guard let bounds = CalendarLayout.clipToDay(
                start: span.start, end: span.end, day: day, calendar: calendar
            ) else { continue }
            if bounds.coversWholeDay {
                allDay.append(AllDayRow(
                    id: id,
                    source: .task(CalendarLogic.TaskItem(
                        kind: span.kind, task: span.task, date: span.start, hasTime: true
                    )),
                    continuesBefore: bounds.continuesBefore, continuesAfter: bounds.continuesAfter
                ))
                continue
            }
            sourceById[id] = .task(CalendarLogic.TaskItem(
                kind: span.kind, task: span.task, date: span.start, hasTime: true
            ))
            boundsById[id] = bounds
            packables.append(CalendarLayout.Packable(
                id: id, startMinutes: bounds.startMinutes, endMinutes: packEnd(bounds)
            ))
        }

        // Date-only task items ride the all-day band, after the events.
        for item in allDayTasks where !item.hasTime {
            allDay.append(AllDayRow(
                id: "task-\(item.id)", source: .task(item),
                continuesBefore: false, continuesAfter: false
            ))
        }

        let blocks: [Block] = CalendarLayout.packOverlaps(packables).compactMap { packed in
            guard let source = sourceById[packed.id], let bounds = boundsById[packed.id] else { return nil }
            return Block(
                id: packed.id,
                source: source,
                startMinutes: bounds.startMinutes,
                endMinutes: bounds.endMinutes,
                displayEndMinutes: min(
                    max(bounds.endMinutes, bounds.startMinutes + minimumBlockMinutes),
                    CalendarLayout.minutesPerDay
                ),
                column: packed.column,
                columnCount: packed.columnCount,
                continuesBefore: bounds.continuesBefore,
                continuesAfter: bounds.continuesAfter
            )
        }

        return DayLayout(
            dayKey: CalendarLogic.dayKey(day, calendar: calendar),
            allDay: allDay,
            blocks: blocks
        )
    }

    /// Packing end: the true end, nudged so two items at the SAME instant get
    /// separate lanes while back-to-back items keep sharing one.
    private static func packEnd(_ bounds: CalendarLayout.DayBounds) -> Double {
        max(bounds.endMinutes, bounds.startMinutes + 0.5)
    }

    // MARK: - List view sections

    /// One day section of the list view.
    struct ListSection: Equatable, Identifiable {
        let day: Date
        let dayKey: String
        let rows: [CalendarLogic.AgendaRow]
        var id: String { dayKey }
        var isEmpty: Bool { rows.isEmpty }
    }

    /// Build the list view's day sections over `[from, from+dayCount)`.
    /// `includeEmptyDays` keeps a placeholder row-less section so scrolling
    /// stays anchored to real dates (Apple's list hides empty days; we do too
    /// by default, but the day the user selected is always kept so the "today"
    /// jump has a target).
    static func listSections(
        from start: Date,
        dayCount: Int,
        taskBuckets: [String: [CalendarLogic.TaskItem]],
        eventsByDay: [String: [DeviceCalendarEvent]],
        calendar: Calendar,
        alwaysInclude: Set<String> = []
    ) -> [ListSection] {
        guard dayCount > 0 else { return [] }
        var sections: [ListSection] = []
        sections.reserveCapacity(dayCount)
        var cursor = calendar.startOfDay(for: start)
        for _ in 0..<dayCount {
            let key = CalendarLogic.dayKey(cursor, calendar: calendar)
            let rows = CalendarLogic.agendaRows(
                tasks: taskBuckets[key] ?? [],
                events: eventsByDay[key] ?? []
            )
            if !rows.isEmpty || alwaysInclude.contains(key) {
                sections.append(ListSection(day: cursor, dayKey: key, rows: rows))
            }
            guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
            cursor = next
        }
        return sections
    }
}
