import Foundation

/// The Routines screen's shape, the same as the console's
/// (web/src/components/routines/routine-groups.ts; 2026-11-04, the user: "routine
/// page should be seperate by global routine and each project routine ... default
/// first page show min info").
///
/// One group for the global routines (no task, or a task in the Inbox) first, then
/// one per project, named by it, in name order. A routine's project is its task's
/// (`owner`, from the server). Inside a group the failing ones come first, then the
/// rest by name, so flipping a switch never moves its row.
enum RoutineHealth: String {
    case ok, running, error, off
}

struct RoutineGroup: Identifiable, Equatable {
    /// "global", or "project:<name>": the key the folded set stores.
    let id: String
    let name: String
    let isGlobal: Bool
    let routines: [RoutineJob]
    var failing: Int { routines.filter { RoutineGroups.health($0) == .error }.count }
}

enum RoutineGroups {
    static let globalKey = "global"
    /// A trigger the server stops after this many failed checks in a row (src/core/cron/trigger-run-state.ts).
    static let stopAfterErrors = 5

    static func isStopped(_ job: RoutineJob) -> Bool {
        guard job.check != nil, !job.enabled, job.state?.pausedAtMs == nil else { return false }
        return (job.state?.consecutiveErrors ?? 0) >= stopAfterErrors
    }

    static func health(_ job: RoutineJob) -> RoutineHealth {
        if isStopped(job) { return .error }
        if !job.enabled { return .off }
        if job.state?.runningAtMs != nil { return .running }
        // A run that failed into a complete task the routine has since left is not failing
        // now: its next run goes to the task picked (2026-11-04 QA: the row stayed red and
        // the header kept "1 failing" after Edit's Task fixed it; the console does the same).
        let runFailed = job.state?.lastStatus == "error" && !failedInATaskItLeft(job.state?.lastError, job)
        let checkFailed = job.state?.lastCheck?.outcome == "error" && !failedInATaskItLeft(job.state?.lastCheck?.error, job)
        return runFailed || checkFailed ? .error : .ok
    }

    /// "target task X is complete…" for an X that is no longer the routine's task.
    static func failedInATaskItLeft(_ error: String?, _ job: RoutineJob) -> Bool {
        guard let error, let done = error.firstMatch(of: /(?i)target task (\S+) is complete/),
              let current = currentTask(job) else { return false }
        return String(done.1) != current
    }

    /// The word behind the dot, for VoiceOver and the failing row's flag.
    static func healthLabel(_ job: RoutineJob) -> String {
        switch health(job) {
        case .error:
            if isStopped(job) { return "Stopped" }
            return job.check != nil && job.state?.lastCheck?.outcome == "error" ? "Last check failed" : "Last run failed"
        case .running: return "Running"
        case .off: return offLabel(job)
        case .ok: return "On"
        }
    }

    static func offLabel(_ job: RoutineJob) -> String {
        if job.check != nil { return isStopped(job) ? "Stopped" : "Paused" }
        return job.state?.pausedAtMs != nil ? "Paused" : "Off"
    }

    static func groupKey(_ job: RoutineJob) -> String {
        let project = job.owner?.project ?? ""
        return project.isEmpty ? globalKey : "project:\(project)"
    }

