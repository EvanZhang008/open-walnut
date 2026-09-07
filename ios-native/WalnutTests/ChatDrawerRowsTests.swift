import XCTest
@testable import Walnut

/// The drawer's Recents rows: what the list may iterate.
///
/// A `ForEach` over an `Identifiable` collection with a repeated id is undefined
/// behaviour in SwiftUI, not a cosmetic double row — the copies share view
/// identity, so state and animations cross between them. The live server's
/// conversation index carries duplicate ids, so this fold is the thing standing
/// between that data and the list.
final class ChatDrawerRowsTests: XCTestCase {

    private func conversation(
        _ id: String, _ title: String, updatedAt: String = "2026-09-07T00:00:00.000Z"
    ) -> ConversationSummary {
        ConversationSummary(id: id, title: title, updatedAt: updatedAt, messageCount: 0)
    }

    func testAListWithNoDuplicatesIsUntouched() {
        let rows = [conversation("a", "One"), conversation("b", "Two")]
        XCTAssertEqual(ChatDrawer.uniqueByID(rows).map(\.id), ["a", "b"])
    }

    /// FIRST occurrence wins: the server orders this list by recency, so the first
    /// copy is the freshest one.
    func testARepeatedIDKeepsTheFirstCopy() {
        let rows = [
            conversation("a", "Freshest", updatedAt: "2026-09-07T00:00:00.000Z"),
            conversation("b", "Other"),
            conversation("a", "Stale copy", updatedAt: "2026-08-01T00:00:00.000Z"),
        ]
        let out = ChatDrawer.uniqueByID(rows)
        XCTAssertEqual(out.map(\.id), ["a", "b"])
        XCTAssertEqual(out.first?.title, "Freshest")
    }

    /// Order is preserved for everything that survives — the fold must not
    /// resort the list into something the server did not send.
    func testSurvivingRowsKeepTheirOrder() {
        let rows = [
            conversation("c", "Three"), conversation("a", "One"),
            conversation("c", "Three again"), conversation("b", "Two"),
        ]
        XCTAssertEqual(ChatDrawer.uniqueByID(rows).map(\.id), ["c", "a", "b"])
    }

    func testAnEmptyListStaysEmpty() {
        XCTAssertTrue(ChatDrawer.uniqueByID([]).isEmpty)
    }

    /// Every row duplicated: one of each, still in order.
    func testAWhollyDuplicatedListCollapsesToOneOfEach() {
        let rows = [
            conversation("a", "One"), conversation("a", "One"),
            conversation("b", "Two"), conversation("b", "Two"),
        ]
        XCTAssertEqual(ChatDrawer.uniqueByID(rows).map(\.id), ["a", "b"])
    }
}
