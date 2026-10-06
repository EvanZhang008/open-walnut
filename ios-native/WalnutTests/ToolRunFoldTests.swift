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
                       liveTools: [LiveToolCall] = [], liveThinking: String = "") -> TimelineInput {
        TimelineInput(messages: messages, streaming: streaming, liveText: "",
                      liveTextTruncated: false, liveThinking: liveThinking, liveTools: liveTools,
                      activity: nil, showLoadEarlier: false, width: pageWidth,
                      expandedRowIDs: expanded, scope: scope)
    }

    private func rows(_ messages: [ChatMessage], expanded: Set<String> = [],
                      scope: String = TimelineScope.unscoped, streaming: Bool = false,
                      liveTools: [LiveToolCall] = [], liveThinking: String = "") async -> [TimelineRow] {
        await TimelineLayoutActor().buildSnapshot(
            input(messages, expanded: expanded, scope: scope, streaming: streaming,
                  liveTools: liveTools, liveThinking: liveThinking)
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

    /// The id a run gets: where its first member sits, never that member's own id
    /// or payload (`TimelineToolRunFold.runKey`). Every fixture shares one time.
    private func runID(_ kind: String, _ name: String = "", _ n: Int = 0,
                       scope: String = TimelineScope.unscoped) -> String {
        TimelineToolRunFold.rowID(scope: scope, key: "assistant|2026-10-03T00:00:00Z|\(kind)|\(name)#\(n)")
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
        XCTAssertEqual(built[1].id, "assistant|2026-10-03T00:00:00Z|tool|Bash#0#run",
                       "the run is named by where its first member sits")
    }

    func testASingleToolIsStillARun() async throws {
        let built = await rows([tool("t1", "Bash", "ls"), prose("p")])
        XCTAssertEqual(kinds(built), ["toolRun", "text"])
        XCTAssertEqual(try runPayload(built[0]).phrase, "Ran a command")
    }

    func testOpeningTheRunLaysItsMembersOutUnderItInOrder() async throws {
        let messages = [tool("t1", "Bash", "npm test"), thinking("k1"), tool("t2", "Read", "/r/a.ts"), prose("p")]
        let built = await rows(messages, expanded: [runID("tool", "Bash")])
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
        XCTAssertEqual(built[0].id, runID("thinking"), "a leading thought is the run's first member")
    }

    func testReasoningThatLedToTheReplyStaysInTheRun() async throws {
        // Tool, thinking, prose: the thought produced the prose, and it still
        // rides the run, not a "Thinking ›" row of its own above the reply
        // (2026-10-04: "thinking does not need to be pulled out on its own").
        let built = await rows([tool("t1", "Bash", "ls"), thinking("k1"), thinking("k2"), prose("p")])
        XCTAssertEqual(kinds(built), ["toolRun", "text"])
        let open = await rows([tool("t1", "Bash", "ls"), thinking("k1"), thinking("k2"), prose("p")],
                              expanded: [runID("tool", "Bash")])
        XCTAssertEqual(kinds(open), ["toolRun", "toolChip", "thinking", "thinking", "text"])
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
        // Two runs start with a Bash call at the same time: the count tells them apart.
        XCTAssertEqual(built.filter { $0.content.reuseKind == "toolRun" }.map(\.id),
                       [runID("tool", "Bash"), runID("tool", "Bash", 1), runID("tool", "Read"),
                        runID("tool", "Grep")])
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
        XCTAssertEqual(built[0].id, runID("tool", "Bash", scope: "conv-A"))
        XCTAssertTrue(built[0].id.hasPrefix("conv-A|"))
        let open = await rows([tool("t1", "Bash", "ls"), prose("p")],
                              expanded: [runID("tool", "Bash", scope: "conv-A")], scope: "conv-A")
        XCTAssertEqual(kinds(open), ["toolRun", "toolChip", "text"])
        XCTAssertEqual(open[1].id, "conv-A|t1#0")
    }

    func testTheRunKeepsItsIDAndStaysOpenAsCallsJoinAtTheTail() async throws {
        let actor = TimelineLayoutActor()
        let first = await actor.buildSnapshot(input([tool("t1", "Bash", "ls")],
                                                    expanded: [runID("tool", "Bash")])).rows
        XCTAssertEqual(kinds(first), ["toolRun", "toolChip"])
        let grown = await actor.buildSnapshot(input([tool("t1", "Bash", "ls"), tool("t2", "Read", "/r/a.ts")],
                                                    expanded: [runID("tool", "Bash")])).rows
        XCTAssertEqual(kinds(grown), ["toolRun", "toolChip", "toolChip"])
        XCTAssertEqual(grown[0].id, first[0].id)
        XCTAssertEqual(try runPayload(grown[0]).phrase, "Ran a command, read a file")
        // The phrase moved under a stable id, so the diff must hand the row to its cell.
        XCTAssertNotEqual(grown[0].revision, first[0].revision)
    }

    /// The review's case: a session row's id hashes its payload, so the cached
    /// slim read, the rich read that replaces it, and the first call's result
    /// landing each give the first member a NEW id. The run must not follow it,
    /// or the run the reader just opened snaps shut.
    func testAnOpenRunStaysOpenWhenItsFirstMemberIsReRead() async throws {
        let actor = TimelineLayoutActor()
        let slim = ChatMessage(id: "assistant|slim#0", role: "assistant", text: "Bash",
                               createdAt: "2026-10-03T00:00:00Z", kind: .tool, detail: "npm test")
        let opened = runID("tool", "Bash")
        let before = await actor.buildSnapshot(input([slim, prose("p")], expanded: [opened])).rows
        XCTAssertEqual(kinds(before), ["toolRun", "toolChip", "text"])
        let rich = ChatMessage(id: "assistant|rich#0", role: "assistant", text: "Bash",
                               createdAt: "2026-10-03T00:00:00Z", kind: .tool, detail: "npm test",
                               resultPreview: "12 passed", inputPreview: "command: npm test", isError: true)
        let after = await actor.buildSnapshot(input([rich, prose("p")], expanded: [opened])).rows
        XCTAssertEqual(after[0].id, before[0].id)
        XCTAssertEqual(kinds(after), ["toolRun", "toolChip", "text"], "still open")
        XCTAssertEqual(try runPayload(after[0]).failCount, 1, "the new payload still reaches the run")
        guard case .toolChip(_, _, _, let result, _, _, _, _) = after[1].content else {
            return XCTFail("member is not a tool chip")
        }
        XCTAssertEqual(result, "12 passed", "and its member")
    }

    /// The calls the web never folds (`isMergeableHistoryTool`) stay rows of their
    /// own and split the run around them: a message to another session is
    /// conversation, and folded into "Ran a command" it would vanish.
    func testCallsTheWebNeverFoldsStayOutOfTheRun() async throws {
        let send = ChatMessage(id: "s", role: "assistant", text: "Bash", createdAt: "2026-10-03T00:00:01Z",
                               kind: .tool, detail: "Tell the reviewer",
                               inputPreview: "command: walnut tools call task_send '{\"task_id\":\"t\"}'\ndescription: Tell the reviewer")
        let plan = ChatMessage(id: "w", role: "assistant", text: "Write", createdAt: "2026-10-03T00:00:02Z",
                               kind: .tool, detail: "/h/.claude/plans/the-plan.md")
        let exit = ChatMessage(id: "x", role: "assistant", text: "ExitPlanMode",
                               createdAt: "2026-10-03T00:00:03Z", kind: .tool)
        let mcp = ChatMessage(id: "m", role: "assistant", text: "mcp__walnut__session_send",
                              createdAt: "2026-10-03T00:00:04Z", kind: .tool)
        let built = await rows([tool("t1", "Bash", "ls"), send, tool("t2", "Bash", "pwd"), plan, exit, mcp,
                                tool("t3", "Read", "/r/a.ts"), prose("p")])
        XCTAssertEqual(kinds(built), ["toolRun", "toolChip", "toolRun", "toolChip", "toolChip", "toolChip",
                                      "toolRun", "text"])
        guard case .toolChip(let name, let detail, _, _, _, _, _, _) = built[1].content else {
            return XCTFail("the send is not a chip of its own")
        }
        XCTAssertEqual(name, "Bash")
        XCTAssertEqual(detail, "Tell the reviewer")
    }

    func testOnlyARealSendAtACommandPositionCounts() {
        func sends(_ command: String) -> Bool {
            TimelineToolRunFold.staysOutOfRuns(name: "Bash", detail: nil,
                                               inputPreview: "command: \(command)\ndescription: x")
        }
        XCTAssertTrue(sends("walnut tools call task_send '{}'"))
        XCTAssertTrue(sends("walnut tools call session_send - <<'EOF'"))
        XCTAssertTrue(sends("cd /r && WALNUT_X=1 /usr/local/bin/walnut tools call task_send @msg.json"))
        XCTAssertTrue(sends("env walnut tools call task_send '{}'"))
        XCTAssertTrue(sends("python3 build.py | open-walnut tools call task_send -"))
        XCTAssertFalse(sends("walnut tools call task_send --help"), "asking for the schema sends nothing")
        XCTAssertFalse(sends("echo walnut tools call task_send"), "an argument, not a command")
        XCTAssertFalse(sends("grep -rn \"walnut tools call task_send\" docs"))
        XCTAssertFalse(sends("walnut tools call task_get '{}'"))
        XCTAssertFalse(TimelineToolRunFold.staysOutOfRuns(name: "Bash", detail: "x", inputPreview: nil))
        XCTAssertFalse(TimelineToolRunFold.staysOutOfRuns(name: "Write", detail: "/r/notes/plans.md",
                                                          inputPreview: nil))
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

    func testEveryLiveCallFoldsTheRunningOneIncluded() async throws {
        let built = await rows([user("u")], streaming: true,
                               liveTools: [call("a", "Bash", "ls", finished: true),
                                           call("b", "Read", "/r/a.ts", finished: true),
                                           call("c", "Bash", "npm test")])
        // Bubble and ONE closed run that breathes while a call runs. The running
        // call used to be a chip of its own under the run, so every new command
        // arrived opened (2026-10-04). No shimmer: the breathing run says it.
        XCTAssertEqual(kinds(built), ["bubble", "toolRun"])
        let run = try runPayload(built[1])
        XCTAssertEqual(run.phrase, "Ran 2 commands, read a file")
        XCTAssertTrue(run.running)
        XCTAssertFalse(run.expanded)
        XCTAssertEqual(built[1].id, "live-run")
        // Opened, the running call is there with its running state.
        let open = await rows([user("u")], expanded: ["live-run"], streaming: true,
                              liveTools: [call("a", "Bash", "ls", finished: true),
                                          call("c", "Bash", "npm test")])
        XCTAssertEqual(kinds(open), ["bubble", "toolRun", "toolChip", "toolChip"])
        guard case .toolChip(let name, _, _, _, _, let phase, _, _) = open[3].content else {
            return XCTFail("the running call is not a chip")
        }
        XCTAssertEqual(name, "Bash")
        XCTAssertEqual(phase, .running)
        XCTAssertEqual(open[3].id, "live-tool-1", "the chip keeps its ordinal id")
    }

    func testTheRunStopsBreathingWhenItsLastCallReturns() async throws {
        let actor = TimelineLayoutActor()
        let before = await actor.buildSnapshot(input([], streaming: true,
                                                     liveTools: [call("a", "Bash", "ls", finished: true),
                                                                 call("b", "Bash", "pwd")])).rows
        XCTAssertEqual(kinds(before), ["toolRun"])
        XCTAssertEqual(try runPayload(before[0]).phrase, "Ran 2 commands")
        XCTAssertTrue(try runPayload(before[0]).running)
        let after = await actor.buildSnapshot(input([], streaming: true,
                                                    liveTools: [call("a", "Bash", "ls", finished: true),
                                                                call("b", "Bash", "pwd", finished: true)])).rows
        // Still one row, now still, and the shimmer comes back because nothing runs.
        XCTAssertEqual(kinds(after), ["toolRun", "activity"])
        XCTAssertFalse(try runPayload(after[0]).running)
        XCTAssertEqual(after[0].id, before[0].id)
        XCTAssertNotEqual(after[0].revision, before[0].revision)
    }

    func testLiveReasoningRidesTheRunOnceACallStarts() async throws {
        let reasoning = "Checking the tests first.\nThen the build."
        let built = await rows([], streaming: true, liveTools: [call("a", "Bash", "npm test")],
                               liveThinking: reasoning)
        XCTAssertEqual(kinds(built), ["toolRun"], "no Thinking row of its own beside the run")
        let open = await rows([], expanded: ["live-run"], streaming: true,
                              liveTools: [call("a", "Bash", "npm test")], liveThinking: reasoning)
        XCTAssertEqual(kinds(open), ["toolRun", "thinking", "toolChip"])
        guard case .thinking(_, let preview, let fullText, _, _, _) = open[1].content else {
            return XCTFail("the run's first member is not the reasoning")
        }
        XCTAssertNil(preview, "closed: no preview card")
        XCTAssertEqual(fullText, "Checking the tests first.\nThen the build.")
    }

    func testLiveReasoningBeforeAnyCallIsOneClosedLine() async throws {
        let built = await rows([], streaming: true, liveThinking: "Reading the request.")
        XCTAssertEqual(kinds(built), ["thinking"], "and no second Thinking shimmer")
        guard case .thinking(let line, let preview, _, let maxLines, _, _) = built[0].content else {
            return XCTFail("not a thinking row")
        }
        XCTAssertNil(line)
        XCTAssertNil(preview)
        XCTAssertEqual(maxLines, 0)
        let capsule = TimelineRowBuilder().toolRunRow(id: "x#run", members: [member("Bash")],
                                                      failCount: 0, running: false, expanded: false)
        XCTAssertEqual(built[0].height, capsule.height, "one capsule line, nothing under it")
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

    func testALiveSendStaysAChipOfItsOwn() async throws {
        let send = LiveToolCall(id: "s", name: "Bash", detail: "Tell the reviewer", finished: true,
                                inputPreview: "command: walnut tools call task_send '{}'", resultPreview: "ok")
        let built = await rows([], streaming: true,
                               liveTools: [call("a", "Bash", "ls", finished: true), send,
                                           call("b", "Read", "/r/a.ts", finished: true)])
        XCTAssertEqual(kinds(built), ["toolRun", "toolChip", "activity"])
        XCTAssertEqual(try runPayload(built[0]).phrase, "Ran a command, read a file")
        guard case .toolChip(_, let detail, _, _, _, let phase, _, _) = built[1].content else {
            return XCTFail("the send is not a chip")
        }
        XCTAssertEqual(detail, "Tell the reviewer")
        XCTAssertEqual(phase, TimelineToolPhase.liveFinished)
    }

    /// The live run is one id reused by every turn: opening it in one turn must
    /// not open the next turn's.
    func testTheLiveRunsOpenStateEndsWithItsTurn() {
        let open: Set<String> = ["conv-C|live-run", "conv-C|t1#run"]
        let during = TimelineRowBuilder.forgettingEndedLiveRun(
            open, liveTools: [call("a", "Bash", "ls", finished: true)], scope: "conv-C")
        XCTAssertEqual(during, open, "kept while the turn's calls are on screen")
        let after = TimelineRowBuilder.forgettingEndedLiveRun(open, liveTools: [], scope: "conv-C")
        XCTAssertEqual(after, ["conv-C|t1#run"], "a transcript run the reader opened stays open")
        XCTAssertEqual(TimelineRowBuilder.forgettingEndedLiveRun(open, liveTools: [], scope: "conv-D"), open,
                       "another conversation's live run is not this one")
    }

    func testARunningCallAloneIsAClosedRun() async throws {
        let built = await rows([], streaming: true, liveTools: [call("a", "Bash", "ls")])
        XCTAssertEqual(kinds(built), ["toolRun"])
        XCTAssertTrue(try runPayload(built[0]).running)
        XCTAssertEqual(try runPayload(built[0]).phrase, "Ran a command")
    }
}
