import XCTest
@testable import Walnut

/// The Inbox tab's rules replay the WEB console's verdicts on one shared fixture.
///
/// `tests/fixtures/inbox-parity/letters.json` is 40 invented letters plus eight
/// scenarios (patches over the list). `expected.json` next to it is NOT hand
/// written: `tests/web/inbox-ios-parity.test.ts` produces it by running the
/// console's own functions (`sectionCounts`, `filterInboxLetters`,
/// `isOpenDecision`, `nextDecisionGraceExpiry`, `compareLetters`). This suite runs
/// the phone's `InboxListing` over the same scenarios and must answer the same
/// thing, field for field. A rule ported by reading instead of running is exactly
/// how a past badge disagreed with the web, so the referee is the web itself.
final class InboxFilterParityTests: XCTestCase {

    private struct Scenario {
        let name: String
        let nowMs: Double
        let keep: [String]
        let patch: [String: [String: Any]]
    }

    private struct Verdict: Decodable, Equatable {
        let name: String
        let unreadCount: Int
        let unseenDecisionCount: Int
        let order: [String]
        let unreadRows: [String]
        let actionNeededRows: [String]
        let nextGraceExpiry: Double?
    }

    private static var fixtureDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // WalnutTests
            .deletingLastPathComponent() // ios-native
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("tests/fixtures/inbox-parity")
    }

    private func loadFixture() throws -> (letters: [[String: Any]], scenarios: [Scenario]) {
        let data = try Data(contentsOf: Self.fixtureDir.appendingPathComponent("letters.json"))
        let doc = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let letters = try XCTUnwrap(doc["letters"] as? [[String: Any]])
        let raw = try XCTUnwrap(doc["scenarios"] as? [[String: Any]])
        let scenarios = try raw.map { s in
            Scenario(
                name: try XCTUnwrap(s["name"] as? String),
                nowMs: try XCTUnwrap((s["nowMs"] as? NSNumber)?.doubleValue),
                keep: s["keep"] as? [String] ?? [],
                patch: s["patch"] as? [String: [String: Any]] ?? [:]
            )
        }
        return (letters, scenarios)
    }

    /// Same patch rule as the vitest: `null` deletes a key, an unknown id is a new
    /// letter appended after the server's list.
    private func apply(_ base: [[String: Any]], _ patch: [String: [String: Any]]) throws -> [Letter] {
        func patched(_ letter: [String: Any], _ fields: [String: Any]) -> [String: Any] {
            var out = letter
            for (key, value) in fields {
                if value is NSNull { out.removeValue(forKey: key) } else { out[key] = value }
            }
            return out
        }
        let known = Set(base.compactMap { $0["id"] as? String })
        var rows = base.map { letter -> [String: Any] in
            guard let id = letter["id"] as? String, let fields = patch[id] else { return letter }
            return patched(letter, fields)
        }
        for (id, fields) in patch.sorted(by: { $0.key < $1.key }) where !known.contains(id) {
            rows.append(patched([:], fields))
        }
        let data = try JSONSerialization.data(withJSONObject: rows)
        return try JSONDecoder().decode([Letter].self, from: data)
    }

    /// Exactly the shape the vitest writes. The store holds live letters only (the
    /// archive is its own shelf), so the lists run over those, as on the phone.
    private func phoneVerdict(_ s: Scenario, _ letters: [Letter]) -> Verdict {
        let live = letters.filter { !$0.isArchived }
        return Verdict(
            name: s.name,
            unreadCount: InboxListing.unreadCount(letters),
            unseenDecisionCount: InboxListing.unseenDecisionCount(live),
            order: InboxListing.rows(live, filter: .all, keep: [], nowMs: s.nowMs).map(\.id),
            unreadRows: InboxListing.rows(live, filter: .unread, keep: Set(s.keep), nowMs: s.nowMs).map(\.id),
            actionNeededRows: InboxListing.rows(live, filter: .actionNeeded, keep: [], nowMs: s.nowMs).map(\.id),
            nextGraceExpiry: InboxListing.nextGraceExpiry(live, nowMs: s.nowMs)
        )
    }

    func testEveryScenarioMatchesTheWebVerdict() throws {
        let (letters, scenarios) = try loadFixture()
        let expectedData = try Data(contentsOf: Self.fixtureDir.appendingPathComponent("expected.json"))
        let expected = try JSONDecoder().decode([Verdict].self, from: expectedData)
        XCTAssertEqual(scenarios.map(\.name), expected.map(\.name), "fixture and expected.json disagree on scenarios")
        XCTAssertGreaterThanOrEqual(scenarios.count, 8)
        for (scenario, web) in zip(scenarios, expected) {
            let phone = phoneVerdict(scenario, try apply(letters, scenario.patch))
            XCTAssertEqual(phone.unreadCount, web.unreadCount, "\(scenario.name): badge")
            XCTAssertEqual(phone.unseenDecisionCount, web.unseenDecisionCount, "\(scenario.name): Action needed count")
            XCTAssertEqual(phone.order, web.order, "\(scenario.name): All order")
            XCTAssertEqual(phone.unreadRows, web.unreadRows, "\(scenario.name): Unread rows")
            XCTAssertEqual(phone.actionNeededRows, web.actionNeededRows, "\(scenario.name): Action needed rows")
            XCTAssertEqual(phone.nextGraceExpiry, web.nextGraceExpiry, "\(scenario.name): grace timer")
        }
    }

    /// The type chips are the phone's own (the console has none): each lists
    /// exactly its type, in inbox order, and together with nothing else they
    /// partition the non-decision letters.
    func testTypeFiltersPartitionTheirLettersInInboxOrder() throws {
        let (letters, _) = try loadFixture()
        let live = try apply(letters, [:]).filter { !$0.isArchived }
        let all = InboxListing.rows(live, filter: .all, keep: [], nowMs: 0).map(\.id)
        var seen: [String] = []
        for filter in [InboxFilter.review, .completion, .info] {
            let rows = InboxListing.rows(live, filter: filter, keep: [], nowMs: 0)
            XCTAssertFalse(rows.isEmpty, "\(filter) lists nothing on a 40-letter fixture")
            XCTAssertTrue(rows.allSatisfy { $0.type == filter.letterType }, "\(filter) leaked another type")
            XCTAssertEqual(rows.map(\.id), all.filter { Set(rows.map(\.id)).contains($0) }, "\(filter) broke inbox order")
            seen += rows.map(\.id)
        }
        let decisions = live.filter { $0.type == "action_required" }.map(\.id)
        XCTAssertEqual(Set(seen + decisions), Set(all), "a letter type has no chip")
        XCTAssertNil(InboxListing.count(for: .review, in: live), "type chips carry no count")
        XCTAssertEqual(InboxListing.count(for: .unread, in: live), InboxListing.unreadCount(live))
    }

    func testTheStoredFilterSurvivesAndAnUnknownValueFallsBackToAll() {
        for filter in InboxFilter.allCases {
            XCTAssertEqual(InboxFilter(stored: filter.rawValue), filter)
        }
        XCTAssertEqual(InboxFilter(stored: nil), .all)
        XCTAssertEqual(InboxFilter(stored: "starred"), .all, "a value a newer build wrote must not crash or stick")
    }
}
