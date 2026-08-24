import Foundation

/// What the calendar is allowed to show. Pure value type + pure `apply`
/// functions so the rules are unit-testable without a simulator, and so every
/// one of the four views filters IDENTICALLY (a filter that only bit the month
/// grid would be worse than no filter).
///
/// Why this exists: the real store here carries 2,719 open tasks across 23
/// projects, of which ~39 have any date at all. Before this, every dated task
/// from every project landed in one band with no way to narrow it — the user's
/// verdict was "not able to filter". The measured shape also decides the UI:
/// project is the axis worth filtering (23 values), and "tasks vs device
/// events" is the other real split.
struct CalendarFilter: Equatable, Codable {
    /// Projects to show. EMPTY = show every project (the default) — an empty
    /// set deliberately means "no restriction", not "show nothing", so a fresh
    /// install never opens on a blank calendar.
    var projects: Set<String> = []
    /// Show Walnut tasks (the things you can create/complete here).
    var showsTasks = true
    /// Show read-only device calendar events (EventKit).
    var showsEvents = true
    /// Hide tasks whose only date is in the past and already overdue. Off by
    /// default: an overdue thing is exactly what a calendar should shout about.
    var hidesOverdue = false

    static let unrestricted = CalendarFilter()

    /// The Inbox (project == "") shows in the picker under this label; it has
    /// no registry row so it can't be named any other way.
    static let inboxLabel = "Inbox"

    var isActive: Bool { self != Self.unrestricted }

    /// Number of narrowing choices in effect — drives the badge on the filter
    /// button, so "why is my task missing?" is answerable at a glance.
    var activeCount: Int {
        var n = projects.isEmpty ? 0 : 1
        if !showsTasks { n += 1 }
        if !showsEvents { n += 1 }
        if hidesOverdue { n += 1 }
        return n
    }

    // MARK: - Application

    /// True when this task passes the filter. Project matching uses the raw
    /// project string ("" = Inbox) so the set never has to care about display
    /// labels.
    func allows(_ task: WalnutTask) -> Bool {
        guard showsTasks else { return false }
        if !projects.isEmpty, !projects.contains(task.project) { return false }
        if hidesOverdue, task.isOverdue { return false }
        return true
    }

    /// Tasks are filtered BEFORE bucketing (one pass over the store list, not
    /// per day) — the bucketing walk is the expensive part.
    func apply(toTasks tasks: [WalnutTask]) -> [WalnutTask] {
        guard isActive else { return tasks }
        return tasks.filter(allows)
    }

    /// Device events carry no project, so only the tasks/events toggle applies.
    func apply(toEvents events: [DeviceCalendarEvent]) -> [DeviceCalendarEvent] {
        showsEvents ? events : []
    }

    // MARK: - Project menu source

    /// Every project that OWNS a dated open task, plus whatever the filter
    /// already selects (so a selected project can always be deselected, even
    /// after its last dated task moved). Sorted A→Z with Inbox first.
    ///
    /// Scoped to DATED tasks on purpose: 23 projects exist but most never touch
    /// the calendar, and a picker listing them all would be noise.
    static func selectableProjects(
        from tasks: [WalnutTask], selected: Set<String>
    ) -> [String] {
        var names = selected
        for task in tasks where !task.isDone {
            let hasDate = (task.dueDate?.isEmpty == false)
                || (task.startDate?.isEmpty == false)
                || (task.endDate?.isEmpty == false)
            if hasDate { names.insert(task.project) }
        }
        // "" (Inbox) sorts first; the rest A→Z.
        return names.sorted { a, b in
            if a.isEmpty != b.isEmpty { return a.isEmpty }
            return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
        }
    }

    /// Display label for a raw project value.
    static func label(for project: String) -> String {
        project.isEmpty ? inboxLabel : project
    }
}

/// Persisted filter, same tiny-value-type shape as CalendarViewPreference so
/// tests can inject a throwaway suite.
struct CalendarFilterPreference {
    static let key = "walnut.calendar.filter"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// A corrupt/absent blob degrades to unrestricted — never to a filter that
    /// hides everything.
    func load() -> CalendarFilter {
        guard let data = defaults.data(forKey: Self.key),
              let filter = try? JSONDecoder().decode(CalendarFilter.self, from: data)
        else { return .unrestricted }
        return filter
    }

    func save(_ filter: CalendarFilter) {
        // An unrestricted filter is stored as "no key" so a future default
        // change isn't overridden by a stale all-defaults blob.
        guard filter.isActive else {
            defaults.removeObject(forKey: Self.key)
            return
        }
        if let data = try? JSONEncoder().encode(filter) {
            defaults.set(data, forKey: Self.key)
        }
    }
}
