import Foundation
import XCTest
@testable import Walnut

/// The App Store gate's clock probe: the demo seeded at the gate's 16 moments of
/// one week and at every hour of every weekday, every time it shows printed the
/// way the gate reads it, and the rules the gate checked asserted at each moment
/// (App Store gate, 2026-10-05):
///  - before 8:00 AM the latest items read minutes ago, not "11 hours ago";
///  - work (the crash review, the TestFlight build) is planned on weekdays, in
///    working hours, never on a weekend afternoon;
///  - on a Friday, what waits waits until Monday, not "until tomorrow";
///  - nothing past is after now, and nothing planned is behind the clock.
/// The probe text is printed (lines start with "CLOCKPROBE ") and attached to
/// the test result, so a run's output can be compared with the gate's.
final class DemoClockProbeTests: XCTestCase {
    /// The gate's 16 moments: weekday (1 = Sunday ... 7 = Saturday), hour, minute.
    static let moments: [(Int, Int, Int)] = [
        (1, 9, 10), (1, 16, 45), (1, 22, 30), (2, 3, 20), (2, 7, 50), (2, 8, 5),
        (4, 12, 0), (4, 16, 35), (4, 19, 30), (4, 20, 55), (4, 21, 10),
        (6, 15, 0), (6, 16, 20), (6, 23, 30), (7, 10, 0), (7, 18, 0),
    ]

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// A clock in a fixed week that starts on Sunday, October 4, 2026.
    private func clock(_ weekday: Int, _ hour: Int, _ minute: Int) -> DemoClock {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let day = calendar.date(from: DateComponents(year: 2026, month: 10, day: 3 + weekday, hour: hour, minute: minute))!
        return DemoClock(now: day, calendar: calendar)
    }

    private func stamp(_ date: Date?, _ c: DemoClock) -> String {
        guard let date else { return "-" }
        let f = DateFormatter()
        f.calendar = c.calendar
        f.timeZone = c.calendar.timeZone
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE HH:mm"
        return f.string(from: date)
    }

    private func date(_ iso: String?) -> Date? { iso.flatMap { Self.iso.date(from: $0) } }
    private func date(ms: Double?) -> Date? { ms.map { Date(timeIntervalSince1970: $0 / 1000) } }

    /// One moment, as the gate printed it.
    func probe(_ c: DemoClock) -> String {
        let state = DemoFixtures.seed(c)
        let plan = c.plan()
        var out: [String] = []
        out.append("=== NOW \(stamp(c.now, c)) plan.day=\(plan.day) call=\(stamp(plan.call, c)) review=\(stamp(plan.review, c)) asked=\(stamp(plan.askedAt, c))")
        for conversation in state.conversations {
            out.append("conv \(conversation.id) title=\(conversation.title ?? "-") updated=\(stamp(date(conversation.updatedAt), c))")
        }
        if let today = state.conversations.first(where: { $0.id == "c-today" }) {
            for message in today.messages {
                out.append("  [\(stamp(date(message.createdAt), c))] \(message.role): \(message.text)")
                if let thinking = message.thinkingText { out.append("    thinking: \(thinking)") }
            }
        }
        out.append("REPLY focus: " + DemoReplies.chat(for: "What should I focus on today?", clock: c).text)
        out.append("REPLY kitchen: " + DemoReplies.chat(for: "How are the kitchen quotes going?", clock: c).text)
        for letter in state.letters {
            out.append("letter \(letter.id) [\(stamp(date(ms: letter.createdAt), c))] \(letter.subject) | \(letter.textPreview ?? "")")
        }
        for task in state.tasks where ["t-crash", "t-notes", "t-testflight", "t-quotes", "t-plumber", "t-car", "t-meals", "t-train", "t-dentist"].contains(task.id) {
            out.append("task \(task.id) start=\(stamp(date(task.startDate), c)) due=\(task.dueDate ?? "-") updated=\(stamp(date(task.updatedAt), c)) summary=\(task.summary ?? "-")")
        }
        for note in state.notes {
            out.append("note \(note.path) updated=\(stamp(date(note.updatedAt), c))")
        }
        for session in state.sessions {
            out.append("session \(session.id) \(session.title) last=\(stamp(date(session.lastActiveAt), c))")
        }
        for job in state.routines {
            out.append("routine \(job.id) last=\(stamp(date(ms: job.state?.lastRunAtMs), c)) next=\(stamp(date(ms: job.state?.nextRunAtMs), c))")
        }
        for event in DemoCalendarProvider.events(c) {
            out.append("event \(event.title) \(stamp(event.start, c))")
        }
        let release = state.notes.first { $0.path == "Pebble/Release 2.4 plan.md" }?.content ?? ""
        out.append("release note: " + (release.components(separatedBy: "\n").first ?? ""))
        return out.joined(separator: "\n")
    }