    static func groups(_ jobs: [RoutineJob]) -> [RoutineGroup] {
        var order: [String] = []
        var members: [String: [RoutineJob]] = [:]
        for job in jobs {
            let key = groupKey(job)
            if members[key] == nil { order.append(key) }
            members[key, default: []].append(job)
        }
        let byName: (RoutineJob, RoutineJob) -> Bool = {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        let built = order.map { key -> RoutineGroup in
            let all = members[key] ?? []
            let failing = all.filter { health($0) == .error }.sorted(by: byName)
            let rest = all.filter { health($0) != .error }.sorted(by: byName)
            let isGlobal = key == globalKey
            return RoutineGroup(
                id: key,
                name: isGlobal ? "Global" : (all.first?.owner?.project ?? ""),
                isGlobal: isGlobal,
                routines: failing + rest
            )
        }
        return built.sorted { a, b in
            if a.isGlobal != b.isGlobal { return a.isGlobal }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    /// The groups with each one's rows in the order they were last shown, newcomers
    /// after them. Held for the whole visit of the screen (2026-11-04, QA: pausing a
    /// failing routine moved it): the first load sorts failing first, then a switch,
    /// a run, a rename or a refresh never moves a row (the console's keepShownOrder).
    static func keepingOrder(_ groups: [RoutineGroup], shown: [String: [String]]) -> [RoutineGroup] {
        groups.map { group in
            guard let before = shown[group.id] else { return group }
            let at = Dictionary(before.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
            let kept = group.routines.filter { at[$0.id] != nil }.sorted { at[$0.id]! < at[$1.id]! }
            // A newcomer that is failing leads, as on a first load; the rest follow the kept rows.
            let added = group.routines.filter { at[$0.id] == nil }
            let failing = added.filter { health($0) == .error }
            let calm = added.filter { health($0) != .error }
            return RoutineGroup(id: group.id, name: group.name, isGlobal: group.isGlobal, routines: failing + kept + calm)
        }
    }

    /// The order the groups show their rows in, by group: what keepingOrder holds.
    static func shownOrder(_ groups: [RoutineGroup]) -> [String: [String]] {
        Dictionary(groups.map { ($0.id, $0.routines.map(\.id)) }, uniquingKeysWith: { a, _ in a })
    }

    // MARK: - The row's one line

    /// What a cron that cannot be said in words says: the closed row never shows the
    /// raw expression (the opened row's When does, `raw: true`, as "Custom: <expr>").
    static let customSchedule = "Custom schedule"

    /// "Every 5 min", "Weekdays at 9:00 AM", "Once at Nov 8, 9:00 AM": how often. A cron
    /// with no words is "Custom schedule", or with `raw` "Custom: <its expression>".
    static func cadence(_ schedule: RoutineJob.Schedule, raw: Bool = false, brief: Bool = false,
                        calendar: Calendar = .current) -> String {
        switch schedule.kind {
        case "every":
            guard let everyMs = schedule.everyMs, everyMs > 0 else { return "Repeats" }
            if everyMs < 60_000 { return "Every \(Int((everyMs / 1000).rounded()))s" }
            let minutes = Int((everyMs / 60_000).rounded())
            if minutes < 60 { return "Every \(minutes) min" }
            if minutes % 60 == 0 {
                let hours = minutes / 60
                return hours == 1 ? "Every hour" : "Every \(hours) hours"
            }
            return "Every \(minutes) min"
        case "at":
            guard let at = schedule.at, let date = WalnutTask.parseISO(at) else { return "Once" }
            return "Once at \(date.formatted(date: .abbreviated, time: .shortened))"
        case "cron":
            guard let expr = schedule.expr else { return "On a schedule" }
            let full = describeCron(expr, calendar: calendar)
            // The closed row's line is one line: a long description gives way to its short form.
            let short = brief && (full?.count ?? 0) > briefLimit ? briefCron(expr, calendar: calendar) : nil
            let said = short ?? full ?? (raw ? "Custom: \(expr)" : customSchedule)
            // The hours are the schedule's own zone's: name it when it is not the phone's.
            guard let tz = schedule.tz, !tz.isEmpty, tz != calendar.timeZone.identifier else { return said }
            return "\(said) \(TimeZone(identifier: tz)?.abbreviation() ?? tz)"
        default:
            return schedule.kind
        }
    }

    static let dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    /// "9:00 AM" in the calendar's zone, the phone's locale (the row and its tests read
    /// the same clock; a bare test calendar has the root locale, which says "M11").
    static func timeText(_ date: Date, calendar: Calendar = .current) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = calendar.timeZone
        return date.formatted(style)
    }

    /// "Nov 12" in the calendar's zone, the phone's locale.
    static func dayText(_ date: Date, calendar: Calendar = .current) -> String {
        var style = Date.FormatStyle.dateTime.month(.abbreviated).day()
        style.timeZone = calendar.timeZone
        return date.formatted(style)
    }

    /// A cron in words; nil only for what words cannot say (a malformed field, "L",
    /// "#", "W", a stepped list). The common shapes first, in the console's words ("Weekdays
    /// at 9:00 AM", "Monthly on the 1st at 9:00 AM", "Every 15 min, 9 AM to 5 PM,
    /// weekdays"); any other five fields field by field ("At 9:00 AM on days 1 to 7 of the
    /// month and on Mondays", 2026-11-04 QA: the opened row showed "0 9 1-7 * 1").
    static func describeCron(_ expr: String, calendar: Calendar = .current) -> String? {
        guard let parts = cronFields(expr) else { return nil }
        return describeCommonCron(parts, calendar: calendar) ?? CronWords(calendar: calendar).describe(parts)
    }

    /// The five fields, with the macros spelled out ("@daily") and day and month names as
    /// numbers ("MON", "JAN"); nil when it is not five fields.
    static func cronFields(_ expr: String) -> [String]? {
        let trimmed = expr.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let macros = ["@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
                      "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *"]
        let spelled = macros[trimmed] ?? trimmed
        var parts = spelled.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        guard parts.count == 5 else { return nil }
        let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        let days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        func numbered(_ field: String, _ names: [String], from first: Int) -> String {
            var out = field
            for (i, name) in names.enumerated() { out = out.replacingOccurrences(of: name, with: "\(i + first)") }
            return out
        }
        parts[3] = numbered(parts[3], months, from: 1)
        parts[4] = numbered(parts[4], days, from: 0)
        // "?" stays as written: the server's cron counts only a bare "*" as unrestricted,
        // so "0 9 ? * mon-fri" runs every day, not on weekdays (it reads "Custom schedule").
        return parts
    }

    /// The shapes people write most, in the console's own words; nil for the rest.
    private static func describeCommonCron(_ parts: [String], calendar: Calendar) -> String? {
        guard parts.count == 5, parts[3] == "*" else { return nil }
        let minuteField = parts[0], hourField = parts[1], dom = parts[2], dow = parts[4]
        if let minute = Int(minuteField), (0...59).contains(minute), let hour = Int(hourField), (0...23).contains(hour),
           let at = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) {
            let time = timeText(at, calendar: calendar)
            if dom != "*" {
                guard dow == "*" else { return nil }
                // "30 20 */2 * *": every other day (the server counts from the 1st).
                if let n = step(dom), n >= 2, n <= 31 { return "Every \(n) days at \(time)" }
                // "0 9 1 * *": one day of the month.
                guard let day = Int(dom), (1...31).contains(day) else { return nil }
                return "Monthly on the \(ordinal(day)) at \(time)"
            }
            if dow == "*" { return "Every day at \(time)" }
            guard let days = dayWords(dow) else { return nil }
            switch days {
            case "weekdays", "weekends": return "\(days.prefix(1).uppercased())\(days.dropFirst()) at \(time)"
            default: return "\(days) at \(time)"
            }
        }
        // Through the day, in the console's words (routine-format.ts describeSteppedCron):
        // "Every 15 min from 9:00 AM to 5:45 PM, weekdays", "Hourly at :15 from 9:15 AM to
        // 5:15 PM", "Every 2 hours at :00 on Mondays". A range ends at its last run.
        guard dom == "*" else { return nil }
        let dayPart: String
        if dow == "*" { dayPart = "" } else if let days = dayWords(dow) {
            dayPart = days == "weekdays" || days == "weekends" ? ", \(days)" : " on \(days)"
        } else { return nil }
        func clock(_ h: Int, _ m: Int) -> String? {
            calendar.date(bySettingHour: h, minute: m, second: 0, of: Date()).map { timeText($0, calendar: calendar) }
        }
        let hours = range(hourField, 0...23)
        guard hourField == "*" || hours != nil || step(hourField) != nil else { return nil }
        if let minute = Int(minuteField), (0...59).contains(minute) {
            if let n = step(hourField) {
                // Only a step that divides the day is an interval ("*/13" runs 0:00 and 13:00).
                guard (2...12).contains(n), 24 % n == 0 else { return nil }
                return String(format: "Every %d hours at :%02d", n, minute) + dayPart
            }
            guard let hours else { return String(format: "Hourly at :%02d", minute) + dayPart }
            guard let from = clock(hours.lowerBound, minute), let to = clock(hours.upperBound, minute) else { return nil }
            return String(format: "Hourly at :%02d", minute) + " from \(from) to \(to)" + dayPart
        }
        guard step(hourField) == nil else { return nil }
        let n: Int
        // Only a step that divides the hour is an interval ("*/45" runs :00 and :45).
        if minuteField == "*" { n = 1 } else if let s = step(minuteField), (2...30).contains(s), 60 % s == 0 { n = s } else { return nil }
        let lead = n == 1 ? "Every minute" : "Every \(n) min"
        guard let hours else { return lead + dayPart }
        guard let from = clock(hours.lowerBound, 0), let to = clock(hours.upperBound, (59 / n) * n) else { return nil }
        return lead + " from \(from) to \(to)" + dayPart
    }

    /// Longer than this, the closed row says a cron in its short form.
    static let briefLimit = 30

    /// A cron as the closed row says it, on one line: the days first, then the time or
    /// how often ("Weekdays, every 15 min", "Mondays and days 1 to 7, 9:00 AM", "Hourly
    /// at :15, 9 AM to 5 PM"). The opened row's When says it in full. Nil when there is no
    /// short form (a month field, a stepped day of the month).
    static func briefCron(_ expr: String, calendar: Calendar = .current) -> String? {
        guard let parts = cronFields(expr), parts[3] == "*" else { return nil }
        let minuteField = parts[0], hourField = parts[1], dom = parts[2], dow = parts[4]
        func capital(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }
        var days: [String] = []
        if dow != "*" {
            guard let words = dayWords(dow) else { return nil }
            days.append(capital(words))
        }
        if dom != "*" {
            guard let words = monthDayWords(dom) else { return nil }
            days.append(days.isEmpty ? capital(words) : words)
        }
        // Both day fields set: either one matches, as the server counts them.
        let dayPart = days.joined(separator: " and ")
        if let minute = Int(minuteField), (0...59).contains(minute), let hour = Int(hourField), (0...23).contains(hour) {
            guard !dayPart.isEmpty, let at = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) else { return nil }
            return "\(dayPart), \(timeText(at, calendar: calendar))"
        }
        let hours = range(hourField, 0...23)
        let lead: String
        if let minute = Int(minuteField), (0...59).contains(minute) {
            if let n = step(hourField) {
                guard (2...12).contains(n), 24 % n == 0 else { return nil }
                lead = "every \(n) hours"
            } else {
                guard hourField == "*" || hours != nil else { return nil }
                lead = String(format: "hourly at :%02d", minute)
            }
        } else {
            guard hourField == "*" || hours != nil else { return nil }
            if minuteField == "*" { lead = "every minute" } else if let n = step(minuteField), (2...30).contains(n), 60 % n == 0 {
                lead = "every \(n) min"
            } else { return nil }
        }
        if !dayPart.isEmpty { return "\(dayPart), \(lead)" }
        guard let hours else { return nil }
        return "\(capital(lead)), \(hourText(hours.lowerBound, calendar: calendar)) to \(hourText(hours.upperBound, calendar: calendar))"
    }

    /// The days of a cron's day-of-month field, short: "day 15", "days 1 to 7",
    /// "days 1 and 15", "days 1, 10, 20"; nil for a step or another shape.
    private static func monthDayWords(_ dom: String) -> String? {
        if let day = Int(dom), (1...31).contains(day) { return "day \(day)" }
        if let r = range(dom, 1...31) { return "days \(r.lowerBound) to \(r.upperBound)" }
        let fields = dom.split(separator: ",")
        let list = fields.compactMap { Int($0) }.filter { (1...31).contains($0) }
        guard list.count >= 2, list.count == fields.count else { return nil }
        if list.count == 2 { return "days \(list[0]) and \(list[1])" }
        return "days " + list.map(String.init).joined(separator: ", ")
    }

    /// "*/15" → 15.
    private static func step(_ field: String) -> Int? {
        guard field.hasPrefix("*/") else { return nil }
        return Int(field.dropFirst(2))
    }

    /// "9-17" → 9...17, inside `bounds`.
    private static func range(_ field: String, _ bounds: ClosedRange<Int>) -> ClosedRange<Int>? {
        let ends = field.split(separator: "-").compactMap { Int($0) }
        guard ends.count == 2, field.split(separator: "-").count == 2, ends[0] < ends[1],
              bounds.contains(ends[0]), bounds.contains(ends[1]) else { return nil }
        return ends[0]...ends[1]
    }

    /// The days of a cron's weekday field: "weekdays", "weekends", "Mondays", "Mon/Wed",
    /// "Mon to Thu"; nil for another shape.
    private static func dayWords(_ dow: String) -> String? {
        switch dow {
        case "1-5": return "weekdays"
        case "0,6", "6,0": return "weekends"
        default: break
        }
        if let r = range(dow, 0...6) { return "\(dayNames[r.lowerBound].prefix(3)) to \(dayNames[r.upperBound].prefix(3))" }
        let fields = dow.split(separator: ",")
        let days = fields.compactMap { Int($0) }.filter { (0...6).contains($0) }
        guard !days.isEmpty, days.count == fields.count else { return nil }
        if days.count == 1 { return "\(dayNames[days[0]])s" }
        return days.map { String(dayNames[$0].prefix(3)) }.joined(separator: "/")
    }

    /// "9 AM" in the calendar's zone, the phone's locale.
    static func hourText(_ hour: Int, calendar: Calendar = .current) -> String {
        guard let at = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: Date()) else { return "\(hour)" }
        var style = Date.FormatStyle.dateTime.hour()
        style.timeZone = calendar.timeZone
        return at.formatted(style)
    }

