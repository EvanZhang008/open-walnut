import XCTest
@testable import Walnut

final class InboxItemContractTests: XCTestCase {
    static let itemJSON = """
    {"id":"mail-one","subject":"Weekly update","summary":"Review the update", "source":{"kind":"mail","account":"account-one","message":"message-one"},
    "display":{"sender":{"name":"Sender One","address":"sender@example.test"},"sentAt":"2026-10-20T10:00:00Z","accountLabel":"Personal","accountHint":"one@example.test"},
    "actions":[{"id":"read-one","kind":"op","intent":"mark_read"},{"id":"find-one","kind":"op","intent":"find_task"},{"id":"create-one","kind":"op","intent":"create_task"}]}
    """
    static func item() throws -> InboxEmailItem { try JSONDecoder().decode(InboxEmailItem.self, from: Data(itemJSON.utf8)) }
    func testItemsAreAdditiveAndOldConstructorsRemainUsable() throws {
        let letter = try JSONDecoder().decode(Letter.self, from: Data("""
        {"id":"letter-one","subject":"Digest","type":"info","items":[\(Self.itemJSON)],"thread":[{"from":"agent","items":[\(Self.itemJSON)]}]}
        """.utf8))
        XCTAssertEqual(letter.items?.count, 1)
        XCTAssertEqual(letter.threadEntries.first?.items?.count, 1)
        XCTAssertTrue(letter.openActions.isEmpty)
        let old = LetterThreadEntry(from: "agent", text: nil, bodyFormat: nil, bodyFile: nil, at: nil, body: nil,
            bodyBytes: nil, bodyDeferred: nil, bodyUrl: nil, clientId: nil, delivery: nil)
        XCTAssertNil(old.items)
    }
    func testOneDamagedItemDoesNotEraseSiblingsOrBody() throws {
        let json = """
        {"id":"letter-one","subject":"Digest","type":"info","body":"Saved body","items":[\(Self.itemJSON),false,{"id":"broken","subject":"Missing source","actions":[]}]}
        """
        let letter = try JSONDecoder().decode(Letter.self, from: Data(json.utf8))
        XCTAssertEqual(letter.body, "Saved body")
        XCTAssertEqual(letter.items?.count, 3)
        XCTAssertEqual(letter.items?.first?.visibleActions.count, 3)
        XCTAssertTrue(letter.items?.dropFirst().allSatisfy { $0.visibleActions.isEmpty } == true)
    }
    func testUnknownAndInjectedActionsStayReadOnly() throws {
        for action in [#"{"id":"x","kind":"op","intent":"delete_mail"}"#, #"{"id":"x","kind":"op","intent":"mark_read","label":"Run this"}"#] {
            let json = Self.itemJSON.replacingOccurrences(of: #"{"id":"read-one","kind":"op","intent":"mark_read"}"#, with: action)
            let item = try JSONDecoder().decode(InboxEmailItem.self, from: Data(json.utf8))
            XCTAssertNotNil(item.unavailableReason)
            XCTAssertTrue(item.visibleActions.isEmpty)
        }
    }
    func testFindAndAttachAreOneVisibleEntry() throws {
        let json = Self.itemJSON.replacingOccurrences(of: #"{"id":"create-one","kind":"op","intent":"create_task"}"#,
            with: #"{"id":"attach-one","kind":"op","intent":"attach_task"}"#)
        let item = try JSONDecoder().decode(InboxEmailItem.self, from: Data(json.utf8))
        XCTAssertEqual(item.visibleActions.filter { $0.buttonLabel == "Find task" }.map(\.id), ["attach-one"])
    }
    func testMetadataIsPlainDataAndHasHonestFallbacks() throws {
        let item = try Self.item()
        XCTAssertTrue(item.senderLabel.contains("sender@example.test"))
        XCTAssertTrue(item.accountLabel.contains("one@example.test"))
        XCTAssertNotEqual(item.dateLabel, "Date unavailable")
        XCTAssertEqual(InboxItemAction.aiLabel("Ask AI: Explain"), "Ask AI: Explain")
        XCTAssertEqual(InboxItemAction.aiLabel("Explain"), "Ask AI: Explain")
    }
    func testDuplicateIdsStayReadOnlyAndSixtyItemsDoNotUseLetterActionLimit() throws {
        let contents = Array(repeating: Self.itemJSON, count: 60).joined(separator: ",")
        let json = "{\"id\":\"letter-one\",\"subject\":\"Digest\",\"type\":\"info\",\"items\":[\(contents)]}"
        let letter = try JSONDecoder().decode(Letter.self, from: Data(json.utf8))
        XCTAssertEqual(letter.items?.count, 60)
        XCTAssertTrue(letter.items?.allSatisfy { $0.visibleActions.isEmpty } == true)
    }
    func testCurrentReadIsUnknownWhenAbsent() throws {
        let item = try Self.item()
        XCTAssertNil(item.readObservation)
        XCTAssertTrue(item.visibleActions.contains { $0.intent == "mark_read" })
    }
    func testMalformedActionsAreReadOnlyAndReceiptsRemainLossy() throws {
        let json = Self.itemJSON.replacingOccurrences(of: #""intent":"mark_read""#, with: #""intent":false"#)
        let item = try JSONDecoder().decode(InboxEmailItem.self, from: Data(json.utf8))
        XCTAssertNotNil(item.unavailableReason)
        XCTAssertTrue(item.visibleActions.isEmpty)
        XCTAssertEqual(item.subject, "Weekly update")
    }
    @MainActor func testReceiptLabelsSeparateHistoryDeliveryAndPartialFailure() throws {
        let base = try InboxItemStoreTests.receipt()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(base)) as? [String: Any])
        func changed(_ fields: [String: Any], removing: [String] = []) throws -> InboxItemReceipt {
            var json = object.merging(fields) { _, new in new }; removing.forEach { json.removeValue(forKey: $0) }
            return try JSONDecoder().decode(InboxItemReceipt.self, from: JSONSerialization.data(withJSONObject: json))
        }
        XCTAssertEqual(try changed(["execution": "running"], removing: ["startedAt"]).label, "Started (time unavailable)")
        XCTAssertEqual(try changed(["execution": "not_started", "status": "failure"]).label, "Task created. Could not start.")
        XCTAssertEqual(try changed(["execution": "starting", "status": "pending"]).label, "Starting…")
        XCTAssertEqual(try changed(["delivery": "unconfirmed", "intent": "attach_task"]).label, "Attachment unconfirmed")
        XCTAssertEqual(try changed(["delivery": "deferred", "intent": "attach_task"]).label, "Attached. Waiting for permission")
        XCTAssertEqual(try changed(["intent": "mark_read", "status": "failure", "recovery": ["check_status"]]).label, "Read status unconfirmed")
        XCTAssertEqual(try changed(["intent": "reply_ai", "delivery": "skipped"]).label, "Saved. Nothing was sent to the agent.")
        XCTAssertEqual(try changed(["intent": "reply_ai", "delivery": "deferred"]).label, "Waiting for permission")
    }
    func testCompletedOrUnknownTaskCannotContinue() {
        XCTAssertFalse(InboxTaskCandidate(id: "task-one", title: "Work", project: "", phase: "COMPLETE").canAttach)
        XCTAssertFalse(InboxTaskCandidate(id: "task-one", title: "Work", project: "", phase: "NEW_PHASE").canAttach)
        XCTAssertTrue(InboxTaskCandidate(id: "task-one", title: "Work", project: "", phase: "TODO").canAttach)
    }
}
