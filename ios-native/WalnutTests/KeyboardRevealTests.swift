import XCTest
@testable import Walnut

/// How far a page moves so a focused box clears the keyboard (`KeyboardReveal.lift`), with the
/// numbers CI showed (2026-11-26: a box ending at y 954 under a keyboard from y 540).
final class KeyboardRevealTests: XCTestCase {
    func testABoxUnderTheKeyboardMovesUpByItsOverlapAndTheMargin() {
        XCTAssertEqual(KeyboardReveal.lift(bottom: 954, coverTop: 540, margin: 12, room: 2000), 426)
    }

    func testABoxThatShowsDoesNotMove() {
        XCTAssertEqual(KeyboardReveal.lift(bottom: 500, coverTop: 540, margin: 12, room: 2000), 0)
        XCTAssertEqual(KeyboardReveal.lift(bottom: 528, coverTop: 540, margin: 12, room: 2000), 0)
    }

    func testThePageNeverScrollsPastItsEnd() {
        XCTAssertEqual(KeyboardReveal.lift(bottom: 954, coverTop: 540, margin: 12, room: 100), 100)
        XCTAssertEqual(KeyboardReveal.lift(bottom: 954, coverTop: 540, margin: 12, room: -20), 0)
    }
}
