import XCTest
import UIKit
@testable import Walnut

/// The session timeline after turn shaping (`TimelineTurnFold`): the iPhone showed
/// a peer's `<walnut-message …>` envelope as the user's own right-side bubble, raw
/// XML and all, and printed `<walnut-turn status="no-action"/>` as text. Pins the
/// plan (which rows fold, hide or show), the rows the layout actor lays out from it
/// (ids, phrases, expansion), the received-message reader, and the fallback: a list
/// from a server that does not say who sent a row is drawn exactly as before.
@MainActor
final class TurnFoldTests: XCTestCase {
    private let pageWidth: CGFloat = 393
    private let tag = TimelineTurnMarker.tag

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

    private var clock = 0
    private func at() -> String { clock += 1; return String(format: "2026-10-25T00:00:%02dZ", clock) }
    private func user(_ text: String, _ sentBy: String?) -> ChatMessage {
        var m = ChatMessage(id: "u\(clock)", role: "user", text: text, createdAt: at(), kind: nil)
        m.sentBy = sentBy
        return m
    }
    private func person(_ text: String = "Can you check the build?") -> ChatMessage { user(text, "person") }
    private func peer(_ body: String = "The review is done.") -> ChatMessage {
        user("<walnut-message kind=\"peer-note\" from=\"Docs lead [1a2b3c4d]\" title=\"Review\">\n\(body)\n</walnut-message>",
             "agent")
    }
    private func said(_ text: String) -> ChatMessage {
        ChatMessage(id: "a\(clock)", role: "assistant", text: text, createdAt: at(), kind: nil)
    }
    private func tool(_ name: String, _ detail: String? = nil, isError: Bool? = nil) -> ChatMessage {
        // A Bash row carries its input as the server sends it: the command is in
        // the input render, and `detail` may be the call's description instead.
        ChatMessage(id: "t\(clock)", role: "assistant", text: name, createdAt: at(), kind: .tool,
                    detail: detail, resultPreview: "ok",
                    inputPreview: name == "Bash" ? detail.map { "command: \($0)" } : nil, isError: isError)
    }
    private var line: ChatMessage { said(tag) }

    private func plan(_ rows: [ChatMessage],
                      additions: TimelineTurnFold.Additions = .init()) -> [TimelineTurnFold.Part] {
        TimelineTurnFold.plan(rows, turns: TimelineTurnShape.shape(rows, streaming: false), additions: additions)
    }

    /// The server's "always show what Walnut added".
    private let showAll = TimelineTurnFold.Additions(showAll: true)

    /// A readable outline of a plan: "fold:<kind>:<phrase>[members]", "bubble", "text", …
    private func outline(_ parts: [TimelineTurnFold.Part]) -> [String] {
        parts.map { part in
            switch part {
            case .message(let m): return m.isUser ? "bubble:\(m.text)" : (m.kind == .tool ? "tool:\(m.text)" : "text")
            case .run(_, let members): return "run:\(members.count)"
            case .inbound: return "inbound"
            case .ack: return "ack"
            case .fold(let f): return "fold:\(f.kind):\(f.phrase)\(outline(f.members))"
            case .added(_, let items): return "added:" + items.map(\.label).joined(separator: ",")
            }
        }
    }

    private func rows(_ messages: [ChatMessage], expanded: Set<String> = [],
                      streaming: Bool = false, liveText: String = "",
                      liveTools: [LiveToolCall] = [], actor: TimelineLayoutActor? = nil) async -> [TimelineRow] {
        await (actor ?? TimelineLayoutActor()).buildSnapshot(TimelineInput(
            messages: messages, streaming: streaming, liveText: liveText, liveTextTruncated: false,
            liveTools: liveTools, activity: nil, showLoadEarlier: false, width: pageWidth,
            expandedRowIDs: expanded, scope: "s")).rows
    }

    private func runRows(_ rows: [TimelineRow]) -> [(id: String, phrase: String, running: Bool)] {
        rows.compactMap { row in
            if case .toolRun(let phrase, _, let running, _, _) = row.content { return (row.id, phrase, running) }
            return nil
        }
    }

    private func phrases(_ rows: [TimelineRow]) -> [String] {
        rows.compactMap { row in
            if case .toolRun(let phrase, _, _, _, _) = row.content { return phrase }
            return nil
        }
    }

    private func texts(_ rows: [TimelineRow]) -> String {
        rows.map { row -> String in
            switch row.content {
            case .text(let s): return s.string
            case .userBubble(let s, _, _, _, _): return s.string
            case .notification(_, _, _, let body, _, _, _, _): return body.string
            case .peerMessage(let description): return description.accessibilityLabel
            case .chip(_, let text): return text
            default: return ""
            }
        }.joined(separator: "\n")
    }

