import Foundation

/// The demo chat's answers that depend on the day asked about, and its answer to a
/// photo. Split from DemoReplies.swift, which picks the topic.
///
/// App Store gate, 2026-10-09: "What is on my calendar tomorrow?" got the plan
/// ("here is tomorrow at a glance: 1. Review the crash fix ... blocked out on
/// Monday"), and a photo sent with no words was refused.
extension DemoReplies {
    /// The day a message asks about, as an offset from today: "tomorrow" is 1,
    /// "today" or "tonight" is 0, a weekday name is its next date (0 when it is
    /// today). nil when the message names no day.
    static func askedDay(_ lower: String, clock: DemoClock) -> Int? {
        if lower.contains("tomorrow") { return 1 }
        if lower.contains("today") || lower.contains("tonight") || lower.contains("this morning")
            || lower.contains("this afternoon") || lower.contains("this evening") { return 0 }
        let names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
        for (index, name) in names.enumerated() where lower.contains(name) {
            let weekday = index + 1
            let today = clock.calendar.component(.weekday, from: clock.now)
            return weekday == today ? 0 : clock.nextWeekday(weekday)
        }
        return nil
    }

    /// "Today", "Tomorrow, Wednesday," or "On Friday", as a sentence starts.
    static func dayPhrase(_ day: Int, clock: DemoClock) -> String {
        switch day {
        case 0: return "Today"
        case 1: return "Tomorrow, \(clock.weekdayName(1)),"
        default: return "On \(clock.weekdayName(day))"
        }
    }

    /// The plan's call and review as the reply about tomorrow says them, asked while
    /// the plan is for today: what is still today ("Today still has the dentist call
    /// at 10:30 AM."), then each item the plan put on a later day with that day ("The
    /// crash review is on Monday at 2:00 PM."). A weekend plan keeps the review for
    /// Monday, and a Sunday one the call too.
    static func planStillToday(clock: DemoClock) -> String {
        let plan = clock.plan()
        let items = [(name: "dentist call", at: plan.call), (name: "crash review", at: plan.review)]
        let today = items.filter { clock.dayOffset(of: $0.at) == 0 }
            .map { "the \($0.name) at \(DemoClock.timeText($0.at))" }
        var sentences: [String] = []
        if !today.isEmpty { sentences.append("Today still has \(today.joined(separator: " and ")).") }
        for item in items where clock.dayOffset(of: item.at) != 0 {
            let day = clock.dayOffset(of: item.at)
            let when = day == 1 ? "tomorrow at \(DemoClock.timeText(item.at))" : clock.when(item.at, planDay: 0)
            sentences.append("The \(item.name) is \(when).")
        }
        return sentences.joined(separator: " ")
    }

    /// What is on the sample calendar on day `day`, with the plan's call and review
    /// when they fall on it, in time order.
    static func agenda(_ day: Int, clock: DemoClock) -> [String] {
        let plan = clock.plan()
        var items: [(Date, String)] = DemoCalendarProvider.events(clock)
            .filter { clock.dayOffset(of: $0.start) == day }
            .map { ($0.start, "**\(DemoClock.timeText($0.start))** \($0.title)") }
        if clock.dayOffset(of: plan.call) == day {
            items.append((plan.call, "**\(DemoClock.timeText(plan.call))** Call the dentist, from your plan"))
        }
        if clock.dayOffset(of: plan.review) == day {
            items.append((plan.review, "**\(DemoClock.timeText(plan.review))** Review the crash fix (pull request #318), from your plan"))
        }
        return items.sorted { $0.0 < $1.0 }.map { "- \($0.1)" }
    }

    /// "What is on my calendar tomorrow?": the sample calendar for that day.
    static func calendar(_ lower: String, clock: DemoClock) -> Chat {
        let plan = clock.plan()
        let day = askedDay(lower, clock: clock) ?? plan.day
        let lines = agenda(day, clock: clock)
        let phrase = dayPhrase(day, clock: clock)
        var text = lines.isEmpty
            ? "\(phrase) your calendar is free."
            : "\(phrase) your calendar has:\n\n\(lines.joined(separator: "\n"))"
        // Asked about another day while today's plan still has work in it.
        if day != 0, plan.day == 0 {
            let today = agenda(0, clock: clock).filter { $0.contains("from your plan") }
            if !today.isEmpty {
                text += "\n\nToday still has:\n\n\(today.joined(separator: "\n"))"
            }
        }
        return Chat(thinking: "Read the calendar for \(day == 0 ? "today" : clock.weekdayName(day)).", text: text)
    }

    /// "What should I focus on tomorrow?" asked while the plan is for today: the
    /// answer is about tomorrow, and says what today still holds.
    static func tomorrowFocus(clock: DemoClock) -> Chat {
        let name = clock.weekdayName(1)
        let events = DemoCalendarProvider.events(clock)
            .filter { clock.dayOffset(of: $0.start) == 1 }
            .sorted { $0.start < $1.start }
        let first = events.first.map { "starts with **\($0.title)** at \(DemoClock.timeText($0.start)). Then" } ?? "is free on your calendar, so"
        let lead = clock.isWorkday(1)
            ? "Tomorrow, \(name), \(first) the rest of Focus: **Add offline mode to the photo grid**, **Write release notes for 2.4** and the **kitchen counter quotes**."
            : "Tomorrow is \(name), and Focus waits for \(clock.weekdayName(clock.workday(after: 1))). \(events.first.map { "Your calendar has **\($0.title)** at \(DemoClock.timeText($0.start))." } ?? "Your calendar is free.")"
        return Chat(
            thinking: "Read the Focus tier and the calendar for \(name).",
            text: """
            \(lead)

            \(planStillToday(clock: clock))
            """
        )
    }

    /// A photo with no words. The demo cannot look at it, and says so.
    static let photoReply = Chat(
        thinking: "A photo with no question.",
        text: """
        Got the photo. This is the Walnut demo, so this answer is a sample: on your own Walnut I read the photos you attach along with your message, such as a screenshot of a bug or a contractor's quote, and can turn what is in them into a task.

        Add a line saying what you would like to know about it, and the reply follows that.
        """
    )

    /// A session told something with a photo and no words.
    static func sessionPhoto(cwd: String) -> Session {
        Session(
            thinking: "Look at the attached photo before changing anything.",
            tool: Tool(
                name: "Read", detail: "the attached photo",
                input: "file_path: \(cwd.isEmpty ? DemoFixtures.macCodeRoot : cwd)/.walnut/attachments/photo-1.jpg",
                result: "Image read (1 photo)"
            ),
            text: """
            I looked at the photo you attached. This is the Walnut demo, so no real files change here.

            On your own computer I would use what the picture shows, such as a crash screen or a design, in the work on this session, and ask if it was not clear what you wanted done with it.
            """
        )
    }
}
