import XCTest
@testable import Walnut

/// The agent acknowledgement line and the turn shapes, case for case with the web
/// console's `tests/web/turn-end-marker.test.ts` and `tests/web/turn-shape.test.ts`
/// (`TimelineTurnMarker`, `TimelineTurnShape`). One rule on both surfaces: a turn
/// read on the phone and on the Mac hides, folds and shows the same rows.
///
/// The phone's rows are finer than the web's messages: a message's text and its
/// tool calls are separate rows, text first. A web `said('', [Bash])` is one tool
/// row here, `said('Answer.')` one text row.
final class TurnShapeTests: XCTestCase {
    private let tag = TimelineTurnMarker.tag

    // MARK: - Fixtures

    private var clock = 0
    private func at() -> String { clock += 1; return String(format: "2026-10-25T00:00:%02dZ", clock) }

    private func person(_ text: String = "Go.") -> ChatMessage { user(text, "person") }
    private func notice(_ text: String = "NOTICE") -> ChatMessage { user(text, "agent") }
    private func user(_ text: String, _ sentBy: String?) -> ChatMessage {
        var m = ChatMessage(id: "u\(clock)", role: "user", text: text, createdAt: at(), kind: nil)
        m.sentBy = sentBy
        return m
    }
    private func said(_ text: String) -> ChatMessage {
        ChatMessage(id: "a\(clock)", role: "assistant", text: text, createdAt: at(), kind: nil)
    }
    private func tool(_ name: String, isError: Bool? = nil) -> ChatMessage {
        ChatMessage(id: "t\(clock)", role: "assistant", text: name, createdAt: at(), kind: .tool,
                    resultPreview: "ok", isError: isError)
    }
    private var line: ChatMessage { said(tag) }

    private func shapes(_ rows: [ChatMessage], streaming: Bool = false) -> [[String]] {
        TimelineTurnShape.shape(rows, streaming: streaming).map { turn in
            let kind: String
            switch turn.kind {
            case .hidden: kind = "hidden"
            case .answered: kind = "answered"
            case .open: kind = "open"
            }
            return [kind, String(turn.start), String(turn.answer)]
        }
    }

    // MARK: - readTurnMarker

    func testReadsTheMarkerAsTheLastLineAndReturnsTheTextWithoutIt() {
        XCTAssertEqual(TimelineTurnMarker.read("Done, nothing for you.\n\n\(tag)"),
                       .init(text: "Done, nothing for you.", ack: true))
        XCTAssertEqual(TimelineTurnMarker.read("Done.\n\(tag)\n\n  \n"), .init(text: "Done.", ack: true))
    }

    func testReadsTheLineUnderItsFirstNameToo() {
        XCTAssertEqual(TimelineTurnMarker.read(TimelineTurnMarker.legacyTag), .init(text: "", ack: true))
        XCTAssertEqual(TimelineTurnMarker.strip("Done.\n\n\(TimelineTurnMarker.legacyTag)"), "Done.")
    }

    func testKeepsParagraphsListsAndCodeAboveTheMarkerIntact() {
        let body = "Result one.\n\n- a\n- b\n\n```ts\nconst x = 1\n```\n\nResult two."
        XCTAssertEqual(TimelineTurnMarker.read("\(body)\n\n\(tag)").text, body)
    }

    func testIsNotTheMarkerAnywhereElse() {
        for text in [
            "\(tag)\n\nBut here is what you need to do.",
            "Quote:\n> \(tag)",
            "In code:\n```\n\(tag)",
            "The tag is \(tag) inline.",
            tag.replacingOccurrences(of: "agent-ack", with: "other"),
            "<walnut-turn status=\"no-action\">",
            "",
        ] {
            XCTAssertFalse(TimelineTurnMarker.read(text).ack, text)
        }
    }

    func testALineOfAnIndentedCodeBlockOrInsideAFenceOfTheOtherKindIsCode() {
        XCTAssertFalse(TimelineTurnMarker.read("Code:\n\n    \(tag)").ack)
        XCTAssertFalse(TimelineTurnMarker.read("~~~\n```\n\(tag)").ack)
        XCTAssertTrue(TimelineTurnMarker.read("~~~\n```\n~~~\n\(tag)").ack)
    }

    func testAnOpeningFenceWithAnInfoStringNeverClosesABlock() {
        XCTAssertFalse(TimelineTurnMarker.read("```\ncode\n```js\n\(tag)").ack)
        XCTAssertTrue(TimelineTurnMarker.read("```js\ncode\n```\n\(tag)").ack)
        XCTAssertTrue(TimelineTurnMarker.read("```\ncode\n```\n\(tag)").ack)
    }

    func testAnUnmarkedTextComesBackUnchanged() {
        XCTAssertEqual(TimelineTurnMarker.read("Plain answer."), .init(text: "Plain answer.", ack: false))
    }