    // MARK: - The plan

    func testQuietTurnsAreOneRowThatSaysWhatHappenedInOrder() {
        // Two turns that needed nothing: one row, never "Show 2 hidden turns".
        let parts = plan([person(), said("Answer."), peer(), line, peer("Second note."), tool("Read"), line])
        XCTAssertEqual(outline(parts), [
            "bubble:Can you check the build?", "text",
            "fold:turn:Received 2 messages \u{00B7} Ran 1 tool"
                + "[\"inbound\", \"ack\", \"inbound\", \"run:1\", \"ack\"]",
        ])
    }

    func testQuietStepsAcrossTurnsBetweenTwoAnswersAreOneRow() {
        // The report's shape: after an answer, a note answered with the line, then a
        // note whose turn sent a message and was answered: one row, then the answer.
        let parts = plan([person(), said("Answer."), peer(), line,
                          peer("Ping."), tool("mcp__walnut__task_send"), said("Passed it on.")])
        XCTAssertEqual(outline(parts), [
            "bubble:Can you check the build?", "text",
            "fold:turn:Received 2 messages \u{00B7} Sent 1"
                + "[\"inbound\", \"ack\", \"inbound\", \"tool:mcp__walnut__task_send\"]",
            "text",
        ])
    }

    func testAnAnsweredTurnFoldsEverythingBeforeItsAnswer() {
        let parts = plan([peer(), tool("Bash", "build"), tool("mcp__walnut__task_send"), said("Narration."),
                          tool("Read", "a.md"), said("The answer.")])
        XCTAssertEqual(outline(parts), [
            "fold:turn:Received 1 message \u{00B7} Sent 1 \u{00B7} Ran 2 tools"
                + "[\"inbound\", \"run:1\", \"tool:mcp__walnut__task_send\", \"text\", \"run:1\"]",
            "text",
        ])
    }

    func testAPersonsMessageAlwaysShowsAndALoneRunIsLeftAsItIs() {
        XCTAssertEqual(outline(plan([person(), tool("Read", "a"), tool("Bash", "b"), said("Done.")])),
                       ["bubble:Can you check the build?", "run:2", "text"])
    }

    func testWalnutsNotesInFrontOfAPersonsWordsReadAsTheirLinesAboveTheBubble() {
        let rider = "<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"moved\">\nThis task moved.\n</walnut-message>"
        let rows = [person("\(rider)\n\nPlease draft the notes."), said("Drafted.")]
        // Hidden by default: the bubble holds the words and offers the note on a long press.
        XCTAssertEqual(outline(plan(rows)), ["bubble:Please draft the notes.", "text"])
        // Shown (the server's setting): the note's line above the bubble.
        XCTAssertEqual(outline(plan(rows, additions: showAll)), [
            "inbound", "bubble:Please draft the notes.", "text",
        ])
    }

    /// 2026-10-29: a status change of a followed task rode in front of the person's
    /// words, and its outcome was missing from the closed list, so the whole row
    /// read as one notice with the words inside it. Every note the queue puts in
    /// front of a message splits off the same way.
    func testEveryNoteWalnutPutsInFrontOfAMessageLeavesThePersonsWordsTheirBubble() {
        let status = "<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"status\" "
            + "note=\"status changes of tasks you follow, not a work request\">\n"
            + "A task you follow changed its status (Walnut's record, not a report):\n"
            + "- \"Sample lead\" (task-a): Working \u{2192} Waiting at 21:05 UTC.\n</walnut-message>"
        XCTAssertEqual(outline(plan([person("\(status)\n\nYes, go for it."), said("Started.")], additions: showAll)), [
            "inbound", "bubble:Yes, go for it.", "text",
        ])
        XCTAssertEqual(outline(plan([person("\(status)\n\nYes, go for it."), said("Started.")])), [
            "bubble:Yes, go for it.", "text",
        ])
        for outcome in ["moved", "restarted", "org-update", "status", "waiting", "handed-over", "task-routing-policy"] {
            let note = "<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"\(outcome)\">\nA note.\n</walnut-message>"
            XCTAssertEqual(TimelineInboundMessage.splitRiders("\(note)\n\nThe words.")?.body, "The words.", outcome)
        }
        // A notice the queue never puts in front (a subtask's completion) stays the whole row.
        let completed = "<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"completed\">\nDone.\n</walnut-message>"
        XCTAssertNil(TimelineInboundMessage.splitRiders("\(completed)\n\nThe words."))
    }

