// walnut-calendar — EventKit bridge for Open Walnut's calendar view.
//
// Reads/writes the Mac's system calendars (ALL accounts the user added in
// System Settings → Internet Accounts: iCloud, Google, Exchange, …), so
// Walnut needs no per-provider OAuth; macOS owns sync back to the cloud.
//
// Subcommands (all output JSON on stdout; errors as {"error":..., "code":...}):
//   calendars                          → [{id,title,account,color,readonly}]
//   list <fromISO> <toISO>             → [{id,calendarId,calendarName,account,
//                                          title,start,end,allDay,location,readonly}]
//   update <eventId> <startISO> <endISO> [title]
//   create <calendarId> <title> <startISO> <endISO> [allDay]
//   delete <eventId>
//
// Dates are tz-less LOCAL wall time ("2026-08-05T09:00:00") to match Walnut's
// task-date contract. Recurring events: `list` expands occurrences (EventKit
// does this natively); `update`/`delete` touch only that occurrence
// (span:.thisEvent).
//
// Compiled lazily by src/core/calendar/sources/eventkit.ts via
// `xcrun swiftc -O` into WALNUT_HOME/cache (same pattern as walnut-extract).

import EventKit
import Foundation

let store = EKEventStore()

func fail(_ message: String, code: String) -> Never {
    let payload: [String: String] = ["error": message, "code": code]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    FileHandle.standardOutput.write(data)
    exit(1)
}

// ── date helpers (local wall time, no tz suffix) ────────────────────────────

let localFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    f.timeZone = TimeZone.current
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

let dayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone.current
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

func parseLocal(_ s: String) -> Date? {
    if s.contains("T") { return localFormatter.date(from: s) }
    return dayFormatter.date(from: s)
}

func formatLocal(_ d: Date) -> String { localFormatter.string(from: d) }

// ── access ──────────────────────────────────────────────────────────────────

func requestAccess() {
    let sema = DispatchSemaphore(value: 0)
    var granted = false
    var accessError: Error?
    let handler: (Bool, Error?) -> Void = { ok, err in
        granted = ok
        accessError = err
        sema.signal()
    }
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents(completion: handler)
    } else {
        store.requestAccess(to: .event, completion: handler)
    }
    _ = sema.wait(timeout: .now() + 30)
    if !granted {
        let detail = accessError.map { " (\($0.localizedDescription))" } ?? ""
        fail("Calendar access denied\(detail). Grant access in System Settings → Privacy & Security → Calendars.", code: "permission-denied")
    }
}

func colorHex(_ calendar: EKCalendar) -> String {
    guard let cg = calendar.cgColor, let comps = cg.components, comps.count >= 3 else { return "#0A84FF" }
    let r = Int((comps[0] * 255).rounded()), g = Int((comps[1] * 255).rounded()), b = Int((comps[2] * 255).rounded())
    return String(format: "#%02X%02X%02X", r, g, b)
}

func calendarJson(_ c: EKCalendar) -> [String: Any] {
    return [
        "id": c.calendarIdentifier,
        "title": c.title,
        "account": c.source?.title ?? "Local",
        "color": colorHex(c),
        "readonly": !c.allowsContentModifications,
    ]
}

func eventJson(_ e: EKEvent) -> [String: Any] {
    // Occurrences of a recurring event share eventIdentifier; suffix the start
    // timestamp so every rendered chip has a unique, re-findable id.
    let baseId = e.eventIdentifier ?? "unknown"
    let occId = e.hasRecurrenceRules || e.isDetached
        ? "\(baseId)#\(Int(e.startDate.timeIntervalSince1970))"
        : baseId
    var out: [String: Any] = [
        "id": occId,
        "calendarId": e.calendar.calendarIdentifier,
        "calendarName": e.calendar.title,
        "account": e.calendar.source?.title ?? "Local",
        "title": e.title ?? "(untitled)",
        "start": e.isAllDay ? dayFormatter.string(from: e.startDate) : formatLocal(e.startDate),
        "end": e.isAllDay ? dayFormatter.string(from: e.endDate) : formatLocal(e.endDate),
        "allDay": e.isAllDay,
        "readonly": !e.calendar.allowsContentModifications,
    ]
    if let loc = e.location, !loc.isEmpty { out["location"] = loc }
    return out
}

