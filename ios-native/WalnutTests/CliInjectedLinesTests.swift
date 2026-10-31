import XCTest
import UIKit
@testable import Walnut

/// The lines the CLI put into a session's conversation itself (a loaded skill's
/// text, a hook's added context, a continuation summary) ride the transcript row
/// beside them (`injectedAfter`, `injectedBefore` on the first row) and the phone
/// draws each as one closed row that opens to its text, folded with the steps around
/// it, as the web chat does (2026-10-30). Pins the wire, the expansion (order, ids,
/// the same line read twice across a page boundary), the turn shape and fold, the
/// fold line's words, and the rows the layout actor builds.
@MainActor
final class CliInjectedLinesTests: XCTestCase {
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

    private let skill = CliInjectedItem(kind: "skill", label: "Loaded skill release-notes",
                                        text: "Base directory for this skill: /skills/release-notes\n\n# Release notes")
    private let hook = CliInjectedItem(kind: "hook", label: "Added by the SessionStart hook",
                                       text: "The docs build with bun.")
    private let stopHook = CliInjectedItem(kind: "hook", label: "Added by the Stop hook",
                                           text: "Remember the changelog.")
    private let summary = CliInjectedItem(kind: "context", label: "Continuation summary",
                                          text: "This session is being continued from a previous conversation.")

    private var clock = 0
    private func at() -> String { clock += 1; return String(format: "2026-10-30T00:00:%02dZ", clock) }
    private func person(_ text: String = "Draft the release notes.") -> ChatMessage {
        var m = ChatMessage(id: "u\(clock)", role: "user", text: text, createdAt: at(), kind: nil)
        m.sentBy = "person"
        return m
    }
    private func said(_ text: String) -> ChatMessage {
        ChatMessage(id: "a\(clock)", role: "assistant", text: text, createdAt: at(), kind: nil)
    }
    private func tool(_ name: String, _ detail: String? = nil) -> ChatMessage {
        ChatMessage(id: "t\(clock)", role: "assistant", text: name, createdAt: at(), kind: .tool,
                    detail: detail, resultPreview: "ok")
    }
    private func carrying(_ m: ChatMessage, after: [CliInjectedItem]? = nil,
                          before: [CliInjectedItem]? = nil) -> ChatMessage {
        var copy = m
        copy.injectedAfter = after
        copy.injectedBefore = before
        return copy
    }

    private func plan(_ rows: [ChatMessage]) -> [TimelineTurnFold.Part] {
        let expanded = TimelineInjectedLines.expand(rows)
        return TimelineTurnFold.plan(expanded, turns: TimelineTurnShape.shape(expanded, streaming: false))
    }

    private func outline(_ parts: [TimelineTurnFold.Part]) -> [String] {
        parts.map { part in
            switch part {
            case .message(let m):
                if m.kind == .injected { return "injected:\(m.detail ?? "")" }
                return m.isUser ? "bubble:\(m.text)" : (m.kind == .tool ? "tool:\(m.text)" : "text")
            case .run(_, let members): return "run:\(members.count)"
            case .inbound: return "inbound"
            case .ack: return "ack"
            case .fold(let f): return "fold:\(f.phrase)\(outline(f.members))"
            case .added(_, let items): return "added:" + items.map(\.label).joined(separator: ",")
            }
        }
    }

    private func rows(_ messages: [ChatMessage], expanded: Set<String> = [],
                      showAll: Bool = false) async -> [TimelineRow] {
        await TimelineLayoutActor().buildSnapshot(TimelineInput(
            messages: messages, streaming: false, liveText: "", liveTextTruncated: false,
            activity: nil, showLoadEarlier: false, width: pageWidth, expandedRowIDs: expanded,
            scope: scope, showWalnutAdditions: showAll)).rows
    }

    private func phrases(_ rows: [TimelineRow]) -> [String] {
        rows.compactMap { row in
            if case .toolRun(let phrase, _, _, _, _) = row.content { return phrase }
            return nil
        }
    }

    private func bubbleTexts(_ rows: [TimelineRow]) -> [String] {
        rows.compactMap { row in
            if case .userBubble(let text, _, _, _, _) = row.content { return text.string }
            return nil
        }
    }

    // MARK: - Wire

