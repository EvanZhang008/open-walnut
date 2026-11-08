import XCTest
@testable import Walnut

/// The user's rename (2026-11-06): asks read as "Quick question" on screen while
/// the server keeps filing them under "Ask Walnut" / "Ask <agent>". Display only:
/// the stored name is what every request, filter and decoder keeps.
final class AskProjectNameTests: XCTestCase {

    func testAskProjectsReadAsQuickQuestion() {
        XCTAssertEqual(AskProjectName.display("Ask Walnut"), "Quick question")
        XCTAssertEqual(AskProjectName.display("Ask Mentor"), "Quick question \u{B7} Mentor")
        XCTAssertEqual(AskProjectName.display("Ask Note Assistant"), "Quick question \u{B7} Note Assistant")
        XCTAssertEqual(AskProjectName.display("  Ask Walnut "), "Quick question")
    }

    func testOtherProjectsAreUnchanged() {
        for name in ["Pebble", "", "Inbox", "Ask", "Ask ", "Asking for help", "Task Walnut", "Walnut"] {
            XCTAssertEqual(AskProjectName.display(name), name, name)
        }
    }

    func testPlaceholderTitleFollowsItsProject() {
        XCTAssertEqual(AskProjectName.displayTitle("Ask Walnut", project: "Ask Walnut"), "Quick question")
        XCTAssertEqual(AskProjectName.displayTitle("Ask Mentor", project: "Ask Mentor"), "Quick question \u{B7} Mentor")
        // No project on the row: only the general agent's placeholder is certain.
        XCTAssertEqual(AskProjectName.displayTitle("Ask Walnut", project: nil), "Quick question")
        XCTAssertEqual(AskProjectName.displayTitle("Ask Walnut", project: ""), "Ask Walnut")
        XCTAssertEqual(AskProjectName.displayTitle("Ask Mentor", project: nil), "Ask Mentor")
    }

    func testRealTitlesAreNeverRewritten() {
        XCTAssertEqual(AskProjectName.displayTitle("Ask Walnut greeting", project: "Ask Walnut"),
                       "Ask Walnut greeting")
        XCTAssertEqual(AskProjectName.displayTitle("Ask Bob about the lease", project: "Ask Walnut"),
                       "Ask Bob about the lease")
        XCTAssertEqual(AskProjectName.displayTitle("Ask Bob about the lease", project: nil),
                       "Ask Bob about the lease")
        XCTAssertEqual(AskProjectName.displayTitle("Compare two laptops", project: "Ask Walnut"),
                       "Compare two laptops")
        // A task whose title is an Ask name in another project keeps it.
        XCTAssertEqual(AskProjectName.displayTitle("Ask Walnut", project: "Pebble"), "Ask Walnut")
    }

    func testMainTaskReadsCEO() {
        XCTAssertEqual(AskProjectName.displayTitle("Main", project: "Ask Walnut", orgRole: "main"), "CEO")
        XCTAssertEqual(AskProjectName.displayTitle("Main", project: "", orgRole: nil), "Main")
        XCTAssertEqual(AskProjectName.displayTitle("Pebble lead", project: "Pebble", orgRole: "lead"), "Pebble lead")
    }

    func testDrawerHeadingFollowsTheActiveAgent() {
        XCTAssertEqual(AskProjectName.storedProject(agentID: "general", agentName: "Walnut"), "Ask Walnut")
        XCTAssertEqual(AskProjectName.storedProject(agentID: "mentor", agentName: "Mentor"), "Ask Mentor")
        XCTAssertEqual(AskProjectName.storedProject(agentID: "mentor", agentName: nil), "Ask mentor")
        XCTAssertEqual(AskProjectName.storedProject(agentID: "x", agentName: "  a/b..c  "), "Ask a-b.c")
        XCTAssertEqual(AskProjectName.storedProject(agentID: "x", agentName: "a\\b\u{0000}c"), "Ask a-b-c")
        XCTAssertEqual(AskProjectName.storedProject(agentID: "x", agentName: String(repeating: "a", count: 61)),
                       "Ask " + String(repeating: "a", count: 60))
        XCTAssertEqual(AskProjectName.display(AskProjectName.storedProject(agentID: "general", agentName: nil)),
                       "Quick question")
    }

    /// The decoded list keeps the stored name: the rename never reaches a request.
    func testAskListKeepsTheStoredProject() throws {
        let json = #"{"agentId":"general","project":"Ask Walnut","total":0,"asks":[]}"#
        let list = try JSONDecoder().decode(AskList.self, from: Data(json.utf8))
        XCTAssertEqual(list.project, "Ask Walnut")
        let encoded = String(decoding: try JSONEncoder().encode(list), as: UTF8.self)
        XCTAssertTrue(encoded.contains("Ask Walnut"))
        XCTAssertFalse(encoded.contains("Quick question"))
    }
}
