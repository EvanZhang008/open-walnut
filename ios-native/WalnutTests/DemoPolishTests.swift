import Foundation
import UIKit
import XCTest
@testable import Walnut

/// The demo's small surfaces a reviewer reads first: the Demo label, the voice
/// reply, the fixture copy, the Settings address, and the letter title.
@MainActor
final class DemoPolishTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private let api = WalnutAPI()

    override func setUp() async throws {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        DemoServer.shared.latencyScale = 0
        DemoServer.shared.turnScale = 0
        DemoServer.shared.reset()
    }

    override func tearDown() async throws {
        DemoServer.shared.reset()
        DemoServer.shared.latencyScale = 1
        DemoServer.shared.turnScale = 1
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    // MARK: - The Demo label

    /// WCAG 2.x relative luminance of an opaque colour in one scheme.
    private func luminance(_ color: UIColor, dark: Bool) -> Double {
        let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
        func linear(_ channel: CGFloat) -> Double {
            let c = Double(channel)
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    func testTheSampleDataLabelClearsTheTextBarInBothSchemes() throws {
        for dark in [false, true] {
            let ink = luminance(DemoBanner.inkColor, dark: dark)
            let fill = luminance(DemoBanner.fillColor, dark: dark)
            let ratio = (max(ink, fill) + 0.05) / (min(ink, fill) + 0.05)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "dark=\(dark): the label measured \(ratio)")
        }
        // Both words draw in that ink: a secondary style on either one is what
        // measured 2.0:1 light and 2.5:1 dark.
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut/Demo/DemoChrome.swift"), encoding: .utf8)
        let bannerSource = try XCTUnwrap(source.components(separatedBy: "struct DemoBanner: View {").dropFirst().first?
            .components(separatedBy: "private struct DemoModeChrome").first)
        // Code only: the doc comment names the style it replaced.
        let banner = bannerSource.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        for faded in [".secondary", ".tertiary", ".opacity("] {
            XCTAssertFalse(banner.contains(faded), "the Demo label draws text in \(faded)")
        }
    }

    // MARK: - The voice reply

    func testTheDemoVoiceSentenceGetsAReminderReply() {
        // A Tuesday and a Friday, October 2026: the sentence names the next work day.
        for (day, when) in [(6, "**tomorrow morning**"), (9, "**Monday morning**")] {
            let morning = Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: day, hour: 9, minute: 41))!
            let clock = DemoClock(now: morning)
            let reply = DemoReplies.chat(for: DemoFixtures.transcriptionSentence(clock), clock: clock).text
            XCTAssertTrue(reply.contains("**Send the counter quotes to the contractor**"), reply)
            XCTAssertTrue(reply.contains(when), reply)
            XCTAssertFalse(reply.contains("Two of the three counter quotes"),
                           "a reminder is not answered with the kitchen status report")
        }
    }

    func testOtherQuestionsKeepTheirReplies() {
        XCTAssertTrue(DemoReplies.chat(for: "How are the kitchen quotes going?").text
            .contains("Two of the three counter quotes"))
        XCTAssertTrue(DemoReplies.chat(for: "Do you remember the counter quotes?").text
            .contains("Two of the three counter quotes"), "a question is not a reminder")
        let morning = DemoClock(now: Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date())!)
        XCTAssertTrue(DemoReplies.chat(for: "What should I focus on today?", clock: morning).text.contains("today at a glance"))
        let evening = DemoClock(now: Calendar.current.date(bySettingHour: 22, minute: 0, second: 0, of: Date())!)
        XCTAssertTrue(DemoReplies.chat(for: "What should I focus on today?", clock: evening).text.contains("tomorrow at a glance"))
        let plumber = DemoReplies.chat(for: "Add a task to call the plumber tomorrow").text
        XCTAssertTrue(plumber.contains("**Call the plumber**") && plumber.contains("**tomorrow**"), plumber)
    }

    // MARK: - Fixture copy

    /// A long code span with punctuation right after it wraps on a phone and
    /// leaves a lone period at the start of the next line.
    func testNoLongCodeSpanIsFollowedByPunctuation() throws {
        let state = DemoFixtures.seed()
        var texts: [String] = []
        texts += state.sessions.flatMap { $0.transcript.map(\.text) }
        texts += state.conversations.flatMap { $0.messages.map(\.text) }
        texts += state.letters.flatMap { [$0.body ?? "", $0.textPreview ?? ""] }
        texts += state.notes.map(\.content)
        texts += state.tasks.flatMap { [$0.summary ?? "", $0.description ?? "", $0.note ?? ""] }
        let pattern = try NSRegularExpression(pattern: "`[^`\\n]{20,}`[.,;:!?]")
        for text in texts {
            let range = NSRange(text.startIndex..., in: text)
            XCTAssertNil(pattern.firstMatch(in: text, range: range), "code span then punctuation in: \(text.prefix(80))")
        }
    }

    // MARK: - Settings

    func testSettingsNamesTheDemoAsADemoNotAnAddress() {
        XCTAssertEqual(SettingsView.addressText(DemoMode.baseURLString), "Demo with sample data, no server")
        XCTAssertEqual(SettingsView.addressText("https://walnut.example.net"), "https://walnut.example.net")
        XCTAssertEqual(SettingsView.addressText(""), "Not configured")
    }

    // MARK: - The letter reader

    func testTheLetterTitleSaysAnsweredOnceAnswered() async throws {
        let before = try await api.letter(id: "l-headline")
        XCTAssertNil(before.answered)
        XCTAssertEqual(LetterReaderView.title(for: before), before.kind.label)
        XCTAssertEqual(LetterReaderView.title(for: before), "Action needed")
        XCTAssertTrue(LetterEnvelopeRow.showsTypeBadge(before))
        _ = try await api.answerLetter(id: "l-headline", actionId: "b")
        settleTurns()
        let after = try await api.letter(id: "l-headline")
        XCTAssertNotNil(after.answered)
        XCTAssertEqual(LetterReaderView.title(for: after), "Answered", "the same word the inbox row's chip uses")
        XCTAssertEqual(LetterReaderView.title(for: nil), "Letter")
        // The row drops its "Action needed" badge once answered, and keeps the
        // badge of every other kind.
        XCTAssertFalse(LetterEnvelopeRow.showsTypeBadge(after), "an answered row said Action needed next to Answered")
        let kitchen = try await api.letter(id: "l-counters")
        XCTAssertTrue(LetterEnvelopeRow.showsTypeBadge(kitchen))
    }

    private func settleTurns() {
        let deadline = Date().addingTimeInterval(5)
        while DemoServer.shared.pendingStepCount > 0, Date() < deadline {
            usleep(5_000)
        }
        DemoServer.shared.turnQueue.sync {}
        DemoServer.shared.streams.drain()
        XCTAssertEqual(DemoServer.shared.pendingStepCount, 0, "scripted turns did not finish")
    }

    /// Answering a letter reaches the session that asked: the answer is its next
    /// turn, it does the work, closes the task, ticks the release plan and
    /// writes back in the thread (App Store gate, 2026-10-02: nothing moved).
    func testAnsweringTheHeadlineLetterMovesItsSessionAndTask() async throws {
        _ = try await api.answerLetter(id: "l-headline", actionId: "b")
        settleTurns()
        let transcript = try await api.sessionTranscript(id: "s-copy")
        let texts = transcript.messages.map(\.text)
        XCTAssertTrue(texts.contains { $0.contains("Ship option B") }, "the answer never reached the session")
        XCTAssertTrue(texts.last?.contains("**Your photos, together**") == true, texts.last ?? "")
        let tasks = try await api.tasks().tasks
        XCTAssertEqual(tasks.first { $0.id == "t-copy" }?.phase, "COMPLETE")
        XCTAssertEqual(tasks.first { $0.id == "t-testflight" }?.summary, "Waiting on the crash fix.")
        let session = try await api.sessions().sessions.first { $0.id == "s-copy" }
        XCTAssertEqual(session?.processStatus, "idle")
        let letter = try await api.letter(id: "l-headline")
        XCTAssertEqual(letter.thread?.last?.from, "agent")
        XCTAssertTrue(letter.thread?.last?.text?.contains("Your photos, together") == true)
        // A thread turn's `text` shows as written (only a `body` renders
        // markdown), so the demo's agent turns carry no markup.
        let turns = [("l-headline", "b"), ("l-merge", "merge"), ("l-merge", "wait")].compactMap {
            DemoReplies.letterTurn(letterID: $0.0, actionID: $0.1, label: "Ship option B",
                                   description: "Your photos, together", cwd: "")
        }
        XCTAssertEqual(turns.count, 3)
        for turn in turns {
            XCTAssertFalse(turn.threadReply.contains("**"), turn.threadReply)
            XCTAssertFalse(turn.threadReply.contains("`"), turn.threadReply)
        }
        XCTAssertFalse(letter.thread?.last?.text?.contains("**") ?? true, "the thread showed the asterisks")
        let plan = try await api.noteContent(path: "Pebble/Release 2.4 plan.md")
        XCTAssertTrue(plan.content.contains("- [x] New onboarding headline"), plan.content)
    }

    func testWaitingOnTheCrashFixKeepsTheOfflineTaskOpen() async throws {
        _ = try await api.answerLetter(id: "l-merge", actionId: "wait")
        settleTurns()
        let texts = try await api.sessionTranscript(id: "s-offline").messages.map(\.text)
        XCTAssertTrue(texts.contains { $0.contains("Wait for the crash fix") })
        let offline = try await api.tasks().tasks.first { $0.id == "t-offline" }
        XCTAssertEqual(offline?.phase, "IN_PROGRESS")
        XCTAssertEqual(offline?.summary, "Ready to merge after the crash fix lands.")
    }

    // MARK: - Settings in the demo

    /// The card names both resets, and the status does not claim a server.
    func testTheDemoCardNamesBothResetsAndTheStatusSaysDemo() {
        XCTAssertTrue(DemoMode.changesNote.contains("when you leave the demo"))
        XCTAssertTrue(DemoMode.changesNote.contains("the app restarts"))
        XCTAssertEqual(DemoMode.statusLabel, "Demo")
    }

    /// The board's badge uses the same word as Settings in the demo, and keeps
    /// its server words outside it.
    func testTheStatusBadgeSaysDemoInTheDemoAndLiveOutsideIt() {
        XCTAssertEqual(StatusBadge.label(online: true, mode: .live, inDemo: true), "Demo")
        XCTAssertEqual(StatusBadge.label(online: false, mode: nil, inDemo: true), "Demo")
        XCTAssertEqual(StatusBadge.label(online: true, mode: .live, inDemo: false), "Live")
        XCTAssertEqual(StatusBadge.label(online: true, mode: .replica, inDemo: false), "Replica")
        XCTAssertEqual(StatusBadge.label(online: false, mode: .live, inDemo: false), "Offline")
    }

    /// A relaunch starts the demo server from its sample data; the cached copies
    /// of the last run go too, the pending-create overlay included.
    func testALaunchInTheDemoDropsTheLastRunsCaches() async {
        DiskCache.save(["leftover"], key: "tasks-pending-created")
        let before = await DiskCache.loadAsync([String].self, key: "tasks-pending-created")
        XCTAssertEqual(before, ["leftover"])
        DemoEntry.startFreshAtLaunch()
        let after = await DiskCache.loadAsync([String].self, key: "tasks-pending-created")
        XCTAssertNil(after)
    }

    /// Disconnect says what it cannot do: an unreachable server keeps its row.
    func testTheDisconnectConfirmationNamesTheUnreachableServerLimit() {
        XCTAssertTrue(SettingsView.disconnectMessage.contains("can't be reached"))
        XCTAssertTrue(SettingsView.disconnectMessage.contains("revoke the phone"))
    }

    // MARK: - The calendar in the demo

    /// The demo never asks for calendar access: its calendar is the sample one,
    /// which reports access without calling EventKit and lists sample events.
    func testTheDemoCalendarNeverAsksAndShowsSampleEvents() async {
        let store = DeviceCalendarStore.forCurrentPairing()
        XCTAssertEqual(store.access, .granted, "granted from the start, so the view never requests access")
        await store.requestAccessIfNeeded()
        // The sample events start the day after the chat's plan (today's, or
        // tomorrow's late in the day).
        let dayAfterPlan = Calendar.current.date(byAdding: .day, value: DemoClock().plan().day + 1, to: Date())!
        await store.loadRange(from: Date().addingTimeInterval(-86_400), to: Date().addingTimeInterval(8 * 86_400))
        let all = store.eventsByDay.values.flatMap { $0 }
        XCTAssertFalse(all.isEmpty)
        XCTAssertTrue(all.allSatisfy { $0.id.hasPrefix("demo-event-") })
        XCTAssertTrue(all.contains { Calendar.current.isDate($0.start, inSameDayAs: dayAfterPlan) })
    }

    func testOutsideTheDemoTheCalendarIsThePhones() async {
        AppConfig.processServerURLOverride = URL(string: "https://walnut.example.net")
        let store = DeviceCalendarStore.forCurrentPairing()
        await store.loadRange(from: Date(), to: Date().addingTimeInterval(8 * 86_400))
        XCTAssertFalse(store.eventsByDay.values.flatMap { $0 }.contains { $0.id.hasPrefix("demo-event-") })
    }
}
