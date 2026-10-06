import XCTest
@testable import Walnut

/// Tapping Load earlier must leave the reader on the message they were reading.
///
/// The reader taps the row at the TOP of the page, so the viewport anchor used
/// to be that row, and it is at the top before and after the older page lands:
/// restoring it showed the start of the new page and the message the reader was
/// on jumped a page down. The anchor now skips it for the row below it.
@MainActor
final class TimelineLoadEarlierAnchorTests: XCTestCase {
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
        RunLoop.current.run(until: Date().addingTimeInterval(0.35))
        controller.collectionView.layoutIfNeeded()
    }

    /// `renewedHead`: the first held row comes back under a new id, the way a
    /// folded run whose first calls were on the page is keyed by its new first call.
    private func page(older: Int, held: Int, gen: Int, renewedHead: Bool = false) -> TimelineSnapshot {
        let loadEarlier = TimelineRowBuilder().loadEarlierRow(scope: "s")
        let rows = (0..<older).map { TimelineRow(id: "o\($0)", revision: 0, content: .truncationChip, height: 44) }
            + (0..<held).map { i in
                TimelineRow(id: renewedHead && i == 0 ? "h0-renewed" : "h\(i)", revision: 0,
                            content: .truncationChip, height: 44)
            }
        return TimelineSnapshot(rows: [loadEarlier] + rows, width: 393, generation: gen)
    }

    private func screenY(_ controller: TimelineCollectionController, _ id: String) -> CGFloat? {
        guard let i = controller.rows.firstIndex(where: { $0.id == id }),
              let frame = controller.collectionView.layoutAttributesForItem(at: IndexPath(item: i, section: 0))?.frame
        else { return nil }
        return frame.minY - controller.collectionView.contentOffset.y
    }

    private func assertReaderStays(olderRows: Int, renewedHead: Bool = false, watch: String = "h0",
                                   file: StaticString = #filePath, line: UInt = #line) {
        var pinned = true
        let (window, controller) = hostController()
        defer { window.isHidden = true; window.rootViewController = nil }
        controller.isPinned = { pinned }
        controller.setPinned = { pinned = $0 }
        applyFully(controller, page(older: 0, held: 60, gen: 1))
        // The reader scrolled to the top, where the Load earlier row is.
        pinned = false
        let cv = controller.collectionView!
        cv.setContentOffset(CGPoint(x: 0, y: -cv.adjustedContentInset.top), animated: false)
        cv.layoutIfNeeded()
        let before = screenY(controller, watch)
        XCTAssertNotNil(before, file: file, line: line)

        applyFully(controller, page(older: olderRows, held: 60, gen: 2, renewedHead: renewedHead))

        XCTAssertEqual(screenY(controller, watch) ?? -1, before ?? 0, accuracy: 1.0,
                       "the message under the row moved on screen", file: file, line: line)
        XCTAssertFalse(pinned, file: file, line: line)
    }

    func testASmallPageLandsAboveTheReader() {
        assertReaderStays(olderRows: 30) // targeted update path
    }

    func testALargePageLandsAboveTheReader() {
        assertReaderStays(olderRows: 300) // progressive-fill path
    }

    func testAPageThatRenewsTheTopRowsIdKeepsTheRowBelowIt() {
        // Measured on the simulator: the top row was a folded run that continued
        // on the page, so it came back under a new id and the reader landed on
        // the start of the page.
        assertReaderStays(olderRows: 30, renewedHead: true, watch: "h1")
        assertReaderStays(olderRows: 300, renewedHead: true, watch: "h1")
    }
}
