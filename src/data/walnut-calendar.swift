// walnut-calendar — EventKit bridge for Open Walnut's calendar view.
//
// Reads/writes the Mac's system calendars (ALL accounts the user added in
// System Settings → Internet Accounts: iCloud, Google, Exchange, …), so
// Walnut needs no per-provider OAuth; macOS owns sync back to the cloud.
//
// Subcommands (all output JSON on stdout; errors as {"error":..., "code":...}):
//   calendars                          → [{id,title,account,color,readonly}]
//   list <fromISO> <toISO> [refresh]   → [{id,calendarId,calendarName,account,
//                                          title,start,end,allDay,location,readonly,
//                                          status,selfStatus}]
//   update <eventId> <startISO> <endISO> [title]
//   create <calendarId> <title> <startISO> <endISO> [allDay]
//   delete <eventId>
//
// `status`/`selfStatus` are omitted when the source says nothing useful, so a
// plain personal event stays a plain payload. They matter for invitations: a
// meeting the organizer cancelled keeps sitting in the EventKit store with
// status "canceled" until someone processes the cancellation, and a meeting the
// user declined keeps sitting there with selfStatus "declined". Dropping both
// (as this helper used to) made those indistinguishable from live meetings.
//
// Passing `refresh` as the 4th arg to `list` asks EventKit to pull from the
// remote accounts first. The pull is asynchronous inside macOS, so it freshens
// the NEXT poll rather than this call's result — which is why only Walnut's
// background refresh passes it, not ordinary reads.
//
// Dates are tz-less LOCAL wall time ("2026-08-05T09:00:00") to match Walnut's
// task-date contract. Recurring events: `list` expands occurrences (EventKit
// does this natively); `update`/`delete` touch only that occurrence
// (span:.thisEvent).
//
// Compiled, signed and cached lazily by src/core/helper-build.ts, for
// src/core/calendar/sources/eventkit.ts (which owns HELPER_VERSION).

import Darwin
import EventKit
import Foundation

// ── TCC self-responsibility ─────────────────────────────────────────────────
// TCC attributes a calendar request to the RESPONSIBLE process — normally the
// top of the parent chain (Walnut.app, iTerm, launchd job, …), whose Info.plist
// must carry NSCalendarsUsageDescription or tccd refuses without even
// prompting. That made calendar access break whenever the launcher changed.
// Fix: re-exec ourselves with responsibility DISCLAIMED (the same private
// posix_spawn attribute Chromium/OBS use), so this binary becomes its own
// responsible process and tccd reads the usage keys from our embedded
// __info_plist section (injected at compile time by eventkit.ts). The grant
// then sticks to this binary, independent of who launched Walnut.
func reexecDisclaimedIfNeeded() {
    guard ProcessInfo.processInfo.environment["WALNUT_CAL_DISCLAIMED"] != "1" else { return }
    typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>?, Int32) -> Int32
    let RTLD_DEFAULT = UnsafeMutableRawPointer(bitPattern: -2)
    guard let sym = dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim") else { return }
    let setDisclaim = unsafeBitCast(sym, to: DisclaimFn.self)

    var attr: posix_spawnattr_t?
    guard posix_spawnattr_init(&attr) == 0 else { return }
    defer { posix_spawnattr_destroy(&attr) }
    guard setDisclaim(&attr, 1) == 0 else { return }

    let exePath = Bundle.main.executablePath ?? CommandLine.arguments[0]
    var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
    argv.append(nil)
    var env = ProcessInfo.processInfo.environment
    env["WALNUT_CAL_DISCLAIMED"] = "1"
    var envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") }
    envp.append(nil)

    var pid: pid_t = 0
    guard posix_spawn(&pid, exePath, nil, &attr, argv, envp) == 0 else { return } // fall back inline
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    // WIFEXITED / WEXITSTATUS (Swift has no C macros)
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
}

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

/// `status` subcommand: report the CURRENT authorization state without ever
/// triggering the system prompt. The Permission Doctor polls this while its
/// fix dialog is open, so it must be side-effect free — requestAccess() would
/// pop the dialog on every poll tick. Because this helper disclaims parent
/// responsibility (see reexecDisclaimedIfNeeded), the state reported here is
/// the helper's OWN grant — the one that actually gates list/create/update.
func printAuthStatus() -> Never {
    let status = EKEventStore.authorizationStatus(for: .event)
    let state: String
    switch status {
    case .notDetermined: state = "not-determined"
    case .fullAccess, .authorized: state = "granted"
    case .writeOnly: state = "denied" // list needs read; write-only can't render the view
    default: state = "denied" // .denied, .restricted
    }
    output(["state": state])
    exit(0)
}

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

/// EKEventStatus → wire string. `.none` (most personal events) returns nil so
/// the key is omitted entirely rather than shipping a meaningless "none".
func statusString(_ status: EKEventStatus) -> String? {
    switch status {
    case .confirmed: return "confirmed"
    case .tentative: return "tentative"
    case .canceled: return "canceled"
    default: return nil // .none
    }
}

/// The CURRENT USER's response to an invitation, when the source tracks it.
/// Only the states a caller can act on are reported; .unknown/.completed/
/// .inProcess say nothing about whether the user is going, so they're omitted.
func selfStatusString(_ e: EKEvent) -> String? {
    guard let attendees = e.attendees else { return nil }
    for a in attendees where a.isCurrentUser {
        switch a.participantStatus {
        case .pending: return "pending"
        case .accepted: return "accepted"
        case .declined: return "declined"
        case .tentative: return "tentative"
        case .delegated: return "delegated"
        default: return nil
        }
    }
    return nil
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
    if let status = statusString(e.status) { out["status"] = status }
    if let selfStatus = selfStatusString(e) { out["selfStatus"] = selfStatus }
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
guard args.count >= 2 else { fail("usage: walnut-calendar <status|calendars|list|update|create|delete> …", code: "usage") }
reexecDisclaimedIfNeeded()
// `status` must run BEFORE requestAccess(): it exists precisely to observe
// the auth state without mutating it (no prompt, no denial recorded).
if args[1] == "status" { printAuthStatus() }
requestAccess()

switch args[1] {
case "calendars":
    output(store.calendars(for: .event).map(calendarJson))

case "list":
    guard args.count >= 4, let from = parseLocal(args[2]), let toDay = parseLocal(args[3]) else {
        fail("usage: list <fromISO> <toISO> [refresh]", code: "usage")
    }
    // Ask macOS to pull from Exchange/Google/iCloud before reading. The pull is
    // asynchronous in calendaraccessd, so this warms the next poll, not this
    // read — callers that need "right now" should just poll more often.
    if args.count >= 5 && args[4] == "refresh" { store.refreshSourcesIfNecessary() }
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
