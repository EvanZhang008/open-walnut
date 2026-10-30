import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// What Walnut added to a person's message (its notes in front, the context blocks it
/// put first, its message hints) is hidden in the session chat by default and shown
/// on request, for one message (the bubble's long-press item) or always (the server's
/// `ui.show_walnut_additions`), as the web chat does (2026-10-29). Pins the wire, the
/// plan, the rows the layout actor builds from it, their heights, and the setting.
@MainActor
final class WalnutAddedTests: XCTestCase {
    private let pageWidth: CGFloat = 393
    private let scope = "s"

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        MainWork.resetForTesting()
    }

    override func tearDown() {
        TimelineTextStyler.adopt(.unspecified)
        super.tearDown()
    }

    // MARK: - Fixtures

    private let rider = "<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"moved\">\nThis task moved.\n</walnut-message>"
    private let context = "[Conversation context]\nEarlier: the review was done.\n[/Conversation context]"
    private let contextItem = WalnutAddedItem(kind: "context", name: "Conversation context",
                                              label: "Context", text: "Earlier: the review was done.")
    private let hintItem = WalnutAddedItem(kind: "hint", name: "rich-output", label: "Rich output",
                                           text: "rich output mode is still on.")

    /// A person's row as the server sends it: a note in front, a context block, the
    /// words, the hint already taken off, and `textWithoutContext`.
    private func personRow(createdAt: String = "2026-10-29T00:00:01Z") -> ChatMessage {
        var m = ChatMessage(id: "u1", role: "user", text: "\(rider)\n\n\(context)\n\nPlease tidy the notes.",
                            createdAt: createdAt, kind: nil)
        m.sentBy = "person"
        m.added = [contextItem, hintItem]
        m.textWithoutContext = "\(rider)\n\nPlease tidy the notes."
        return m
    }

    private func answer(_ at: String = "2026-10-29T00:00:02Z") -> ChatMessage {
        ChatMessage(id: "a1", role: "assistant", text: "Tidied.", createdAt: at, kind: nil)
    }

    private func plan(_ rows: [ChatMessage],
                      additions: TimelineTurnFold.Additions = .init()) -> [TimelineTurnFold.Part] {
        TimelineTurnFold.plan(rows, turns: TimelineTurnShape.shape(rows, streaming: false), additions: additions)
    }

    private func outline(_ parts: [TimelineTurnFold.Part]) -> [String] {
        parts.map { part in
            switch part {
            case .message(let m): return m.isUser ? "bubble:\(m.text)" : "text"
            case .run(_, let members): return "run:\(members.count)"
            case .inbound: return "inbound"
            case .ack: return "ack"
            case .fold(let f): return "fold:\(f.phrase)"
            case .added(_, let items): return "added:" + items.map(\.label).joined(separator: ",")
            }
        }
    }

    private func bubble(_ parts: [TimelineTurnFold.Part]) -> ChatMessage? {
        for part in parts { if case .message(let m) = part, m.isUser { return m } }
        return nil
    }

    private func rows(_ messages: [ChatMessage], expanded: Set<String> = [], showAll: Bool = false,
                      category: UIContentSizeCategory = .unspecified) async -> [TimelineRow] {
        await TimelineLayoutActor().buildSnapshot(TimelineInput(
            messages: messages, streaming: false, liveText: "", liveTextTruncated: false,
            activity: nil, showLoadEarlier: false, width: pageWidth, expandedRowIDs: expanded,
            scope: scope, sizeCategory: category, showWalnutAdditions: showAll)).rows
    }

    private func bubbleRow(_ rows: [TimelineRow]) -> (text: String, menu: TimelineAddedMenu?)? {
        for row in rows {
            if case .userBubble(let text, _, _, _, let menu) = row.content { return (text.string, menu) }
        }
        return nil
    }

    private func revealKey() -> String {
        bubble(plan([personRow(), answer()]))?.walnutAddedToggle?.key ?? ""
    }

    // MARK: - Wire

    func testTranscriptRowsDecodeWhatWalnutAddedAndAnOlderRowDecodesWithout() throws {
        let json = """
        {"sessionId":"s","exportedAt":"2026-10-29T00:00:00Z","truncated":false,"messages":[
          {"role":"user","text":"[Conversation context]\\nEarlier.\\n[/Conversation context]\\n\\nGo.",
           "timestamp":"2026-10-29T00:00:01Z","sentBy":"person","textWithoutContext":"Go.",
           "added":[{"kind":"context","name":"Conversation context","label":"Context","text":"Earlier."},
                    {"kind":"hint","name":"rich-output","label":"Rich output","text":"rich output mode is on."}]},
          {"role":"user","text":"Old.","timestamp":"2026-10-29T00:00:02Z","sentBy":"person"},
          {"role":"user","text":"Older still.","timestamp":"2026-10-29T00:00:03Z"}]}
        """
        let transcript = try JSONDecoder().decode(SessionTranscript.self, from: Data(json.utf8))
        XCTAssertEqual(transcript.messages[0].textWithoutContext, "Go.")
        XCTAssertEqual(transcript.messages[0].added?.map(\.label), ["Context", "Rich output"])
        XCTAssertEqual(transcript.messages[0].added?.first?.text, "Earlier.")
        XCTAssertNil(transcript.messages[1].added)
        XCTAssertNil(transcript.messages[1].textWithoutContext)
        XCTAssertNil(transcript.messages[2].added)
        // The store's rows carry both, so the timeline can read them.
        let held = SessionConversationStore.keepingWholeText(transcript.messages, held: [])
        XCTAssertEqual(held[0].textWithoutContext, "Go.")
        XCTAssertEqual(held[0].added?.count, 2)
        XCTAssertEqual(held[0].text, transcript.messages[0].text, "text stays whole for older apps")
        XCTAssertNil(held[1].added)
    }

    func testChatMessageKeepsWhatWalnutAddedThroughItsDiskCopyAndEveryRebuild() throws {
        let m = personRow()
        let copy = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(m))
        XCTAssertEqual(copy.added, m.added)
        XCTAssertEqual(copy.textWithoutContext, m.textWithoutContext)
        let replaced = m.replacingText("Other words.")
        XCTAssertEqual(replaced.added, m.added)
        XCTAssertEqual(replaced.textWithoutContext, m.textWithoutContext)
        XCTAssertEqual(replaced.sentBy, "person")
        // An item a newer server shapes with a field missing still reads.
        let item = try JSONDecoder().decode(WalnutAddedItem.self, from: Data(#"{"kind":"hint","name":"x"}"#.utf8))
        XCTAssertEqual(item.label, "x")
        XCTAssertEqual(item.text, "")
    }

    func testConfigCarriesTheAlwaysShowSettingAndAnOlderServerReadsOff() throws {
        let on = try JSONDecoder().decode(ServerConfigInfo.self, from: Data("""
        {"config":{"user":{},"ui":{"show_walnut_additions":true}},"cloud":false}
        """.utf8))
        XCTAssertTrue(on.showWalnutAdditions)
        let off = try JSONDecoder().decode(ServerConfigInfo.self, from: Data("""
        {"config":{"user":{},"ui":{"show_walnut_additions":false}}}
        """.utf8))
        XCTAssertFalse(off.showWalnutAdditions)
        let older = try JSONDecoder().decode(ServerConfigInfo.self, from: Data(#"{"config":{"user":{}}}"#.utf8))
        XCTAssertFalse(older.showWalnutAdditions)
    }

    // MARK: - The plan

    func testByDefaultThePersonsBubbleHoldsOnlyTheirWordsAndOffersTheRestOnALongPress() {
        let parts = plan([personRow(), answer()])
        XCTAssertEqual(outline(parts), ["bubble:Please tidy the notes.", "text"])
        let toggle = bubble(parts)?.walnutAddedToggle
        XCTAssertEqual(toggle?.count, 3, "one note in front plus two added items")
        XCTAssertEqual(toggle?.shown, false)
    }

    func testRevealedTheNotesReadAboveTheBubbleAndTheRestIsOneRowUnderIt() {
        let key = revealKey()
        XCTAssertFalse(key.isEmpty)
        let parts = plan([personRow(), answer()], additions: .init(showAll: false, isRevealed: { $0 == key }))
        XCTAssertEqual(outline(parts), [
            "inbound", "bubble:Please tidy the notes.", "added:Context,Rich output", "text",
        ])
        XCTAssertEqual(bubble(parts)?.walnutAddedToggle?.shown, true)
        // Another message's reveal shows nothing here.
        XCTAssertEqual(outline(plan([personRow(), answer()], additions: .init(isRevealed: { $0 != key }))),
                       ["bubble:Please tidy the notes.", "text"])
    }

    func testTheAlwaysShowSettingShowsThemWithNoMenuStep() {
        let parts = plan([personRow(), answer()], additions: .init(showAll: true))
        XCTAssertEqual(outline(parts), [
            "inbound", "bubble:Please tidy the notes.", "added:Context,Rich output", "text",
        ])
        XCTAssertNil(bubble(parts)?.walnutAddedToggle, "no long-press item when they always show")
    }

    func testTheBubbleDrawsTheTextWithoutContextAndNeverTheRawBlock() async {
        // No note in front, only a context block: the bubble is the words alone.
        var m = ChatMessage(id: "u1", role: "user", text: "\(context)\n\nWhat changed?",
                            createdAt: "2026-10-29T00:00:01Z", kind: nil)
        m.sentBy = "person"
        m.added = [contextItem]
        m.textWithoutContext = "What changed?"
        XCTAssertEqual(outline(plan([m, answer()])), ["bubble:What changed?", "text"])
        for showAll in [false, true] {
            let built = await rows([m, answer()], showAll: showAll)
            let drawn = bubbleRow(built)
            XCTAssertEqual(drawn?.text, "What changed?")
            XCTAssertFalse(built.contains { row in
                if case .text(let s) = row.content { return s.string.contains("[Conversation context]") }
                return false
            })
        }
    }

    func testAnOlderRowWithoutTheFieldsIsDrawnAsBefore() {
        // A plain person row: its own text, no menu item.
        var plain = ChatMessage(id: "u1", role: "user", text: "Just words.", createdAt: "2026-10-29T00:00:01Z", kind: nil)
        plain.sentBy = "person"
        let parts = plan([plain, answer()])
        XCTAssertEqual(outline(parts), ["bubble:Just words.", "text"])
        XCTAssertNil(bubble(parts)?.walnutAddedToggle)
        // A server that says nobody sent anything: the row is drawn whole, as before.
        let legacy = ChatMessage(id: "u1", role: "user", text: "\(rider)\n\nHello.",
                                 createdAt: "2026-10-29T00:00:01Z", kind: nil)
        XCTAssertFalse(TimelineTurnShape.knowsSenders([legacy, answer()]))
        // A row with a note and nothing else added still offers the note, counted once.
        var noted = ChatMessage(id: "u1", role: "user", text: "\(rider)\n\nHello.",
                                createdAt: "2026-10-29T00:00:01Z", kind: nil)
        noted.sentBy = "person"
        XCTAssertEqual(bubble(plan([noted, answer()]))?.walnutAddedToggle?.count, 1)
    }

    func testARowWithNoWordsOfThePersonIsUnchanged() {
        var delivery = ChatMessage(id: "u1", role: "user", text: rider, createdAt: "2026-10-29T00:00:01Z", kind: nil)
        delivery.sentBy = "agent"
        delivery.added = [hintItem]
        let parts = plan([delivery])
        XCTAssertEqual(outline(parts), ["inbound"])
        // A person's row that is only Walnut's context keeps its whole text.
        var only = ChatMessage(id: "u2", role: "user", text: context, createdAt: "2026-10-29T00:00:03Z", kind: nil)
        only.sentBy = "person"
        only.textWithoutContext = ""
        XCTAssertEqual(TimelineTurnFold.ownText(only), context)
    }

    // MARK: - Rows

    func testTheRowsTheActorBuildsHideRevealAndOpen() async {
        let messages = [personRow(), answer()]
        // Hidden: no note line and no added row; the bubble's menu offers all three.
        let hidden = await rows(messages)
        XCTAssertEqual(bubbleRow(hidden)?.text, "Please tidy the notes.")
        XCTAssertEqual(bubbleRow(hidden)?.menu?.title, "Show what Walnut added (3)")
        XCTAssertFalse(hidden.contains { $0.content.reuseKind == "peerMessage" })
        XCTAssertFalse(hidden.contains { $0.content.reuseKind == "toolRun" })
        let key = revealKey()
        let reveal = TimelineTurnFold.revealRowID(scope: scope, key: key)
        XCTAssertEqual(bubbleRow(hidden)?.menu?.toggleRowID, reveal)
        // Revealed: the note's line, the bubble, then one closed "Walnut added" row.
        let shown = await rows(messages, expanded: [reveal])
        XCTAssertEqual(shown.map(\.content.reuseKind), ["peerMessage", "bubble", "toolRun", "text"])
        XCTAssertEqual(bubbleRow(shown)?.menu?.title, "Hide what Walnut added")
        let foldID = TimelineTurnFold.rowID(scope: scope, key: key)
        guard case .toolRun(let phrase, _, _, let expanded, _) = shown[2].content else { return XCTFail("no row") }
        XCTAssertEqual(phrase, "Walnut added: Context \u{00B7} Rich output")
        XCTAssertFalse(expanded)
        XCTAssertEqual(shown[2].id, foldID)
        // Opened: each item's label and its whole text, under the row.
        let open = await rows(messages, expanded: [reveal, foldID])
        XCTAssertEqual(open.map(\.content.reuseKind), ["peerMessage", "bubble", "toolRun", "text", "text", "text"])
        let items = open[3...4].compactMap { row -> String? in
            if case .text(let s) = row.content { return s.string }
            return nil
        }
        XCTAssertEqual(items, ["Context\nEarlier: the review was done.",
                               "Rich output\nrich output mode is still on."])
        // Closed again: back to the one row.
        let closed = await rows(messages, expanded: [reveal])
        XCTAssertEqual(closed.map(\.content.reuseKind), ["peerMessage", "bubble", "toolRun", "text"])
        // The setting on: shown with no reveal and no menu item.
        let always = await rows(messages, showAll: true)
        XCTAssertEqual(always.map(\.content.reuseKind), ["peerMessage", "bubble", "toolRun", "text"])
        XCTAssertNil(bubbleRow(always)?.menu)
    }

    func testTheRevealSurvivesARichReadReplacingTheRowsPayload() {
        let key = revealKey()
        var richer = personRow()
        richer = ChatMessage(id: "other-id", role: "user", text: richer.text + " ", createdAt: richer.createdAt, kind: nil)
        richer.sentBy = "person"
        richer.added = [contextItem, hintItem]
        XCTAssertEqual(bubble(plan([richer, answer()]))?.walnutAddedToggle?.key, key,
                       "named by the row's place, not its id or text")
    }

    // MARK: - Heights

    /// The "Walnut added" row is the turn fold's capsule: SwiftUI must not lay it out
    /// taller than the row the actor gave it, at either end of the text-size range.
    func testTheAddedRowFitsItsHeightAtEveryTextSize() async {
        let messages = [personRow(), answer()]
        let key = revealKey()
        let foldID = TimelineTurnFold.rowID(scope: scope, key: key)
        var checked = 0
        for category in [UIContentSizeCategory.extraSmall, .large, .accessibilityExtraExtraExtraLarge] {
            let built = await rows(messages, expanded: [foldID], showAll: true, category: category)
            for row in built where row.content.reuseKind == "toolRun" {
                let rendered = hostedHeight(row, category: category)
                XCTAssertLessThanOrEqual(ceil(rendered), ceil(row.height) + 1,
                                         "\(category.rawValue): given \(row.height)pt, laid out at \(rendered)pt")
                XCTAssertLessThanOrEqual(row.height, rendered + max(4, rendered * 0.02),
                                         "\(category.rawValue): reserves too much")
                checked += 1
            }
            // Each opened item is a TextKit row: measured exactly as the text cell lays it out.
            TimelineTextStyler.adopt(category)
            for row in built {
                guard case .text(let s) = row.content, s.string.hasPrefix("Context") || s.string.hasPrefix("Rich") else { continue }
                let tv = TimelineTextView()
                tv.attributedText = s
                let rendered = tv.sizeThatFits(CGSize(width: TimelineMetrics.assistantTextWidth(pageWidth),
                                                      height: .greatestFiniteMagnitude)).height
                XCTAssertEqual(row.height - TimelineMetrics.textVPad * 2, ceil(rendered), accuracy: 2,
                               "\(category.rawValue): item text measured \(row.height) vs rendered \(rendered)")
                checked += 1
            }
        }
        XCTAssertGreaterThanOrEqual(checked, 9, "gate checked nothing (n=\(checked))")
        // At the largest size the long phrase wraps rather than truncating.
        TimelineTextStyler.adopt(.accessibilityExtraExtraExtraLarge)
        let builder = TimelineRowBuilder()
        let wide = builder.addedRows(id: "w", items: [contextItem, hintItem], expanded: false, width: pageWidth)[0]
        let one = builder.foldRow(id: "o", phrase: "Ran", failCount: 0, expanded: false, width: pageWidth)
        XCTAssertGreaterThan(wide.height, one.height)
    }

    private func hostedHeight(_ row: TimelineRow, category: UIContentSizeCategory) -> CGFloat {
        let content = TimelineHostedCell.content(for: row, delegate: nil)
        let host: UIHostingController<AnyView>
        if let size = DynamicTypeSize(category) {
            host = UIHostingController(rootView: AnyView(content.dynamicTypeSize(size)))
            host.traitOverrides.preferredContentSizeCategory = category
        } else {
            host = UIHostingController(rootView: AnyView(content))
        }
        host.view.backgroundColor = .clear
        return host.sizeThatFits(in: CGSize(width: pageWidth, height: .greatestFiniteMagnitude)).height
    }

    // MARK: - The setting

    func testTheSettingIsReadKeyedByServerAndAFailedReadKeepsIt() async throws {
        let suite = "walnut-added-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var answer: Result<Bool, Error> = .success(true)
        var server = "http://a.example"
        let setting = WalnutAdditionsSetting(defaults: defaults, fetch: { try answer.get() },
                                             currentServer: { server })
        XCTAssertFalse(setting.showAll, "off until the server says otherwise")
        await setting.refresh()
        XCTAssertTrue(setting.showAll)
        // A failed read keeps what it had.
        answer = .failure(URLError(.notConnectedToInternet))
        await setting.refresh()
        XCTAssertTrue(setting.showAll)
        // A relaunch draws it as chosen before the read answers.
        let relaunched = WalnutAdditionsSetting(defaults: defaults, fetch: { throw URLError(.timedOut) },
                                                currentServer: { server })
        XCTAssertTrue(relaunched.showAll)
        // Paired with another server: its choice is not this one's.
        server = "http://b.example"
        await relaunched.refreshIfStale()
        XCTAssertFalse(relaunched.showAll)
    }
}
