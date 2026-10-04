import XCTest
import UIKit
@testable import Walnut

/// The 2026-10-03 report: "the phone is nothing like the web console. It does not
/// collapse, it does not simplify. The user does not care how many commands you
/// ran: fold it all up, they tap to glance, they only care about the final
/// message." Pins the fold (`TimelineToolRunFold`), the phrase it prints
/// (`TimelineToolRunPhrase`, the web's words), and the rows the layout actor
/// builds from it, on the live turn as well as the transcript.
@MainActor
final class ToolRunFoldTests: XCTestCase {
    private let pageWidth: CGFloat = 393

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

    private func tool(_ id: String, _ name: String, _ detail: String? = nil,
                      isError: Bool? = nil, agent: String? = nil) -> ChatMessage {
        ChatMessage(id: id, role: "assistant", text: name, createdAt: "2026-10-03T00:00:00Z",
                    kind: .tool, detail: detail, resultPreview: "ok", agent: agent,
                    inputPreview: "command: \(detail ?? name)", isError: isError)
    }

    private func thinking(_ id: String, _ line: String = "Reasoning about it.") -> ChatMessage {
        ChatMessage(id: id, role: "assistant", text: line, createdAt: "2026-10-03T00:00:00Z",
                    kind: .thinking, thinkingText: line + " At length.")
    }

    private func prose(_ id: String, _ text: String = "Done, the file has three TODOs.") -> ChatMessage {
        ChatMessage(id: id, role: "assistant", text: text, createdAt: "2026-10-03T00:00:00Z", kind: nil)
    }

    private func user(_ id: String, _ text: String = "check the docs") -> ChatMessage {
        ChatMessage(id: id, role: "user", text: text, createdAt: "2026-10-03T00:00:00Z", kind: nil)
    }

    private func input(_ messages: [ChatMessage], expanded: Set<String> = [],
                       scope: String = TimelineScope.unscoped, streaming: Bool = false,
                       liveTools: [LiveToolCall] = []) -> TimelineInput {
        TimelineInput(messages: messages, streaming: streaming, liveText: "",
                      liveTextTruncated: false, liveTools: liveTools, activity: nil,
                      showLoadEarlier: false, width: pageWidth, expandedRowIDs: expanded,
                      scope: scope)
    }

    private func rows(_ messages: [ChatMessage], expanded: Set<String> = [],
                      scope: String = TimelineScope.unscoped, streaming: Bool = false,
                      liveTools: [LiveToolCall] = []) async -> [TimelineRow] {
        await TimelineLayoutActor().buildSnapshot(
            input(messages, expanded: expanded, scope: scope, streaming: streaming,
                  liveTools: liveTools)
        ).rows
    }

    private func kinds(_ rows: [TimelineRow]) -> [String] { rows.map(\.content.reuseKind) }

    private func runPayload(
        _ row: TimelineRow?, _ file: StaticString = #filePath, _ line: UInt = #line
    ) throws -> (phrase: String, failCount: Int, running: Bool, expanded: Bool) {
        guard case .toolRun(let phrase, let failCount, let running, let expanded)
                = try XCTUnwrap(row, "no run row", file: file, line: line).content else {
            XCTFail("expected the .toolRun case", file: file, line: line)
            throw XCTSkip("not a run row")
        }
        return (phrase, failCount, running, expanded)
    }

    private func member(_ name: String, _ detail: String? = nil) -> TimelineToolRunPhrase.Member {
        TimelineToolRunPhrase.Member(name: name, detail: detail)
    }

    // MARK: - The phrase (the web console's words, case for case)

    func testManyEditsToOneFileAreOneEditedFile() {
        let members = [member("Read", "/r/index.html")]
            + Array(repeating: member("Edit", "/r/index.html"), count: 6)
            + [member("Bash", "node --check x.js")]
        XCTAssertEqual(TimelineToolRunPhrase.phrase(members), "Read a file, edited a file, ran a command")
    }

    func testCountsDistinctFilesPerCategoryWriteAndEditTogether() {
        XCTAssertEqual(TimelineToolRunPhrase.phrase([
            member("Edit", "/r/a.ts"), member("Write", "/r/b.ts"), member("Edit", "/r/a.ts"),
            member("Read", "/r/a.ts"), member("Read", "/r/a.ts"), member("Read", "/r/c.ts"),
        ]), "Edited 2 files, read 2 files")
    }

