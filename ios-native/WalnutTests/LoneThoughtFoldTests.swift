import XCTest
import UIKit
@testable import Walnut

/// A thought drawn on its own is the line every fold is (2026-11-20, the user: "collpe
/// like > Thinking bro.... just liek all other not even icon icon isinside te collpes").
/// Closed it is the chevron and the word "Thinking", nothing else; opened, its thinking
/// row (the icon, the first line, the tap that opens the whole thought) sits under it.
/// A thought inside an opened fold or run stays its thinking row.
///
/// The guard (`assertEveryThoughtSitsUnderAnOpenedLine`) runs over every way a thought
/// reaches the timeline: the live turn streaming and just ended, the Personal AI chat
/// (no senders), a session transcript (a person's turn), inside a run and inside a turn
/// fold. A NEW way that draws a thinking row on its own fails it.
@MainActor
final class LoneThoughtFoldTests: XCTestCase {
    private let pageWidth: CGFloat = 393

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        MainWork.resetForTesting()
    }

    // MARK: - Fixtures

    private let time = "2026-11-20T00:00:00Z"

    private func thinking(_ id: String, at: String? = nil) -> ChatMessage {
        ChatMessage(id: id, role: "assistant", text: "Weighing the request.", createdAt: at ?? time,
                    kind: .thinking, thinkingText: "Weighing the request. At length.")
    }

    private func prose(_ id: String, at: String? = nil) -> ChatMessage {
        ChatMessage(id: id, role: "assistant", text: "Here is the answer.", createdAt: at ?? time, kind: nil)
    }

    private func tool(_ id: String) -> ChatMessage {
        ChatMessage(id: id, role: "assistant", text: "Bash", createdAt: time, kind: .tool,
                    detail: "ls", resultPreview: "ok", inputPreview: "command: ls")
    }

    private func user(_ id: String, sentBy: String? = nil) -> ChatMessage {
        var m = ChatMessage(id: id, role: "user", text: "check the docs", createdAt: time, kind: nil)
        m.sentBy = sentBy
        return m
    }

    private func rows(_ messages: [ChatMessage], expanded: Set<String> = [], streaming: Bool = false,
                      liveThinking: String = "", liveTools: [LiveToolCall] = [],
                      scope: String = "s") async -> [TimelineRow] {
        await TimelineLayoutActor().buildSnapshot(TimelineInput(
            messages: messages, streaming: streaming, liveText: "", liveTextTruncated: false,
            liveThinking: liveThinking, liveTools: liveTools, activity: nil, showLoadEarlier: false,
            width: pageWidth, expandedRowIDs: expanded, scope: scope)).rows
    }

    private func kinds(_ rows: [TimelineRow]) -> [String] { rows.map(\.content.reuseKind) }

    private func line(_ row: TimelineRow, file: StaticString = #filePath, lineNo: UInt = #line)
        -> (phrase: String, running: Bool, expanded: Bool, lead: String?)? {
        guard case .toolRun(let phrase, let failures, let running, let expanded, let lead) = row.content else {
            XCTFail("\(row.id) is \(row.content.reuseKind), not the fold line", file: file, line: lineNo)
            return nil
        }
        XCTAssertTrue(failures.isEmpty, file: file, line: lineNo)
        return (phrase, running, expanded, lead)
    }

    /// The class guard: a thinking row is never drawn unless an OPENED line stands
    /// above it (a thought's own line, a run's, a turn fold's), with only step rows of
    /// that same opened list between them.
    private func assertEveryThoughtSitsUnderAnOpenedLine(_ rows: [TimelineRow], _ what: String,
                                                         file: StaticString = #filePath, line: UInt = #line) {
        for (i, row) in rows.enumerated() {
            guard case .thinking = row.content else { continue }
            var j = i - 1
            var opened = false
            while j >= 0 {
                switch rows[j].content {
                case .thinking, .toolChip, .liftedStep, .peerMessage, .chip: j -= 1; continue
                case .toolRun(_, _, _, let expanded, _): opened = expanded
                default: break
                }
                break
            }
            XCTAssertTrue(opened, "\(what): thinking row \(row.id) is drawn on its own, not as the fold line "
                          + "(rows: \(kinds(rows)))", file: file, line: line)
        }
    }

    // MARK: - The live turn

    func testTheLiveThoughtAloneIsAClosedThinkingLine() async throws {
        let closed = await rows([], streaming: true, liveThinking: "Reading the request.")
        XCTAssertEqual(kinds(closed), ["toolRun"], "only the line: no chip row, no second Thinking shimmer")
        let shape = try XCTUnwrap(line(closed[0]))
        XCTAssertEqual(shape.phrase, "Thinking")
        XCTAssertNil(shape.lead, "nothing but the chevron and the word")
        XCTAssertFalse(shape.expanded)
        XCTAssertTrue(shape.running, "the line breathes while the thought streams")
        XCTAssertEqual(closed[0].id, TimelineScope.namespace("s", TimelineRowBuilder.liveThoughtFoldID))
        XCTAssertTrue(closed[0].content.isTappableChip)
        // One step row's height, the same as any one-line fold.
        let run = TimelineRowBuilder().toolRunRow(id: "x", members: [.init(name: "Bash", detail: nil)],
                                                  failures: .none, running: false, expanded: false, width: pageWidth)
        XCTAssertEqual(closed[0].height, run.height)

        // Opened: the thinking row under it, carrying the whole thought for its own tap.
        let open = await rows([], expanded: [closed[0].id], streaming: true, liveThinking: "Reading the request.")
        XCTAssertEqual(kinds(open), ["toolRun", "thinking"])
        XCTAssertTrue(try XCTUnwrap(line(open[0])).expanded)
        XCTAssertEqual(open[0].height, closed[0].height, "opening never grows the line itself")
        guard case .thinking(_, let preview, let fullText, _, _, _) = open[1].content else {
            return XCTFail("the opened line holds no thinking row")
        }
        XCTAssertNil(preview)
        XCTAssertEqual(fullText, "Reading the request.")
        XCTAssertEqual(open[1].id, TimelineScope.namespace("s", "live-thinking"))
    }

    func testAJustEndedTurnKeepsItsThoughtAsTheSameLineStill() async throws {
        let id = TimelineScope.namespace("s", TimelineRowBuilder.liveThoughtFoldID)
        let ended = await rows([], streaming: false, liveThinking: "Reading the request.")
        XCTAssertEqual(kinds(ended), ["toolRun"])
        XCTAssertEqual(ended[0].id, id)
        XCTAssertFalse(try XCTUnwrap(line(ended[0])).running, "the turn is over: still")
        let open = await rows([], expanded: [id], streaming: false, liveThinking: "Reading the request.")
        XCTAssertEqual(kinds(open), ["toolRun", "thinking"])
    }

    func testTheLiveThoughtLinesOpenStateEndsWithItsReasoning() {
        let id = TimelineScope.namespace("s", TimelineRowBuilder.liveThoughtFoldID)
        let open: Set<String> = [id, "s|t1#thought"]
        XCTAssertEqual(TimelineRowBuilder.forgettingEndedLiveRun(open, liveTools: [], liveThinking: "x", scope: "s"),
                       open, "kept while the thought is on screen")
        XCTAssertEqual(TimelineRowBuilder.forgettingEndedLiveRun(open, liveTools: [], liveThinking: "", scope: "s"),
                       ["s|t1#thought"], "the next turn's thought arrives closed; a saved one stays open")
    }

    func testTheLiveThoughtInsideAnOpenedRunIsStillItsThinkingRow() async throws {
        let call = LiveToolCall(id: "a", name: "Bash", detail: "ls", finished: false,
                                inputPreview: "command: ls", resultPreview: nil)
        let runID = TimelineScope.namespace("s", TimelineRowBuilder.liveRunID)
        let open = await rows([], expanded: [runID], streaming: true, liveThinking: "Plan.", liveTools: [call])
        XCTAssertEqual(kinds(open), ["toolRun", "thinking", "toolChip"])
        XCTAssertNotEqual(try XCTUnwrap(line(open[0])).phrase, "Thinking", "the run's own line, no second one")
    }

    // MARK: - Saved history

    func testASavedThoughtAloneIsAClosedThinkingLineWithItsRowInside() async throws {
        // The Personal AI chat: no senders, a thought with no call around it.
        let messages = [user("u"), thinking("k1"), prose("p")]
        let closed = await rows(messages)
        XCTAssertEqual(kinds(closed), ["bubble", "toolRun", "text"])
        let shape = try XCTUnwrap(line(closed[1]))
        XCTAssertEqual(shape.phrase, "Thinking")
        XCTAssertFalse(shape.running)
        XCTAssertFalse(shape.expanded)
        XCTAssertEqual(closed[1].id, TimelineRowBuilder.thoughtFoldID(scope: "s", messageID: "k1"))
        let open = await rows(messages, expanded: [closed[1].id])
        XCTAssertEqual(kinds(open), ["bubble", "toolRun", "thinking", "text"])
        guard case .thinking(let firstLine, _, let fullText, _, _, _) = open[2].content else {
            return XCTFail("the opened line holds no thinking row")
        }
        XCTAssertEqual(firstLine, "Weighing the request.", "inside, the row keeps its first line")
        XCTAssertEqual(fullText, "Weighing the request. At length.")
    }

    func testTheAnswersOwnThoughtAfterAPersonIsTheLineToo() async throws {
        // A session transcript: the thought stays with the answer (nothing quiet before it).
        let messages = [user("u", sentBy: "person"), thinking("k1", at: "2026-11-20T00:00:05Z"),
                        prose("p", at: "2026-11-20T00:00:05Z")]
        let built = await rows(messages)
        XCTAssertEqual(kinds(built), ["bubble", "toolRun", "text"])
        XCTAssertEqual(try XCTUnwrap(line(built[1])).phrase, "Thinking")
    }

    // MARK: - The class guard

    func testNoWayOfDrawingAThoughtLeavesItsRowOnItsOwn() async {
        let id = TimelineScope.namespace("s", TimelineRowBuilder.liveThoughtFoldID)
        let call = LiveToolCall(id: "a", name: "Bash", detail: "ls", finished: true,
                                inputPreview: "command: ls", resultPreview: "ok")
        let runID = TimelineScope.namespace("s", TimelineRowBuilder.liveRunID)
        let personTurn = [user("u", sentBy: "person"), thinking("k1", at: "2026-11-20T00:00:05Z"),
                          prose("p", at: "2026-11-20T00:00:05Z")]
        let quietTurn = [user("u", sentBy: "person"), tool("t1"), thinking("k1", at: "2026-11-20T00:00:03Z"),
                         prose("p", at: "2026-11-20T00:00:09Z")]
        let cases: [(String, [TimelineRow])] = [
            ("live alone", await rows([], streaming: true, liveThinking: "x")),
            ("live alone, opened", await rows([], expanded: [id], streaming: true, liveThinking: "x")),
            ("turn ended", await rows([], liveThinking: "x")),
            ("turn ended, opened", await rows([], expanded: [id], liveThinking: "x")),
            ("live in a run, opened", await rows([], expanded: [runID], streaming: true,
                                                 liveThinking: "x", liveTools: [call])),
            ("chat", await rows([user("u"), thinking("k1"), thinking("k2"), prose("p")])),
            ("chat, both opened", await rows([user("u"), thinking("k1"), thinking("k2"), prose("p")],
                                             expanded: [TimelineRowBuilder.thoughtFoldID(scope: "s", messageID: "k1"),
                                                        TimelineRowBuilder.thoughtFoldID(scope: "s", messageID: "k2")])),
            ("chat run, opened", await rows([tool("t1"), thinking("k1"), prose("p")],
                                            expanded: Set([TimelineToolRunFold.rowID(
                                                scope: "s", key: "assistant|\(time)|tool|Bash#0")]))),
            ("person's turn", await rows(personTurn)),
            ("quiet steps", await rows(quietTurn)),
        ]
        for (what, built) in cases { assertEveryThoughtSitsUnderAnOpenedLine(built, what) }
        // Opening every line of the quiet turn's fold still leaves no thought alone.
        let closed = await rows(quietTurn)
        let lines = Set(closed.filter { $0.content.reuseKind == "toolRun" }.map(\.id))
        assertEveryThoughtSitsUnderAnOpenedLine(await rows(quietTurn, expanded: lines), "quiet steps, opened")
    }
}
