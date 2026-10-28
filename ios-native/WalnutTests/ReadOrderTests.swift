import XCTest
@testable import Walnut

/// Overlapping reads of one letter (its open, a pull, a thread signal): only
/// the newest answer so far is applied, so a slow older answer never puts back
/// an older thread.
@MainActor
final class ReadOrderTests: XCTestCase {
    func testAnswersInOrderAreAllApplied() {
        let order = ReadOrder()
        let first = order.begin()
        XCTAssertTrue(order.accept(first))
        let second = order.begin()
        XCTAssertTrue(order.accept(second))
    }

    func testAnOlderAnswerAfterANewerOneIsDropped() {
        let order = ReadOrder()
        let older = order.begin()
        let newer = order.begin()
        XCTAssertTrue(order.accept(newer))
        XCTAssertFalse(order.accept(older), "the slow older answer replaced the newer one")
    }

    func testAnOlderAnswerStillCountsWhenTheNewerReadFailed() {
        let order = ReadOrder()
        let older = order.begin()
        _ = order.begin()  // failed or cancelled: never accepted
        XCTAssertTrue(order.accept(older))
    }
}