    func testACallWithoutAKnownPathCountsAsItsOwnFile() {
        XCTAssertEqual(TimelineToolRunPhrase.phrase([member("Edit"), member("Edit", ""), member("Edit", "/r/a.ts")]),
                       "Edited 3 files")
        XCTAssertEqual(TimelineToolRunPhrase.phrase([member("NotebookEdit", "/r/n.ipynb"),
                                                     member("NotebookEdit", "/r/n.ipynb")]),
                       "Edited a file")
    }

    func testCommandsAndOtherToolsStillCountCalls() {
        XCTAssertEqual(TimelineToolRunPhrase.phrase([member("Bash", "ls"), member("Bash", "ls"),
                                                     member("Grep"), member("Grep")]),
                       "Ran 2 commands, ran 2 searches")
    }

    func testEveryCategoryHasItsWordAndUnknownToolsFallThrough() {
        XCTAssertEqual(TimelineToolRunPhrase.phrase([member("WebFetch", "https://a"), member("Skill", "x"),
                                                     member("TodoWrite"), member("Task", "explore"),
                                                     member("mcp__walnut__task_get")]),
                       "Fetched a page, launched a skill, updated tasks, ran a subagent, used a tool")
        XCTAssertEqual(TimelineToolRunPhrase.phrase([member("Agent"), member("Agent"), member("Mystery"),
                                                     member("Mystery"), member("WebSearch")]),
                       "Ran 2 subagents, used 2 tools, searched files")
        XCTAssertEqual(TimelineToolRunPhrase.phrase([]), "")
    }

    // MARK: - The fold

    func testConsecutiveToolRowsBecomeOneCollapsedRunRow() async throws {
        let messages = [user("u"), tool("t1", "Bash", "npm test"), tool("t2", "Bash", "git status"),
                        tool("t3", "Read", "/r/a.ts"), prose("p")]
        let built = await rows(messages)
        // Bubble, ONE run row, the reply. Not three chips.
        XCTAssertEqual(kinds(built), ["bubble", "toolRun", "text"])
        let run = try runPayload(built[1])
        XCTAssertEqual(run.phrase, "Ran 2 commands, read a file")
        XCTAssertEqual(run.failCount, 0)
        XCTAssertFalse(run.expanded)
        XCTAssertEqual(built[1].id, "t1#run", "the run is identified by its first member")
    }

    func testASingleToolIsStillARun() async throws {
        let built = await rows([tool("t1", "Bash", "ls"), prose("p")])
        XCTAssertEqual(kinds(built), ["toolRun", "text"])
        XCTAssertEqual(try runPayload(built[0]).phrase, "Ran a command")
    }

    func testOpeningTheRunLaysItsMembersOutUnderItInOrder() async throws {
        let messages = [tool("t1", "Bash", "npm test"), thinking("k1"), tool("t2", "Read", "/r/a.ts"), prose("p")]
        let built = await rows(messages, expanded: ["t1#run"])
        XCTAssertEqual(kinds(built), ["toolRun", "toolChip", "thinking", "toolChip", "text"])
        XCTAssertTrue(try runPayload(built[0]).expanded)
        // The members are the SAME rows they were before the fold existed: the chip
        // still opens the drawer with its input and result.
        guard case .toolChip(let name, let detail, let inputPreview, let result, _, let phase, _, _)
                = built[1].content else { return XCTFail("member is not a tool chip") }
        XCTAssertEqual(name, "Bash")
        XCTAssertEqual(detail, "npm test")
        XCTAssertEqual(inputPreview, "command: npm test")
        XCTAssertEqual(result, "ok")
        XCTAssertEqual(phase, .transcript)
        XCTAssertEqual(built[1].id, "t1#0")
    }

    func testReasoningBetweenAndBeforeToolsRidesTheRun() async throws {
        let built = await rows([thinking("k0"), tool("t1", "Bash", "ls"), thinking("k1"),
                                tool("t2", "Bash", "pwd"), prose("p")])
        XCTAssertEqual(kinds(built), ["toolRun", "text"])
        XCTAssertEqual(built[0].id, "k0#run", "a leading thought is the run's first member")
    }

    func testReasoningThatLedToTheReplySplitsOffAboveIt() async throws {
        // Thinking, tool, thinking, prose: the second thought produced the prose,
        // so it is the "Thinking ›" row above the reply, not a member of the run.
        let built = await rows([tool("t1", "Bash", "ls"), thinking("k1"), thinking("k2"), prose("p")])
        XCTAssertEqual(kinds(built), ["toolRun", "thinking", "thinking", "text"])
        XCTAssertEqual(built[1].id, "k1#0")
    }