    func testTheGatesSixteenMoments() throws {
        var all: [String] = []
        for (weekday, hour, minute) in Self.moments {
            let c = clock(weekday, hour, minute)
            all.append(probe(c))
            try checkRules(c, weekday: weekday, hour: hour)
        }
        let output = all.joined(separator: "\n")
        for line in output.components(separatedBy: "\n") { print("CLOCKPROBE " + line) }
        attach(output, "clock-probe.txt")
    }

    /// Every hour of every weekday (168 moments, on the hour, App Store
    /// release, 2026-10-06): the same rules at each, one summary line per moment
    /// printed ("CLOCKWEEK ") and attached, and the full probe of every moment
    /// attached beside it.
    func testEveryHourOfEveryWeekday() throws {
        var lines: [String] = []
        var full: [String] = []
        for weekday in 1...7 {
            for hour in 0..<24 {
                let c = clock(weekday, hour, 0)
                try checkRules(c, weekday: weekday, hour: hour)
                lines.append(summary(c))
                full.append(probe(c))
            }
        }
        XCTAssertEqual(lines.count, 168)
        for line in lines { print("CLOCKWEEK " + line) }
        attach(lines.joined(separator: "\n"), "clock-week.txt")
        attach(full.joined(separator: "\n"), "clock-week-full.txt")
    }

    /// The rules the gate checked, at one moment.
    private func checkRules(_ c: DemoClock, weekday: Int, hour: Int) throws {
        let at = stamp(c.now, c)
        let state = DemoFixtures.seed(c)
        let plan = c.plan()
        let cal = c.calendar

        // Work: the review and the TestFlight build on weekdays, in hours.
        let review = try XCTUnwrap(date(state.tasks.first { $0.id == "t-crash" }?.startDate))
        XCTAssertEqual(review, plan.review, at)
        XCTAssertTrue(c.isWorkday(c.dayOffset(of: review)), "\(at): review on \(stamp(review, c))")
        XCTAssertTrue((14...17).contains(cal.component(.hour, from: review)), "\(at): review at \(stamp(review, c))")
        let ship = try XCTUnwrap(date(state.tasks.first { $0.id == "t-testflight" }?.startDate))
        XCTAssertTrue(c.isWorkday(c.dayOffset(of: ship)), "\(at): TestFlight on \(stamp(ship, c))")
        XCTAssertEqual(c.dayOffset(of: ship), c.workday(after: c.dayOffset(of: review)),
                       "\(at): TestFlight goes out the first work day after the review")
        XCTAssertEqual(cal.component(.hour, from: ship), 11, "\(at): TestFlight at \(stamp(ship, c))")
        XCTAssertGreaterThan(ship, review, "\(at): the build waits on the review")
        XCTAssertGreaterThan(review, c.now, at)
        XCTAssertGreaterThanOrEqual(plan.call.timeIntervalSince(c.now), 30 * 60, at)
        XCTAssertNotEqual(cal.component(.weekday, from: plan.call), 1, "\(at): no call on a Sunday")
        XCTAssertTrue((10 * 60 + 30...17 * 60).contains(cal.component(.hour, from: plan.call) * 60 + cal.component(.minute, from: plan.call)),
                      "\(at): the call in office hours, \(stamp(plan.call, c))")

        // What waits: a work day, said as one.
        let reply = DemoReplies.chat(for: "What should I focus on today?", clock: c).text
        if weekday == 6 && plan.day == 0 { XCTAssertTrue(reply.contains("can wait until Monday."), "\(at): \(reply)") }
        if weekday == 7 && plan.day == 0 { XCTAssertTrue(reply.contains("can wait until Monday."), "\(at): \(reply)") }
        if plan.day == 0, c.isWorkday(1) { XCTAssertTrue(reply.contains("can wait until tomorrow."), at) }
        XCTAssertNotNil(reply.range(of: "can wait until "), "\(at): \(reply)")

        // Recent items read recent in waking hours: the chat's last message six
        // minutes ago and the release notes task three minutes ago stay put
        // whenever that moment is after 6:00 AM (always from 7:00 AM to 7:00 PM).
        // Written before 6:00 AM, at night or in the first minutes after it,
        // they are folded into the evening before like everything else.
        let chat = try XCTUnwrap(date(state.conversations.first { $0.id == "c-today" }?.updatedAt))
        let notes = try XCTUnwrap(date(state.tasks.first { $0.id == "t-notes" }?.updatedAt))
        XCTAssertEqual(chat.timeIntervalSince1970, c.waking(c.now.addingTimeInterval(-6 * 60)).timeIntervalSince1970,
                       accuracy: 1, "\(at): the chat reads \(stamp(chat, c))")
        XCTAssertEqual(notes.timeIntervalSince1970, c.waking(c.now.addingTimeInterval(-3 * 60)).timeIntervalSince1970,
                       accuracy: 1, at)
        if (7..<19).contains(hour) {
            XCTAssertEqual(c.now.timeIntervalSince(chat), 6 * 60, accuracy: 1, "\(at): the chat reads \(stamp(chat, c))")
            XCTAssertEqual(c.now.timeIntervalSince(notes), 3 * 60, accuracy: 1, at)
        }

        // Nothing past is after now, and nothing planned is behind the clock.
        for letter in state.letters {
            if let created = date(ms: letter.createdAt) { XCTAssertLessThanOrEqual(created, c.now, "\(at): \(letter.id)") }
        }
        for conversation in state.conversations {
            if let updated = date(conversation.updatedAt) { XCTAssertLessThanOrEqual(updated, c.now, "\(at): \(conversation.id)") }
            for message in conversation.messages {
                if let created = date(message.createdAt) {
                    XCTAssertLessThanOrEqual(created, c.now, "\(at): a message in \(conversation.id)")
                }
            }
        }
        for task in state.tasks {
            if let updated = date(task.updatedAt) { XCTAssertLessThanOrEqual(updated, c.now, "\(at): \(task.id) updated") }
        }
        for note in state.notes {
            if let updated = date(note.updatedAt) { XCTAssertLessThanOrEqual(updated, c.now, "\(at): \(note.path)") }
        }
        for session in state.sessions {
            if let last = date(session.lastActiveAt) { XCTAssertLessThanOrEqual(last, c.now, "\(at): \(session.id)") }
            for row in session.transcript {
                if let written = date(row.timestamp) { XCTAssertLessThanOrEqual(written, c.now, "\(at): a row in \(session.id)") }
            }
        }
        for job in state.routines {
            if let last = date(ms: job.state?.lastRunAtMs) { XCTAssertLessThanOrEqual(last, c.now, "\(at): \(job.id) last run") }
            if let next = date(ms: job.state?.nextRunAtMs) { XCTAssertGreaterThan(next, c.now, "\(at): \(job.id) next run") }
        }
    }