    // MARK: - stripTurnMarker

    func testNeverPrintsTheMarkerLine() {
        XCTAssertEqual(TimelineTurnMarker.strip("Done.\n\n\(tag)"), "Done.")
    }

    func testHoldsBackAHalfWrittenMarkerWhileStreamingAndOnlyThen() {
        XCTAssertEqual(TimelineTurnMarker.stripLive("Done.\n\n<walnut-tu"), "Done.\n")
        XCTAssertEqual(TimelineTurnMarker.strip("Done.\n\n<walnut-tu"), "Done.\n\n<walnut-tu")
        XCTAssertEqual(TimelineTurnMarker.stripLive("Use a < b"), "Use a < b")
        // The tag's first chunk alone on its line is held too; a `<` in prose is not.
        XCTAssertEqual(TimelineTurnMarker.stripLive("Done.\n\n<"), "Done.\n")
        XCTAssertEqual(TimelineTurnMarker.stripLive("Done.\n<"), "Done.")
        XCTAssertEqual(TimelineTurnMarker.stripLive("a <"), "a <")
        XCTAssertEqual(TimelineTurnMarker.strip("Done.\n<"), "Done.\n<")
        XCTAssertEqual(TimelineTurnMarker.stripLive("Done.\n<b>bold</b>"), "Done.\n<b>bold</b>")
        // A finished line mid-stream, and a reply that is nothing yet but the line's start.
        XCTAssertEqual(TimelineTurnMarker.stripLive("Done.\n\n\(tag)"), "Done.")
        XCTAssertEqual(TimelineTurnMarker.stripLive("<walnut-turn st"), "")
    }

    // MARK: - noActionRows: only a finished, clean agent turn ending in the line alone

    func testNeverATurnAPersonStartedNeverALineWithWordsBeforeIt() {
        XCTAssertEqual(shapes([person("Does it have to be a Mac?"), said("Yes. Here is why...\n\n\(tag)")]),
                       [["answered", "0", "1"]])
        XCTAssertEqual(shapes([person("Does it have to be a Mac?"), line]), [["open", "0", "-1"]])
        // Words before the line, in a notice's turn: still words for the reader.
        XCTAssertEqual(shapes([notice(), said("All done, nothing for you.\n\n\(tag)")]), [["answered", "0", "1"]])
    }

    func testHidesTheCleanFinishedTurn() {
        XCTAssertEqual(shapes([notice(), tool("Read"), said("Middle result."), line]), [["hidden", "0", "-1"]])
        XCTAssertEqual(shapes([notice(), line, notice("Next."), said("Plain.")]),
                       [["hidden", "0", "-1"], ["answered", "2", "3"]])
    }

    func testNeverTheTurnStillStreamingButAnEarlierFinishedOneYes() {
        XCTAssertEqual(shapes([notice(), line], streaming: true), [["open", "0", "-1"]])
        XCTAssertEqual(shapes([notice(), line, notice("Next."), said("...")], streaming: true),
                       [["hidden", "0", "-1"], ["open", "2", "-1"]])
    }

    func testNeverWhenTheMarkedRowIsNotTheTurnsLastWord() {
        XCTAssertEqual(shapes([notice(), line, tool("Bash")]), [["open", "0", "-1"]])
        XCTAssertEqual(shapes([notice(), line, said("One more thing you must do.")]), [["answered", "0", "2"]])
    }

    func testNeverWithAFailureAQuestionAPlanOrAnErrorInTheTurn() {
        XCTAssertEqual(shapes([notice(), tool("Bash", isError: true), line]), [["open", "0", "-1"]])
        XCTAssertEqual(shapes([notice(), tool("AskUserQuestion"), line]), [["open", "0", "-1"]])
        XCTAssertEqual(shapes([notice(), tool("ExitPlanMode"), line]), [["open", "0", "-1"]])
        let error = ChatMessage(id: "e", role: "assistant", text: "API error", createdAt: at(),
                                kind: .notification, source: "session-error")
        XCTAssertEqual(shapes([notice(), error, line]), [["open", "0", "-1"]])
    }

    func testAnInfoCardAfterTheAnswerDoesNotCountACliLineStartsNoTurn() {
        let info = ChatMessage(id: "i", role: "assistant", text: "Compacted", createdAt: at(),
                               kind: .notification, source: "compaction")
        XCTAssertEqual(shapes([notice(), line, info]), [["hidden", "0", "-1"]])
        XCTAssertEqual(shapes([notice(), tool("Bash", isError: true), user("skill dump", "cli"), line]),
                       [["open", "0", "-1"]])
    }

    func testATurnWhoseStartIsOutsideTheListIsNeverHidden() {
        XCTAssertEqual(shapes([tool("Bash", isError: true), line]), [["open", "-1", "-1"]])
        XCTAssertEqual(shapes([tool("Bash", isError: true), notice(), line]), [["open", "-1", "-1"]])
        XCTAssertEqual(shapes([said("Earlier answer."), notice(), line]),
                       [["answered", "-1", "0"], ["hidden", "1", "-1"]])
    }