    func testAReceivedMessageInAnOpenTurnFoldsWithTheStepsAroundIt() {
        XCTAssertEqual(outline(plan([peer(), tool("Bash", "status"), tool("mcp__walnut__task_send")])),
                       ["fold:turn:Received 1 message \u{00B7} Sent 1 \u{00B7} Ran 1 tool"
                        + "[\"inbound\", \"run:1\", \"tool:mcp__walnut__task_send\"]"])
        // A failed call is a step too: it folds with the message, and the fold's
        // header counts it (the one rule, the web's fold-rows.ts).
        let failed = plan([peer(), tool("Bash", "rebuild", isError: true)])
        XCTAssertEqual(outline(failed), ["fold:turn:Received 1 message \u{00B7} Ran 1 tool[\"inbound\", \"run:1\"]"])
        if case .fold(let f)? = failed.first { XCTAssertEqual(f.failCount, 1) } else { XCTFail("no fold") }
        // Alone, a received message is its one line, never a bubble and never a fold.
        XCTAssertEqual(outline(plan([said("Earlier."), peer()])), ["text", "inbound"])
        XCTAssertEqual(outline(plan([said("Earlier."), peer(), peer("Second note.")])),
                       ["text", "inbound", "inbound"])
    }

    func testTheReportedSplitIsOneRowAFailedCallAndANoticeIncluded() {
        // 2026-10-30, the user's fourth report: after an answer, a trigger's notice,
        // four commands with one failed and the no-action line (an open turn: it
        // had a failure), then a re-check notice, a turn interrupted, one more
        // command and the answer. Three rows on screen; now one.
        func notice(_ kind: String, _ body: String) -> ChatMessage {
            user("<walnut-message kind=\"\(kind)\" from=\"Trigger: sample-check\" title=\"\(body)\">\n\(body)\n</walnut-message>", "agent")
        }
        let interrupted = ChatMessage(id: "n\(clock)", role: "user", text: "Turn interrupted", createdAt: at(),
                                      kind: .notification, source: "interrupt")
        let parts = plan([person(), said("Still waiting."), notice("notification", "No new reply"),
                          tool("Bash", "check"), tool("Bash", "check --letter", isError: true),
                          tool("Bash", "check --fixed"), tool("Bash", "check --trigger"), line,
                          notice("trigger", "Is it still open?"), interrupted, tool("Bash", "check --fixed"),
                          said("Still waiting; the check runs now.")])
        XCTAssertEqual(outline(parts), [
            "bubble:Can you check the build?", "text",
            "fold:turn:Received 2 messages \u{00B7} Ran 5 tools \u{00B7} 1 notice"
                + "[\"inbound\", \"run:4\", \"ack\", \"inbound\", \"bubble:Turn interrupted\", \"run:1\"]",
            "text",
        ])
        if case .fold(let f) = parts[2] { XCTAssertEqual(f.failCount, 1) } else { XCTFail("no fold") }
        // Error notices are the red count; others are named on the line, and alone
        // either kind reads by what it was.
        XCTAssertEqual(TimelineFoldSteps.phrase([.notice(error: true), .notice(error: true)]), "2 notices")
        XCTAssertEqual(TimelineFoldSteps.phrase([.calls(2), .notice(error: true)]), "Ran 2 tools")
        XCTAssertEqual(TimelineFoldSteps.phrase([.calls(2), .notice(error: false)]), "Ran 2 tools \u{00B7} 1 notice")
    }

    func testAQuestionToThePersonAndWordsStillEndAStretch() {
        let parts = plan([person(), said("Answer."), peer(), tool("Bash", "a", isError: true),
                          said("Halfway there."), tool("AskUserQuestion")])
        XCTAssertEqual(outline(parts), [
            "bubble:Can you check the build?", "text",
            "fold:turn:Received 1 message \u{00B7} Ran 1 tool[\"inbound\", \"run:1\"]",
            "text", "run:1",
        ])
    }

    func testTheAnswersOwnReasoningIsTheLastQuietStepOrStaysWithTheAnswer() {
        let thinking = ChatMessage(id: "th", role: "assistant", text: "Weighing it", createdAt: "2026-10-25T00:09:00Z",
                                   kind: .thinking)
        let answer = ChatMessage(id: "an", role: "assistant", text: "The answer.", createdAt: thinking.createdAt, kind: nil)
        // After quiet steps, the answer's reasoning is their last one: one row, then the answer.
        XCTAssertEqual(outline(plan([peer(), tool("Bash", "b"), said("Narration."), thinking, answer])),
                       ["fold:turn:Received 1 message \u{00B7} Ran 1 tool"
                            + "[\"inbound\", \"run:1\", \"text\", \"text\"]",
                        "text"])
        XCTAssertEqual(outline(plan([peer(), thinking, answer])),
                       ["fold:turn:Received 1 message[\"inbound\", \"text\"]", "text"])
        // Nothing quiet before it (a person asked): it stays with the answer.
        XCTAssertEqual(outline(plan([person(), thinking, answer])), ["bubble:Can you check the build?", "text", "text"])
    }

