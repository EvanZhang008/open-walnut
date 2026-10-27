import XCTest
@testable import Walnut

/// Opening a folded row keeps its heading where the reader tapped it.
///
/// A reader at the bottom is pinned, and a pinned apply follows the bottom: the
/// card grew under the tap and its heading was pushed off the top of the screen.
/// The apply that opens the tapped row now holds that row in place instead, and
/// the reader, now reading the card, is no longer pinned to the bottom.
@MainActor
final class TimelineToggleAnchorTests: XCTestCase {
    private func hostController() -> (UIWindow, TimelineCollectionController) {
        let controller = TimelineCollectionController()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = controller
        window.isHidden = false
        controller.view.frame = window.bounds
        controller.view.layoutIfNeeded()
        return (window, controller)
    }

    private func applyFully(_ controller: TimelineCollectionController, _ snapshot: TimelineSnapshot) {
        controller.apply(snapshot)
        for _ in 0..<100 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
            if controller.rows.count == snapshot.rows.count { break }
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        controller.collectionView.layoutIfNeeded()
    }

    /// 30 rows, then the card `c`, then two rows under it.
    private func page(cardHeight: CGFloat, cardRevision: Int, tail: Int = 0, gen: Int) -> TimelineSnapshot {
        let head = (0..<30).map { TimelineRow(id: "r\($0)", revision: 0, content: .truncationChip, height: 44) }
        let card = TimelineRow(id: "c", revision: cardRevision, content: .truncationChip, height: cardHeight)
        let below = (0..<2).map { i in
            TimelineRow(id: "t\(i)", revision: i == 1 ? tail : 0, content: .truncationChip, height: 44)
        }
        return TimelineSnapshot(rows: head + [card] + below, width: 393, generation: gen)
    }

    private func screenY(_ controller: TimelineCollectionController, _ id: String) -> CGFloat? {
        guard let i = controller.rows.firstIndex(where: { $0.id == id }),
              let frame = controller.collectionView.layoutAttributesForItem(at: IndexPath(item: i, section: 0))?.frame
        else { return nil }
        return frame.minY - controller.collectionView.contentOffset.y
    }

    func testOpeningACardAtTheBottomKeepsItsHeadingWhereItWasTapped() {
        var pinned = true
        let (window, controller) = hostController()
        defer { window.isHidden = true; window.rootViewController = nil }
        controller.isPinned = { pinned }
        controller.setPinned = { pinned = $0 }
        applyFully(controller, page(cardHeight: 60, cardRevision: 0, gen: 1))
        let before = screenY(controller, "c")
        XCTAssertNotNil(before)
        XCTAssertLessThan(before ?? 0, 852, "the card is on screen at the bottom")

        controller.timelineCell(didRequest: .toggleExpanded(rowID: "c"))
        // A streaming tick that lands before the rebuild leaves the request waiting.
        applyFully(controller, page(cardHeight: 60, cardRevision: 0, tail: 1, gen: 2))
        let afterTick = screenY(controller, "c")
        XCTAssertTrue(pinned, "an unrelated apply keeps the reader pinned")

        applyFully(controller, page(cardHeight: 640, cardRevision: 1, tail: 1, gen: 3))
        XCTAssertEqual(screenY(controller, "c") ?? -1, afterTick ?? 0, accuracy: 1.0,
                       "the opened card's heading moved on screen")
        XCTAssertFalse(pinned, "a reader reading the card they opened is no longer at the bottom")

        // A later apply does not pull the reader back down to the bottom.
        applyFully(controller, page(cardHeight: 640, cardRevision: 1, tail: 2, gen: 4))
        XCTAssertEqual(screenY(controller, "c") ?? -1, afterTick ?? 0, accuracy: 1.0)
    }

    func testClosingACardKeepsItsHeadingAndAReaderAtTheBottomStaysPinned() {
        var pinned = true
        let (window, controller) = hostController()
        defer { window.isHidden = true; window.rootViewController = nil }
        controller.isPinned = { pinned }
        controller.setPinned = { pinned = $0 }
        applyFully(controller, page(cardHeight: 300, cardRevision: 1, gen: 1))
        let before = screenY(controller, "c")
        controller.timelineCell(didRequest: .toggleExpanded(rowID: "c"))
        applyFully(controller, page(cardHeight: 60, cardRevision: 0, gen: 2))
        // The card shrinks; the content can no longer reach above it, so the offset
        // clamps to the bottom and the heading moves down by what the bottom allows.
        let after = screenY(controller, "c") ?? -1
        XCTAssertGreaterThanOrEqual(after, (before ?? 0) - 1, "closing never pushes the heading up")
        XCTAssertTrue(pinned, "closing a card at the bottom leaves the reader at the bottom")
    }

    func testARequestForARowThatNeverChangesExpires() {
        var pinned = true
        let (window, controller) = hostController()
        defer { window.isHidden = true; window.rootViewController = nil }
        controller.isPinned = { pinned }
        controller.setPinned = { pinned = $0 }
        applyFully(controller, page(cardHeight: 60, cardRevision: 0, gen: 1))
        controller.timelineCell(didRequest: .toggleExpanded(rowID: "gone"))
        // The tapped row is not in the next snapshot: the request is dropped, and the
        // card's later growth follows the bottom as it always has.
        applyFully(controller, page(cardHeight: 60, cardRevision: 0, tail: 1, gen: 2))
        applyFully(controller, page(cardHeight: 640, cardRevision: 1, tail: 1, gen: 3))
        XCTAssertTrue(pinned)
        let cv = controller.collectionView!
        let bottom = cv.contentSize.height + cv.adjustedContentInset.bottom - cv.bounds.maxY
        XCTAssertLessThan(abs(bottom), 1, "a pinned reader follows the bottom")
    }
}
