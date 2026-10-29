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

    /// At the largest text size five lines of draft took 340pt of the 430
    /// above the keyboard and the box got 43pt (2026-10-28). The field takes at
    /// most a third of the height it shares with the page.
    func testTheReplyFieldTakesAtMostAThirdOfTheSharedHeight() {
        XCTAssertNil(Box.replyFieldCap(shared: 0), "before the first measure the field keeps its lines")
        let cap = try! XCTUnwrap(Box.replyFieldCap(shared: 430))
        XCTAssertEqual(cap, 430.0 / 3, accuracy: 0.01)
        // What is left for the page still gives the box more than its floor.
        XCTAssertGreaterThanOrEqual(430 - cap, Box.floor)
        XCTAssertEqual(Box.replyFieldCap(shared: 900)!, 300, accuracy: 0.01)
    }

    /// The page follows a growing draft only right after an edit: a keyboard
    /// dragged away resizes the reply box too, and must not move the page.
    @MainActor
    func testTheDraftIsFollowedOnlyRightAfterAnEdit() {
        let follow = DraftGrowthFollow()
        let t = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(follow.editedRecently(now: t), "nothing was typed yet")
        follow.edited(at: t)
        XCTAssertTrue(follow.editedRecently(now: t.addingTimeInterval(0.2)))
        XCTAssertFalse(follow.editedRecently(now: t.addingTimeInterval(0.6)), "a later resize is not the edit's")
    }

    /// One fit rule for both passes of the turn header, with room for rounding.
    func testATurnHeaderThatMeasuresAsOneLineIsPlacedAsOne() {
        let line = LetterTurnHeaderLayout.oneLine(
            name: CGSize(width: 120, height: 16), date: CGSize(width: 90.3, height: 15), spacing: 5
        )
        XCTAssertEqual(line, CGSize(width: 215.3, height: 16))
        XCTAssertTrue(LetterTurnHeaderLayout.fits(line, in: 215.3))
        XCTAssertTrue(LetterTurnHeaderLayout.fits(line, in: 215), "bounds rounded down to the pixel grid")
        XCTAssertFalse(LetterTurnHeaderLayout.fits(line, in: 214))
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