    func testAnEnvelopeWithAnEmptyBodyOrACutOffTailNeverCrashesOrPrintsTheTag() {
        XCTAssertEqual(TimelineInboundMessage.parse("<walnut-message kind=\"reply\" from=\"A\">\n</walnut-message>")?
                        .envelopes.first?.body, "")
        // An empty rider still splits whole: nothing of the person's words is lost.
        XCTAssertEqual(TimelineInboundMessage.splitRiders("<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"moved\">\n</walnut-message>\n\nHi.")?.body, "Hi.")
    }

    func testFoldKeysNameTheRowsPlaceNotItsPayload() {
        var rows = [person(), tool("Bash", "b"), said("Narration."), tool("Read", "a"), said("Answer.")]
        guard case .fold(let before) = plan(rows)[1] else { return XCTFail("no fold") }
        // The rich read replaces the first call's payload (and so its store id): same key.
        rows[1] = ChatMessage(id: "other-id", role: "assistant", text: "Bash", createdAt: rows[1].createdAt,
                              kind: .tool, detail: "b", resultPreview: "longer output", inputPreview: "command: b")
        guard case .fold(let after) = plan(rows)[1] else { return XCTFail("no fold") }
        XCTAssertEqual(before.kind, .turn)
        XCTAssertEqual(before.key, after.key)
    }

    // MARK: - The rows

    func testTheActorDrawsNoTagAndNoReceivedBubbleAndRemembersAnOpenedFold() async throws {
        let messages = [person(), said("Answer.\n\n\(tag)"), peer(), line, peer("Ping."), said("Noted, nothing to do.")]
        let closed = await rows(messages)
        XCTAssertEqual(closed.filter { if case .userBubble = $0.content { return true }; return false }.count, 1)
        XCTAssertFalse(texts(closed).contains("walnut-"))
        // The hidden turn and the next turn's work before its answer: one row.
        XCTAssertEqual(phrases(closed), ["Received 2 messages"])
        XCTAssertFalse(texts(closed).contains("Docs lead: Review"))
        // Open it by its row id: the members appear, each as its one-line description.
        let ids = closed.filter { if case .toolRun = $0.content { return true }; return false }.map(\.id)
        let open = await rows(messages, expanded: Set(ids))
        XCTAssertEqual(phrases(open), ["Received 2 messages"])
        XCTAssertTrue(texts(open).contains("Docs lead: Review"))
        XCTAssertEqual(open.filter { if case .peerMessage = $0.content { return true }; return false }.count, 2)
        XCTAssertFalse(open.contains { if case .notification = $0.content { return true }; return false })
        XCTAssertFalse(texts(open).contains("The review is done."))
        XCTAssertTrue(texts(open).contains(TimelineRowBuilder.acknowledgedCaption))
        XCTAssertFalse(texts(open).contains("walnut-"))
        XCTAssertEqual(open.filter { if case .userBubble = $0.content { return true }; return false }.count, 1)
        // Refetched (new store ids, same places): the folds stay open.
        let refetched = messages.enumerated().map { i, m -> ChatMessage in
            var copy = ChatMessage(id: "re-\(i)", role: m.role, text: m.text, createdAt: m.createdAt, kind: m.kind)
            copy.sentBy = m.sentBy
            return copy
        }
        let again = await rows(refetched, expanded: Set(ids))
        XCTAssertEqual(phrases(again), ["Received 2 messages"])
    }

    func testAListWithoutSendersIsDrawnAsBefore() async {
        let peerRow = user(peer().text, nil)
        let messages = [user("Go.", nil), said("Answer."), peerRow, said("Noted.")]
        let drawn = await rows(messages)
        // Nothing folds; the person's row is a bubble and the delivery its one-line description.
        XCTAssertEqual(drawn.filter { if case .userBubble = $0.content { return true }; return false }.count, 1)
        XCTAssertEqual(drawn.filter { if case .peerMessage = $0.content { return true }; return false }.count, 1)
        XCTAssertFalse(texts(drawn).contains("The review is done."))
        XCTAssertTrue(phrases(drawn).isEmpty)
        // The ack line never prints on any server.
        let acked = await rows([user("Go.", nil), said("Done.\n\n\(tag)")])
        XCTAssertFalse(texts(acked).contains("walnut-turn"))
    }

