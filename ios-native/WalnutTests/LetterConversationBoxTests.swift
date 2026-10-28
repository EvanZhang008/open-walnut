import CoreGraphics
import XCTest
@testable import Walnut

/// A letter with a thread shows its conversation in a box under the letter,
/// scrolling on its own (2026-10-25: a long document stood between the reader
/// and the newest reply; 2026-10-26: the split with a bar between the panes
/// looked broken).
final class LetterConversationBoxTests: XCTestCase {
    typealias Box = LetterConversationBox

    func testAShortLetterSharesOneScreenWithTheBox() {
        XCTAssertEqual(Box.height(visible: 640, document: 200), 440)
        XCTAssertEqual(Box.height(visible: 640, document: 320), 320, "exactly half is still shared")
    }

    func testALongLetterIsReadFirstAndTheBoxThenFillsTheScreen() {
        XCTAssertEqual(Box.height(visible: 640, document: 321), 640)
        XCTAssertEqual(Box.height(visible: 640, document: 5000), 640)
    }

    func testTheKeyboardMakesTheBoxFillWhatIsLeftRatherThanAThinStrip() {
        // 300pt above the keyboard and a 120pt letter: 180pt would be under the
        // 220pt floor, so the box takes the whole 300pt (the page scrolls to it).
        XCTAssertEqual(Box.height(visible: 300, document: 120), 300)
        XCTAssertEqual(Box.height(visible: 300, document: 60), 240)
    }

    func testAScreenSmallerThanTheFloorGivesTheBoxAllOfIt() {
        XCTAssertEqual(Box.height(visible: 150, document: 0), 150)
        XCTAssertEqual(Box.height(visible: 150, document: 400), 150)
    }

    func testBeforeTheFirstMeasureTheBoxHasItsFloor() {
        XCTAssertEqual(Box.height(visible: 0, document: 0), Box.floor)
    }

    /// A full-height box keeps the 160pt rule; a short one (keyboard up) stops
    /// following after a third of its height, never closer than twice the
    /// distance that starts following again.
    func testAShortBoxStopsFollowingAfterAThirdOfItsHeight() {
        typealias F = LetterFollowsNewestStatus
        XCTAssertEqual(F.stopFollowingDistance(viewport: 700), 160)
        XCTAssertEqual(F.stopFollowingDistance(viewport: 180), 80)
        XCTAssertEqual(F.stopFollowingDistance(viewport: 300), 100)
        XCTAssertEqual(F.stopFollowingDistance(viewport: 0), 80)
    }
}
