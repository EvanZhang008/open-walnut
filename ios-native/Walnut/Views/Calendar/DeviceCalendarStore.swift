import EventKit
import Foundation
import Observation

/// One device calendar event, decoupled from EKEvent so the merge/bucketing
/// logic (CalendarLogic) and the mock-layer tests never need EventKit types.
struct DeviceCalendarEvent: Equatable, Identifiable {
    let id: String
    let title: String
    let start: Date
    let end: Date
    let isAllDay: Bool
    /// Source calendar's display color (sRGB components) — nil when unknown.
    let colorRed: Double?
    let colorGreen: Double?
    let colorBlue: Double?
    let calendarTitle: String?
}

/// Protocol seam over EKEventStore: the store below talks ONLY to this, so
/// CalendarStoreTests can inject a scripted provider (grant/deny, fixture
/// events) without real calendar access. EventKitProvider is the one real
/// implementation.
protocol CalendarEventProvider {
    var authorizationStatus: EKAuthorizationStatus { get }
    func requestAccess() async -> Bool
    func events(from: Date, to: Date) -> [DeviceCalendarEvent]
}

/// Real EventKit-backed provider. iOS 17+ full-access API (the app targets
/// iOS 18, so no legacy requestAccess path is needed).
final class EventKitProvider: CalendarEventProvider {
    private let store = EKEventStore()

    var authorizationStatus: EKAuthorizationStatus {
        EKEventStore.authorizationStatus(for: .event)
    }

    func requestAccess() async -> Bool {
        (try? await store.requestFullAccessToEvents()) ?? false
    }

    func events(from: Date, to: Date) -> [DeviceCalendarEvent] {
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
        return store.events(matching: predicate).map { ek in
            var red: Double?, green: Double?, blue: Double?
            if let cg = ek.calendar?.cgColor,
               let comps = cg.components, comps.count >= 3 {
                red = Double(comps[0]); green = Double(comps[1]); blue = Double(comps[2])
            }
            return DeviceCalendarEvent(
                // Occurrences of a recurring event share eventIdentifier —
                // suffix the start stamp so per-day lists get unique ids.
                id: (ek.eventIdentifier ?? UUID().uuidString)
                    + "@\(Int(ek.startDate?.timeIntervalSince1970 ?? 0))",
                title: ek.title ?? "Untitled event",
                start: ek.startDate ?? from,
                end: ek.endDate ?? ek.startDate ?? from,
                isAllDay: ek.isAllDay,
                colorRed: red, colorGreen: green, colorBlue: blue,
                calendarTitle: ek.calendar?.title
            )
        }
    }
}

/// Device-calendar state for the Tasks-tab calendar: lazy permission request
/// on first open, per-month event fetch with a small in-memory cache, and a
/// graceful denied state (the task layer is never blocked by it).
@Observable
@MainActor
final class DeviceCalendarStore {
    enum Access: Equatable {
        case undetermined  // never asked — ask on first calendar open
        case granted
        case denied        // denied/restricted → "enable in Settings" hint
    }

    private let provider: CalendarEventProvider
    private var calendar: Calendar

    private(set) var access: Access
    /// Events bucketed by local day key ("yyyy-MM-dd"), covering every month
    /// fetched so far this app session.
    private(set) var eventsByDay: [String: [DeviceCalendarEvent]] = [:]

    /// Months already fetched ("yyyy-MM"). Tiny session cache: a month's
    /// events are fetched once and reused while the view lives; pull-to-
    /// refresh / reopen resets the store for fresh data.
    private var fetchedMonths: Set<String> = []
    private var inFlightMonths: Set<String> = []

    init(provider: CalendarEventProvider = EventKitProvider(), calendar: Calendar = .current) {
        self.provider = provider
        self.calendar = calendar
        switch provider.authorizationStatus {
        case .fullAccess: access = .granted
        case .notDetermined: access = .undetermined
        // writeOnly can't read events — treat like denied for this feature.
        default: access = .denied
        }
    }

    /// Lazy permission ask — called on first calendar open. No-op unless the
    /// status is still undetermined.
    func requestAccessIfNeeded() async {
        guard access == .undetermined else { return }
        let granted = await provider.requestAccess()
        access = granted ? .granted : .denied
        AppLog.info("calendar", "eventkit access resolved", ["granted": String(granted)])
    }

    /// Fetch one visible month (grid spill covered by a ±7-day pad). Cached
    /// per month; concurrent duplicate calls collapse.
    func loadMonth(containing anchor: Date) async {
        guard access == .granted else { return }
        let key = CalendarLogic.monthKey(anchor, calendar: calendar)
        guard !fetchedMonths.contains(key), !inFlightMonths.contains(key) else { return }
        guard let firstOfMonth = CalendarLogic.startOfMonth(anchor, calendar: calendar),
              let from = calendar.date(byAdding: .day, value: -7, to: firstOfMonth),
              let nextMonth = calendar.date(byAdding: .month, value: 1, to: firstOfMonth),
              let to = calendar.date(byAdding: .day, value: 7, to: nextMonth)
        else { return }
        inFlightMonths.insert(key)
        defer { inFlightMonths.remove(key) }
        // EKEventStore queries are synchronous — run off-main.
        let provider = self.provider
        let events = await Task.detached(priority: .userInitiated) {
            provider.events(from: from, to: to)
        }.value
        fetchedMonths.insert(key)
        // Rebucket the padded window; per-day lists merge across fetches
        // (adjacent months' pads overlap — replace wholesale by day).
        let fresh = CalendarLogic.bucketEvents(events, calendar: self.calendar)
        for (day, rows) in fresh { eventsByDay[day] = rows }
        AppLog.info("calendar", "month events loaded", ["month": key, "events": String(events.count)])
    }

    /// Fetch every month touched by `from...to` (the list view's scroll window
    /// and the multi-day pager both span month boundaries). Rides the same
    /// per-month cache, so re-entering a covered range is free.
    func loadRange(from: Date, to: Date) async {
        guard access == .granted else { return }
        guard var cursor = CalendarLogic.startOfMonth(min(from, to), calendar: calendar),
              let last = CalendarLogic.startOfMonth(max(from, to), calendar: calendar)
        else { return }
        // Cap the walk so a corrupt range can't fan out unbounded.
        var hops = 0
        while cursor <= last, hops <= 36 {
            await loadMonth(containing: cursor)
            guard let next = calendar.date(byAdding: .month, value: 1, to: cursor) else { break }
            cursor = next
            hops += 1
        }
    }

    func events(on dayKey: String) -> [DeviceCalendarEvent] {
        eventsByDay[dayKey] ?? []
    }

    /// Drop the cache (pull-to-refresh) so months refetch on next load.
    func invalidate() {
        fetchedMonths.removeAll()
        eventsByDay.removeAll()
    }
}