    func testTheLiveTurnHoldsBackAHalfWrittenTag() async {
        let drawn = await rows([person(), said("Answer.")], streaming: true, liveText: "Working on it.\n\n<walnut-tu")
        XCTAssertFalse(texts(drawn).contains("<walnut"))
        XCTAssertTrue(texts(drawn).contains("Working on it."))
    }

    func testTheLiveTurnAReceivedMessageStartedIsOneRowThatBecomesItsAnsweredFold() async {
        let history = [person(), said("Answer."), peer()]
        let running = [LiveToolCall(id: "1", name: "Bash", detail: "status", finished: true),
                       LiveToolCall(id: "2", name: "Read", detail: "a.md", finished: false)]
        let actor = TimelineLayoutActor()
        let live = runRows(await rows(history, streaming: true, liveTools: running, actor: actor))
        // One row for the message and the calls, breathing while a call runs; no second run row.
        XCTAssertEqual(live.map(\.phrase), ["Received 1 message \u{00B7} Ran 2 tools"])
        XCTAssertEqual(live.map(\.running), [true])
        // Opened, it holds the received message's one line (no body) and the live calls.
        let opened = await rows(history, expanded: [live[0].id], streaming: true, liveTools: running, actor: actor)
        XCTAssertTrue(texts(opened).contains("Docs lead: Review"))
        XCTAssertFalse(texts(opened).contains("The review is done."))
        XCTAssertFalse(opened.contains { if case .notification = $0.content { return true }; return false })
        XCTAssertEqual(opened.filter { if case .toolChip = $0.content { return true }; return false }.count, 2)
        // The turn ends: history holds the calls and the answer, the row keeps its id (and so its open state).
        let ended = history + [tool("Bash", "status"), tool("Read", "a.md"), said("All set.")]
        let after = runRows(await rows(ended, expanded: [live[0].id], actor: actor))
        XCTAssertEqual(after.first?.id, live[0].id)
        XCTAssertEqual(after.first?.phrase, "Received 1 message \u{00B7} Ran 2 tools")
        // A person's live turn is untouched: its run stays the live run.
        let own = runRows(await rows([person()], streaming: true, liveTools: running))
        XCTAssertEqual(own.map(\.phrase), ["Ran a command, read a file"])
    }

    func testTheRowKeepsItsLiveCallsAfterTheTurnEndsUntilTheRefetchBringsThem() async {
        let history = [person(), said("Answer."), peer()]
        let calls = [LiveToolCall(id: "1", name: "Bash", detail: "status", finished: true),
                     LiveToolCall(id: "2", name: "Read", detail: "a.md", finished: true)]
        let actor = TimelineLayoutActor()
        let live = runRows(await rows(history, streaming: true, liveTools: calls, actor: actor))
        // Turn end: streaming stops, the store paints the reply and still holds the
        // calls, and the refetch has not landed. The row stays as it was, not running.
        let gap = history + [said("All set.")]
        let during = await rows(gap, expanded: [live[0].id], liveTools: calls, actor: actor)
        XCTAssertEqual(runRows(during).map(\.id), [live[0].id])
        XCTAssertEqual(runRows(during).map(\.phrase), ["Received 1 message \u{00B7} Ran 2 tools"])
        XCTAssertEqual(runRows(during).map(\.running), [false])
        XCTAssertEqual(during.filter { if case .toolChip = $0.content { return true }; return false }.count, 2)
        XCTAssertTrue(texts(during).contains("All set."))
        // An ack-only reply prints nothing while it waits; the row reads it last,
        // after the calls, as it will once the refetch puts it there.
        let acked = await rows(history + [said(tag)], liveTools: calls, actor: actor)
        XCTAssertEqual(runRows(acked).map(\.phrase), ["Received 1 message \u{00B7} Ran 2 tools"])
        XCTAssertFalse(texts(acked).contains("walnut-turn"))
        // The refetch lands (the store clears the calls with it): same id, same words.
        let fetched = history + [tool("Bash", "status"), tool("Read", "a.md"), said("All set.")]
        let after = runRows(await rows(fetched, expanded: [live[0].id], actor: actor))
        XCTAssertEqual(after.first?.id, live[0].id)
        XCTAssertEqual(after.first?.phrase, "Received 1 message \u{00B7} Ran 2 tools")
        // A person's turn that ended is drawn as before: no merged row.
        let own = runRows(await rows([person(), said("Done.")], liveTools: calls))
        XCTAssertTrue(own.isEmpty)
    }

