import XCTest
@testable import Walnut

/// A quiet fold's line (`TimelineFoldSteps`): counts only, "Received 12 messages ·
/// Sent 3 · Ran 8 tools". Mirrors the web console's tests/web/fold-steps.test.ts;
/// the two read the same.
final class FoldStepsTests: XCTestCase {
    private typealias S = TimelineFoldSteps.Step

    func testTheReportedDenseStretchReadsAsThreeCounts() {
        let steps: [S] = [.received, .received, .calls(1), .sent, .ack, .received, .thought, .ack]
            + Array(repeating: .received, count: 10)
            + [.calls(1), .calls(2), .sent, .inbox]
            + Array(repeating: .calls(1), count: 4)
        XCTAssertEqual(TimelineFoldSteps.phrase(steps), "Received 13 messages \u{00B7} Sent 3 \u{00B7} Ran 8 tools")
    }

    func testOneIsSingularAndWhatDidNotHappenIsLeftOut() {
        XCTAssertEqual(TimelineFoldSteps.phrase([.received, .ack]), "Received 1 message")
        XCTAssertEqual(TimelineFoldSteps.phrase([.sent]), "Sent 1")
        XCTAssertEqual(TimelineFoldSteps.phrase([.calls(1)]), "Ran 1 tool")
        XCTAssertEqual(TimelineFoldSteps.phrase([.received, .calls(1), .thought, .calls(1)]),
                       "Received 1 message \u{00B7} Ran 2 tools")
    }

    func testAnInboxLetterCountsAsSent() {
        XCTAssertEqual(TimelineFoldSteps.phrase([.inbox, .sent]), "Sent 2")
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
                       "Received 12\(nb)messages \u{00B7} Sent\(nb)3 \u{00B7} Ran\(nb)8\(nb)tools")
        XCTAssertEqual(TimelineFoldSteps.wrapping("Received 1 message"), "Received 1\(nb)message")
        XCTAssertEqual(TimelineFoldSteps.wrapping("Read a file, ran a command"), "Read a file, ran a command")
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