    func testTranscriptRowsDecodeTheLinesAndAnOlderRowDecodesWithout() throws {
        let json = """
        {"sessionId":"s","exportedAt":"2026-10-30T00:00:00Z","truncated":false,"messages":[
          {"role":"user","text":"Go.","timestamp":"2026-10-30T00:00:01Z","sentBy":"person",
           "injectedBefore":[{"kind":"hook","label":"Added by the SessionStart hook","text":"Hi."}]},
          {"role":"assistant","text":"Skill","timestamp":"2026-10-30T00:00:02Z","kind":"tool","detail":"release-notes",
           "injectedAfter":[{"kind":"skill","label":"Loaded skill release-notes","text":"Base directory for this skill: /x"},
                            {"kind":"context","label":"Continuation summary","text":"This session is being continued."}]},
          {"role":"assistant","text":"Done.","timestamp":"2026-10-30T00:00:03Z"}]}
        """
        let transcript = try JSONDecoder().decode(SessionTranscript.self, from: Data(json.utf8))
        XCTAssertEqual(transcript.messages[0].injectedBefore?.map(\.kind), ["hook"])
        XCTAssertNil(transcript.messages[0].injectedAfter)
        XCTAssertEqual(transcript.messages[1].injectedAfter?.map(\.label),
                       ["Loaded skill release-notes", "Continuation summary"])
        XCTAssertNil(transcript.messages[2].injectedAfter)
        XCTAssertNil(transcript.messages[2].injectedBefore)
        // The store's rows carry both, on the tool row too.
        let held = SessionConversationStore.keepingWholeText(transcript.messages, held: [])
        XCTAssertEqual(held[0].injectedBefore, transcript.messages[0].injectedBefore)
        XCTAssertEqual(held[1].injectedAfter, transcript.messages[1].injectedAfter)
        XCTAssertEqual(held[1].kind, .tool)
        XCTAssertNil(held[2].injectedAfter)
        // An item a newer server shapes with a field missing still reads.
        let item = try JSONDecoder().decode(CliInjectedItem.self, from: Data(#"{"text":"x"}"#.utf8))
        XCTAssertEqual(item.kind, "context")
        XCTAssertEqual(item.label, "Injected context")
    }

    func testTheLinesSurviveTheDiskCopyAndEveryRebuild() throws {
        let m = carrying(person(), after: [skill], before: [hook])
        let copy = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(m))
        XCTAssertEqual(copy.injectedAfter, [skill])
        XCTAssertEqual(copy.injectedBefore, [hook])
        let replaced = m.replacingText("Other words.")
        XCTAssertEqual(replaced.injectedAfter, [skill])
        XCTAssertEqual(replaced.injectedBefore, [hook])
    }

    /// A slim poll clips a skill's text at its smaller budget: the whole text a rich
    /// read delivered for the same place stays.
    func testAClippedLineKeepsTheWholeTextHeldForIt() {
        let whole = CliInjectedItem(kind: "skill", label: skill.label, text: skill.text + "\n\nStep one. Step two.")
        var held = tool("Skill", "release-notes")
        held.injectedAfter = [whole]
        let clipped = CliInjectedItem(kind: "skill", label: skill.label,
                                      text: String(whole.text.prefix(30)) + "\u{2026}")
        let incoming = SessionTranscript.Message(role: "assistant", text: "Skill", timestamp: held.createdAt,
                                                 kind: "tool", detail: "release-notes", injectedAfter: [clipped])
        let kept = SessionConversationStore.keepingWholeText([incoming], held: [held])
        XCTAssertEqual(kept[0].injectedAfter, [whole])
        // A line of another label at that place is not this one's whole text.
        let other = CliInjectedItem(kind: "skill", label: "Loaded skill other", text: clipped.text)
        let notKept = SessionConversationStore.keepingWholeText(
            [SessionTranscript.Message(role: "assistant", text: "Skill", timestamp: held.createdAt, kind: "tool",
                                       detail: "release-notes", injectedAfter: [other])], held: [held])
        XCTAssertEqual(notKept[0].injectedAfter, [other])
    }

    // MARK: - Expansion

    func testEachLineIsPutBackWhereItWasInOrder() {
        let first = carrying(person(), before: [hook, summary])
        let call = carrying(tool("Skill", "release-notes"), after: [skill, stopHook])
        let answer = carrying(said("Drafted."), after: [stopHook])
        let out = TimelineInjectedLines.expand([first, call, answer])
        XCTAssertEqual(out.map { $0.kind == .injected ? $0.detail ?? "" : $0.text }, [
            hook.label, summary.label, first.text,
            "Skill", skill.label, stopHook.label,
            "Drafted.", stopHook.label,
        ])
        // Each is named by its carrier's place and index, never by its words.
        let firstKey = TimelineTurnFold.locationKey(first) + "#0"
        let callKey = TimelineTurnFold.locationKey(call) + "#0"
        XCTAssertEqual(out[0].id, TimelineInjectedLines.rowID(firstKey, "before", 0))
        XCTAssertEqual(out[1].id, TimelineInjectedLines.rowID(firstKey, "before", 1))
        XCTAssertEqual(out[4].id, TimelineInjectedLines.rowID(callKey, "after", 0))
        XCTAssertEqual(out[5].id, TimelineInjectedLines.rowID(callKey, "after", 1))
        XCTAssertEqual(Set(out.map(\.id)).count, out.count, "ids are unique")
        // The row holds the line, at its carrier's time.
        XCTAssertEqual(TimelineInjectedLines.item(out[4]), skill)
        XCTAssertEqual(out[4].createdAt, call.createdAt)
        XCTAssertEqual(out[4].role, "user")
        // Nothing to put back: the very same list.
        let plain = [person(), said("Hi.")]
        XCTAssertEqual(TimelineInjectedLines.expand(plain), plain)
    }

    /// A slim read clips a row's text, which changes the store's id for it; the lines
    /// beside it keep theirs.
    func testIdsHoldAcrossARefetchThatReplacesTheCarrier() {
        let call = carrying(tool("Skill", "release-notes"), after: [skill])
        var reread = ChatMessage(id: "another-id", role: call.role, text: call.text, createdAt: call.createdAt,
                                 kind: .tool, detail: call.detail, resultPreview: "a different preview")
        reread.injectedAfter = [CliInjectedItem(kind: "skill", label: skill.label, text: "Base dir\u{2026}")]
        let before = TimelineInjectedLines.expand([person(), call])
        let after = TimelineInjectedLines.expand([before[0], reread])
        XCTAssertEqual(before.last?.id, after.last?.id)
    }

    /// Load earlier puts a page in front of a head whose read began with lines; the
    /// page's last row carries the same lines after it. Drawn once, under the names
    /// they had while the head led the list.
    func testTheSameLinesReadTwiceAcrossAPageBoundaryAreDrawnOnce() {
        let head = carrying(person(), before: [summary])
        let shown = TimelineInjectedLines.expand([head])
        let earlier = carrying(said("Earlier."), after: [skill, summary])
        let paged = TimelineInjectedLines.expand([earlier, head])
        XCTAssertEqual(paged.filter { $0.kind == .injected }.map { $0.detail ?? "" }, [skill.label, summary.label])
        XCTAssertEqual(paged.first(where: { $0.detail == summary.label })?.id, shown[0].id)
        // A clip of the same line is the same line.
        let clipped = CliInjectedItem(kind: summary.kind, label: summary.label,
                                      text: String(summary.text.prefix(10)) + "\u{2026}")
        let mixed = TimelineInjectedLines.expand([carrying(said("Earlier."), after: [skill, clipped]), head])
        XCTAssertEqual(mixed.filter { $0.kind == .injected }.count, 2)
        // Lines of their own on each side: all of them, in order.
        let apart = TimelineInjectedLines.expand([carrying(said("Earlier."), after: [skill]),
                                                  carrying(person(), before: [hook])])
        XCTAssertEqual(apart.filter { $0.kind == .injected }.map { $0.detail ?? "" }, [skill.label, hook.label])
    }

    // MARK: - Turn shape and fold

    func testALineIsNeverSentNeverAPersonAndNeverEndsATurn() {
        let line = TimelineInjectedLines.expand([carrying(said("Hi."), after: [skill])])[1]
        XCTAssertFalse(TimelineTurnShape.isSent(line))
        XCTAssertFalse(TimelineTurnShape.isPerson(line))
        XCTAssertFalse(TimelineTurnShape.isInbound(line))
        // A Stop hook's context after the answer leaves the turn answered.
        let rows = TimelineInjectedLines.expand([person(), tool("Bash", "ls"), carrying(said("Done."), after: [stopHook])])
        let turns = TimelineTurnShape.shape(rows, streaming: false)
        XCTAssertEqual(turns.count, 1)
        XCTAssertEqual(turns[0].kind, .answered)
        XCTAssertEqual(turns[0].answer, 2)
    }

    func testASkillsTextFoldsWithTheCallBeforeTheAnswer() {
        let parts = plan([person(), carrying(tool("Skill", "release-notes"), after: [skill]), said("Drafted.")])
        XCTAssertEqual(outline(parts), [
            "bubble:Draft the release notes.",
            "fold:Ran 1 tool[\"run:1\", \"injected:\(skill.label)\"]",
            "text",
        ])
    }

    func testALineBeforeTheFirstMessageIsItsOwnClosedRow() {
        let parts = plan([carrying(person(), before: [hook]), said("Hi.")])
        XCTAssertEqual(outline(parts), ["injected:\(hook.label)", "bubble:Draft the release notes.", "text"])
    }

    func testALineAfterTheAnswerJoinsTheQuietStepsThatFollow() {
        let peer: ChatMessage = {
            var m = ChatMessage(id: "p", role: "user",
                                text: "<walnut-message kind=\"peer-note\" from=\"Docs [1a2b3c4d]\" title=\"Done\">\nOk\n</walnut-message>",
                                createdAt: at(), kind: nil)
            m.sentBy = "agent"
            return m
        }()
        let parts = plan([person(), carrying(said("Drafted."), after: [stopHook]), peer, tool("Read", "a.md"),
                          said(TimelineTurnMarker.tag)])
        XCTAssertEqual(outline(parts), [
            "bubble:Draft the release notes.", "text",
            "fold:Received 1 message from Docs \u{00B7} Ran 1 tool[\"injected:\(stopHook.label)\", \"inbound\", \"run:1\", \"ack\"]",
        ])
    }

    /// The web's `foldStepsPhrase`: a CLI line counts as nothing in the line, and a
    /// stretch of them alone reads "Thinking".
    func testTheFoldLineCountsNoLineTheCliPutIn() {
        let line = TimelineInjectedLines.expand([carrying(said("Hi."), after: [skill, hook])])
        XCTAssertEqual(TimelineFoldSteps.steps(line[1]), [.context(skill: true)])
        XCTAssertEqual(TimelineFoldSteps.steps(line[2]), [.context(skill: false)])
        XCTAssertEqual(TimelineFoldSteps.phrase([.context(skill: true)]), "Thinking")
        XCTAssertEqual(TimelineFoldSteps.phrase([.calls(1), .context(skill: true)]), "Ran 1 tool")
        XCTAssertEqual(TimelineFoldSteps.phrase([.received(from: nil), .context(skill: false), .sent(to: nil)]), "Received 1 message \u{00B7} Sent 1")
    }

    // MARK: - Rows

    func testALineIsOneClosedRowThatOpensToItsLabelAndText() async {
        let messages = [carrying(person(), before: [hook]), said("Hi.")]
        let closed = await rows(messages)
        XCTAssertEqual(phrases(closed), [hook.label])
        XCTAssertEqual(bubbleTexts(closed), ["Draft the release notes."], "never the person's bubble")
        let line = TimelineInjectedLines.expand(messages)[0]
        let id = "\(TimelineScope.namespace(scope, line.id))#0"
        XCTAssertEqual(closed.first?.id, id)
        guard case .toolRun(_, _, _, let isOpen, _) = closed[0].content else { return XCTFail("no row") }
        XCTAssertFalse(isOpen)
        // VoiceOver reads the label and that a tap opens it.
        XCTAssertEqual(TimelineChipAccessibility.toolRun(phrase: hook.label, failCount: 0, expanded: false),
                       "\(hook.label), collapsed")
        let open = await rows(messages, expanded: [id])
        guard case .toolRun(_, _, _, let nowOpen, _) = open[0].content,
              case .text(let body) = open[1].content else { return XCTFail("not opened") }
        XCTAssertTrue(nowOpen)
        XCTAssertEqual(body.string, "\(hook.label)\n\(hook.text)")
        XCTAssertEqual(open[1].id, "\(id)#0")
        XCTAssertEqual(bubbleTexts(open), ["Draft the release notes."])
    }

    /// Not a "what Walnut added" item: drawn the same with that setting on or off.
    func testTheLinesShowWhateverTheWalnutAdditionsSetting() async {
        let messages = [person(), carrying(tool("Skill", "release-notes"), after: [skill]), said("Drafted.")]
        let off = await rows(messages)
        let on = await rows(messages, showAll: true)
        XCTAssertEqual(off.map(\.id), on.map(\.id))
        XCTAssertEqual(phrases(off), ["Ran 1 tool"])
        // Opened, the fold holds the run and the line's own closed row.
        let foldID = off.first { row in if case .toolRun = row.content { return true }; return false }?.id ?? ""
        let opened = await rows(messages, expanded: [foldID])
        XCTAssertEqual(phrases(opened), ["Ran 1 tool", "Launched a skill", skill.label])
        XCTAssertEqual(bubbleTexts(opened), ["Draft the release notes."])
    }

    /// A list from an older server (no senders) is not shaped, and still draws the
    /// lines as closed rows, never a bubble.
    func testAnUnshapedListDrawsTheLinesAsClosedRows() async {
        let user = ChatMessage(id: "u", role: "user", text: "Go.", createdAt: at(), kind: nil)
        let built = await rows([carrying(user, after: [skill]), said("Ok.")])
        XCTAssertEqual(phrases(built), [skill.label])
        XCTAssertEqual(bubbleTexts(built), ["Go."])
    }
}
