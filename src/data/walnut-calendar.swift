// walnut-calendar — EventKit bridge for Open Walnut's calendar view.
//
// Reads/writes the Mac's system calendars (ALL accounts the user added in
// System Settings → Internet Accounts: iCloud, Google, Exchange, …), so
// Walnut needs no per-provider OAuth; macOS owns sync back to the cloud.
//
// Subcommands (all output JSON on stdout; errors as {"error":..., "code":...}):
//   capabilities                       → {writeSafetyVersion}   (no Calendars access)
//   status                             → {state}                (no prompt)
//   calendars                          → [{id,title,account,color,readonly}]
//   list <fromISO> <toISO> [refresh]   → [event]
//   get <eventId>                      → event
//   update <eventId> <startISO> <endISO> [title] [--human-confirm]   → event
//   create <calendarId> <title> <startISO> <endISO> [allDay]          → event
//   delete <eventId> [--human-confirm]                                → {ok}
//
// Write safety: update/delete pass on their own only for a Walnut block (stamped
// openwalnut://calendar-block/<UUID> by `create`, no attendees, organizer none or
// the user); anything else fails `human-approval-required`, or with
// --human-confirm shows a native dialog that only a click on "… and notify" passes.
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
// does this natively); `get`/`update`/`delete` resolve exactly that occurrence
// or answer not-found, and write with span:.thisEvent.
//
// Compiled, signed and cached lazily by src/core/helper-build.ts, for
// src/core/calendar/sources/eventkit.ts (which owns HELPER_VERSION).
//
// The SAME file is also compiled into Walnut.app (desktop/build.sh, with
// -D WALNUT_APP), where `Walnut --calendar-bridge <subcommand> …` runs
// walnutCalendarMain. That is the preferred route: the Calendars grant then
// belongs to Walnut itself, one certificate-signed identity that survives every
// rebuild, instead of to a helper whose version bumps each asked again. So:
// everything here except walnutCalendarMain is `private` (the app module has its
// own `fail`/`output`), and the `@main` entry point exists only in the helper.

