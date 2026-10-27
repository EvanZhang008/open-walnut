import CoreGraphics
import XCTest
@testable import Walnut

/// A letter with a thread splits into the document and the conversation, each
/// scrolling on its own (2026-10-25: a long document stood between the reader
/// and the newest reply). The console splits with the same numbers
/// (`web/src/components/inbox/thread-pane-model.ts`).
final class LetterPaneSplitTests: XCTestCase {
    func testTheDocumentGetsItsShareWhenBothPanesAreLong() {
        let height = LetterPaneSplit.documentHeight(space: 630, bar: 30, document: 5000, conversation: 3000)
        XCTAssertEqual(height ?? -1, 600 * LetterPaneSplit.documentShare, accuracy: 0.5)
    }

    func testAShortConversationLeavesTheRestToTheDocument() {
        let height = LetterPaneSplit.documentHeight(space: 630, bar: 30, document: 5000, conversation: 100)
        XCTAssertEqual(height ?? -1, 500, accuracy: 0.5)
    }

    func testAShortDocumentTakesOnlyItsOwnHeight() {
        let height = LetterPaneSplit.documentHeight(space: 630, bar: 30, document: 180, conversation: 3000)
        XCTAssertEqual(height ?? -1, 180, accuracy: 0.5)
    }

    func testAnUnmeasuredDocumentStartsAtItsLargestHeight() {
        let height = LetterPaneSplit.documentHeight(space: 630, bar: 30, document: 0, conversation: 3000)
        XCTAssertEqual(height ?? -1, 240, accuracy: 0.5)
    }

    func testNoRoomMeansNoFixedHeight() {
        XCTAssertNil(LetterPaneSplit.documentHeight(space: 0, bar: 30, document: 400, conversation: 400))
        XCTAssertNil(LetterPaneSplit.documentHeight(space: 20, bar: 30, document: 400, conversation: 400))
    }

    /// A full-height pane keeps the 160pt rule; a short one (keyboard up) stops
    /// following after a third of its height, never closer than twice the
    /// distance that starts following again.
    func testAShortPaneStopsFollowingAfterAThirdOfItsHeight() {
        typealias F = LetterFollowsNewestStatus
        XCTAssertEqual(F.stopFollowingDistance(viewport: 700), 160)
        XCTAssertEqual(F.stopFollowingDistance(viewport: 180), 80)
        XCTAssertEqual(F.stopFollowingDistance(viewport: 300), 100)
        XCTAssertEqual(F.stopFollowingDistance(viewport: 0), 80)
    }
}
