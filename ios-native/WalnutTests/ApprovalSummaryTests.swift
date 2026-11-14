import XCTest
@testable import Walnut

/// The approval sheet leads with what the step does and why (2026-11-14), as the web dialog does
/// (web/src/components/approvals/approval-context.tsx summaryOf): the asker's own line and why,
/// else the summary Walnut wrote (src/core/approvals/summary.ts). An older server's approval, with
/// no context at all, still decodes and leads with its own line.
final class ApprovalSummaryTests: XCTestCase {
    private func decode(_ context: String?) throws -> Approval {
        let json = """
        {"id":"apr-sum1","what":"Push commit da21d9c to origin mainline in meta-fresh","digest":"d","mode":"biometric",
         "requester":{"host":"clouddev","taskTitle":"Platform Lead"},"createdAt":"2026-11-14T00:00:00.000Z",
         "expiresAt":"2026-11-14T00:05:00.000Z","status":"pending"\(context.map { ",\"context\":\($0)" } ?? "")}
        """
        return try JSONDecoder().decode(Approval.self, from: Data(json.utf8))
    }

    func testOlderServerWithNoContextLeadsWithItsOwnLine() throws {
        let a = try decode(nil)
        XCTAssertEqual(a.lead.text, "Push commit da21d9c to origin mainline in meta-fresh")
        XCTAssertFalse(a.lead.byWalnut)
        XCTAssertNil(a.lead.why)
        XCTAssertTrue(a.awaitsSummary)
    }

    func testWalnutSummaryLeadsOnceItArrives() throws {
        let a = try decode(#"{"why":"last words","whyFrom":"session","summary":"Pushes the two report commits so the team reads them."}"#)
        XCTAssertEqual(a.lead.text, "Pushes the two report commits so the team reads them.")
        XCTAssertTrue(a.lead.byWalnut)
        XCTAssertNil(a.lead.why, "the session's last words are never shown as a reason")
        XCTAssertFalse(a.awaitsSummary)
    }

    func testTheAskersOwnWhyWinsOverAnySummary() throws {
        let a = try decode(#"{"why":"The launch post links to them.","whyFrom":"asker","summary":"must not show"}"#)
        XCTAssertEqual(a.lead.text, "Push commit da21d9c to origin mainline in meta-fresh")
        XCTAssertEqual(a.lead.why, "The launch post links to them.")
        XCTAssertFalse(a.lead.byWalnut)
        XCTAssertFalse(a.awaitsSummary)
    }
}
