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

    /// A Git push's signed envelope (2026-11-14: the phone showed it whole, as raw JSON, above the buttons).
    private func decodeSigned() throws -> Approval {
        let ctx = #"{"commitSha":"770164961fc7c5491a827f1047c45c94989b8071","operation":"push","remote":"origin","remoteRef":"refs/heads/mainline","repository":"/local/home/dev/.local/state/open-walnut/tasks/t-8252/meta-fresh","version":"walnut-git-operation-v1"}"#
        let env: [String: Any] = ["version": "walnut-single-use-v1", "nonce": "ab", "context": ctx, "why": "x"]
        let detail = String(data: try JSONSerialization.data(withJSONObject: env), encoding: .utf8)!
        let obj: [String: Any] = [
            "id": "apr-sig1", "what": "Push commit 7701649 to origin mainline in meta-fresh", "detail": detail, "digest": "d",
            "mode": "biometric", "requester": ["host": "clouddev"], "createdAt": "2026-11-14T00:00:00.000Z",
            "expiresAt": "2026-11-14T00:05:00.000Z", "status": "pending", "singleUse": true,
            "context": ["summary": "Pushes the two tracking commits to the shared repo.", "whyFrom": "session"],
        ]
        return try JSONDecoder().decode(Approval.self, from: try JSONSerialization.data(withJSONObject: obj))
    }

    func testASignedEnvelopeFoldsUnderDetailsAndTheRepoLineLeads() throws {
        let a = try decodeSigned()
        XCTAssertEqual(a.lead.text, "Pushes the two tracking commits to the shared repo.")
        XCTAssertNil(a.words, "a signed envelope is never shown as the request in words")
        let tech = try XCTUnwrap(a.technicalDetail)
        XCTAssertTrue(tech.signed)
        XCTAssertTrue(tech.text.contains("\"remoteRef\" : \"refs/heads/mainline\""), tech.text)
        XCTAssertFalse(tech.text.contains("walnut-single-use-v1"), "Details holds the signed context, not the envelope around it")
        XCTAssertEqual(a.repoLine, "~/.local/state/open-walnut/tasks/t-8252/meta-fresh \u{2192} mainline")
    }

    func testWalnutsOwnAskReadsItsWordsWholeWithNoDetails() throws {
        let json = """
        {"id":"apr-w1","what":"Let Notes click Send on mail.example.test?","detail":"Message it sends: Thanks, see you Friday.","digest":"d","mode":"tap",
         "requester":{"host":"mac"},"createdAt":"2026-11-14T00:00:00.000Z","expiresAt":"2026-11-14T00:05:00.000Z","status":"pending","detailRole":"summary"}
        """
        let a = try JSONDecoder().decode(Approval.self, from: Data(json.utf8))
        XCTAssertEqual(a.words, "Message it sends: Thanks, see you Friday.")
        XCTAssertNil(a.technicalDetail)
        XCTAssertNil(a.repoLine)
    }

    func testAnOlderServersDetailStaysTechnical() throws {
        let a = try decode(nil)
        XCTAssertNil(a.words)
        XCTAssertNil(a.technicalDetail, "no detail, no Details fold")
    }
}