    /// "1st", "2nd", "3rd", "11th", "22nd".
    static func ordinal(_ n: Int) -> String {
        let tens = n % 100
        if (11...13).contains(tens) { return "\(n)th" }
        switch n % 10 {
        case 1: return "\(n)st"
        case 2: return "\(n)nd"
        case 3: return "\(n)rd"
        default: return "\(n)th"
        }
    }

    /// The cadence says the hour it runs at ("Weekdays at 9:00 AM"), in the phone's
    /// own zone: then the next run only needs its day. "Every 5 min", "Hourly at :15",
    /// a raw expression and a foreign zone's hour do not.
    static func namesItsHour(_ schedule: RoutineJob.Schedule, calendar: Calendar = .current) -> Bool {
        guard schedule.kind == "cron", let expr = schedule.expr else { return false }
        if let tz = schedule.tz, !tz.isEmpty, tz != calendar.timeZone.identifier { return false }
        guard let parts = cronFields(expr) else { return false }
        return Int(parts[0]) != nil && Int(parts[1]) != nil && describeCron(expr, calendar: calendar) != nil
    }

    /// When it runs next, as short as the row allows (2026-11-04, the same rule as the
    /// console's row): minutes when it is under an hour; else, after a cadence that says
    /// its hour, only the day ("today", "tomorrow", "in 3 days", "on Nov 12"); else the
    /// day and the hour ("next at 12:09 PM", "tomorrow at 9:00 AM", "Mon at 8:00 AM").
    static func shortNext(_ next: Date?, now: Date, namesHour: Bool, calendar: Calendar = .current) -> String? {
        guard let next else { return nil }
        let inSeconds = next.timeIntervalSince(now)
        if inSeconds < 60 { return "next in <1 min" }
        if inSeconds < 3600 { return "next in \(Int((inSeconds / 60).rounded())) min" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: next)).day ?? 0
        let time = timeText(next, calendar: calendar)
        if days >= 7 { return "on \(dayText(next, calendar: calendar))" }
        if namesHour {
            if days <= 0 { return "today" }
            if days == 1 { return "tomorrow" }
            return "in \(days) days"
        }
        // Within half a day the clock time says it ("next at 1:07 AM"): "tomorrow at" for a
        // run an hour away read as far off (2026-11-04 review; the console's shortNextRun).
        if days <= 0 || inSeconds < 12 * 3600 { return "next at \(time)" }
        if days == 1 { return "tomorrow at \(time)" }
        return "\(dayNames[calendar.component(.weekday, from: next) - 1].prefix(3)) at \(time)"
    }

    /// "Next run today at 12:09 PM": the opened row's exact next run (the console's describeNextRun).
    static func nextRunLong(_ next: Date?, now: Date, calendar: Calendar = .current) -> String? {
        guard let next else { return nil }
        let time = timeText(next, calendar: calendar)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: next)).day ?? 0
        if days <= 0 {
            let inSeconds = next.timeIntervalSince(now)
            if inSeconds < 60 { return "Next run in <1 min" }
            if inSeconds < 3600 { return "Next run in \(Int((inSeconds / 60).rounded())) min" }
            return "Next run today at \(time)"
        }
        if days == 1 { return "Next run tomorrow at \(time)" }
        if days < 7 { return "Next run \(dayNames[calendar.component(.weekday, from: next) - 1]) at \(time)" }
        return "Next run \(dayText(next, calendar: calendar)) at \(time)"
    }

    /// "2h ago", "just now": short, against the shown clock (the console's describeAgo).
    static func ago(_ date: Date, now: Date) -> String {
        let s = max(0, now.timeIntervalSince(date))
        if s < 45 { return "just now" }
        if s < 3600 { return "\(max(1, Int((s / 60).rounded())))m ago" }
        if s < 86_400 { return "\(Int((s / 3600).rounded()))h ago" }
        return "\(Int((s / 86_400).rounded()))d ago"
    }

    /// How often, with "Checks" in front for a trigger: "Checks every 5 min".
    static func often(_ job: RoutineJob, brief: Bool = false, calendar: Calendar = .current) -> String {
        let base = cadence(job.schedule, brief: brief, calendar: calendar)
        return job.check != nil ? "Checks \(base.prefix(1).lowercased())\(base.dropFirst())" : base
    }

    /// The row's line under the name: how often it runs and when next, or why it is
    /// quiet. The cadence keeps its hour; "ago" and "after 5 failed checks" are the
    /// opened row's (the stopped row's red flag already says "Stopped").
    static func rowTiming(_ job: RoutineJob, now: Date, calendar: Calendar = .current) -> String {
        let parts = rowTimingParts(job, now: now, calendar: calendar)
        return parts.next.map { "\(parts.how) · \($0)" } ?? parts.how
    }

    /// The row's line in its two halves: how often (with "Paused · " in front while
    /// quiet), and when next. The row keeps the second half on one line ("next in" and
    /// "7 min" split at XXL, QA).
    /// `brief`: the cadence as the drawn row says it, on one line ("Weekdays, every 15
    /// min"); without it the full words, for VoiceOver.
    static func rowTimingParts(_ job: RoutineJob, now: Date, brief: Bool = false,
                               calendar: Calendar = .current) -> (how: String, next: String?) {
        let how = often(job, brief: brief, calendar: calendar)
        if !job.enabled {
            if isStopped(job) { return (how, nil) }
            return ("\(offLabel(job)) · \(how)", nil)
        }
        // A one-time routine's cadence is its moment: a next run would say it again.
        if job.schedule.kind == "at" { return (how, nil) }
        let namesHour = namesItsHour(job.schedule, calendar: calendar)
        return (how, shortNext(job.state?.nextRunDate, now: now, namesHour: namesHour, calendar: calendar))
    }

    /// The page's one-line count, as the console's toolbar says it: "64 routines" and,
    /// apart, "3 failing".
    static func summary(_ groups: [RoutineGroup]) -> (count: String, failing: String?) {
        let total = groups.reduce(0) { $0 + $1.routines.count }
        let failing = groups.reduce(0) { $0 + $1.failing }
        return ("\(total) \(total == 1 ? "routine" : "routines")", failing > 0 ? "\(failing) failing" : nil)
    }

    // MARK: - The opened row

    /// The "When" fact: the full cadence, and under it the exact next run while it is on.
    static func whenFact(_ job: RoutineJob, now: Date, calendar: Calendar = .current) -> String {
        let said = cadence(job.schedule, raw: true, calendar: calendar)
        guard job.enabled, job.schedule.kind != "at", let next = nextRunLong(job.state?.nextRunDate, now: now, calendar: calendar) else { return said }
        return "\(said)\n\(next)"
    }

    /// Why it is quiet, for the opened row: "Paused 40m ago", "Stopped after 5 failed
    /// checks", "Off". Nil while it is on.
    static func quietFact(_ job: RoutineJob, now: Date) -> String? {
        guard !job.enabled else { return nil }
        if isStopped(job) { return "Stopped after \(stopAfterErrors) failed checks" }
        if offLabel(job) == "Off" { return "Off" }
        guard let paused = job.state?.pausedAtMs else { return "Paused" }
        return "Paused \(ago(Date(timeIntervalSince1970: paused / 1000), now: now))"
    }

    /// The routine's error as a person reads it: its task by title, not by id, and
    /// for a task that is done, what to do about it. Once it has been pointed at
    /// another task (Edit's Task), the old failure says so instead of asking again.
    /// What the opened row's box says. `past` is an old failure the routine has since been
    /// fixed for (pointed at an open task): drawn as a quiet note, not in red, since the
    /// dot and the group no longer call it failing (2026-11-04 review: a red box under a
    /// green dot read as two answers).
    struct ErrorNote: Equatable {
        let message: String
        let nextStep: String?
        var past = false

        init(_ message: String, _ nextStep: String?, past: Bool = false) {
            self.message = message
            self.nextStep = nextStep
            self.past = past
        }
    }

    static func errorText(_ job: RoutineJob) -> ErrorNote? {
        let raw = job.state?.lastError?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if raw.isEmpty || boxSaysTheCheck(job) {
            // A trigger's failed check gets the same box.
            guard boxSaysTheCheck(job) else { return nil }
            let why = job.state?.lastCheck?.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if failedInATaskItLeft(why, job) { return retargeted(job) }
            // The way out: the check is what failed (QA: the box said it again with none).
            let fix = isStopped(job) ? "Fix the check command with Edit, then Resume." : "Fix the check command with Edit."
            return ErrorNote(why.isEmpty ? "The last check failed." : "The last check failed: \(plainExit(nameTask(in: why, job)))", fix)
        }
        let done = raw.firstMatch(of: /(?i)target task (\S+) is complete/)
        if failedInATaskItLeft(raw, job) { return retargeted(job) }
        if done != nil {
            // Plain words, as the console says it (the server's "will not resurrect it"
            // read like a stack trace).
            let title = job.owner?.title.flatMap { $0.isEmpty ? nil : $0 }
            return ErrorNote("\(title.map { "Its task \"\($0)\"" } ?? "Its task") is complete, so its last run went nowhere.",
                             "Point it at an open task with Edit, or turn it off.")
        }
        return ErrorNote(nameTask(in: raw, job), nil)
    }

    /// The old failure after Edit's Task pointed it elsewhere: said, not asked about again.
    private static func retargeted(_ job: RoutineJob) -> ErrorNote {
        let current = currentTask(job)
        let title = current != nil && job.owner?.taskId == current ? job.owner?.title.flatMap { $0.isEmpty ? nil : $0 } : nil
        let task = title.map { "\"\($0)\"" } ?? "the task you picked"
        // A stopped trigger stays stopped until Resume: "from its next run" promised a run.
        // A stopped one still needs a look (Resume): only a fixed one reads quiet.
        return ErrorNote("Its last run failed: the task it ran in then was complete.",
                         isStopped(job) ? "It runs in \(task) once you Resume it." : "It runs in \(task) from its next run.",
                         past: !isStopped(job))
    }

    /// Whether the red box is the check's own failure: then the Check fact says only
    /// "failed", never the reason twice (QA steps 10 and 16).
    /// Also when the run's error is one the retarget already answered and the check failed
    /// for its own reason: that failure is what keeps the dot red.
    static func boxSaysTheCheck(_ job: RoutineJob) -> Bool {
        guard job.check != nil, job.state?.lastCheck?.outcome == "error" else { return false }
        let lastError = job.state?.lastError?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return lastError.isEmpty
            || (failedInATaskItLeft(lastError, job) && !failedInATaskItLeft(job.state?.lastCheck?.error, job))
    }

    /// A long error's first line (a stack, a page of HTML): the rest goes behind "Show
    /// full error". `more` says there is a rest.
    static func errorHead(_ message: String, limit: Int = 160) -> (head: String, more: Bool) {
        let first = message.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? message
        let line = first.trimmingCharacters(in: .whitespaces)
        let head = line.count > limit ? "\(line.prefix(limit))…" : line
        return (head, head != message.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// A text with each web address given places to break that add no hyphen: after a
    /// "/" and before a "." or a "?", "&", "=" in it. A long address at the largest sizes
    /// broke as "mail.example.-com" (2026-11-05 review), which reads and copies wrong.
    static func urlBreaks(_ text: String) -> String {
        let zwsp: Character = "\u{200B}"
        return text.split(separator: " ", omittingEmptySubsequences: false).map { word -> String in
            guard word.contains("://") || (word.contains("/") && word.contains(".")) else { return String(word) }
            var out = ""
            var previous: Character?
            for ch in word {
                if ".?&=".contains(ch), let p = previous, p != "/", p != zwsp { out.append(zwsp) }
                out.append(ch)
                previous = ch
                if ch == "/" { out.append(zwsp); previous = zwsp }
            }
            // "https://" stays whole.
            return out.replacingOccurrences(of: "/\u{200B}/\u{200B}", with: "//\u{200B}")
        }.joined(separator: " ")
    }

    /// The task a routine runs in now: its executor's target, else its owner's.
    static func currentTask(_ job: RoutineJob) -> String? {
        job.executor?.target ?? job.owner.flatMap { $0.taskId.isEmpty ? nil : $0.taskId }
    }

    /// A server line with the routine's task named by its title instead of its id.
    static func nameTask(in text: String, _ job: RoutineJob) -> String {
        guard let owner = job.owner, let title = owner.title, !title.isEmpty, !owner.taskId.isEmpty else { return text }
        return text.replacingOccurrences(of: owner.taskId, with: "\"\(title)\"")
    }

    // MARK: - The opened row's facts, in the console's order and words

    struct Fact: Equatable, Identifiable {
        let label: String
        let value: String
        var id: String { label }
    }

    /// State (only while it is quiet), When, Runs, Task, then a trigger's Check and
    /// Activity, or another routine's Last run (the console's RoutineRow). Under a red
    /// box the last run or check only says when: the box says how it failed (the row's
    /// flag, the table and the box said "failed" three times, 2026-11-05 review).
    static func facts(_ job: RoutineJob, now: Date, calendar: Calendar = .current) -> [Fact] {
        var rows: [Fact] = []
        if let quiet = quietFact(job, now: now) { rows.append(Fact(label: "State", value: quiet)) }
        rows.append(Fact(label: "When", value: whenFact(job, now: now, calendar: calendar)))
        rows.append(Fact(label: "Runs", value: job.check != nil
                         ? "In its task's session, when its check finds something"
                         : job.executor?.type == "session" ? "In its task's session" : (job.executor?.label ?? "Walnut Agent")))
        if let owner = job.owner {
            rows.append(Fact(label: "Task", value: owner.title?.isEmpty == false ? owner.title! : owner.taskId))
        }
        if let check = job.check {
            var last = describeLastCheck(job.state?.lastCheck, now: now, short: boxSaysTheCheck(job))
            if boxSaysTheCheck(job), errorText(job) != nil, let at = job.state?.lastCheck?.atMs {
                last = ago(Date(timeIntervalSince1970: at / 1000), now: now)
            }
            if last.hasPrefix("Not ") { last = "n" + last.dropFirst() }
            rows.append(Fact(label: "Check", value: "\(describeCheck(check))\nLast check: \(last)"))
            let budget = check.maxFiresPerDay.flatMap { $0 > 0 ? " · at most \($0) a day" : nil } ?? ""
            rows.append(Fact(label: "Activity", value: describeFireTally(job.state, now: now) + budget))
        } else if let line = lastRunLine(job.state, now: now, whenOnly: errorText(job) != nil) {
            rows.append(Fact(label: "Last run", value: line))
        }
        return rows
    }

    /// "2h ago · ok in 14s": a plain routine's last run; nil when it never ran. With
    /// `whenOnly` (a box under it says how it went) only "2h ago".
    static func lastRunLine(_ state: RoutineJob.State?, now: Date, whenOnly: Bool = false) -> String? {
        guard let state, let last = state.lastRunDate else { return nil }
        if whenOnly { return ago(last, now: now) }
        let outcome = state.lastStatus == "error" ? "failed" : state.lastStatus == "skipped" ? "skipped" : "ok"
        let took = (state.lastDurationMs ?? 0) >= 1000 ? " in \(Int(((state.lastDurationMs ?? 0) / 1000).rounded()))s" : ""
        return "\(ago(last, now: now)) · \(outcome)\(took)"
    }

    /// How often a trigger woke its task, in plain words: "Woke its task once, 9 min ago",
    /// "Woke its task 3 times, last 2 hours ago", "Has not woken its task yet" (the
    /// console's describeFireTally said "3×, last 2h ago"). The server's count, else the
    /// daemon's counter, else the recorded rows; a fire still being delivered is neither
    /// counted nor the latest.
    static func describeFireTally(_ state: RoutineJob.State?, now: Date) -> String {
        let fires = state?.fireLog ?? []
        let landed = fires.filter { $0.delivery?.status != "retrying" }
        let count = state?.fireCount ?? state?.lastFireSeq ?? landed.count
        let retrying = fires.contains { $0.delivery?.status == "retrying" }
        if count <= 0 { return retrying ? "Not yet: a message to its task is still being sent" : "Has not woken its task yet" }
        let last = landed.compactMap(\.atMs).max().map { agoWords(Date(timeIntervalSince1970: $0 / 1000), now: now) }
        let times = count == 1 ? "once" : count == 2 ? "twice" : "\(count) times"
        let when = last.map { count == 1 ? ", \($0)" : ", last \($0)" } ?? ""
        return "Woke its task \(times)\(when)\(retrying ? "; one more message is still being sent" : "")"
    }

    /// "9 min ago", "2 hours ago", "3 days ago", "just now": `ago` in whole words.
    static func agoWords(_ date: Date, now: Date) -> String {
        let s = max(0, now.timeIntervalSince(date))
        if s < 45 { return "just now" }
        if s < 3600 { return "\(max(1, Int((s / 60).rounded()))) min ago" }
        if s < 86_400 {
            let h = Int((s / 3600).rounded())
            return h == 1 ? "1 hour ago" : "\(h) hours ago"
        }
        let d = Int((s / 86_400).rounded())
        return d == 1 ? "1 day ago" : "\(d) days ago"
    }

    /// How far to scroll so an opened row's details show (positive = down), given its
    /// line's top, where the details end, and the visible band (top already leaves room
    /// for the bar and the group's header): never so far the line goes above the band;
    /// a line already above it comes back down into view.
    static func revealShift(lineTop: CGFloat, end: CGFloat, top: CGFloat, bottom: CGFloat) -> CGFloat {
        if lineTop < top { return lineTop - top }
        guard end > bottom else { return 0 }
        return min(end - bottom, lineTop - top)
    }

    // MARK: - What a switch, a delete or a run answered, on its row

    /// "Could not pause it: <why>": a refused switch or delete, said on that row.
    static func actionFailure(_ verb: String, _ reason: String) -> String { "Could not \(verb): \(reason)" }

    /// The verb of a switch to `on` (the console's: pause, resume, turn on).
    static func switchVerb(_ job: RoutineJob, on: Bool) -> String {
        guard on else { return "pause it" }
        return offLabel(job) == "Off" ? "turn it on" : "resume it"
    }

    /// What the opened row says after Run now: "Started" until the routine shows how
    /// the run ended, then that; or why it did not run.
    struct RunNote: Equatable {
        /// The routine's run stamp when the run started; nil for one that did not.
        var before: String?
        var ok: Bool
        var text: String
    }

    /// What changes on a routine when it has run: its last run, or its check's.
    static func runStamp(_ job: RoutineJob) -> String {
        let run = job.state?.lastRunAtMs.map { String($0) } ?? ""
        let check = job.state?.lastCheck?.atMs.map { String($0) } ?? ""
        return "\(run)|\(check)"
    }

    static func started(_ job: RoutineJob) -> RunNote { RunNote(before: runStamp(job), ok: true, text: "Started") }

    static func didNotRun(_ reason: String, _ job: RoutineJob) -> RunNote {
        RunNote(before: nil, ok: false, text: "Did not run: \(nameTask(in: reason, job))")
    }

    /// How a run the server took ended, once the routine shows it; nil while its stamp
    /// has not moved. The run is answered before it delivers, so a delivery that failed
    /// (into a finished task, say) is only known from the routine (the console's settledRun).
    static func settledRun(before: String, _ job: RoutineJob) -> RunNote? {
        guard runStamp(job) != before else { return nil }
        let failed = job.check != nil ? job.state?.lastCheck?.outcome == "error" : job.state?.lastStatus == "error"
        if failed { return RunNote(before: nil, ok: false, text: "It ran and failed: the reason is above.") }
        return RunNote(before: nil, ok: true, text: job.check != nil ? "Checked just now" : "Ran just now")
    }

    /// The note to show for a routine as it is now: never a success beside a fresh failure.
    static func shownRun(_ note: RunNote?, _ job: RoutineJob) -> RunNote? {
        guard let note else { return nil }
        if let before = note.before, let settled = settledRun(before: before, job) { return settled }
        return note
    }

    /// The check as one line, said: "Runs sh check.sh on devbox" (the console's
    /// "$ sh check.sh @ devbox" was a bare prompt sign, 2026-11-05 review).
    static func describeCheck(_ check: RoutineJob.Check) -> String {
        let run = (check.run ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let short = run.count > 60 ? "\(run.prefix(60))…" : run
        let host = check.host.flatMap { $0.isEmpty || $0 == "__local__" || $0 == "local" ? nil : $0 }
        return "Runs \(short) \(host.map { "on \($0)" } ?? "on this computer")"
    }

    /// A trigger's "Last check" (most routines are triggers, and their last run says
    /// nothing): "2m ago · nothing new", "2m ago · fired, 2 items", "2m ago · failed: exit 1".
    static func describeLastCheck(_ last: RoutineJob.State.LastCheck?, now: Date, short: Bool = false) -> String {
        guard let last, let atMs = last.atMs else { return "Not checked yet" }
        let when = ago(Date(timeIntervalSince1970: atMs / 1000), now: now)
        switch last.outcome {
        case "fired":
            let n = last.items ?? 0
            let what = n > 0 ? "woke its task, \(n) item\(n == 1 ? "" : "s")" : "woke its task"
            if last.retryPending == true { return "\(when) · \(what), delivery retrying" }
            if last.error != nil { return "\(when) · \(what) but not delivered" }
            return "\(when) · \(what)"
        case "error":
            let msg = oneLine(last.error ?? "")
            guard !msg.isEmpty, !short else { return "\(when) · failed" }
            return "\(when) · failed: \(plainExit(msg.count > 80 ? "\(msg.prefix(80))…" : msg))"
        default:
            return "\(when) · \(last.reason == "rate-limited" ? "held: it woke its task as often as allowed today" : "nothing new")"
        }
    }

    /// "exit 2: the page timed out" said plainly: "exit code 2: the page timed out".
    static func plainExit(_ text: String) -> String {
        guard let m = text.firstMatch(of: /^exit (\d+)(.*)$/) else { return text }
        return "exit code \(m.1)\(m.2)"
    }

    private static func oneLine(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    // MARK: - History (state.checkLog / state.fireLog)

    /// The History fold's rows, newest first: the recent checks, each fire once (the
    /// console's auditHistory). checkLog is short and a replayed fire can append a
    /// second row for one fire, so a fire is shown from fireLog, which keeps its
    /// newest attempt; then by each row's own time, since a replayed backlog is
    /// written after checks that ran later.
    static func auditHistory(_ state: RoutineJob.State?) -> [RoutineJob.State.AuditEntry] {
        let checks = state?.checkLog ?? []
        let fires = state?.fireLog ?? []
        let rows = checks.isEmpty ? fires : checks
        func key(_ row: RoutineJob.State.AuditEntry) -> String {
            row.seq.map { "\(row.epoch ?? "")#\($0)" } ?? "at#\(row.atMs ?? -1)"
        }
        var seen = Set<String>()
        var out: [RoutineJob.State.AuditEntry] = []
        for row in rows {
            guard row.outcome == "fired" else { out.append(row); continue }
            let k = key(row)
            guard seen.insert(k).inserted else { continue }
            out.append(fires.first { key($0) == k } ?? row)
        }
        // A stable sort: rows with the same time keep their written order.
        return out.enumerated().sorted { a, b in
            let ta = a.element.atMs ?? -Double.infinity, tb = b.element.atMs ?? -Double.infinity
            return ta != tb ? ta > tb : a.offset < b.offset
        }.map(\.element)
    }

    /// "History (3 recorded checks)".
    static func historyTitle(_ job: RoutineJob, count: Int) -> String {
        let noun = job.check != nil ? (count == 1 ? "check" : "checks") : (count == 1 ? "run" : "runs")
        return "History (\(count) recorded \(noun))"
    }

    /// A history row's time: the clock today, the date in front on another day
    /// (a replayed fire can be days old, and "06:12" alone reads as this morning).
    static func auditClock(_ atMs: Double?, now: Date, calendar: Calendar = .current) -> String {
        guard let atMs else { return "--:--" }
        let at = Date(timeIntervalSince1970: atMs / 1000)
        let time = timeText(at, calendar: calendar)
        return calendar.isDate(at, inSameDayAs: now) ? time : "\(dayText(at, calendar: calendar)) \(time)"
    }

    /// One history row as a sentence (the console's describeAuditEntry): what the
    /// check decided and, for a fire, where the message went. A retrying delivery
    /// never reads as delivered.
    static func describeAuditEntry(_ entry: RoutineJob.State.AuditEntry) -> String {
        let verdict = auditVerdict(entry)
        return (entry.warnings?.isEmpty == false) ? "\(verdict) · output repaired" : verdict
    }

    private static func auditVerdict(_ entry: RoutineJob.State.AuditEntry) -> String {
        // In plain words (2026-11-05 review: "check error: exit 2", "fired, 1 new item").
        if entry.outcome == "error" {
            let msg = oneLine(entry.error ?? "")
            guard !msg.isEmpty else { return "The check failed" }
            let shown = msg.count > 90 ? "\(msg.prefix(90))…" : msg
            if let m = shown.firstMatch(of: /^exit (\d+):?\s*(.*)$/) {
                let rest = String(m.2)
                return "The check failed (exit code \(m.1))\(rest.isEmpty ? "" : ": \(rest)")"
            }
            return "The check failed: \(shown)"
        }
        if entry.outcome == "quiet" {
            if entry.reason == "rate-limited" { return "Held: it woke its task as often as allowed today; a later check will" }
            if entry.reason == "all-seen" { return "Quiet: nothing new (all items already seen)" }
            return "Quiet: the check found nothing"
        }
        let n = entry.items ?? 0
        let newItems = "\(n) new item\(n == 1 ? "" : "s")"
        let coalesced = entry.coalesced ?? 1
        let what = entry.manual == true ? "Run now"
            : coalesced > 1 ? "Woke its task \(coalesced == 2 ? "twice" : "\(coalesced) times"), \(newItems)"
            : n > 0 ? "Woke its task, \(newItems)" : "Woke its task"
        guard let d = entry.delivery else { return what }
        let tries = (entry.attempts ?? 1) > 1 ? " after \(entry.attempts ?? 1) tries" : ""
        if d.status == "retrying" { return "\(what) → delivery retrying\(tries)" }
        if d.status == "error" {
            let why = oneLine(d.error ?? entry.error ?? "unknown error")
            return "\(what) → not delivered\(tries): \(why.count > 80 ? "\(why.prefix(80))…" : why)"
        }
        // A stored summary can carry a trigger's envelope after a dash: cut both.
        var target = (oneLine(d.summary ?? "delivered").components(separatedBy: "<walnut-message").first ?? "")
            .trimmingCharacters(in: .whitespaces)
        if target.hasSuffix("—") || target.hasSuffix("-") { target = String(target.dropLast()).trimmingCharacters(in: .whitespaces) }
        let shown = target.isEmpty ? "delivered" : target.count > 56 ? "\(target.prefix(56))…" : target
        return "\(what) → \(shown)\(tries)"
    }

    /// Whether a history row went wrong (drawn in the danger colour).
    static func auditFailed(_ entry: RoutineJob.State.AuditEntry) -> Bool {
        entry.outcome == "error" || entry.delivery?.status == "error"
    }
}

/// Any five-field cron in words, field by field, for the shapes the common ones do not
/// cover (RoutineGroups.describeCron): the time ("At 9:00 AM", "Every 5 min, 9 AM to
/// 5 PM", "Hourly at :05 and :35"), then the days ("on the 1st and 15th", "on days 1 to
/// 7 of the month", "on Tue and Thu") and the months ("in March", "from March to June").
/// When both the day of the month and the day of the week are set, either one runs it
/// (standard cron), so they are joined with "and on". Nil only when a field cannot be read.
struct CronWords {
    let calendar: Calendar

    /// One comma-separated piece of a field: a value, a range, either with a step.
    struct Item: Equatable {
        var lo: Int
        var hi: Int
        var step = 1
        var isValue: Bool { lo == hi && step == 1 }
    }

    /// A field: every value ("*"), or its pieces.
    enum Field: Equatable {
        case any
        case items([Item])

        var values: [Int]? {
            guard case .items(let items) = self, items.allSatisfy(\.isValue) else { return nil }
            return items.map(\.lo)
        }
        var single: Int? { values.flatMap { $0.count == 1 ? $0[0] : nil } }
        var one: Item? {
            guard case .items(let items) = self, items.count == 1 else { return nil }
            return items[0]
        }
    }

    /// "1-5", "*/15", "9-17/2", "5/10", "1,15": the pieces inside `bounds`; nil when malformed.
    static func parse(_ text: String, _ bounds: ClosedRange<Int>) -> Field? {
        if text == "*" { return .any }
        var items: [Item] = []
        for piece in text.split(separator: ",", omittingEmptySubsequences: false).map(String.init) {
            let halves = piece.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard halves.count <= 2 else { return nil }
            var step = 1
            if halves.count == 2 {
                guard let n = Int(halves[1]), n >= 1 else { return nil }
                step = n
            }
            let base = halves[0]
            var item: Item
            if base == "*" {
                item = Item(lo: bounds.lowerBound, hi: bounds.upperBound, step: step)
            } else if base.contains("-") {
                let ends = base.split(separator: "-", omittingEmptySubsequences: false).compactMap { Int($0) }
                guard ends.count == 2, base.split(separator: "-", omittingEmptySubsequences: false).count == 2,
                      ends[0] <= ends[1] else { return nil }
                item = Item(lo: ends[0], hi: ends[1], step: step)
            } else {
                guard let v = Int(base) else { return nil }
                // "5/10": from 5 to the end, every 10.
                item = Item(lo: v, hi: halves.count == 2 ? bounds.upperBound : v, step: step)
            }
            guard bounds.contains(item.lo), bounds.contains(item.hi) else { return nil }
            items.append(item)
        }
        // "*/1" is every value.
        if items.count == 1, items[0].step == 1, items[0].lo == bounds.lowerBound, items[0].hi == bounds.upperBound { return .any }
        return items.isEmpty ? nil : .items(items)
    }

    /// "a", "a and b", "a, b and c".
    static func list(_ words: [String]) -> String {
        guard words.count > 1 else { return words.first ?? "" }
        return words.dropLast().joined(separator: ", ") + " and " + words[words.count - 1]
    }

    /// A step over the whole field that does not divide it is not an interval ("*/45" runs
    /// :00 and :45, then :00 again): its values instead, a few at most; nil past that.
    static func evened(_ field: Field, _ bounds: ClosedRange<Int>) -> Field? {
        guard case .items(let items) = field else { return field }
        let period = bounds.upperBound - bounds.lowerBound + 1
        var out: [Item] = []
        for item in items {
            if item.step > 1, item.lo == bounds.lowerBound, item.hi == bounds.upperBound, period % item.step != 0 {
                out += stride(from: item.lo, through: item.hi, by: item.step).map { Item(lo: $0, hi: $0) }
            } else {
                out.append(item)
            }
        }
        if out.count != items.count, out.count > 6 { return nil }
        return .items(out)
    }

    func describe(_ parts: [String]) -> String? {
        guard parts.count == 5,
              let parsedMinute = Self.parse(parts[0], 0...59), let parsedHour = Self.parse(parts[1], 0...23),
              let dom = Self.parse(parts[2], 1...31), let parsedMonth = Self.parse(parts[3], 1...12),
              let dow = Self.parse(parts[4], 0...7),
              let minute = Self.evened(parsedMinute, 0...59), let hour = Self.evened(parsedHour, 0...23),
              let month = Self.evened(parsedMonth, 1...12) else { return nil }
        // Both day fields written (anything but a bare "*"): either one runs it. One that
        // covers every day ("1-31", "?") then makes it every day, which the words below
        // would not say: the server's way, so it stays "Custom schedule".
        if parts[2] != "*", parts[4] != "*", dom == .any || dow == .any { return nil }
        guard let time = timeWords(minute, hour) else { return nil }
        var days: [String] = []
        if dom != .any {
            guard let words = domWords(dom) else { return nil }
            days.append(words)
        }
        if dow != .any {
            guard let words = dowWords(dow) else { return nil }
            days.append(words)
        }
        var out = time
        if !days.isEmpty { out += " " + days.joined(separator: " and ") }
        if month != .any {
            guard let words = monthWords(month) else { return nil }
            out += " " + words
        }
        return out
    }

    // MARK: - The time of day

    private func time(_ hour: Int, _ minute: Int) -> String {
        guard let at = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) else { return "\(hour):\(minute)" }
        return RoutineGroups.timeText(at, calendar: calendar)
    }

    private func hour(_ h: Int) -> String { RoutineGroups.hourText(h, calendar: calendar) }
    private func minute(_ m: Int) -> String { String(format: ":%02d", m) }

    /// "9 AM", "9 AM to 5 PM", "every 2nd hour from 9 AM to 5 PM", for the hours.
    private func hourTerm(_ item: Item) -> String {
        if item.isValue { return hour(item.lo) }
        if item.step == 1 { return "\(hour(item.lo)) to \(hour(item.hi))" }
        // From its first run to its last: a step starts over each day.
        let last = item.lo + ((item.hi - item.lo) / item.step) * item.step
        return "every \(RoutineGroups.ordinal(item.step)) hour" + (item.lo == 0 && item.hi == 23 ? "" : " from \(hour(item.lo)) to \(hour(last))")
    }

    /// ":00", ":10 to :20", "every 5th minute from :10".
    private func minuteTerm(_ item: Item) -> String {
        if item.isValue { return minute(item.lo) }
        if item.step == 1 { return "\(minute(item.lo)) to \(minute(item.hi))" }
        let last = item.lo + ((item.hi - item.lo) / item.step) * item.step
        return "every \(RoutineGroups.ordinal(item.step)) minute from \(minute(item.lo)) to \(minute(last))"
    }

    /// What follows a minute that is not one fixed time: "", ", 9 AM to 5 PM", ", in the
    /// 9 AM hour", ", in every 2nd hour".
    private func hourQualifier(_ field: Field) -> String {
        guard case .items(let items) = field else { return "" }
        if let only = field.one {
            if only.isValue { return ", in the \(hour(only.lo)) hour" }
            if only.step == 1 { return ", \(hour(only.lo)) to \(hour(only.hi))" }
            return ", in " + hourTerm(only)
        }
        if let values = field.values { return ", in the \(Self.list(values.map(hour))) hours" }
        return ", in the hours " + Self.list(items.map(hourTerm))
    }

    private func timeWords(_ minuteField: Field, _ hourField: Field) -> String? {
        // A few exact times: "At 9:00 AM", "At 9:00 AM and 5:00 PM", "At 9:00 AM and 9:30 AM".
        if let ms = minuteField.values, let hs = hourField.values, ms.count * hs.count <= 6 {
            let times = hs.sorted().flatMap { h in ms.sorted().map { m in time(h, m) } }
            return "At " + Self.list(times)
        }
        if let m = minuteField.single {
            let at = minute(m)
            switch hourField {
            case .any: return "Hourly at \(at)"
            case .items(let items):
                if let only = hourField.one, only.step > 1 {
                    // From its first run to its last ("9-17/2" runs last at 5 PM, "9-16/2" at 3 PM).
                    let last = only.lo + ((only.hi - only.lo) / only.step) * only.step
                    let span = only.lo == 0 && only.hi == 23 ? "" : " from \(time(only.lo, m)) to \(time(last, m))"
                    return "Every \(only.step) hours at \(at)\(span)"
                }
                if let only = hourField.one, only.step == 1 { return "Hourly at \(at) from \(time(only.lo, m)) to \(time(only.hi, m))" }
                return "At \(at) past " + Self.list(items.map(hourTerm))
            }
        }
        // Every minute or every n through a range of hours: from its first run to its last,
        // as the console says it ("Every 15 min from 9:00 AM to 5:45 PM").
        if let hours = hourField.one, hours.step == 1, !hours.isValue {
            let n: Int?
            switch minuteField {
            case .any: n = 1
            case .items: n = minuteField.one.flatMap { $0.lo == 0 && $0.hi == 59 ? $0.step : nil }
            }
            if let n {
                return (n == 1 ? "Every minute" : "Every \(n) min") + " from \(time(hours.lo, 0)) to \(time(hours.hi, (59 / n) * n))"
            }
        }
        let lead: String
        switch minuteField {
        case .any:
            lead = "Every minute"
        case .items(let items):
            if let only = minuteField.one, !only.isValue {
                let every = only.step == 1 ? "Every minute" : "Every \(only.step) min"
                let last = only.lo + ((only.hi - only.lo) / only.step) * only.step
                if only.lo == 0 && only.hi == 59 { lead = every }
                else { lead = "\(every) from \(minute(only.lo)) to \(minute(last))" }
            } else if let values = minuteField.values {
                lead = "Hourly at " + Self.list(values.sorted().map(minute))
            } else {
                lead = "At minutes " + Self.list(items.map(minuteTerm))
            }
        }
        return lead + hourQualifier(hourField)
    }

    // MARK: - The days and months

    /// "on the 1st", "on the 1st and 15th", "on days 1 to 7 of the month", "every 2 days".
    private func domWords(_ field: Field) -> String? {
        guard case .items(let items) = field else { return nil }
        if let values = field.values { return "on the " + Self.list(values.map(RoutineGroups.ordinal)) }
        if let only = field.one {
            if only.step == 1 { return "on days \(only.lo) to \(only.hi) of the month" }
            if only.lo == 1 && only.hi == 31 { return "every \(only.step) days" }
            return "every \(only.step) days from the \(RoutineGroups.ordinal(only.lo))" + (only.hi == 31 ? "" : " to the \(RoutineGroups.ordinal(only.hi))")
        }
        guard items.allSatisfy({ $0.step == 1 }) else { return nil }
        return "on days " + Self.list(items.map { $0.isValue ? "\($0.lo)" : "\($0.lo) to \($0.hi)" }) + " of the month"
    }

    /// "on Mondays", "on Tue and Thu", "on weekdays", "on Mon to Thu" (7 is Sunday too).
    private func dowWords(_ field: Field) -> String? {
        guard case .items(let items) = field, items.allSatisfy({ $0.step == 1 }) else { return nil }
        let short = { (d: Int) in String(RoutineGroups.dayNames[d % 7].prefix(3)) }
        if let values = field.values {
            let days = Array(Set(values.map { $0 % 7 })).sorted()
            if days == [0, 6] { return "on weekends" }
            if days.count == 1 { return "on \(RoutineGroups.dayNames[days[0]])s" }
            return "on " + Self.list(days.map(short))
        }
        if let only = field.one, only.lo == 1, only.hi == 5 { return "on weekdays" }
        if let only = field.one, only.lo == 0 || only.lo == 1, only.hi >= 6, only.hi - only.lo >= 6 { return "on every day" }
        return "on " + Self.list(items.map { $0.isValue ? short($0.lo) : "\(short($0.lo)) to \(short($0.hi))" })
    }

    /// English, like every other word on the screen (a bare calendar's root locale says "M03").
    static let monthNames = ["January", "February", "March", "April", "May", "June", "July",
                             "August", "September", "October", "November", "December"]

    /// "in March", "in January and July", "from March to June", "every 3 months".
    private func monthWords(_ field: Field) -> String? {
        guard case .items(let items) = field else { return nil }
        let name = { (m: Int) in Self.monthNames[m - 1] }
        if let values = field.values { return "in " + Self.list(values.map(name)) }
        if let only = field.one {
            if only.step == 1 { return "from \(name(only.lo)) to \(name(only.hi))" }
            if only.lo == 1 && only.hi == 12 { return "every \(only.step) months" }
            return "every \(only.step) months from \(name(only.lo))" + (only.hi == 12 ? "" : " to \(name(only.hi))")
        }
        guard items.allSatisfy({ $0.step == 1 }) else { return nil }
        return "in " + Self.list(items.map { $0.isValue ? name($0.lo) : "\(name($0.lo)) to \(name($0.hi))" })
    }
}
