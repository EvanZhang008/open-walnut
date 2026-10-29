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

    private func plan(_ rows: [ChatMessage]) -> [TimelineTurnFold.Part] {
        TimelineTurnFold.plan(rows, turns: TimelineTurnShape.shape(rows, streaming: false))
    }

    /// A readable outline of a plan: "fold:<kind>:<phrase>[members]", "bubble", "text", …
    private func outline(_ parts: [TimelineTurnFold.Part]) -> [String] {
        parts.map { part in
            switch part {
            case .message(let m): return m.isUser ? "bubble:\(m.text)" : (m.kind == .tool ? "tool:\(m.text)" : "text")
            case .run(_, let members): return "run:\(members.count)"
            case .inbound: return "inbound"
            case .ack: return "ack"
            case .fold(let f): return "fold:\(f.kind):\(f.phrase)\(outline(f.members))"
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
            case .userBubble(let s, _, _, _): return s.string
            case .notification(_, _, _, let body, _, _, _, _): return body.string
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

    func testWalnutsNotesInFrontOfAPersonsWordsAreOneRowAboveTheBubble() {
        let rider = "<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"moved\">\nThis task moved.\n</walnut-message>"
        let parts = plan([person("\(rider)\n\nPlease draft the notes."), said("Drafted.")])
        XCTAssertEqual(outline(parts), [
            "fold:rider:Received 1 message[\"inbound\"]", "bubble:Please draft the notes.", "text",
        ])
    }

    func testAReceivedMessageInAnOpenTurnFoldsWithTheStepsAroundIt() {
        XCTAssertEqual(outline(plan([peer(), tool("Bash", "status"), tool("mcp__walnut__task_send")])),
                       ["fold:turn:Received 1 message \u{00B7} Sent 1 \u{00B7} Ran 1 tool"
                        + "[\"inbound\", \"run:1\", \"tool:mcp__walnut__task_send\"]"])
        // A failed call is never folded away unread: it stays a row of its own.
        XCTAssertEqual(outline(plan([peer(), tool("Bash", "rebuild", isError: true)])),
                       ["fold:turn:Received 1 message[\"inbound\"]", "run:1"])
        // Even alone, a received message is a fold, never a bubble.
        XCTAssertEqual(outline(plan([said("Earlier."), peer()])),
                       ["text", "fold:turn:Received 1 message[\"inbound\"]"])
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
        // A clipped row lost its close tag: the head line still never prints.
        let cut = TimelineInboundMessage.displayText("<walnut-message kind=\"peer-note\" from=\"Docs lead [1a2b3c4d]\">\nA long note that was cl\u{2026}")
        XCTAssertEqual(cut, "**From Docs lead**: A long note that was cl\u{2026}")
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
        // Open both folds by their row ids: the members appear, as received cards.
        let ids = closed.filter { if case .toolRun = $0.content { return true }; return false }.map(\.id)
        let open = await rows(messages, expanded: Set(ids))
        XCTAssertEqual(phrases(open), ["Received 2 messages"])
        XCTAssertTrue(texts(open).contains("From Docs lead: Review"))
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
        // Today's rendering: the delivery is a bubble, nothing folds.
        XCTAssertEqual(drawn.filter { if case .userBubble = $0.content { return true }; return false }.count, 2)
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
        // Opened, it holds the received card and the live calls.
        let opened = await rows(history, expanded: [live[0].id], streaming: true, liveTools: running, actor: actor)
        XCTAssertTrue(texts(opened).contains("From Docs lead: Review"))
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

    func testAShortReceivedCardOpensFoldedToItsHeadingInsideAnOpenedFold() async {
        let history = [person(), said("Answer."), peer("Short."), said(tag)]
        let closed = await rows(history)
        guard let fold = closed.first(where: { if case .toolRun = $0.content { return true }; return false }) else {
            return XCTFail("no fold row")
        }
        let opened = await rows(history, expanded: [fold.id])
        let cards = opened.compactMap { row -> (collapsible: Bool, expanded: Bool, line: String)? in
            if case .notification(_, _, _, _, let line, _, let collapsible, let expanded) = row.content {
                return (collapsible, expanded, line)
            }
            return nil
        }
        XCTAssertEqual(cards.count, 1)
        XCTAssertEqual(cards.first?.collapsible, true)
        XCTAssertEqual(cards.first?.expanded, false)
        XCTAssertEqual(cards.first?.line.contains("Docs lead"), true)
    }

    func testAReceivedCardIsFoldedTheMomentItArrivesEvenWhileTheTurnRuns() async {
        let notice = user("<walnut-message kind=\"notification\" from=\"Walnut\" about=\"Docs lead [1a2b3c4d]\" "
                              + "outcome=\"completed\" note=\"automated Walnut status notice\">\nIt completed.\n</walnut-message>",
                          "agent")
        func cards(_ rows: [TimelineRow]) -> Int {
            rows.filter { if case .notification = $0.content { return true }; return false }.count
        }
        func bubbles(_ rows: [TimelineRow]) -> Int {
            rows.filter { if case .userBubble = $0.content { return true }; return false }.count
        }
        // The notice just landed and its turn has called nothing yet: one folded row.
        let arrived = await rows([person(), said("Answer."), notice], streaming: true)
        XCTAssertEqual(phrases(arrived), ["Received 1 message"])
        XCTAssertEqual(cards(arrived), 0)
        XCTAssertEqual(bubbles(arrived), 1)
        // A notice delivered into a person's running turn: the person's words stay, the notice folds.
        let midTurn = await rows([person("Ship it?"), tool("Bash", "build"), notice], streaming: true)
        XCTAssertEqual(bubbles(midTurn), 1)
        XCTAssertEqual(cards(midTurn), 0)
        XCTAssertTrue(phrases(midTurn).contains { $0.hasPrefix("Received 1 message") })
        XCTAssertFalse(texts(midTurn).contains("walnut-message"))
        // Quiet, open turn (nothing answered yet): still folded.
        let quiet = await rows([person(), said("Answer."), notice])
        XCTAssertEqual(cards(quiet), 0)
    }

    // MARK: - Received messages

    func testAReceivedMessageReadsAsWhoItIsFromAndWhatItSays() {
        let text = "<walnut-message kind=\"peer-note\" from=\"Docs &amp; site [1a2b3c4d]\" title=\"Done\">\n"
            + "Line one.\nLine two.\n</walnut-message>\nReply when done: walnut tools call task_send"
        XCTAssertEqual(TimelineInboundMessage.displayText(text),
                       "**From Docs & site**: Done\n\nLine one.\nLine two.\n\nReply when done: walnut tools call task_send")
        // Two envelopes in one row (a batched delivery).
        let two = "<walnut-message kind=\"notification\" from=\"Walnut\">\nA.\n</walnut-message>\n"
            + "<walnut-message kind=\"trigger\">\nB.\n</walnut-message>"
        XCTAssertEqual(TimelineInboundMessage.parse(two)?.envelopes.count, 2)
        XCTAssertEqual(TimelineInboundMessage.displayText(two), "**From Walnut**: A.\n\n**From a trigger**: B.")
        // A shape this reader does not know is shown as it is.
        XCTAssertEqual(TimelineInboundMessage.displayText("[Walnut notification] legacy"), "[Walnut notification] legacy")
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
