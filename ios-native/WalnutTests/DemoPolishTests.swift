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
        let reply = DemoReplies.chat(for: DemoFixtures.transcriptionSentence).text
        XCTAssertTrue(reply.contains("**Send the counter quotes to the contractor**"), reply)
        XCTAssertTrue(reply.contains("**Friday morning**"), reply)
        XCTAssertFalse(reply.contains("Two of the three counter quotes"),
                       "a reminder is not answered with the kitchen status report")
    }

    func testOtherQuestionsKeepTheirReplies() {
        XCTAssertTrue(DemoReplies.chat(for: "How are the kitchen quotes going?").text
            .contains("Two of the three counter quotes"))
        XCTAssertTrue(DemoReplies.chat(for: "Do you remember the counter quotes?").text
            .contains("Two of the three counter quotes"), "a question is not a reminder")
        XCTAssertTrue(DemoReplies.chat(for: "What should I focus on today?").text.contains("today at a glance"))
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
        _ = try await api.answerLetter(id: "l-headline", actionId: "b")
        let after = try await api.letter(id: "l-headline")
        XCTAssertNotNil(after.answered)
        XCTAssertEqual(LetterReaderView.title(for: after), "Answered", "the same word the inbox row's chip uses")
        XCTAssertEqual(LetterReaderView.title(for: nil), "Letter")
    }
}