    func testTrailingReasoningAtTheTailStaysWithTheRun() async throws {
        // Nothing follows: the turn is still going (or ended on a tool), and the
        // thought belongs to whatever comes next inside the same run.
        let built = await rows([tool("t1", "Bash", "ls"), thinking("k1")])
        XCTAssertEqual(kinds(built), ["toolRun"])
    }

    func testReasoningWithNoToolAroundItIsNotARun() async throws {
        let built = await rows([user("u"), thinking("k1"), thinking("k2"), prose("p")])
        XCTAssertEqual(kinds(built), ["bubble", "thinking", "thinking", "text"])
    }

    func testProseUserRowsAndNotificationsCloseARun() async throws {
        let notice = ChatMessage(id: "n", role: "assistant", text: "Session error: boom",
                                 createdAt: "2026-10-03T00:00:00Z", kind: .notification,
                                 source: "session-error")
        let built = await rows([tool("t1", "Bash", "ls"), prose("p1", "Let me look further."),
                                tool("t2", "Bash", "pwd"), notice, tool("t3", "Read", "/r/a.ts"),
                                user("u"), tool("t4", "Grep", "TODO")])
        XCTAssertEqual(kinds(built), ["toolRun", "text", "toolRun", "notification", "toolRun",
                                      "bubble", "toolRun"])
        XCTAssertEqual(built.filter { $0.content.reuseKind == "toolRun" }.map(\.id),
                       ["t1#run", "t2#run", "t3#run", "t4#run"])
    }

    /// Both wire shapes carry the flag: the session transcript (its own row type,
    /// which the first device check found dropping it) and the chat list.
    func testIsErrorDecodesOnBothWireShapes() throws {
        let transcript = try JSONDecoder().decode(SessionTranscript.self, from: Data("""
        {"sessionId":"s","exportedAt":"2026-10-03T00:00:00Z","truncated":false,"messages":[
         {"role":"assistant","text":"Bash","timestamp":"2026-10-03T00:00:00Z","kind":"tool","isError":true},
         {"role":"assistant","text":"Bash","timestamp":"2026-10-03T00:00:01Z","kind":"tool"}]}
        """.utf8))
        XCTAssertEqual(transcript.messages.map(\.isError), [true, nil])
        let chat = try JSONDecoder().decode([ChatMessage].self, from: Data("""
        [{"id":"m0","role":"assistant","text":"Bash","createdAt":"2026-10-03T00:00:00Z","kind":"tool","isError":true},
         {"id":"m1","role":"assistant","text":"Bash","createdAt":"2026-10-03T00:00:01Z","kind":"tool"}]
        """.utf8))
        XCTAssertEqual(chat.map(\.isError), [true, nil])
    }

    func testFailedCallsAreCounted() async throws {
        let built = await rows([tool("t1", "Bash", "ls", isError: true), tool("t2", "Bash", "pwd"),
                                tool("t3", "Edit", "/r/a.ts", isError: true), prose("p")])
        let run = try runPayload(built[0])
        XCTAssertEqual(run.failCount, 2)
        XCTAssertEqual(TimelineChipAccessibility.toolRun(phrase: run.phrase, failCount: run.failCount,
                                                         expanded: false),
                       "Ran 2 commands, edited a file, 2 failed, collapsed")
        XCTAssertEqual(TimelineChipAccessibility.toolRun(phrase: "Ran a command", failCount: 0,
                                                         expanded: true),
                       "Ran a command, expanded")
    }

    func testTheRunRowIsScopedLikeItsMembers() async throws {
        let built = await rows([tool("t1", "Bash", "ls"), prose("p")], scope: "conv-A")
        XCTAssertEqual(built[0].id, "conv-A|t1#run")
        let open = await rows([tool("t1", "Bash", "ls"), prose("p")], expanded: ["conv-A|t1#run"],
                              scope: "conv-A")
        XCTAssertEqual(kinds(open), ["toolRun", "toolChip", "text"])
        XCTAssertEqual(open[1].id, "conv-A|t1#0")
    }

    func testTheRunKeepsItsIDAndStaysOpenAsCallsJoinAtTheTail() async throws {
        let actor = TimelineLayoutActor()
        let first = await actor.buildSnapshot(input([tool("t1", "Bash", "ls")], expanded: ["t1#run"])).rows
        XCTAssertEqual(kinds(first), ["toolRun", "toolChip"])
        let grown = await actor.buildSnapshot(input([tool("t1", "Bash", "ls"), tool("t2", "Read", "/r/a.ts")],
                                                    expanded: ["t1#run"])).rows
        XCTAssertEqual(kinds(grown), ["toolRun", "toolChip", "toolChip"])
        XCTAssertEqual(grown[0].id, first[0].id)
        XCTAssertEqual(try runPayload(grown[0]).phrase, "Ran a command, read a file")
        // The phrase moved under a stable id, so the diff must hand the row to its cell.
        XCTAssertNotEqual(grown[0].revision, first[0].revision)
    }

