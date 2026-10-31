import XCTest
@testable import Walnut

/// A quiet fold's line (`TimelineFoldSteps`): counts only, no names (2026-10-31, the
/// user: "just Received 1 message"), "Received 12 messages · Sent 3 · Ran 8 tools".
/// Mirrors the web console's tests/web/fold-steps.test.ts; the two read the same.
final class FoldStepsTests: XCTestCase {
    private typealias S = TimelineFoldSteps.Step

    func testTheReportedDenseStretchReadsAsThreeCountsAndNoNames() {
        var steps: [S] = [.received, .received, .calls(1), .sent(to: nil), .ack, .received, .thought, .ack]
        steps += Array(repeating: S.received, count: 10)
        steps += [.calls(1), .calls(2), .sent(to: nil), .inbox]
        steps += Array(repeating: S.calls(1), count: 4)
        XCTAssertEqual(TimelineFoldSteps.phrase(steps),
                       "Received 13 messages \u{00B7} Sent 3 \u{00B7} Ran 8 tools")
    }

    func testATitleWithItsOwnDotOrCommaNeverReadsAsTheSeparator() {
        XCTAssertEqual(TimelineFoldSteps.phrase([.sent(to: "Brief: the letter, in three sections \u{00B7} Tabs"), .sent(to: "Docs")]),
                       "Sent 2")
    }