    /// One line per moment: the plan's title, the call, the review, the
    /// TestFlight build, what waits, and how long ago the chat was last written.
    private func summary(_ c: DemoClock) -> String {
        let state = DemoFixtures.seed(c)
        let plan = c.plan()
        let today = state.conversations.first { $0.id == "c-today" }
        let chat = date(today?.updatedAt)
        let ship = date(state.tasks.first { $0.id == "t-testflight" }?.startDate)
        let reply = DemoReplies.chat(for: "What should I focus on today?", clock: c).text
        let waits = reply.range(of: "can wait until [^.]+[.]", options: .regularExpression).map { String(reply[$0]) } ?? "-"
        let ago = chat.map { "\(Int((c.now.timeIntervalSince($0) / 60).rounded()))m ago" } ?? "-"
        return "\(stamp(c.now, c)) | \(today?.title ?? "-") | call \(stamp(plan.call, c)) | review \(stamp(plan.review, c))"
            + " | TestFlight \(stamp(ship, c)) | \(waits) | chat \(ago) (\(stamp(chat, c)))"
    }

    private func attach(_ text: String, _ name: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// The minute the gate saw lag: the calendar's now-line ticks on the
    /// minute, not a fixed 60 s after it appeared.
    func testTheNowLineTicksOnTheMinute() {
        let base = Date(timeIntervalSince1970: 1_791_216_000) // a whole minute
        XCTAssertEqual(CalendarLayout.secondsToNextMinute(after: base), 60.05, accuracy: 0.001)
        XCTAssertEqual(CalendarLayout.secondsToNextMinute(after: base.addingTimeInterval(59.5)), 0.55, accuracy: 0.001)
        XCTAssertEqual(CalendarLayout.secondsToNextMinute(after: base.addingTimeInterval(12.25)), 47.80, accuracy: 0.001)
        for offset in stride(from: 0.0, to: 120, by: 7.3) {
            let now = base.addingTimeInterval(offset)
            let tick = now.addingTimeInterval(CalendarLayout.secondsToNextMinute(after: now))
            let intoMinute = tick.timeIntervalSince1970.truncatingRemainder(dividingBy: 60)
            XCTAssertEqual(intoMinute, 0.05, accuracy: 0.001, "a tick lands just past a whole minute")
        }
    }
}