    func testAfterTheTurnEndsOnlyTheRowTheCallsRodeKeepsThem() async {
        // Turn B's own delivery is not in history yet (it lands with the refetch),
        // so while B streams its calls ride no received row; at its end they must
        // not be lent to turn A before it.
        let turnA = [person(), said("Answer."), peer(), tool("Bash", "earlier"), said("A is done.")]
        let calls = [LiveToolCall(id: "1", name: "Read", detail: "b.md", finished: true)]
        let actor = TimelineLayoutActor()
        let before = runRows(await rows(turnA, actor: actor))
        _ = await rows(turnA, streaming: true, liveTools: calls, actor: actor)
        let gap = runRows(await rows(turnA + [said("B is done.")], liveTools: calls, actor: actor))
        // A's row keeps its id and never takes B's call (its "update" is A's own
        // answer, now followed by B's reply in the same unsent stretch).
        XCTAssertEqual(gap.map(\.id), before.map(\.id))
        XCTAssertFalse(gap.contains { $0.phrase.contains("read a file") })
    }

    func testCountsMatchTheWebForABoardPostAndASendInsideARun() {
        // A Board post is a tool on the web, never a sent message.
        XCTAssertTrue(outline(plan([peer(), tool("mcp__walnut__board_post")]))[0]
            .hasPrefix("fold:turn:Received 1 message \u{00B7} Ran 1 tool["))
        // A lone run that holds a send still folds, as the web's `sends(part)` does.
        let parts = outline(plan([person(), tool("Bash", "b"), tool("mcp__walnut__org_send"), said("Done.")]))
        XCTAssertEqual(parts.count, 3)
        XCTAssertTrue(parts[1].hasPrefix("fold:turn:Sent 1 \u{00B7} Ran 1 tool["), parts[1])
    }

    func testALiveCallIsNeverMatchedToTheSameCallOfAnEarlierTurn() async {
        // The row spans an earlier quiet turn that ran the same command.
        let history = [person(), said("Answer."), peer(), tool("Bash", "git status"), line, peer("Second note.")]
        let calls = [LiveToolCall(id: "1", name: "Bash", detail: "git status", finished: true)]
        let actor = TimelineLayoutActor()
        let live = runRows(await rows(history, streaming: true, liveTools: calls, actor: actor))
        XCTAssertEqual(live.map(\.phrase), ["Received 2 messages \u{00B7} Ran 2 tools"])
        // A mid-turn refetch brings this turn's call: it is counted once.
        let fetched = runRows(await rows(history + [tool("Bash", "git status")], streaming: true,
                                         liveTools: calls, actor: actor))
        XCTAssertEqual(fetched.map(\.phrase), ["Received 2 messages \u{00B7} Ran 2 tools"])
        XCTAssertEqual(fetched.map(\.id), live.map(\.id))
    }

    func testAnAnsweredTurnLendsItsRowToNoLaterCalls() async {
        // Turn A ended on an ack with its reasoning before it. Turn B was started
        // by a row history does not hold yet (the person's message sent from
        // another device), so B's calls are not A's: A's row keeps its words and
        // id while B streams and after it ends, and its reasoning stays inside it.
        let think = ChatMessage(id: "k\(clock)", role: "assistant", text: "Nothing to change.",
                                createdAt: at(), kind: .thinking)
        let turnA = [person(), said("Answer."), peer(), think, line]
        let calls = [LiveToolCall(id: "1", name: "Read", detail: "b.md", finished: true)]
        let actor = TimelineLayoutActor()
        let before = await rows(turnA, actor: actor)
        let foldA = runRows(before)
        XCTAssertEqual(foldA.map(\.phrase), ["Received 1 message"])
        let live = await rows(turnA, streaming: true, liveTools: calls, actor: actor)
        let after = await rows(turnA, liveTools: calls, actor: actor)
        for snapshot in [live, after] {
            XCTAssertEqual(Array(snapshot.map(\.id).prefix(before.count)), before.map(\.id))
            XCTAssertEqual(runRows(snapshot).first?.phrase, foldA.first?.phrase)
        }
    }

    func testAMessageDeliveredAtTurnEndDrawsAfterTheRowThatKeepsItsCalls() async {
        // The phone's own message, queued during the turn, lands with the reply.
        let history = [person(), said("Answer."), peer()]
        let calls = [LiveToolCall(id: "1", name: "Bash", detail: "status", finished: true)]
        let actor = TimelineLayoutActor()
        let live = runRows(await rows(history, streaming: true, liveTools: calls, actor: actor))
        let gap = history + [said("All set."), person("One more thing.")]
        let during = await rows(gap, liveTools: calls, actor: actor)
        XCTAssertEqual(runRows(during).map(\.id), live.map(\.id))
        XCTAssertEqual(runRows(during).map(\.phrase), ["Received 1 message \u{00B7} Ran 1 tool"])
        let rowAt = during.firstIndex { $0.id == live.first?.id }
        let replyAt = during.firstIndex { texts([$0]).contains("All set.") }
        let sentAt = during.firstIndex { texts([$0]).contains("One more thing.") }
        XCTAssertNotNil(rowAt); XCTAssertNotNil(replyAt); XCTAssertNotNil(sentAt)
        if let rowAt, let replyAt, let sentAt { XCTAssertTrue(rowAt < replyAt && replyAt < sentAt) }
    }

