import XCTest
@testable import Walnut

/// The phone's mark of which Brief rewrite it has read (`OrgBriefSeen`), the web's rule
/// (`org-brief-model.ts` briefUnread / markBriefSeen) kept on the phone: the Brief tab's dot is for
/// a rewrite newer than the mark, opening the Brief marks it, and the mark never moves back.
@MainActor
final class OrgBriefSeenTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUp() {
        super.setUp()
        suite = "OrgBriefSeenTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testTheRuleIsTheWebs() {
        XCTAssertFalse(OrgBriefSeen.unread(seen: nil, at: nil), "no Brief: nothing to read")
        XCTAssertTrue(OrgBriefSeen.unread(seen: nil, at: "2026-11-25T10:00:00Z"), "never read here")
        XCTAssertFalse(OrgBriefSeen.unread(seen: "2026-11-25T10:00:00Z", at: "2026-11-25T10:00:00Z"), "read as written")
        XCTAssertFalse(OrgBriefSeen.unread(seen: "2026-11-25T11:00:00Z", at: "2026-11-25T10:00:00Z"), "an older rewrite than the one read")
        XCTAssertTrue(OrgBriefSeen.unread(seen: "2026-11-25T10:00:00Z", at: "2026-11-25T10:00:01Z"), "rewritten since")
        XCTAssertFalse(OrgBriefSeen.unread(seen: nil, at: "not a time"), "an unreadable time is never a dot")
    }

    func testAMarkNeverMovesBackAndKeepsTheNewestFifty() {
        let marked = OrgBriefSeen.marking([:], taskId: "vp", at: "2026-11-25T10:00:00Z")
        XCTAssertEqual(marked?["vp"], "2026-11-25T10:00:00Z")
        XCTAssertNil(OrgBriefSeen.marking(marked!, taskId: "vp", at: "2026-11-25T09:00:00Z"), "an older read changes nothing")
        XCTAssertNil(OrgBriefSeen.marking(marked!, taskId: "vp", at: "2026-11-25T10:00:00Z"), "the same read changes nothing")
        XCTAssertEqual(OrgBriefSeen.marking(marked!, taskId: "vp", at: "2026-11-25T12:00:00Z")?["vp"], "2026-11-25T12:00:00Z")
        var many: [String: String] = [:]
        for i in 0..<OrgBriefSeen.kept {
            many["node-\(i)"] = String(format: "2026-10-01T%02d:%02d:%02dZ", i / 3600, (i / 60) % 60, i % 60)
        }
        let next = OrgBriefSeen.marking(many, taskId: "newest", at: "2026-11-25T10:00:00Z")!
        XCTAssertEqual(next.count, OrgBriefSeen.kept, "the newest \(OrgBriefSeen.kept) marks are kept")
        XCTAssertEqual(next["newest"], "2026-11-25T10:00:00Z")
        XCTAssertNil(next["node-0"], "the oldest mark gave way")
    }

    func testTheStoreMarksAndPersists() {
        let seen = OrgBriefSeen(defaults: defaults)
        XCTAssertTrue(seen.isNew("vp", briefAt: "2026-11-25T10:00:00Z"))
        seen.markSeen("vp", at: "2026-11-25T10:00:00Z")
        XCTAssertFalse(seen.isNew("vp", briefAt: "2026-11-25T10:00:00Z"))
        XCTAssertTrue(seen.isNew("vp", briefAt: "2026-11-25T10:30:00Z"), "a rewrite since is new again")
        seen.markSeen("vp", at: nil)
        XCTAssertFalse(seen.isNew("vp", briefAt: "2026-11-25T10:00:00Z"), "no time marks nothing and loses nothing")
        let again = OrgBriefSeen(defaults: defaults)
        XCTAssertFalse(again.isNew("vp", briefAt: "2026-11-25T10:00:00Z"), "the mark survives a relaunch")
    }

    func testTheRowCarriesBriefAtAndTheSegmentWordsIt() throws {
        let row = try JSONDecoder().decode(WalnutTask.self, from: Data("""
        {"id":"vp","title":"Growth lead","status":"in_progress","phase":"IN_PROGRESS","priority":"none","project":"Growth",
         "created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-25T10:00:00Z","org_role":"lead","brief_at":"2026-11-25T10:00:00Z"}
        """.utf8))
        XCTAssertEqual(row.briefAt, "2026-11-25T10:00:00Z")
        let older = try JSONDecoder().decode(WalnutTask.self, from: Data("""
        {"id":"vp","title":"Growth lead","status":"in_progress","phase":"IN_PROGRESS","priority":"none","project":"Growth",
         "created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-25T10:00:00Z","org_role":"lead"}
        """.utf8))
        XCTAssertNil(older.briefAt, "an older server sends none: no dot")
        XCTAssertEqual(OrgNodeTab.briefLabel(new: true), "Brief •")
        XCTAssertEqual(OrgNodeTab.briefLabel(new: false), "Brief")
    }
}
