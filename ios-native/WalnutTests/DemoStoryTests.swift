import Foundation
import XCTest
@testable import Walnut

/// The demo is read across screens: a letter, a chat, a note and the board all
/// tell parts of one week. These tests pin the places where they used to
/// contradict each other (App Store gate, 2026-10-01): shops that changed name
/// between the chat and the letter, a count that disagreed with its own table,
/// a note dated before the pull request it mentions, a plan naming a time
/// already behind the clock, a routine whose last run fell on the wrong day.
final class DemoStoryTests: XCTestCase {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func date(_ iso: String?) throws -> Date {
        try XCTUnwrap(iso.flatMap { Self.iso.date(from: $0) }, "not a date: \(iso ?? "nil")")
    }

    /// A clock at a given local time on a fixed Wednesday.
    private func clock(hour: Int, minute: Int = 0) -> DemoClock {
        clock(weekday: 4, hour: hour, minute: minute)
    }

    /// A clock on a weekday (1 = Sunday ... 7 = Saturday) of a fixed week that
    /// starts on Sunday, October 4, 2026.
    private func clock(weekday: Int, hour: Int, minute: Int = 0) -> DemoClock {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let day = calendar.date(from: DateComponents(year: 2026, month: 10, day: 3 + weekday, hour: hour, minute: minute))!
        return DemoClock(now: day, calendar: calendar)
    }