    func testASendCountsOnTheLineAndNamesItsTaskOnTheChip() {
        XCTAssertEqual(TimelineFoldSteps.phrase([.sent(to: "Brief task"), .sent(to: "Task status foundation")]),
                       "Sent 2")
        var send = ChatMessage(id: "t1", role: "assistant", text: "Bash", createdAt: "2026-10-30T00:00:00Z", kind: .tool,
                               detail: nil, resultPreview: "Message delivered on this host to abcd12",
                               inputPreview: "command: for id in abcd1234 99887766; do walnut tools call task_send x; done")
        send.sentTo = [SentTarget(ref: "abcd12", taskId: "abcd1234-ef56", title: "Brief task"),
                       SentTarget(ref: "998877", taskId: nil, title: nil)]
        XCTAssertEqual(TimelineFoldSteps.steps(send), [.sent(to: "Brief task"), .sent(to: nil)])
        XCTAssertEqual(TimelineTurnFold.sendLabel(send), "Sent to Brief task +1")
        // An older server sends no targets: one unnamed send, the chip's own label.
        send.sentTo = nil
        XCTAssertEqual(TimelineFoldSteps.steps(send), [.sent(to: nil)])
        XCTAssertNil(TimelineTurnFold.sendLabel(send))
        // The wire field decodes; an older row without it still does.
        let json = #"{"id":"x","role":"assistant","text":"Bash","createdAt":"","kind":"tool","sentTo":[{"ref":"abcd12","taskId":"abcd1234-ef56","title":"Brief task"}]}"#
        let row = try? JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8))
        XCTAssertEqual(row?.sentTo?.first?.title, "Brief task")
    }

    /// The path the app takes (2026-10-30, the iOS gate: names never showed because the
    /// transcript's own row type dropped `sentTo`): transcript JSON, the store's rows,
    /// the fold's step and the chip. A send that is not first in its command counts too.
    @MainActor func testTheTranscriptsTargetsReachTheFoldLineAndTheChip() throws {
        let json = """
        {"sessionId":"s","exportedAt":"2026-10-30T00:00:00Z","truncated":false,"messages":[
          {"role":"assistant","text":"Bash","timestamp":"2026-10-30T00:00:01Z","kind":"tool",
           "inputPreview":"command: walnut tools help task_send; walnut tools call task_send x","detailRef":"ref-1",
           "sentTo":[{"ref":"abcd12","taskId":"abcd1234-ef56","title":"Brief task \\u00b7 Tabs"}]}]}
        """
        let transcript = try JSONDecoder().decode(SessionTranscript.self, from: Data(json.utf8))
        let rows = SessionConversationStore.keepingWholeText(transcript.messages, held: [])
        XCTAssertEqual(rows[0].sentTo?.first?.taskId, "abcd1234-ef56")
        XCTAssertEqual(rows[0].detailRef, "ref-1")
        XCTAssertTrue(TimelineTurnFold.isOutbound(rows[0]))
        // It stays out of "Ran a command" on its own row, as a send does.
        XCTAssertFalse(TimelineToolRunFold.isRunMember(rows[0]))
        XCTAssertEqual(TimelineFoldSteps.steps(rows[0]), [.sent(to: "Brief task \u{00B7} Tabs")])
        XCTAssertEqual(TimelineFoldSteps.phrase(TimelineFoldSteps.steps(rows[0])), "Sent 1")
        XCTAssertEqual(TimelineTurnFold.sendLabel(rows[0]), "Sent to Brief task / Tabs")
        // A fold's copy of the row keeps them.
        XCTAssertEqual(rows[0].replacingText("Bash").sentTo, rows[0].sentTo)
    }

    func testOneIsSingularAndWhatDidNotHappenIsLeftOut() {
        XCTAssertEqual(TimelineFoldSteps.phrase([.received, .ack]), "Received 1 message")
        XCTAssertEqual(TimelineFoldSteps.phrase([.received]), "Received 1 message")
        XCTAssertEqual(TimelineFoldSteps.phrase([.sent(to: nil)]), "Sent 1")
        XCTAssertEqual(TimelineFoldSteps.phrase([.calls(1)]), "Ran 1 tool")
        XCTAssertEqual(TimelineFoldSteps.phrase([.received, .calls(1), .thought, .calls(1)]),
                       "Received 1 message \u{00B7} Ran 2 tools")
    }

    func testAnInboxLetterCountsAsSent() {
        XCTAssertEqual(TimelineFoldSteps.phrase([.inbox, .sent(to: nil)]), "Sent 2")
        let letter = ChatMessage(id: "t1", role: "assistant", text: "mcp__walnut__human_inbox_send", createdAt: "2026-10-27T00:00:02Z",
                                 kind: .tool, detail: nil, resultPreview: "ok")
        XCTAssertEqual(TimelineFoldSteps.steps(letter), [.inbox])
    }

    func testAStretchWithNothingReceivedSentOrRunReadsByWhatItWas() {
        XCTAssertEqual(TimelineFoldSteps.phrase([.update]), "An update")
        XCTAssertEqual(TimelineFoldSteps.phrase([.update, .update]), "2 updates")
        XCTAssertEqual(TimelineFoldSteps.phrase([.ack]), "Acknowledged")
        XCTAssertEqual(TimelineFoldSteps.phrase([.thought]), "Thinking")
        XCTAssertEqual(TimelineFoldSteps.phrase([]), "Thinking")
    }

    func testACountNeverPartsFromItsNounWhenTheLineWraps() {
        let nb = "\u{00A0}"
        XCTAssertEqual(TimelineFoldSteps.wrapping("Received 12 messages \u{00B7} Sent 3 \u{00B7} Ran 8 tools"),
                       "Received 12\(nb)messages\(nb)\u{00B7} Sent\(nb)3\(nb)\u{00B7} Ran\(nb)8\(nb)tools")
        XCTAssertEqual(TimelineFoldSteps.wrapping("Received 1 message"), "Received 1\(nb)message")
        XCTAssertEqual(TimelineFoldSteps.wrapping("Read a file, ran a command"), "Read a file, ran a command")
    }

    /// 2026-10-31, Main's chat: "Received 13 messages from CEO, from Trigger: Main daily
    /// reflection +8". Org notices carry about="CEO" (Main itself) and the line read that
    /// subject as their sender. Same structure, neutral names (the web's twin test).
    func testTheReportedMainChatNamesNoOneOnTheLine() {
        var row = ChatMessage(id: "u1", role: "user",
                              text: "<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"task-routing-policy\">\nWalnut changed your default instructions.\n</walnut-message>\n\n"
                                + "<walnut-message kind=\"notification\" from=\"Walnut\" about=\"CEO\" about-task=\"main-task-1\" outcome=\"org-update\">\nOrg update since 2 h ago\n</walnut-message>\n\n"
                                + "<walnut-message kind=\"trigger\" from=\"Trigger: Main daily reflection\">\nRoutine ran on schedule\n</walnut-message>",
                              createdAt: "2026-10-31T00:00:00Z", kind: nil)
        row.sentBy = "agent"
        XCTAssertEqual(TimelineFoldSteps.phrase(TimelineFoldSteps.steps(row)), "Received 3 messages")
    }

    func testARowsStepsComeFromItsEnvelopes() {
        var row = ChatMessage(id: "u1", role: "user",
                              text: "<walnut-message kind=\"reply\" from=\"Login script [7c7c7c7c]\" title=\"Fixed\">\nok\n</walnut-message>\n"
                                + "<walnut-message kind=\"peer-note\" from=\"Lead\">\nhi\n</walnut-message>",
                              createdAt: "2026-10-27T00:00:00Z", kind: nil)
        row.sentBy = "agent"
        XCTAssertEqual(TimelineFoldSteps.steps(row), [.received, .received])
        let ack = ChatMessage(id: "a1", role: "assistant", text: TimelineTurnMarker.tag, createdAt: "2026-10-27T00:00:01Z", kind: nil)
        XCTAssertEqual(TimelineFoldSteps.steps(ack), [.ack])
        let bash = ChatMessage(id: "t1", role: "assistant", text: "Bash", createdAt: "", kind: .tool,
                               detail: "Run the unit tests", inputPreview: "command: bun test")
        XCTAssertEqual(TimelineFoldSteps.steps(bash), [.calls(1)])
    }
}