    func testAnOpenLiveRowDrawsACallOnceWhenAMidTurnRefetchAlreadyHasIt() async {
        let calls = [LiveToolCall(id: "1", name: "Bash", detail: "status", finished: true),
                     LiveToolCall(id: "2", name: "Read", detail: "a.md", finished: false)]
        let history = [person(), said("Answer."), peer(), tool("Bash", "status")]
        let actor = TimelineLayoutActor()
        let live = runRows(await rows(history, streaming: true, liveTools: calls, actor: actor))
        XCTAssertEqual(live.map(\.phrase), ["Received 1 message \u{00B7} Ran 2 tools"])
        let opened = await rows(history, expanded: [live[0].id], streaming: true, liveTools: calls, actor: actor)
        // The history call is its own folded run; only the call history lacks is a live chip.
        XCTAssertEqual(runRows(opened).map(\.phrase), ["Received 1 message \u{00B7} Ran 2 tools", "Ran a command"])
        XCTAssertEqual(opened.filter { if case .toolChip = $0.content { return true }; return false }.count, 1)
    }

    func testAReceivedMessageInsideAnOpenedFoldShowsOnlyItsDescription() async {
        let history = [person(), said("Answer."), peer("Short."), said(tag)]
        let closed = await rows(history)
        guard let fold = closed.first(where: { if case .toolRun = $0.content { return true }; return false }) else {
            return XCTFail("no fold row")
        }
        let opened = await rows(history, expanded: [fold.id])
        let descriptions = opened.compactMap { row -> PeerMessageDescription? in
            if case .peerMessage(let description) = row.content { return description }
            return nil
        }
        XCTAssertEqual(descriptions, [PeerMessageDescription(sender: "Docs lead", title: "Review")])
        // No card to open and no body.
        XCTAssertFalse(opened.contains { if case .notification = $0.content { return true }; return false })
        XCTAssertFalse(texts(opened).contains("Short."))
    }

    func testAReceivedShapeThisBuildCannotReadStillShowsOneSafeLine() async {
        let odd = user("<walnut-message kind=\"Odd_Kind\" from=\"Docs lead\">\n<b>raw</b>\n</walnut-message>", "agent")
        let drawn = await rows([person(), said("Answer."), odd])
        let descriptions = drawn.compactMap { row -> PeerMessageDescription? in
            if case .peerMessage(let description) = row.content { return description }
            return nil
        }
        XCTAssertEqual(descriptions, [PeerMessagePresentation.unreadableReceived])
        XCTAssertFalse(texts(drawn).contains("raw"))
        XCTAssertFalse(texts(drawn).contains("walnut-message"))
    }

    func testAReceivedNoticeIsItsOneLineOnArrivalAndMergesOnlyWithSteps() async {
        let notice = user("<walnut-message kind=\"notification\" from=\"Walnut\" about=\"Docs lead [1a2b3c4d]\" "
                              + "about-session=\"s-docs\" outcome=\"completed\" note=\"automated Walnut status notice\">"
                              + "\nIt completed.\n</walnut-message>", "agent")
        let expected = [PeerMessageDescription(sender: "Docs lead", title: "Completed")]
        func descriptions(_ rows: [TimelineRow]) -> [PeerMessageDescription] {
            rows.compactMap { if case .peerMessage(let d) = $0.content { return d }; return nil }
        }
        func cards(_ rows: [TimelineRow]) -> Int {
            rows.filter { if case .notification = $0.content { return true }; return false }.count
        }
        func bubbles(_ rows: [TimelineRow]) -> Int {
            rows.filter { if case .userBubble = $0.content { return true }; return false }.count
        }
        // The notice just landed and its turn has called nothing yet: its one line, nothing to open.
        let arrived = await rows([person(), said("Answer."), notice], streaming: true)
        XCTAssertEqual(descriptions(arrived), expected)
        XCTAssertTrue(phrases(arrived).isEmpty)
        XCTAssertEqual(cards(arrived), 0)
        XCTAssertEqual(bubbles(arrived), 1)
        // Delivered beside a person's finished step: they merge into one row, as on the web,
        // and the opened row holds the notice's one line, never its body.
        let midTurn = [person("Ship it?"), tool("Bash", "build"), notice]
        let closed = await rows(midTurn, streaming: true)
        XCTAssertEqual(bubbles(closed), 1)
        XCTAssertEqual(cards(closed), 0)
        let merged = runRows(closed).first { $0.phrase.hasPrefix("Received 1 message") }
        XCTAssertNotNil(merged)
        let opened = await rows(midTurn, expanded: Set([merged?.id].compactMap { $0 }), streaming: true)
        XCTAssertEqual(descriptions(opened), expected)
        XCTAssertEqual(cards(opened), 0)
        XCTAssertFalse(texts(opened).contains("walnut-message"))
        XCTAssertFalse(texts(opened).contains("It completed."))
        // Quiet, open turn (nothing answered yet): the same one line.
        let quiet = await rows([person(), said("Answer."), notice])
        XCTAssertEqual(descriptions(quiet), expected)
        XCTAssertEqual(cards(quiet), 0)
    }

