import XCTest
@testable import Walnut

/// A letter a task answered in the user's place (`answered.by`, and `by` on the human turn it
/// wrote): the inbox names that task, never its id, and the user may still answer over it, as on
/// the web (2026-10-27: "whatever a person can do in Walnut an agent can do too").
final class LetterAnsweredByTests: XCTestCase {
    private func letter(answered: [String: Any]?, turnBy: [String: Any]? = nil, archived: Bool = false) throws -> Letter {
        var turn: [String: Any] = ["from": "human", "text": "Wide", "at": 1_793_000_000_000.0]
        if let turnBy { turn["by"] = turnBy }
        var json: [String: Any] = [
            "id": "lt-by-1", "subject": "Which layout?", "type": "action_required",
            "createdAt": 1_793_000_000_000.0, "read": false, "pinned": false, "archived": archived,
            "actions": [["id": "wide", "label": "Wide"], ["id": "tall", "label": "Tall"]],
            "thread": [turn],
        ]
        if let answered { json["answered"] = answered }
        return try JSONDecoder().decode(Letter.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testATaskAnswerDecodesWithItsName() throws {
        let by: [String: Any] = ["sessionId": "s-1", "taskId": "t-1", "name": "Draft the onboarding email"]
        let l = try letter(answered: ["actionId": "wide", "label": "Wide", "at": 1_793_000_000_000.0, "by": by], turnBy: by)
        XCTAssertEqual(l.answered?.by, LetterAnsweredBy(sessionId: "s-1", taskId: "t-1", name: "Draft the onboarding email"))
        XCTAssertEqual(l.threadEntries.first?.by?.displayName, "Draft the onboarding email")
        // Answered, so not a to-do in Action needed; its options stay for the user to answer over it.
        XCTAssertFalse(l.isAwaitingDecision)
        XCTAssertEqual(l.openActions.map(\.id), ["wide", "tall"])
    }

    func testTheUsersOwnAnswerClosesTheOptions() throws {
        let l = try letter(answered: ["actionId": "wide", "label": "Wide", "at": 1_793_000_000_000.0])
        XCTAssertNil(l.answered?.by)
        XCTAssertNil(l.threadEntries.first?.by)
        XCTAssertTrue(l.openActions.isEmpty)
        XCTAssertEqual(try letter(answered: nil).openActions.count, 2)
        // As on the web: an archived decision opened from the archive can still be made.
        XCTAssertEqual(try letter(answered: nil, archived: true).openActions.count, 2)
        XCTAssertFalse(try letter(answered: nil, archived: true).isAwaitingDecision)
    }

    func testANamelessTaskIsNeverShownByItsId() {
        let bare = LetterAnsweredBy(sessionId: "s-2", taskId: "mvrsa32l-7fe5", name: nil)
        XCTAssertEqual(bare.displayName, "a task")
        XCTAssertEqual(bare.label(or: "A task"), "A task")
        XCTAssertEqual(LetterAnsweredBy(sessionId: "s-3", taskId: nil, name: "  ").displayName, "a task")
    }
}