    func testADeliveryAfterAnAnswerIsItsOwnTurnOneMidWorkIsPartOfIt() {
        XCTAssertEqual(shapes([person(), tool("Bash", isError: true), notice(), line]), [["open", "0", "-1"]])
        XCTAssertEqual(shapes([person(), tool("Bash"), notice(), line]), [["open", "0", "-1"]])
        XCTAssertEqual(shapes([notice(), tool("Bash"), person(), line]), [["open", "0", "-1"], ["open", "2", "-1"]])
        XCTAssertEqual(shapes([person(), tool("Bash", isError: true), said("It failed."), notice(), line]),
                       [["answered", "0", "2"], ["hidden", "3", "-1"]])
    }

    // MARK: - shapeTurns

    func testANoticeAnsweredWithTheLineAloneIsHiddenThePersonsTurnShowsItsAnswer() {
        XCTAssertEqual(shapes([person(), tool("Read"), said("Here it is."), notice(), tool("Bash"), line]),
                       [["answered", "0", "2"], ["hidden", "3", "-1"]])
    }

    func testANoticeThatDrewARealAnswerIsAnswered() {
        XCTAssertEqual(shapes([notice(), tool("Bash"), said("You need to decide X.")]), [["answered", "0", "2"]])
    }

    func testAPersonsTurnThatEndedWithTheLineShowsItsAnswer() {
        XCTAssertEqual(shapes([person(), said("Done.\n\n\(tag)")]), [["answered", "0", "1"]])
    }

    func testAFailureATurnEndingInAToolCallOrTheLiveTurnStaysOpen() {
        XCTAssertEqual(shapes([notice(), tool("Bash", isError: true), line]), [["open", "0", "-1"]])
        XCTAssertEqual(shapes([notice(), tool("Bash")]), [["open", "0", "-1"]])
        XCTAssertEqual(shapes([person(), said("Partial.")], streaming: true), [["open", "0", "-1"]])
    }

    func testADeliveryThatCameInMidWorkBelongsToTheTurnItInterrupted() {
        XCTAssertEqual(shapes([person(), tool("Bash"), notice(), said("All done.")]), [["answered", "0", "3"]])
    }

    func testAPersonsMessageAlwaysStartsItsOwnTurn() {
        XCTAssertEqual(shapes([notice(), tool("Bash"), person(), said("Answer.")]),
                       [["open", "0", "-1"], ["answered", "2", "3"]])
    }

    func testAListThatStartsInsideATurnShapesItFromTheFirstRow() {
        XCTAssertEqual(shapes([tool("Read"), said("Result."), notice(), line]),
                       [["answered", "-1", "1"], ["hidden", "2", "-1"]])
    }

    // MARK: - Phone-only rules

    func testALocalBubbleWithNoSenderIsThePersonsAndACliLineIsNobodys() {
        // Not echoed yet: no `sentBy`, still the person's turn.
        XCTAssertEqual(shapes([user("Go.", nil), said("Answer.")]), [["answered", "0", "1"]])
        XCTAssertTrue(TimelineTurnShape.isPerson(user("Go.", nil)))
        XCTAssertFalse(TimelineTurnShape.isSent(user("[Request interrupted by user]", "cli")))
        XCTAssertTrue(TimelineTurnShape.isInbound(notice()))
    }

    func testAListWithNoSenderAtAllIsAnOlderServers() {
        XCTAssertFalse(TimelineTurnShape.knowsSenders([user("Go.", nil), said("Answer.")]))
        XCTAssertTrue(TimelineTurnShape.knowsSenders([notice(), said("Answer.")]))
    }

    func testASettledShapeHoldsWhileTheNextTurnStreams() {
        let rows = [person(), tool("Read"), said("Here it is.")]
        var settled: [String: TimelineTurnShape.Kind] = [:]
        let quiet = TimelineTurnShape.settle(TimelineTurnShape.shape(rows, streaming: false), in: rows,
                                             streaming: false, settled: &settled)
        XCTAssertEqual(quiet.map(\.kind), [.answered])
        // The next turn streams before its first row is in the list: the answer stays folded.
        let held = TimelineTurnShape.settle(TimelineTurnShape.shape(rows, streaming: false), in: rows,
                                            streaming: true, settled: &settled)
        XCTAssertEqual(held.map(\.kind), [.answered])
        // A turn that never settled is the live one: open.
        let live = rows + [notice(), said("Narration so far.")]
        let streaming = TimelineTurnShape.settle(TimelineTurnShape.shape(live, streaming: false), in: live,
                                                 streaming: true, settled: &settled)
        XCTAssertEqual(streaming.map(\.kind), [.answered, .open])
    }
}