    func testToggleReachesTheCellThroughTheContentKey() {
        let closed = TimelineRowBuilder().toolRunRow(id: "x#run", members: [member("Bash")],
                                                     failCount: 0, running: false, expanded: false)
        let open = TimelineRowBuilder().toolRunRow(id: "x#run", members: [member("Bash")],
                                                   failCount: 0, running: false, expanded: true)
        XCTAssertEqual(closed.height, open.height, "opening a run never grows the run row itself")
        XCTAssertNotEqual(closed.contentKey, open.contentKey)
        XCTAssertNotEqual(closed.revision, open.revision)
        XCTAssertTrue(closed.content.isTappableChip)
    }

    // MARK: - The live turn

    private func call(_ id: String, _ name: String, _ detail: String? = nil,
                      finished: Bool = false) -> LiveToolCall {
        LiveToolCall(id: id, name: name, detail: detail, finished: finished,
                     inputPreview: "command: \(detail ?? name)",
                     resultPreview: finished ? "ok" : nil)
    }

    func testFinishedLiveCallsFoldWhileTheRunningOneStaysVisible() async throws {
        let built = await rows([user("u")], streaming: true,
                               liveTools: [call("a", "Bash", "ls", finished: true),
                                           call("b", "Read", "/r/a.ts", finished: true),
                                           call("c", "Bash", "npm test")])
        // Bubble, the folded finished calls, the breathing running chip. No shimmer:
        // a running chip already says the agent is busy.
        XCTAssertEqual(kinds(built), ["bubble", "toolRun", "toolChip"])
        XCTAssertEqual(try runPayload(built[1]).phrase, "Ran a command, read a file")
        XCTAssertEqual(built[1].id, "live-run")
        guard case .toolChip(let name, _, _, _, _, let phase, _, _) = built[2].content else {
            return XCTFail("the running call is not a chip")
        }
        XCTAssertEqual(name, "Bash")
        XCTAssertEqual(phase, .running)
        XCTAssertEqual(built[2].id, "live-tool-2", "the chip keeps its ordinal id across the fold")
    }

    func testACallJoinsTheRunTheMomentItsResultLands() async throws {
        let actor = TimelineLayoutActor()
        let before = await actor.buildSnapshot(input([], streaming: true,
                                                     liveTools: [call("a", "Bash", "ls", finished: true),
                                                                 call("b", "Bash", "pwd")])).rows
        XCTAssertEqual(kinds(before), ["toolRun", "toolChip"])
        XCTAssertEqual(try runPayload(before[0]).phrase, "Ran a command")
        let after = await actor.buildSnapshot(input([], streaming: true,
                                                    liveTools: [call("a", "Bash", "ls", finished: true),
                                                                call("b", "Bash", "pwd", finished: true)])).rows
        // Folded, and the shimmer comes back because nothing is running now.
        XCTAssertEqual(kinds(after), ["toolRun", "activity"])
        XCTAssertEqual(try runPayload(after[0]).phrase, "Ran 2 commands")
        XCTAssertEqual(after[0].id, before[0].id)
    }

    func testTheLiveRunOpensToItsChips() async throws {
        let built = await rows([], expanded: ["live-run"], streaming: true,
                               liveTools: [call("a", "Bash", "ls", finished: true),
                                           call("b", "Read", "/r/a.ts", finished: true)])
        XCTAssertEqual(kinds(built), ["toolRun", "toolChip", "toolChip", "activity"])
        XCTAssertTrue(try runPayload(built[0]).expanded)
        guard case .toolChip(_, _, _, let result, _, let phase, _, _) = built[1].content else {
            return XCTFail("member is not a chip")
        }
        XCTAssertEqual(phase, TimelineToolPhase.liveFinished)
        XCTAssertEqual(result, "ok")
    }

    func testTheLiveRunIsScoped() async {
        let built = await rows([], scope: "conv-B", streaming: true,
                               liveTools: [call("a", "Bash", "ls", finished: true)])
        XCTAssertEqual(built.first?.id, "conv-B|live-run")
    }

    func testNoFinishedCallMeansNoRunRow() async {
        let built = await rows([], streaming: true, liveTools: [call("a", "Bash", "ls")])
        XCTAssertEqual(kinds(built), ["toolChip"])
    }
}