    // MARK: - Received messages

    func testTheEnvelopeReaderTakesBatchedRowsApartAndRefusesAnOpenTag() {
        let text = "<walnut-message kind=\"peer-note\" from=\"Docs &amp; site [1a2b3c4d]\" title=\"Done\" request=\"rq-1\">\n"
            + "Line one.\nLine two.\n</walnut-message>\nReply when done: walnut tools call task_send"
        let one = TimelineInboundMessage.parse(text)
        XCTAssertEqual(one?.envelopes.first?.attributes["from"], "Docs & site [1a2b3c4d]")
        XCTAssertEqual(one?.envelopes.first?.body, "Line one.\nLine two.")
        XCTAssertEqual(one?.envelopes.first?.replyRequested, true)
        XCTAssertEqual(one?.rest, "")
        // Two envelopes in one row (a batched delivery).
        let two = "<walnut-message kind=\"notification\" from=\"Walnut\">\nA.\n</walnut-message>\n"
            + "<walnut-message kind=\"trigger\">\nB.\n</walnut-message>"
        XCTAssertEqual(TimelineInboundMessage.parse(two)?.envelopes.map(\.body), ["A.", "B."])
        // A shape this reader does not know is no envelope.
        XCTAssertNil(TimelineInboundMessage.parse("[Walnut notification] legacy"))
        // A tag that never closes is not an envelope.
        XCTAssertNil(TimelineInboundMessage.parse("<walnut-message kind=\"reply\">\ncut off"))
    }

    func testRidersSplitOnlyWhenNothingCanBeLost() {
        let moved = "<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"moved\">\nMoved.\n</walnut-message>"
        let app = "<walnut-message kind=\"app-state\" from=\"Calendar\">\nOn.\n</walnut-message>"
        XCTAssertEqual(TimelineInboundMessage.splitRiders("\(moved)\n\n\(app)\n\nHello.")?.riders.count, 2)
        XCTAssertEqual(TimelineInboundMessage.splitRiders("\(moved)\n\nHello.")?.body, "Hello.")
        // No body, a single newline, or a rider outside the closed list: no split.
        XCTAssertNil(TimelineInboundMessage.splitRiders("\(moved)\n\n  "))
        XCTAssertNil(TimelineInboundMessage.splitRiders("\(moved)\nHello."))
        let peerNote = "<walnut-message kind=\"peer-note\" from=\"Walnut\">\nHi.\n</walnut-message>"
        XCTAssertNil(TimelineInboundMessage.splitRiders("\(peerNote)\n\nHello."))
        // A trigger behind a place note stays the body.
        let trigger = "<walnut-message kind=\"trigger\">\nFired.\n</walnut-message>"
        XCTAssertEqual(TimelineInboundMessage.splitRiders("\(moved)\n\n\(trigger)")?.body, trigger)
    }

    // MARK: - Wire

    func testSentByDecodesWhenPresentAndIsNilOnAnOlderServer() throws {
        let json = """
        {"sessionId":"s","exportedAt":"2026-10-25T00:00:00Z","truncated":false,"messages":[
          {"role":"user","text":"Go.","timestamp":"2026-10-25T00:00:01Z","sentBy":"person"},
          {"role":"user","text":"Old.","timestamp":"2026-10-25T00:00:02Z"}]}
        """
        let transcript = try JSONDecoder().decode(SessionTranscript.self, from: Data(json.utf8))
        XCTAssertEqual(transcript.messages.map(\.sentBy), ["person", nil])
        // The disk cache round-trips it on the timeline row.
        var row = ChatMessage(id: "r", role: "user", text: "Go.", createdAt: "t", kind: nil)
        row.sentBy = "agent"
        let back = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(row))
        XCTAssertEqual(back.sentBy, "agent")
    }
}
