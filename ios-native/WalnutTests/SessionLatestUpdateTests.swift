import XCTest
@testable import Walnut

/// The `+` menu's "Latest update" reads the session record's recap fields
/// (`overview` = the whole session, `recap` = the last turn) from GET
/// /v1/sessions/:id. The row exists only while there is something to show.
final class SessionLatestUpdateTests: XCTestCase {

    private func record(_ fields: String) throws -> SessionDetail.Record {
        let json = """
        { "session": { "claudeSessionId": "abc-123", "process_status": "idle"\(fields) },
          "pendingPermissions": [] }
        """
        return try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8)).session
    }

    func testBothParagraphsDecodeAndTrim() throws {
        let r = try record(#", "overview": " Reworking the composer. ", "overviewAt": "2026-10-26T09:00:00.000Z", "recap": "Deployed.\n", "recapAt": "2026-10-26T09:05:00.000Z""#)
        XCTAssertEqual(r.overviewAt, "2026-10-26T09:00:00.000Z")
        XCTAssertEqual(r.latestUpdate?.overall, "Reworking the composer.")
        XCTAssertEqual(r.latestUpdate?.latest, "Deployed.")
    }

    func testARecordFromBeforeTheOverviewShowsLatestAlone() throws {
        let r = try record(#", "recap": "Fixed the timeout bug.""#)
        XCTAssertNil(r.latestUpdate?.overall)
        XCTAssertEqual(r.latestUpdate?.latest, "Fixed the timeout bug.")
    }

    func testNoRecapMeansNoRow() throws {
        XCTAssertNil(try record("").latestUpdate)
        XCTAssertNil(try record(#", "overview": "  ", "recap": """#).latestUpdate)
    }

    /// Unicode text (a Chinese display language) survives as test data.
    func testUnicodeRecap() throws {
        let r = try record(#", "recap": "\u5df2\u90e8\u7f72""#)
        XCTAssertEqual(r.latestUpdate?.latest, "\u{5df2}\u{90e8}\u{7f72}")
    }

    /// The sheet's "Updated …" line reads the newer stamp; none when neither parses.
    func testUpdatedAtIsTheNewerStamp() throws {
        let r = try record(#", "overview": "A", "overviewAt": "2026-10-26T09:00:00.000Z", "recap": "B", "recapAt": "2026-10-26T09:05:00.000Z""#)
        XCTAssertEqual(r.latestUpdateAt, WalnutTask.parseISO("2026-10-26T09:05:00.000Z"))
        XCTAssertNil(try record(#", "recap": "B""#).latestUpdateAt)
    }
}