/// Resolve an occurrence id ("<ekid>" or "<ekid>#<epoch>") to the concrete
/// EKEvent instance, searching around the occurrence time for recurring events.
func findEvent(_ occId: String) -> EKEvent? {
    let parts = occId.split(separator: "#", maxSplits: 1)
    let baseId = String(parts[0])
    guard let base = store.event(withIdentifier: baseId) else { return nil }
    if parts.count == 1 { return base }
    guard let epoch = Double(parts[1]) else { return base }
    let target = Date(timeIntervalSince1970: epoch)
    let predicate = store.predicateForEvents(
        withStart: target.addingTimeInterval(-1),
        end: target.addingTimeInterval(24 * 3600),
        calendars: [base.calendar]
    )
    return store.events(matching: predicate).first {
        $0.eventIdentifier == baseId && abs($0.startDate.timeIntervalSince1970 - epoch) < 1
    } ?? base
}

func output(_ obj: Any) {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    FileHandle.standardOutput.write(data)
}

// ── main ────────────────────────────────────────────────────────────────────

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: walnut-calendar <calendars|list|update|create|delete> …", code: "usage") }
requestAccess()

switch args[1] {
case "calendars":
    output(store.calendars(for: .event).map(calendarJson))

case "list":
    guard args.count >= 4, let from = parseLocal(args[2]), let toDay = parseLocal(args[3]) else {
        fail("usage: list <fromISO> <toISO>", code: "usage")
    }
    // `to` is an inclusive day string → extend to end of that day.
    let to = args[3].contains("T") ? toDay : toDay.addingTimeInterval(24 * 3600)
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
    output(store.events(matching: predicate).map(eventJson))

case "update":
    guard args.count >= 5, let start = parseLocal(args[3]), let end = parseLocal(args[4]) else {
        fail("usage: update <eventId> <startISO> <endISO> [title]", code: "usage")
    }
    guard let event = findEvent(args[2]) else { fail("event not found: \(args[2])", code: "not-found") }
    if !event.calendar.allowsContentModifications { fail("calendar is read-only", code: "readonly") }
    let allDay = !args[3].contains("T")
    event.startDate = start
    // All-day "end" arrives as an inclusive day → extend to end-of-day so
    // EventKit doesn't get a zero-length event.
    event.endDate = allDay && !args[4].contains("T") && end <= start ? end.addingTimeInterval(24 * 3600 - 1) : end
    event.isAllDay = allDay
    if args.count >= 6 && !args[5].isEmpty { event.title = args[5] }
    do {
        try store.save(event, span: .thisEvent, commit: true)
        output(eventJson(event))
    } catch { fail("save failed: \(error.localizedDescription)", code: "save-failed") }

case "create":
    guard args.count >= 6, let start = parseLocal(args[4]), let endRaw = parseLocal(args[5]) else {
        fail("usage: create <calendarId> <title> <startISO> <endISO> [allDay]", code: "usage")
    }
    guard let calendar = store.calendar(withIdentifier: args[2]) else {
        fail("calendar not found: \(args[2])", code: "not-found")
    }
    if !calendar.allowsContentModifications { fail("calendar is read-only", code: "readonly") }
    let event = EKEvent(eventStore: store)
    event.calendar = calendar
    event.title = args[3]
    event.startDate = start
    let allDay = args.count >= 7 && args[6] == "true"
    event.isAllDay = allDay
    // All-day "end" is an inclusive day → EventKit wants end-of-day.
    event.endDate = allDay && !args[5].contains("T") ? endRaw.addingTimeInterval(24 * 3600 - 1) : endRaw
    do {
        try store.save(event, span: .thisEvent, commit: true)
        output(eventJson(event))
    } catch { fail("save failed: \(error.localizedDescription)", code: "save-failed") }

case "delete":
    guard args.count >= 3 else { fail("usage: delete <eventId>", code: "usage") }
    guard let event = findEvent(args[2]) else { fail("event not found: \(args[2])", code: "not-found") }
    do {
        try store.remove(event, span: .thisEvent, commit: true)
        output(["ok": true])
    } catch { fail("delete failed: \(error.localizedDescription)", code: "save-failed") }

default:
    fail("unknown subcommand: \(args[1])", code: "usage")
}