import AppKit
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
private func reexecDisclaimedIfNeeded() {
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

private let store = EKEventStore()

private func fail(_ message: String, code: String) -> Never {
    let payload: [String: String] = ["error": message, "code": code]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    FileHandle.standardOutput.write(data)
    exit(1)
}

// ── date helpers (local wall time, no tz suffix) ────────────────────────────

private let localFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    f.timeZone = TimeZone.current
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

private let dayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone.current
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

private func parseLocal(_ s: String) -> Date? {
    if s.contains("T") { return localFormatter.date(from: s) }
    return dayFormatter.date(from: s)
}

private func formatLocal(_ d: Date) -> String { localFormatter.string(from: d) }

// ── access ──────────────────────────────────────────────────────────────────

/// `status` subcommand: report the CURRENT authorization state without ever
/// triggering the system prompt. The Permission Doctor polls this while its
/// fix dialog is open, so it must be side-effect free — requestAccess() would
/// pop the dialog on every poll tick. Because this helper disclaims parent
/// responsibility (see reexecDisclaimedIfNeeded), the state reported here is
/// the helper's OWN grant — the one that actually gates list/create/update.
private func printAuthStatus() -> Never {
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

private func requestAccess() {
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

private func colorHex(_ calendar: EKCalendar) -> String {
    guard let cg = calendar.cgColor, let comps = cg.components, comps.count >= 3 else { return "#0A84FF" }
    let r = Int((comps[0] * 255).rounded()), g = Int((comps[1] * 255).rounded()), b = Int((comps[2] * 255).rounded())
    return String(format: "#%02X%02X%02X", r, g, b)
}

private func calendarJson(_ c: EKCalendar) -> [String: Any] {
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
private func statusString(_ status: EKEventStatus) -> String? {
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
private func selfStatusString(_ e: EKEvent) -> String? {
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

private func eventJson(_ e: EKEvent) -> [String: Any] {
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
    let facts = writeFacts(e)
    out["walnutCreated"] = facts.walnutCreated
    out["hasAttendees"] = facts.hasAttendees
    out["recurring"] = facts.recurring
    out["writeSafetyVersion"] = writeSafetyVersion
    // Absent organizer means "none", never "not me".
    if let mine = facts.organizerIsCurrentUser { out["organizerIsCurrentUser"] = mine }
    if let name = facts.organizerName { out["organizerName"] = name }
    return out
}

/// Exactly the named occurrence, or not-found: a write through the base event of a
/// recurring meeting can reach the whole series, so the base is never a fallback.
private func findOccurrence(_ occId: String) -> EKEvent {
    let parts = occId.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
    let baseId = String(parts[0])
    guard !baseId.isEmpty, let base = store.event(withIdentifier: baseId) else {
        fail("event not found: \(occId)", code: "not-found")
    }
    if parts.count == 1 {
        // EventKit answers a bare recurring id with its first occurrence, not the one meant.
        if base.hasRecurrenceRules || base.isDetached {
            fail("event not found: \(occId) is a recurring event; name one occurrence as <id>#<start epoch>", code: "not-found")
        }
        return base
    }
    guard let epoch = Double(parts[1]), epoch.isFinite else {
        fail("occurrence not found: \(occId)", code: "not-found")
    }
    let target = Date(timeIntervalSince1970: epoch)
    let predicate = store.predicateForEvents(
        withStart: target.addingTimeInterval(-1),
        end: target.addingTimeInterval(24 * 3600),
        calendars: [base.calendar]
    )
    guard let occurrence = store.events(matching: predicate).first(where: {
        $0.eventIdentifier == baseId && abs($0.startDate.timeIntervalSince1970 - epoch) < 1
    }) else {
        fail("occurrence not found: \(occId)", code: "not-found")
    }
    return occurrence
}

// BEGIN pure write-safety rules (Foundation only: the policy test compiles and runs this block alone)

/// Reported by `capabilities`; binaries from before the write rules do not know that subcommand.
private let writeSafetyVersion = 1

/// Opens the confirmation dialog for a protected event; never an approval by itself.
private let humanConfirmFlag = "--human-confirm"

/// The dialog cancels itself this long after the request started, inside the server's timeout.
private let humanConfirmBudget: TimeInterval = 85

private let walnutBlockScheme = "openwalnut"
private let walnutBlockHost = "calendar-block"

private func newWalnutBlockURL() -> URL {
    return URL(string: "\(walnutBlockScheme)://\(walnutBlockHost)/\(UUID().uuidString)")!
}

/// Only Walnut's own stamp counts, never "has no attendees" (every personal event has none).
private func isWalnutBlockURL(_ url: URL?) -> Bool {
    guard let url = url,
          let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
          c.scheme == walnutBlockScheme, c.host == walnutBlockHost,
          c.user == nil, c.password == nil, c.port == nil,
          c.query == nil, c.fragment == nil,
          c.percentEncodedPath.hasPrefix("/") else { return false }
    return UUID(uuidString: String(c.percentEncodedPath.dropFirst())) != nil
}

private enum WriteAction {
    case update, delete
    var verb: String { self == .update ? "Update" : "Delete" }
    var confirmButton: String { self == .update ? "Update and notify" : "Delete and notify" }
}

private struct WriteFacts {
    let title: String
    let walnutCreated: Bool
    let hasAttendees: Bool
    /// nil when the event has no organizer at all.
    let organizerIsCurrentUser: Bool?
    let organizerName: String?
    let recurring: Bool

    var writableWithoutHuman: Bool {
        return walnutCreated && !hasAttendees
            && (organizerIsCurrentUser == nil || organizerIsCurrentUser == true)
    }
}

private func protectionReasons(_ f: WriteFacts) -> String {
    var reasons: [String] = []
    if !f.walnutCreated { reasons.append("Walnut did not create it") }
    if f.hasAttendees { reasons.append("it has attendees") }
    if f.organizerIsCurrentUser == false {
        reasons.append(f.organizerName.map { "\($0) organizes it" } ?? "someone else organizes it")
    }
    guard let last = reasons.popLast() else { return "" }
    return reasons.isEmpty ? last : reasons.joined(separator: ", ") + " and " + last
}

private func organizerPhrase(_ f: WriteFacts) -> String {
    return f.organizerName.map { "The organizer (\($0))" } ?? "The organizer"
}

private func approvalRequiredMessage(_ action: WriteAction, _ f: WriteFacts) -> String {
    var parts = ["\(action.verb) \"\(f.title)\" needs a person to confirm it on this Mac: \(protectionReasons(f))."]
    if f.recurring {
        parts.append("It is one occurrence of a recurring series, and the calendar server may apply this to the whole series.")
    }
    parts.append("\(organizerPhrase(f)) may be notified.")
    parts.append("Use Hide event instead to remove it from Walnut without changing the calendar.")
    return parts.joined(separator: " ")
}

private func confirmAlertTitle(_ action: WriteAction, _ f: WriteFacts) -> String {
    return "\(action.verb) \"\(f.title)\"?"
}

/// `when` names the occurrence and calendar: for a recurring event the title alone does not.
private func confirmAlertText(_ action: WriteAction, _ f: WriteFacts, when: String) -> String {
    let doing = action == .delete ? "deleting" : "changing"
    let series = f.recurring
        ? "This is one occurrence of a recurring series. On some calendar servers (Exchange among them) \(doing) it can affect the whole series."
        : "If this event belongs to a recurring series, \(doing) it can affect the whole series on some calendar servers."
    let notify = action == .delete
        ? "\(organizerPhrase(f)) may be notified, and deleting an invitation can decline it for you."
        : "\(organizerPhrase(f)) and the attendees may be notified of the change."
    return [
        when,
        "Walnut will not change this event on its own: \(protectionReasons(f)).",
        series,
        notify,
        "To take it off Walnut only, press Cancel and use Hide event instead. Hiding changes nothing in your calendar.",
    ].filter { !$0.isEmpty }.joined(separator: "\n\n")
}

/// The flag counts only as the last argument after the required ones, so it is never a title; anything else is nil (usage).
private func splitHumanConfirm(_ rest: [String], required: Int, optional: Int) -> (positional: [String], humanConfirm: Bool)? {
    var positional = rest
    var humanConfirm = false
    if positional.count > required, positional.last == humanConfirmFlag {
        positional.removeLast()
        humanConfirm = true
    }
    guard positional.count >= required, positional.count <= required + optional else { return nil }
    guard !positional.contains(humanConfirmFlag) else { return nil }
    return (positional, humanConfirm)
}
// END pure write-safety rules

private func participantName(_ p: EKParticipant) -> String? {
    if let name = p.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
    guard p.url.scheme?.lowercased() == "mailto",
          let address = URLComponents(url: p.url, resolvingAgainstBaseURL: false)?.path,
          !address.isEmpty else { return nil }
    return address
}

private func writeFacts(_ e: EKEvent) -> WriteFacts {
    let organizer = e.organizer
    return WriteFacts(
        title: e.title ?? "(untitled)",
        walnutCreated: isWalnutBlockURL(e.url),
        hasAttendees: e.hasAttendees || !(e.attendees ?? []).isEmpty,
        organizerIsCurrentUser: organizer?.isCurrentUser,
        organizerName: organizer.flatMap(participantName),
        recurring: e.hasRecurrenceRules || e.isDetached
    )
}

private func occurrenceLabel(_ e: EKEvent) -> String {
    let f = DateFormatter()
    f.dateStyle = .full
    f.timeStyle = e.isAllDay ? .none : .short
    return "\(f.string(from: e.startDate)) · \(e.calendar.title) (\(e.calendar.source?.title ?? "Local"))"
}

/// Returns only when the write may go ahead; the default path (no flag) never shows anything.
private func requireWriteApproval(_ e: EKEvent, _ action: WriteAction, humanConfirm: Bool, caller: pid_t, startedAt: Date) {
    let facts = writeFacts(e)
    if facts.writableWithoutHuman { return }
    guard humanConfirm else {
        fail(approvalRequiredMessage(action, facts), code: "human-approval-required")
    }
    confirmWithPerson(action, facts, when: occurrenceLabel(e), caller: caller, startedAt: startedAt)
}

private enum ConfirmEnd { case confirmed, cancelled, timedOut, callerGone }

/// Set by the watch timer and read after the modal loop, both on the main thread.
private final class ConfirmWatch: @unchecked Sendable {
    var end: ConfirmEnd?
}

private func confirmWithPerson(_ action: WriteAction, _ facts: WriteFacts, when: String, caller: pid_t, startedAt: Date) {
    let subject = "\(action.verb.lowercased()) \"\(facts.title)\""
    let hide = "Use Hide event instead to remove it from Walnut without changing the calendar."
    // No unlocked screen (an ssh-started server, a locked Mac): nobody could answer, so refuse now.
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          session[kCGSessionOnConsoleKey] as? Bool == true,
          session["CGSSessionScreenIsLocked"] as? Bool != true else {
        fail("No one can confirm \(subject) on this Mac's screen right now; nothing was changed. \(hide)", code: "human-approval-required")
    }
    let deadline = startedAt.addingTimeInterval(humanConfirmBudget)
    guard deadline.timeIntervalSinceNow >= 10 else {
        fail("No time was left to confirm \(subject); nothing was changed. \(hide)", code: "human-approval-required")
    }
    let end = MainActor.assumeIsolated {
        runConfirmAlert(
            title: confirmAlertTitle(action, facts),
            text: confirmAlertText(action, facts, when: when),
            confirmButton: action.confirmButton,
            caller: caller,
            deadline: deadline
        )
    }
    switch end {
    case .confirmed:
        return
    case .cancelled:
        fail("\(action.verb) \"\(facts.title)\" was cancelled on this Mac; nothing was changed. \(hide)", code: "approval-canceled")
    case .timedOut, .callerGone:
        fail("No answer to \(subject) in time; nothing was changed. \(hide)", code: "human-approval-required")
    }
}

/// Cancel is first (default, Return); the go-ahead has no key equivalent, so only a click passes.
@MainActor
private func runConfirmAlert(title: String, text: String, confirmButton: String, caller: pid_t, deadline: Date) -> ConfirmEnd {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = title
    alert.informativeText = text
    let cancel = alert.addButton(withTitle: "Cancel")
    cancel.keyEquivalent = "\r"
    let goAhead = alert.addButton(withTitle: confirmButton)
    goAhead.keyEquivalent = ""
    if #available(macOS 11.0, *) { goAhead.hasDestructiveAction = true }
    // Asked from a background process while the person looks at Walnut: come to the front.
    app.activate(ignoringOtherApps: true)

    let watch = ConfirmWatch()
    // runModal has no timeout; this ends it at the deadline or once the caller (parent) is gone.
    let timer = Timer(timeInterval: 0.25, repeats: true) { t in
        let end: ConfirmEnd? = getppid() != caller ? .callerGone : (Date() >= deadline ? .timedOut : nil)
        guard let end = end else { return }
        watch.end = end
        t.invalidate()
        // stopModal from a timer waits for the next event; abortModal ends the loop now.
        MainActor.assumeIsolated { NSApplication.shared.abortModal() }
    }
    RunLoop.main.add(timer, forMode: .modalPanel)
    let response = alert.runModal()
    timer.invalidate()
    if let end = watch.end { return end }
    guard response == .alertSecondButtonReturn else { return .cancelled }
    // A click between two timer ticks must not land after the deadline or a caller that gave up.
    if getppid() != caller { return .callerGone }
    if Date() >= deadline { return .timedOut }
    return .confirmed
}

private func output(_ obj: Any) {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    FileHandle.standardOutput.write(data)
}

// ── main ────────────────────────────────────────────────────────────────────

/// One request, then exit. `args` is argv-shaped: args[0] is the program, args[1]
/// the subcommand. Walnut.app passes its own argv with `--calendar-bridge` removed.
func walnutCalendarMain(_ args: [String]) -> Never {
guard args.count >= 2 else { fail("usage: walnut-calendar <capabilities|status|calendars|list|get|update|create|delete> …", code: "usage") }
// Before the re-exec and requestAccess(): the server probes any binary with it, never prompting.
if args[1] == "capabilities" {
    output(["writeSafetyVersion": writeSafetyVersion])
    exit(0)
}
reexecDisclaimedIfNeeded()
// The process the server's timeout kills: a dialog outliving it must not write.
let caller = getppid()
let startedAt = Date()
// `status` must run BEFORE requestAccess(): it exists precisely to observe
// the auth state without mutating it (no prompt, no denial recorded).
if args[1] == "status" { printAuthStatus() }
// And a subcommand we do not know is refused BEFORE requestAccess() too: asking
// for Calendars and then answering "usage" put a real permission dialog on the
// user's screen for a typo (2026-09-26, a verification run of this very file).
guard ["calendars", "list", "get", "update", "create", "delete"].contains(args[1]) else {
    fail("unknown subcommand: \(args[1])", code: "usage")
}
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

case "get":
    guard args.count == 3 else { fail("usage: get <eventId>", code: "usage") }
    output(eventJson(findOccurrence(args[2])))

case "update":
    guard let parsed = splitHumanConfirm(Array(args.dropFirst(2)), required: 3, optional: 1),
          let start = parseLocal(parsed.positional[1]), let end = parseLocal(parsed.positional[2]) else {
        fail("usage: update <eventId> <startISO> <endISO> [title] [--human-confirm]", code: "usage")
    }
    let pos = parsed.positional
    let event = findOccurrence(pos[0])
    if !event.calendar.allowsContentModifications { fail("calendar is read-only", code: "readonly") }
    requireWriteApproval(event, .update, humanConfirm: parsed.humanConfirm, caller: caller, startedAt: startedAt)
    let allDay = !pos[1].contains("T")
    event.startDate = start
    // All-day "end" arrives as an inclusive day → extend to end-of-day so
    // EventKit doesn't get a zero-length event.
    event.endDate = allDay && !pos[2].contains("T") && end <= start ? end.addingTimeInterval(24 * 3600 - 1) : end
    event.isAllDay = allDay
    if pos.count >= 4 && !pos[3].isEmpty { event.title = pos[3] }
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
    // The stamp that lets a later update/delete pass without a person.
    event.url = newWalnutBlockURL()
    do {
        try store.save(event, span: .thisEvent, commit: true)
        output(eventJson(event))
    } catch { fail("save failed: \(error.localizedDescription)", code: "save-failed") }

case "delete":
    guard let parsed = splitHumanConfirm(Array(args.dropFirst(2)), required: 1, optional: 0) else {
        fail("usage: delete <eventId> [--human-confirm]", code: "usage")
    }
    let event = findOccurrence(parsed.positional[0])
    // Before the gate: never ask a person to confirm a delete that cannot happen.
    if !event.calendar.allowsContentModifications { fail("calendar is read-only", code: "readonly") }
    requireWriteApproval(event, .delete, humanConfirm: parsed.humanConfirm, caller: caller, startedAt: startedAt)
    do {
        try store.remove(event, span: .thisEvent, commit: true)
        output(["ok": true])
    } catch { fail("delete failed: \(error.localizedDescription)", code: "save-failed") }

default:
    fail("unknown subcommand: \(args[1])", code: "usage")
}
exit(0)
}

// The helper's entry point. `@main` rather than a bare call because Swift rejects a
// top-level expression in a non-main file even inside an INACTIVE #if, and in the
// app build this file is not main.swift. Needs -parse-as-library when compiled on
// its own (HelperSpec.parseAsLibrary in src/core/calendar/sources/eventkit.ts).
#if !WALNUT_APP
@main
struct WalnutCalendarHelper {
    static func main() { walnutCalendarMain(CommandLine.arguments) }
}
#endif
