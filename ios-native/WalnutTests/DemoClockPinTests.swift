import SwiftUI
import XCTest
@testable import Walnut

/// The demo's one clock (App Store r6 gate, findings 4, 9 and 11).
///
/// The listing screenshots show a 9:41 status bar, and the demo times its sample
/// data from the moment it starts: a capture made at 3 PM on a Friday read "Plan
/// for today" with its first item on Monday. A Debug build launched in the demo with
/// `-walnutDemoNow <ISO 8601>` runs the demo from that moment, and every screen that
/// shows a time reads the same clock (`AppClock`). Outside the demo the argument is
/// ignored. And every demo source reads the demo server's one clock: the calendar
/// built its own (`DemoClock()`), the voice transcript always said "Friday morning",
/// and "What is on my calendar tomorrow?" was answered with the plan.
@MainActor
final class DemoClockPinTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private let api = WalnutAPI()

    /// Tuesday, October 6, 2026, 9:41 AM on the test's own calendar.
    private static func local(_ day: Int, _ hour: Int, _ minute: Int) -> Date {
        Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }
    private static var pin: Date { local(6, 9, 41) }
    private static var pinText: String { ISO8601DateFormatter().string(from: pin) }
    private static var arguments: [String] { ["Walnut", AppClock.demoPinArgument, pinText] }

    override func setUp() async throws {
        LifecycleHub.shared.teardownAll()
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.turnScale = 0
        AppClock.clearDemoPin()
        DemoServer.shared.reset()
        DemoURLProtocol.resetLog()
    }

    override func tearDown() async throws {
        AppClock.clearDemoPin()
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        DemoServer.shared.turnScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    nonisolated override class func tearDown() {
        MainActor.assumeIsolated { LifecycleHub.shared.resumeAll() }
        super.tearDown()
    }

    private func settleTurns() {
        let deadline = Date().addingTimeInterval(5)
        while DemoServer.shared.pendingStepCount > 0, Date() < deadline {
            usleep(5_000)
        }
        DemoServer.shared.turnQueue.sync {}
        DemoServer.shared.streams.drain()
    }

    private func date(_ iso: String) -> Date? { WalnutTask.parseISO(iso) }

    // MARK: - The pin

    func testThePinIsReadOnlyInTheDemo() {
        let now = Date()
        let wanted = Self.pin.timeIntervalSince(now)
        XCTAssertEqual(AppClock.demoPinOffset(arguments: Self.arguments, demoActive: true, now: now), wanted, accuracy: 0.001)
        XCTAssertEqual(AppClock.demoPinOffset(arguments: Self.arguments, demoActive: false, now: now), 0,
                       "outside the demo the argument is ignored")
        XCTAssertEqual(AppClock.demoPinOffset(arguments: ["Walnut"], demoActive: true, now: now), 0)
        XCTAssertEqual(AppClock.demoPinOffset(arguments: ["Walnut", AppClock.demoPinArgument], demoActive: true, now: now), 0)
        XCTAssertEqual(AppClock.demoPinOffset(arguments: ["Walnut", AppClock.demoPinArgument, "Tuesday"], demoActive: true, now: now), 0)
        // UTC and fractional seconds name the same moment.
        let utc = ISO8601DateFormatter()
        utc.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        XCTAssertEqual(
            AppClock.demoPinOffset(arguments: ["Walnut", AppClock.demoPinArgument, utc.string(from: Self.pin)], demoActive: true, now: now),
            wanted, accuracy: 0.001
        )
    }

    func testThePinMovesEveryShownTimeTogether() {
        AppClock.applyDemoPin(arguments: Self.arguments, demoActive: true)
        XCTAssertEqual(AppClock.now().timeIntervalSince(Self.pin), 0, accuracy: 5)

        // Five minutes before the shown now reads "5m ago", as it would on a phone
        // whose clock said 9:41.
        let fiveAgo = AppClock.now().addingTimeInterval(-300)
        XCTAssertEqual(RelativeTime.short(date: fiveAgo), RelativeTime.short(date: Date().addingTimeInterval(-300), relativeTo: Date()))
        XCTAssertEqual(AppClock.relativeNamed(fiveAgo), Date().addingTimeInterval(-300).formatted(.relative(presentation: .named)))
        XCTAssertTrue(AppClock.isToday(Self.pin))
        XCTAssertTrue(AppClock.isTomorrow(Self.local(7, 12, 0)))
        XCTAssertTrue(AppClock.isYesterday(Self.local(5, 12, 0)))
        XCTAssertEqual(TaskRow.dueText(Self.local(7, 0, 0)), "Tomorrow")
        XCTAssertEqual(TaskRow.dueText(Self.local(6, 0, 0)), "Today")

        // A launch that is not in the demo ignores it; leaving forgets it.
        AppClock.applyDemoPin(arguments: Self.arguments, demoActive: false)
        XCTAssertEqual(AppClock.demoOffset, 0)
        AppClock.applyDemoPin(arguments: Self.arguments, demoActive: true)
        AppClock.clearDemoPin()
        XCTAssertEqual(AppClock.demoOffset, 0)
        XCTAssertEqual(AppClock.now().timeIntervalSinceNow, 0, accuracy: 1)
    }

    func testTheDemoServerRunsOnThePinnedClock() async throws {
        AppClock.applyDemoPin(arguments: Self.arguments, demoActive: true)
        DemoServer.shared.reset()
        XCTAssertEqual(DemoServer.shared.clockNow.now.timeIntervalSince(Self.pin), 0, accuracy: 5)
        XCTAssertEqual(DemoServer.shared.now.timeIntervalSince(Self.pin), 0, accuracy: 5)

        // The letters were written this morning, before 9:41.
        let letters = try await api.letters(archived: false).letters
        let newest = try XCTUnwrap(letters.compactMap(\.createdAt).max())
        let newestDate = Date(timeIntervalSince1970: newest / 1000)
        XCTAssertLessThanOrEqual(newestDate, Self.pin.addingTimeInterval(5))
        XCTAssertGreaterThan(newestDate, Self.pin.addingTimeInterval(-3600), "the newest letter is from the last hour")

        // A message sent now is stamped on the same clock.
        let id = try await api.createConversation(title: "Clock")
        _ = try await api.sendMessage(conversationID: id, text: "Hello")
        settleTurns()
        let messages = try await api.messages(conversationID: id)
        let stamp = try XCTUnwrap(messages.first.flatMap { date($0.createdAt) })
        XCTAssertEqual(stamp.timeIntervalSince(Self.pin), 0, accuracy: 60)

        // The plan reads today, with times later this morning and afternoon.
        let plan = DemoServer.shared.clockNow.plan()
        XCTAssertEqual(plan.day, 0)
        XCTAssertEqual(Calendar.current.component(.hour, from: plan.call), 10)
        XCTAssertEqual(Calendar.current.component(.hour, from: plan.review), 14)
    }

    func testEnteringTheDemoReadsThePinAndLeavingItForgetsIt() async throws {
        let connection = ConnectionStore()
        let tasks = TasksStore()
        let chat = ChatStore()
        let notes = NotesStore()
        let inbox = InboxStore()
        LocalDataReset.register(tasks: tasks, chat: chat, notes: notes, inbox: inbox, filePreview: nil)

        try await DemoEntry.enter(connection: connection, recents: tasks.recents, arguments: Self.arguments)
        XCTAssertEqual(AppClock.now().timeIntervalSince(Self.pin), 0, accuracy: 10)
        XCTAssertEqual(DemoServer.shared.clockNow.now.timeIntervalSince(Self.pin), 0, accuracy: 10)

        connection.disconnect()
        XCTAssertEqual(AppClock.demoOffset, 0, "leaving the demo puts the shown clock back")
        XCTAssertEqual(DemoServer.shared.clockNow.now.timeIntervalSinceNow, 0, accuracy: 10)
    }

    // MARK: - One clock for every demo source

    /// The calendar answers from the demo server's clock, the one the plan was made
    /// with: a demo started at 4:25 PM plans today, and a calendar read later (a
    /// fresh clock past 4:30 PM would plan tomorrow) still keeps the plan's day free.
    func testTheCalendarShowsTheDayThePlanIsFor() {
        let start = Self.local(7, 16, 25)
        DemoServer.shared.reset(now: start)
        let clock = DemoServer.shared.clockNow
        XCTAssertEqual(clock.plan().day, 0)
        let expected = DemoCalendarProvider.events(clock)
        let got = DemoCalendarProvider().events(
            from: start.addingTimeInterval(-3 * 86_400), to: start.addingTimeInterval(14 * 86_400)
        )
        XCTAssertEqual(got.map(\.id).sorted(), expected.map(\.id).sorted())
        XCTAssertEqual(Set(got.map(\.start)), Set(expected.map(\.start)))
        let planDay = clock.plan().call
        XCTAssertFalse(got.contains { Calendar.current.isDate($0.start, inSameDayAs: planDay) },
                       "nothing on the calendar contradicts the plan's day")
    }

    /// The voice transcript names the next work day, never a fixed weekday.
    func testTheVoiceTranscriptNamesTheNextWorkDay() async throws {
        let cases: [(day: Int, when: String)] = [
            (6, "tomorrow morning"),   // Tuesday
            (9, "on Monday morning"),  // Friday
            (10, "on Monday morning"), // Saturday
            (11, "tomorrow morning"),  // Sunday
        ]
        for (day, when) in cases {
            DemoServer.shared.reset(now: Self.local(day, 9, 41))
            let heard = try await api.transcribe(audio: Data([0, 1, 2]), format: "m4a")
            XCTAssertTrue(heard.contains(when), "October \(day): \(heard)")
            let reply = DemoReplies.chat(for: heard, clock: DemoServer.shared.clockNow).text
            XCTAssertTrue(reply.contains(when.replacingOccurrences(of: "on ", with: "")), "October \(day): \(reply)")
        }
    }

    /// "What is on my calendar tomorrow?" is answered from the calendar, for that day.
    func testTheCalendarQuestionIsAnsweredFromTheCalendar() {
        DemoServer.shared.reset(now: Self.pin)
        let tuesday = DemoReplies.chat(for: "What is on my calendar tomorrow?", clock: DemoServer.shared.clockNow).text
        XCTAssertTrue(tuesday.contains("Wednesday"), tuesday)
        XCTAssertTrue(tuesday.contains("Coffee with Sam"), tuesday)
        XCTAssertTrue(tuesday.contains("9:00"), tuesday)
        XCTAssertFalse(tuesday.contains("at a glance"), "the plan is not the calendar: \(tuesday)")

        // A Friday evening: tomorrow is Saturday, with the plan's dentist call on it.
        DemoServer.shared.reset(now: Self.local(9, 20, 12))
        let friday = DemoReplies.chat(for: "What is on my calendar tomorrow?", clock: DemoServer.shared.clockNow).text
        XCTAssertTrue(friday.contains("Saturday"), friday)
        XCTAssertTrue(friday.contains("dentist"), friday)
        XCTAssertFalse(friday.contains("Monday"), "tomorrow is Saturday, not Monday: \(friday)")
    }

    /// Asked about tomorrow in the morning, the plan reply talks about tomorrow.
    func testAQuestionAboutTomorrowIsAnsweredForTomorrow() {
        DemoServer.shared.reset(now: Self.pin)
        let reply = DemoReplies.chat(for: "What should I focus on tomorrow?", clock: DemoServer.shared.clockNow).text
        XCTAssertTrue(reply.contains("Wednesday"), reply)
        XCTAssertFalse(reply.hasPrefix("Here is today at a glance"), reply)
    }

    /// On a weekend the plan keeps the review for Monday (and on a Sunday the call
    /// too): "Today still has" names only today's work, and what waits is said with
    /// its own day. A Saturday shortly after midnight read "Today still has the
    /// dentist call at 10:30 AM and the crash review on Monday at 2:00 PM" (r9 run).
    func testTomorrowFocusOnAWeekendSaysWhenEachItemIs() {
        DemoServer.shared.reset(now: Self.local(10, 9, 41)) // Saturday
        let saturday = DemoServer.shared.clockNow
        XCTAssertEqual(saturday.plan().day, 0)
        let reply = DemoReplies.chat(for: "What should I focus on tomorrow?", clock: saturday).text
        XCTAssertTrue(reply.contains("Sunday"), reply)
        let today = reply.components(separatedBy: "Today still has").dropFirst().first?
            .components(separatedBy: ".").first ?? ""
        XCTAssertFalse(today.isEmpty, "no line about today: \(reply)")
        XCTAssertTrue(today.contains("dentist call at 10:30"), reply)
        XCTAssertFalse(today.contains("Monday"), "the line about today names Monday: \(reply)")
        XCTAssertTrue(reply.contains("crash review is on Monday at 2:00"), reply)

        DemoServer.shared.reset(now: Self.local(11, 9, 41)) // Sunday: both wait for Monday
        let sunday = DemoServer.shared.clockNow
        XCTAssertEqual(sunday.plan().day, 0)
        let monday = DemoReplies.chat(for: "What should I focus on tomorrow?", clock: sunday).text
        XCTAssertTrue(monday.contains("Tomorrow, Monday,"), monday)
        XCTAssertFalse(monday.contains("Today still has"), "nothing of the plan is today: \(monday)")
        XCTAssertTrue(monday.contains("dentist call is tomorrow at 10:30"), monday)
        XCTAssertTrue(monday.contains("crash review is tomorrow at 2:00"), monday)
    }

    /// A calendar question that names a weekday says the day: "On Thursday ...".
    func testACalendarQuestionAboutAWeekdaySaysItsDay() {
        DemoServer.shared.reset(now: Self.pin) // Tuesday
        let reply = DemoReplies.chat(for: "What is on my calendar on Thursday?", clock: DemoServer.shared.clockNow).text
        XCTAssertTrue(reply.hasPrefix("On Thursday your calendar has"), reply)
        XCTAssertTrue(reply.contains("Yoga class"), reply)
    }

    // MARK: - Small things the pin showed

    /// The demo has no token, so Settings shows none.
    func testDemoSettingsShowNoToken() {
        XCTAssertFalse(SettingsView.showsTokenRow(serverURL: DemoMode.baseURLString))
        XCTAssertTrue(SettingsView.showsTokenRow(serverURL: "http://127.0.0.1:3000"))
    }

    /// At the accessibility sizes the drawer's title gets its own line, so a word
    /// never breaks beside the Clear button.
    func testTheRecentsTitleStacksAtAccessibilitySizes() {
        XCTAssertFalse(TasksRecentsDrawer.headerStacks(.large))
        XCTAssertFalse(TasksRecentsDrawer.headerStacks(.xxxLarge))
        XCTAssertTrue(TasksRecentsDrawer.headerStacks(.accessibility1))
        XCTAssertTrue(TasksRecentsDrawer.headerStacks(.accessibility5))
    }

    /// At the accessibility sizes a drawer row's title and meta wrap in full: two
    /// lines of title and one of meta cut "Fix the shared albu..." and the project
    /// after "2m ago" (App Store r7 gate, finding 14). Below them the row keeps its shape.
    func testTheRecentsRowsWrapInFullAtAccessibilitySizes() {
        for size in [DynamicTypeSize.large, .xxxLarge] {
            let limits = TasksRecentsDrawer.rowLineLimits(size)
            XCTAssertEqual(limits.title, 2, "\(size)")
            XCTAssertEqual(limits.meta, 1, "\(size)")
        }
        for size in [DynamicTypeSize.accessibility1, .accessibility5] {
            let limits = TasksRecentsDrawer.rowLineLimits(size)
            XCTAssertNil(limits.title, "\(size)")
            XCTAssertNil(limits.meta, "\(size)")
        }
    }
}