    /// Every hour of every weekday, early and late in the hour, the minutes
    /// either side of the plan's switch to tomorrow, of the review's 5:00 PM
    /// limit and of the waking-hours edges (6:00 AM, 7:00 PM, 9:00 PM), and the
    /// two days a year the clocks change, whose night is an hour shorter or longer.
    private var everyHourOfTheWeek: [DemoClock] {
        var clocks: [DemoClock] = []
        for weekday in 1...7 {
            for hour in 0..<24 {
                for minute in [5, 40] { clocks.append(clock(weekday: weekday, hour: hour, minute: minute)) }
            }
            for (hour, minute) in [(14, 29), (14, 31), (16, 29), (16, 31), (0, 10), (5, 59), (6, 1), (7, 59), (8, 1),
                                   (18, 59), (19, 1), (20, 59), (21, 1)] {
                clocks.append(clock(weekday: weekday, hour: hour, minute: minute))
            }
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        for (month, day) in [(3, 8), (3, 9), (11, 1), (11, 2)] {
            for hour in [1, 3, 9, 20, 23] {
                let now = calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: 30))!
                clocks.append(DemoClock(now: now, calendar: calendar))
            }
        }
        return clocks
    }

    private func label(_ c: DemoClock) -> String {
        let f = DateFormatter()
        f.calendar = c.calendar
        f.timeZone = c.calendar.timeZone
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE MMM d HH:mm"
        return f.string(from: c.now)
    }

    private func seed(_ c: DemoClock) -> DemoState { DemoFixtures.seed(c) }

    // MARK: - Markdown

    /// Every markdown text the demo shows, with where it is from.
    private func markdownTexts(_ c: DemoClock) -> [(String, String)] {
        let state = seed(c)
        var texts: [(String, String)] = []
        for letter in state.letters { texts.append(("letter \(letter.id)", letter.body ?? "")) }
        for note in state.notes { texts.append(("note \(note.path)", note.content)) }
        for session in state.sessions {
            for row in session.transcript where row.kind == nil {
                texts.append(("session \(session.id)", row.text))
            }
        }
        for conversation in state.conversations {
            for message in conversation.messages where message.kind == nil {
                texts.append(("chat \(conversation.id)", message.text))
            }
        }
        for question in ["How are the kitchen quotes going?", "Any news on the crash?", "What about the trip?",
                         "What should I focus on today?", "What is on my calendar tomorrow?", "What should I focus on tomorrow?",
                         "Hello", DemoFixtures.transcriptionSentence(c)] {
            texts.append(("reply to \(question)", DemoReplies.chat(for: question, clock: c).text))
        }
        texts.append(("session reply", DemoReplies.session(for: "run the tests", cwd: "").text))
        texts.append(("session reply", DemoReplies.session(for: "rename it", cwd: "").text))
        texts.append(("uptime allowed", DemoReplies.uptimeAllowed))
        texts.append(("uptime denied", DemoReplies.uptimeDenied))
        return texts
    }

    /// A line the app's markdown parser joins with the next one into a single
    /// paragraph: not blank and not a heading, list item, table row, quote or fence.
    private func isParagraphLine(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return false }
        for lead in ["#", "- ", "* ", "+ ", "|", ">", "```"] where t.hasPrefix(lead) { return false }
        if t.range(of: #"^\d+\. "#, options: .regularExpression) != nil { return false }
        return true
    }

    /// The headline letter read "A. Share moments, not files Warm and clear.": a
    /// single newline is a soft break, which the parser draws as a space.
    func testNoDemoParagraphRunsTwoLinesTogether() {
        for (source, text) in markdownTexts(clock(hour: 9)) + markdownTexts(clock(weekday: 6, hour: 23)) {
            let lines = text.components(separatedBy: "\n")
            for (a, b) in zip(lines, lines.dropFirst()) where isParagraphLine(a) && isParagraphLine(b) {
                XCTFail("\(source): \"\(a)\" runs into \"\(b)\"")
            }
        }
    }

    func testTheHeadlineLetterRendersEachOptionOnItsOwn() throws {
        let letter = try XCTUnwrap(seed(clock(hour: 9)).letters.first { $0.id == "l-headline" })
        let blocks = MarkdownParser.parse(letter.body ?? "", cache: .skip)
        let items = blocks.compactMap { block -> String? in
            if case .listItem(_, _, let text) = block.kind { return String(text.characters) }
            return nil
        }
        XCTAssertEqual(items, [
            "A. Share moments, not files. Warm and clear. Best if we lead with sharing.",
            "B. Your photos, together. Shortest. Works well next to the album illustration.",
            "C. Albums for the people in them. Most specific about what Pebble does.",
        ])
        // "Each is six words or fewer" has to be true of the three.
        for action in letter.actions ?? [] {
            let words = (action.description ?? "").split(separator: " ")
            XCTAssertLessThanOrEqual(words.count, 6, action.description ?? "")
        }
    }

    // MARK: - The kitchen quotes

    func testTheKitchenStoryIsTheSameInEveryPlace() throws {
        let c = clock(hour: 9)
        let state = seed(c)
        let shops = ["Stone & Co", "Counter Works", "Oak Lane"]
        let letter = try XCTUnwrap(state.letters.first { $0.id == "l-counters" }?.body)
        let note = try XCTUnwrap(state.notes.first { $0.path == "Home/Kitchen remodel.md" }?.content)
        let reply = DemoReplies.chat(for: "How are the kitchen quotes going?", clock: c).text
        let plan = try XCTUnwrap(state.conversations.first { $0.id == "c-today" }?.messages.map(\.text).joined(separator: "\n"))
        let kitchenChat = try XCTUnwrap(state.conversations.first { $0.id == "c-kitchen" }?.messages.map(\.text).joined(separator: "\n"))
        let summary = try XCTUnwrap(state.tasks.first { $0.id == "t-quotes" }?.summary)

        // Two quotes in, from the same two shops, at the same prices.
        let rows = letter.components(separatedBy: "\n").filter { $0.hasPrefix("| ") && !$0.hasPrefix("| Shop") }
        XCTAssertEqual(rows.count, 2, "the letter says two of three are in")
        XCTAssertTrue(letter.contains("Two of the three"))
        for text in [letter, note, reply] {
            XCTAssertTrue(text.contains("Counter Works") && text.contains("2,950"), text)
            XCTAssertTrue(text.contains("Oak Lane") && text.contains("1,800"), text)
        }
        // And the third shop is the same one, still to call back.
        for text in [letter, note, reply, plan, summary] {
            XCTAssertTrue(text.contains("Stone & Co"), "the third shop is not named in: \(text.prefix(80))")
        }
        XCTAssertFalse(letter.contains("| Stone & Co"), "Stone & Co has not quoted yet")
        XCTAssertTrue(shops.allSatisfy { kitchenChat.contains($0) }, "the chat that filed the task names all three")
        // No shop outside the three, anywhere in the demo's text.
        for (source, text) in markdownTexts(c) {
            XCTAssertFalse(text.contains("Riverside"), source)
        }
    }

    // MARK: - Names across screens

    func testLettersNameTheirSessionsAsTheSessionsDo() {
        let state = seed(clock(hour: 9))
        for letter in state.letters {
            guard let id = letter.sender?.sessionId else { continue }
            let session = state.sessions.first { $0.id == id }
            XCTAssertNotNil(session, "\(letter.id) names a session the demo does not have")
            XCTAssertEqual(letter.sender?.sessionTitle, session?.title, letter.id)
            XCTAssertEqual(letter.sender?.taskId, session?.taskId, letter.id)
            XCTAssertEqual(letter.sender?.taskTitle, state.tasks.first { $0.id == session?.taskId }?.title, letter.id)
        }
    }

    /// The chat says it started a release notes session; the board has to have it.
    func testTheSessionTheChatStartedExists() throws {
        let c = clock(hour: 9)
        let state = seed(c)
        let chat = try XCTUnwrap(state.conversations.first { $0.id == "c-today" })
        let start = try XCTUnwrap(chat.messages.first { $0.text == "session_start" })
        let task = try XCTUnwrap(state.tasks.first { $0.title == start.detail })
        let session = try XCTUnwrap(state.sessions.first { $0.taskId == task.id }, "no session on \(task.title)")
        XCTAssertEqual(try date(session.startedAt).timeIntervalSince(try date(start.createdAt)), 0, accuracy: 60)
        XCTAssertTrue(task.sessionIds.contains(session.id))
        XCTAssertEqual(task.phase, "IN_PROGRESS")
    }

    func testNoTextNamesAMonthOrATestPage() {
        let months = ["January", "February", "March", "April", "June", "July", "August",
                      "September", "October", "November", "December"]
        let state = seed(clock(hour: 9))
        var all = markdownTexts(clock(hour: 9)).map(\.1)
        all += state.tasks.map(\.title) + state.notes.map(\.path) + state.conversations.compactMap(\.title)
        all.append(DemoReplies.uptimeRestartOutput)
        for text in all {
            for month in months { XCTAssertFalse(text.contains(month), "a month dates the demo: \(text.prefix(80))") }
            XCTAssertFalse(text.lowercased().contains("test page"), "nothing is paged in the demo: \(text.prefix(80))")
        }
    }

    // MARK: - Times relative to now

    /// The plan in chat was written minutes ago, so it reads true at any hour:
    /// every time it names is ahead, on the day it says, and the board and the
    /// typed reply name the same times. Late in the day it plans tomorrow and
    /// says so (App Store gate, 2026-10-02: at 11:15 PM it named 10:30 AM today).
    func testThePlanReadsTrueAtEveryHourOfEveryWeekday() throws {
        for c in everyHourOfTheWeek {
            let at = label(c)
            let cal = c.calendar
            let state = seed(c)
            let plan = c.plan()
            let call = try date(state.tasks.first { $0.id == "t-dentist" }?.startDate)
            let review = try date(state.tasks.first { $0.id == "t-crash" }?.startDate)
            XCTAssertEqual(call, plan.call, at)
            XCTAssertEqual(review, plan.review, at)
            // Ahead of the clock, the call at least half an hour out.
            XCTAssertGreaterThanOrEqual(call.timeIntervalSince(c.now), 30 * 60, "\(at): the call is too soon or past")
            XCTAssertGreaterThan(review, c.now, "\(at): the review block is past")
            // The call in office hours and never on a Sunday.
            let minutes = cal.component(.hour, from: call) * 60 + cal.component(.minute, from: call)
            XCTAssertTrue((10 * 60 + 30)...(17 * 60) ~= minutes, "\(at): a dentist call at \(DemoClock.timeText(call))")
            XCTAssertNotEqual(cal.component(.weekday, from: call), 1, "\(at): a dentist call on a Sunday")
            // The plan's day: today, or tomorrow once no call fits today.
            let planDay = cal.date(byAdding: .day, value: plan.day, to: cal.startOfDay(for: c.now))!
            XCTAssertTrue(plan.day == 0 || plan.day == 1, at)
            // The review is work: a weekday, starting 2:00 to 5:00 PM, on the
            // plan's day when that is a work day with room for it, else the next
            // work day (App Store gate, 2026-10-05: a Sunday 2:00 PM review, a
            // Friday one at 7:00 PM).
            let reviewDay = c.dayOffset(of: review)
            XCTAssertTrue(c.isWorkday(reviewDay), "\(at): a review on a weekend")
            let reviewMinutes = cal.component(.hour, from: review) * 60 + cal.component(.minute, from: review)
            XCTAssertTrue((14 * 60)...(17 * 60) ~= reviewMinutes, "\(at): a review at \(DemoClock.timeText(review))")
            XCTAssertTrue(reviewDay == plan.day || reviewDay == c.workday(after: plan.day), at)
            if reviewDay != plan.day, c.isWorkday(plan.day) {
                XCTAssertGreaterThan(max(call.addingTimeInterval(7200), c.date(day: plan.day, hour: 14)),
                                     c.date(day: plan.day, hour: 17), "\(at): the review left a day it fit in")
            }
            if plan.day == 1 { XCTAssertGreaterThanOrEqual(cal.component(.hour, from: c.now), 16, "\(at): planned tomorrow too early") }

            // The words: "today" or "tomorrow" as said when it was asked, which
            // at night is the evening before (waking hours).
            let asked = plan.askedAt
            XCTAssertLessThanOrEqual(asked, c.now, at)
            XCTAssertEqual(asked, c.waking(c.now.addingTimeInterval(-DemoClock.planAskedMinutesAgo * 60)), at)
            let gap = cal.dateComponents([.day], from: cal.startOfDay(for: asked), to: planDay).day
            let word = gap == 0 ? "today" : "tomorrow"
            XCTAssertTrue(gap == 0 || gap == 1, at)
            let chat = try XCTUnwrap(state.conversations.first { $0.id == "c-today" })
            // The title is read now: a plan from yesterday evening names its day.
            let title = cal.isDate(asked, inSameDayAs: c.now) ? "Plan for \(word)" : "Plan for \(c.weekdayName(plan.day))"
            XCTAssertEqual(chat.title, title, at)
            let text = chat.messages.map { $0.text + "\n" + ($0.thinkingText ?? "") }.joined(separator: "\n")
            XCTAssertTrue(text.contains("What should I focus on \(word)?"), at)
            XCTAssertTrue(text.contains("realistic plan for \(word):"), at)
            XCTAssertFalse(text.lowercased().contains(word == "today" ? "tomorrow" : "today"), "\(at): the plan mixes its days")
            XCTAssertEqual(try date(chat.messages.first?.createdAt).timeIntervalSince(asked), 0, accuracy: 1, at)

            // The plan, the typed reply and the board name the same times.
            let callDay = cal.dateComponents([.day], from: cal.startOfDay(for: c.now), to: cal.startOfDay(for: call)).day!
            let reply = DemoReplies.chat(for: "What should I focus on today?", clock: c).text
            for named in [text, reply] {
                XCTAssertTrue(named.contains(DemoClock.timeText(call)), "\(at): call \(DemoClock.timeText(call))")
                XCTAssertTrue(named.contains(DemoClock.timeText(review)), "\(at): review \(DemoClock.timeText(review))")
                if callDay != plan.day {
                    XCTAssertTrue(named.contains("on \(c.weekdayName(callDay)) at \(DemoClock.timeText(call))"), at)
                }
                if reviewDay != plan.day {
                    XCTAssertTrue(named.contains("on \(c.weekdayName(reviewDay)) at \(DemoClock.timeText(review))"), at)
                }
            }
            XCTAssertTrue(reply.contains(plan.day == 0 ? "today at a glance" : "tomorrow at a glance"), at)
            // What waits names a work day: never "tomorrow" for a Saturday.
            let rest = c.restWaitsUntil(planDay: plan.day)
            XCTAssertTrue(reply.contains("can wait until \(rest)."), at)
            if plan.day == 0 {
                XCTAssertEqual(rest == "tomorrow", c.isWorkday(1), "\(at): waits until \(rest)")
                if rest != "tomorrow" { XCTAssertEqual(rest, c.weekdayName(c.workday(after: 0)), at) }
            }

            // The sample phone calendar has nothing on the plan's day.
            for event in DemoCalendarProvider.events(c) {
                XCTAssertFalse(cal.isDate(event.start, inSameDayAs: planDay), "\(at): \(event.title) on the plan's day")
            }
        }
    }

    /// Weekday names are said from the dates they are: the third shop's call-back
    /// day, the quotes' due day, the plumber's, the TestFlight build's. A fixed
    /// "by Thursday" read as the past on a Friday (App Store gate, 2026-10-02).
    func testEveryWeekdayNameIsTheDateItNames() throws {
        let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        for c in everyHourOfTheWeek {
            let at = label(c)
            let state = seed(c)
            let callback = c.weekdayName(DemoClock.quotesCallbackInDays)
            let due = c.weekdayName(DemoClock.quotesDueInDays)
            let quotes = try XCTUnwrap(state.tasks.first { $0.id == "t-quotes" })
            XCTAssertEqual(quotes.dueDate, c.day(DemoClock.quotesDueInDays), at)
            let counters = try XCTUnwrap(state.letters.first { $0.id == "l-counters" }?.body)
            let plan = try XCTUnwrap(state.conversations.first { $0.id == "c-today" }?.messages.map(\.text).joined(separator: "\n"))
            let kitchen = DemoReplies.chat(for: "How are the kitchen quotes going?", clock: c).text
            for text in [counters, plan, kitchen] {
                XCTAssertTrue(text.contains("call back by \(callback)"), "\(at): \(text.prefix(60))")
            }
            XCTAssertTrue(kitchen.contains("due **\(due)**"), at)
            // The plumber task and the chat that filed it; the TestFlight day.
            XCTAssertEqual(state.tasks.first { $0.id == "t-plumber" }?.dueDate, c.day(1), at)
            let kitchenChat = try XCTUnwrap(state.conversations.first { $0.id == "c-kitchen" }?.messages.map(\.text).joined(separator: "\n"))
            XCTAssertTrue(kitchenChat.contains("due \(c.weekdayName(1))"), at)
            // The TestFlight build goes out on the first work day after the review
            // it waits on, never on a weekend.
            let shipDay = c.shipDay(c.plan())
            XCTAssertTrue(c.isWorkday(shipDay), at)
            XCTAssertGreaterThan(shipDay, c.dayOffset(of: c.plan().review), at)
            let release = try XCTUnwrap(state.notes.first { $0.path == "Pebble/Release 2.4 plan.md" }?.content)
            XCTAssertTrue(release.contains("TestFlight build on \(c.weekdayName(shipDay))"), at)
            let ship = try date(state.tasks.first { $0.id == "t-testflight" }?.startDate)
            XCTAssertTrue(c.calendar.isDate(ship, inSameDayAs: c.date(day: shipDay, hour: 12)), at)
            let train = DemoReplies.chat(for: "What about the trip?", clock: c).text
            XCTAssertEqual(state.tasks.first { $0.id == "t-train" }?.dueDate, c.day(DemoClock.trainDueInDays), at)
            XCTAssertTrue(train.contains("due in \(DemoClock.trainDueInDays) days"), at)

            // No other weekday name anywhere (the trip's "Saturday market" is a place).
            let callDay = c.calendar.dateComponents([.day], from: c.calendar.startOfDay(for: c.now),
                                                    to: c.calendar.startOfDay(for: c.plan().call)).day!
            let reviewDay = c.dayOffset(of: c.plan().review)
            let allowed: Set<String> = [callback, due, c.weekdayName(1), c.weekdayName(callDay),
                                        c.weekdayName(reviewDay), c.weekdayName(shipDay)]
            for (source, _, text) in datedTexts(state) + [("kitchen reply", c.now, kitchen), ("trip reply", c.now, train)] {
                let plain = text.replacingOccurrences(of: "Saturday market", with: "market")
                for name in weekdays where plain.contains(name) {
                    XCTAssertTrue(allowed.contains(name), "\(at): \(source) names \(name)")
                }
            }
        }
    }

    // MARK: - Nothing reports what has not happened yet

    /// Every dated text the demo shows, with its date: letters (subject, preview,
    /// body, task) at their date, notes at their last edit, task summaries at the
    /// task's last update, and every agent message at its time. A user's own
    /// message is a request, so it may come before what it asks for.
    private func datedTexts(_ state: DemoState) -> [(String, Date, String)] {
        var texts: [(String, Date, String)] = []
        func at(_ iso: String?) -> Date? { iso.flatMap { Self.iso.date(from: $0) } }
        for letter in state.letters {
            guard let ms = letter.createdAt else { continue }
            let text = [letter.subject, letter.textPreview, letter.body, letter.sender?.taskTitle]
                .compactMap { $0 }.joined(separator: "\n")
            texts.append(("letter \(letter.id)", Date(timeIntervalSince1970: ms / 1000), text))
        }
        for note in state.notes {
            if let date = at(note.updatedAt) { texts.append(("note \(note.path)", date, note.path + "\n" + note.content)) }
        }
        for task in state.tasks {
            if let summary = task.summary, let date = at(task.updatedAt) { texts.append(("summary of \(task.id)", date, summary)) }
        }
        for conversation in state.conversations {
            for message in conversation.messages where message.role != "user" {
                guard let date = at(message.createdAt) else { continue }
                let text = [message.text, message.thinkingText, message.detail, message.resultPreview]
                    .compactMap { $0 }.joined(separator: "\n")
                texts.append(("chat \(conversation.id)", date, text))
            }
        }
        for session in state.sessions {
            for row in session.transcript where row.role != "user" {
                guard let date = at(row.timestamp) else { continue }
                let text = [row.text, row.thinkingText, row.detail, row.resultPreview]
                    .compactMap { $0 }.joined(separator: "\n")
                texts.append(("session \(session.id)", date, text))
            }
        }
        return texts
    }

    /// The words that name each task in prose, besides its title.
    private static let taskWords: [String: [String]] = [
        "t-crash": ["crash"], "t-offline": ["offline mode", "offline banner", "photo grid"],
        "t-copy": ["headline"], "t-notes": ["release notes"], "t-testflight": ["testflight"],
        "t-coldstart": ["cold start"], "t-l10n": ["localize the settings"], "t-cache": ["image cache"],
        "t-pricing": ["pricing page"], "t-uptime": ["uptime", "alert"], "t-hero": ["hero image"],
        "t-links": ["footer links", "broken links"],
        "t-quotes": ["counter quotes", "quotes for the kitchen", "three quotes"],
        "t-plumber": ["plumber"], "t-car": ["car registration"], "t-meals": ["meals for the weekend"],
        "t-train": ["train tickets"], "t-pack": ["packing"], "t-dentist": ["dentist"],
        "t-article": ["habit tracking"], "t-library": ["library books"], "t-course": ["design systems course"],
        "t-upload-crash": ["weak signal"], "t-delete-crash": ["last photo in an album"],
        "t-restore-crash": ["restoring from a backup"], "t-widget-crash": ["home screen widget"],
    ]

    /// What the texts report, with when it happened: each task (named by its
    /// title or its words) from its creation, and the story's events.
    private func facts(_ c: DemoClock, _ state: DemoState) throws -> [(String, Date, [String])] {
        var facts: [(String, Date, [String])] = []
        for task in state.tasks {
            let words = try XCTUnwrap(Self.taskWords[task.id], "\(task.id) has no words: add them")
            facts.append(("task \(task.id)", try date(task.createdAt), [task.title.lowercased()] + words))
        }
        let crash = try XCTUnwrap(state.sessions.first { $0.id == "s-crash" })
        let pr = try XCTUnwrap(crash.transcript.first { ($0.resultPreview ?? "").contains("#318") })
        facts.append(("pull request #318", try date(pr.timestamp), ["#318"]))
        facts.append(("the two quotes", DemoFixtures.quotesArrived(c),
                      ["quotes are in", "quotes in", "(two in)", "came in", "2,950", "1,800"]))
        let cache = try XCTUnwrap(state.tasks.first { $0.id == "t-cache" })
        facts.append(("the cache upgrade done", try date(cache.completedAt),
                      ["upgrade is done", "38%", "[x] image cache", "has merged so far"]))
        func letterDate(_ id: String) throws -> Date {
            Date(timeIntervalSince1970: try XCTUnwrap(state.letters.first { $0.id == id }?.createdAt) / 1000)
        }
        facts.append(("the headline letter", try letterDate("l-headline"), ["waiting in your inbox", "sent them to your inbox"]))
        facts.append(("the cache letter", try letterDate("l-cache"), ["wrote it up in your inbox"]))
        facts.append(("the pricing letter", try letterDate("l-pricing"), ["sent a review letter"]))
        let notes = try XCTUnwrap(state.sessions.first { $0.id == "s-notes" })
        facts.append(("the release notes session", try date(notes.startedAt), ["started a session on"]))
        let offline = try XCTUnwrap(state.sessions.first { $0.id == "s-offline" })
        let grid = try XCTUnwrap(offline.transcript.first { $0.role == "assistant" && $0.text.contains("500 thumbnails") })
        facts.append(("the offline grid working", try date(grid.timestamp), ["500 thumbnails", "nearly ready", "ready to merge"]))
        return facts
    }

    /// Every letter, note, summary and agent message is dated on or after
    /// everything it reports, at every hour of every weekday. The weekly review
    /// was dated a week back while naming tasks filed days later (App Store
    /// gate, 2026-10-02); the plan named a pull request opened after it.
    func testNothingIsDatedBeforeWhatItReports() throws {
        for c in everyHourOfTheWeek {
            let state = seed(c)
            let facts = try facts(c, state)
            for (source, when, text) in datedTexts(state) {
                let lower = text.lowercased()
                for (fact, happened, words) in facts where words.contains(where: { lower.contains($0) }) {
                    XCTAssertGreaterThanOrEqual(when.timeIntervalSince(happened), -1,
                                                "\(label(c)): \(source) reports \(fact) before it happened")
                }
            }
        }
    }

    /// Only the plan, which is worked out from the clock, says "today" or
    /// "tomorrow": anywhere else such a word is fixed text that turns false as
    /// the days go by.
    func testOnlyThePlanSaysWhichDayItIs() {
        let words = ["today", "tomorrow", "tonight", "yesterday", "this week", "next week", "last week"]
        for c in [clock(hour: 9), clock(weekday: 6, hour: 23)] {
            for (source, _, text) in datedTexts(seed(c)) where source != "chat c-today" {
                for word in words {
                    XCTAssertFalse(text.lowercased().contains(word), "\(source) says \(word)")
                }
            }
        }
    }

    func testRoutinesRunWhenTheirSchedulesSay() throws {
        for c in everyHourOfTheWeek {
            let at = label(c)
            let state = seed(c)
            let cal = c.calendar
            func runs(_ id: String) throws -> (last: Date, next: Date) {
                let job = try XCTUnwrap(state.routines.first { $0.id == id })
                return (Date(timeIntervalSince1970: try XCTUnwrap(job.state?.lastRunAtMs) / 1000),
                        Date(timeIntervalSince1970: try XCTUnwrap(job.state?.nextRunAtMs) / 1000))
            }
            let briefing = try runs("r-briefing")
            for run in [briefing.last, briefing.next] {
                XCTAssertEqual(cal.component(.hour, from: run), 8, at)
                XCTAssertTrue((2...6).contains(cal.component(.weekday, from: run)), "\(at): the briefing runs on weekdays")
            }
            XCTAssertLessThanOrEqual(briefing.last, c.now, at)
            XCTAssertGreaterThan(briefing.next, c.now, at)
            let weekly = try runs("r-weekly")
            for run in [weekly.last, weekly.next] {
                XCTAssertEqual(cal.component(.hour, from: run), 16, at)
                XCTAssertEqual(cal.component(.weekday, from: run), 6, "\(at): the weekly review runs on Fridays")
            }
            XCTAssertLessThanOrEqual(weekly.last, c.now, at)
            // Its letter is dated at that run; what it carries over is still open.
            let letter = try XCTUnwrap(state.letters.first { $0.id == "l-weekly" })
            XCTAssertEqual(try XCTUnwrap(letter.createdAt) / 1000, weekly.last.timeIntervalSince1970, accuracy: 1, at)
            for title in ["Renew the car registration", "Localize the settings screen", "Investigate slow cold start on older phones"] {
                let task = try XCTUnwrap(state.tasks.first { $0.title == title })
                XCTAssertNotEqual(task.phase, "COMPLETE", "\(title) is carried over, so it is still open")
            }
        }
    }

    /// The journal entry is yesterday's, written yesterday evening.
    func testTheJournalIsYesterdaysAndWrittenThen() throws {
        for c in everyHourOfTheWeek {
            let state = seed(c)
            let journal = try XCTUnwrap(state.notes.first { $0.path.hasPrefix("Journal/") })
            XCTAssertEqual(journal.path, "Journal/\(c.day(-1)).md")
            let written = try date(journal.updatedAt)
            XCTAssertTrue(c.calendar.isDate(written, inSameDayAs: c.date(day: -1, hour: 12)), label(c))
        }
    }

    // MARK: - Waking hours

    /// Every time the demo shows, with what it is, and whether it is in the past.
    private func shownTimes(_ c: DemoClock, _ state: DemoState) throws -> [(String, Date, Bool)] {
        var times: [(String, Date, Bool)] = []
        func add(_ what: String, _ iso: String?, past: Bool = true) throws {
            guard let iso else { return }
            times.append((what, try date(iso), past))
        }
        func addMs(_ what: String, _ ms: Double?, past: Bool = true) {
            guard let ms else { return }
            times.append((what, Date(timeIntervalSince1970: ms / 1000), past))
        }
        for letter in state.letters {
            addMs("letter \(letter.id) written", letter.createdAt)
            addMs("letter \(letter.id) read", letter.readAt)
        }
        for note in state.notes { try add("note \(note.path)", note.updatedAt) }
        for task in state.tasks {
            try add("task \(task.id) created", task.createdAt)
            try add("task \(task.id) updated", task.updatedAt)
            try add("task \(task.id) completed", task.completedAt)
            // Planned times are wall-clock times too (a bare day has no time).
            for planned in [task.startDate, task.endDate] where planned?.contains("T") == true {
                try add("task \(task.id) planned", planned, past: false)
            }
        }
        for session in state.sessions {
            try add("session \(session.id) started", session.startedAt)
            try add("session \(session.id) last active", session.lastActiveAt)
            for row in session.transcript { try add("session \(session.id) row", row.timestamp) }
        }
        for conversation in state.conversations {
            try add("chat \(conversation.id) updated", conversation.updatedAt)
            for message in conversation.messages { try add("chat \(conversation.id) message", message.createdAt) }
        }
        for job in state.routines {
            addMs("routine \(job.id) last run", job.state?.lastRunAtMs)
            addMs("routine \(job.id) next run", job.state?.nextRunAtMs, past: false)
        }
        for dir in DemoFixtures.launchOptions(c).dirs { try add("folder \(dir.cwd) last used", dir.lastUsed) }
        for event in DemoCalendarProvider.events(c) {
            times.append(("event \(event.title) start", event.start, false))
            times.append(("event \(event.title) end", event.end, false))
        }
        for entry in DemoFixtures.recentOpens(state, c) {
            times.append(("recently opened \(entry.id)", entry.openedAt, true))
        }
        return times
    }

    /// Every time the demo shows, past or planned, is between 6:00 AM and
    /// 9:00 PM, whatever hour the demo is opened, and nothing past is after
    /// now (App Store gate, 2026-10-02: a demo opened in the morning showed a
    /// letter written at 3:42 AM and a note saved at 2:51 AM). Opened at night,
    /// the day reads as if it ended at 9:00 PM.
    func testEveryShownTimeIsInWakingHours() throws {
        for c in everyHourOfTheWeek {
            let at = label(c)
            let cal = c.calendar
            for (what, when, isPast) in try shownTimes(c, seed(c)) {
                let parts = cal.dateComponents([.hour, .minute, .second], from: when)
                let seconds = parts.hour! * 3600 + parts.minute! * 60 + parts.second!
                XCTAssertTrue((DemoClock.wakingStartHour * 3600)...(DemoClock.wakingEndHour * 3600) ~= seconds,
                              "\(at): \(what) at \(parts.hour!):\(parts.minute!)")
                if isPast { XCTAssertLessThanOrEqual(when, c.now, "\(at): \(what) is after now") }
            }
        }
    }

    /// The mapping into waking hours keeps every order (so no item moves before
    /// what it reports), leaves daytime alone, and never moves a past time
    /// after now: checked every 7 minutes over the 12 days before each clock.
    func testWakingHoursKeepTheOrderOfEverything() {
        for c in everyHourOfTheWeek {
            let at = label(c)
            let cal = c.calendar
            var previous: Date?
            var t = c.now.addingTimeInterval(-12 * 86_400)
            while t <= c.now {
                let shown = c.waking(t)
                if let previous { XCTAssertGreaterThan(shown, previous, "\(at): order lost at \(t)") }
                XCTAssertLessThanOrEqual(shown, c.now, at)
                let hour = cal.component(.hour, from: t)
                if (DemoClock.wakingStartHour..<DemoClock.eveningStartHour).contains(hour) {
                    XCTAssertEqual(shown, t, "\(at): a daytime moment moved")
                }
                previous = shown
                t = t.addingTimeInterval(7 * 60)
            }
            // The last minutes before now stay as they are in the day and the
            // early evening, and fold into the evening at night.
            let recent = c.now.addingTimeInterval(-10 * 60)
            let hour = cal.component(.hour, from: c.now)
            if (DemoClock.wakingStartHour...20).contains(hour), cal.component(.hour, from: recent) >= DemoClock.wakingStartHour {
                XCTAssertEqual(c.waking(recent), recent, "\(at): a recent daytime moment moved")
            }
            XCTAssertEqual(c.waking(c.now.addingTimeInterval(60)), c.now.addingTimeInterval(60), "the future stays")
        }
    }

    /// The Tasks drawer's sample history opens each thing after it existed, at every
    /// hour of every weekday: a conversation after it started, a task page after the
    /// task was made, and the finished cache upgrade's page after it was done.
    func testTheSampleHistoryOpensEachThingAfterItExisted() throws {
        for c in everyHourOfTheWeek {
            let at = label(c)
            let state = seed(c)
            let entries = DemoFixtures.recentOpens(state, c)
            XCTAssertEqual(entries.count, 4, at)
            for entry in entries {
                XCTAssertLessThanOrEqual(entry.openedAt, c.now, "\(at): \(entry.id) opened after now")
                let task = try XCTUnwrap(state.tasks.first { $0.id == entry.taskId }, "\(at): \(entry.id) names no task")
                XCTAssertGreaterThanOrEqual(entry.openedAt, try date(task.createdAt), "\(at): \(entry.id) opened before it was made")
                if let session = entry.session {
                    let source = try XCTUnwrap(state.sessions.first { $0.id == session.id })
                    XCTAssertEqual(source.taskId, task.id, at)
                    XCTAssertGreaterThanOrEqual(entry.openedAt, try date(source.startedAt), "\(at): \(session.id) opened before it started")
                }
                if let done = task.completedAt {
                    XCTAssertGreaterThanOrEqual(entry.openedAt, try date(done), "\(at): \(entry.id) opened as done before it was done")
                }
            }
        }
    }

    /// The routines run in waking hours, each on its own schedule, so a last
    /// run never lands at night (the crash check ran every 6 hours, at 3:00 AM).
    func testTheCrashCheckRunsDailyInTheDay() throws {
        for c in everyHourOfTheWeek {
            let job = try XCTUnwrap(seed(c).routines.first { $0.id == "r-crashes" })
            XCTAssertEqual(job.schedule.expr, "0 13 * * *")
            let last = Date(timeIntervalSince1970: try XCTUnwrap(job.state?.lastRunAtMs) / 1000)
            let next = Date(timeIntervalSince1970: try XCTUnwrap(job.state?.nextRunAtMs) / 1000)
            XCTAssertEqual(c.calendar.component(.hour, from: last), 13, label(c))
            XCTAssertEqual(c.calendar.component(.hour, from: next), 13, label(c))
            XCTAssertLessThanOrEqual(last, c.now, label(c))
            XCTAssertGreaterThan(next, c.now, label(c))
        }
    }
}
