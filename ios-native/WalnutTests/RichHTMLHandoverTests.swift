import XCTest
import UIKit
import WebKit
@testable import Walnut

/// A reply that settles keeps its cards and islands as they are.
///
/// When a turn ends, the rows that drew the reply as it streamed give way to the
/// rows of its saved message: other row ids, the same documents. The timeline
/// applies that with `reloadData`, and UIKit hands every visible row a cell of
/// its choosing, so a card used to land in another cell instance and load again,
/// blank until it painted and its script started over: a flash the moment the
/// reply settled (2026-11-01, the user: streaming and finished must look exactly
/// the same, "no flash, no change of format"). The collection controller now
/// offers the visible cells' documents before it reloads
/// (`TimelineRichHTMLCell.offerDocuments`), and a cell asked for a document an
/// offered cell shows takes that cell's web view over.
@MainActor
final class RichHTMLHandoverTests: XCTestCase {
    private let pageWidth: CGFloat = 393
    private var contentWidth: CGFloat { TimelineMetrics.richContentWidth(393) }

    private let cardA = "<div style=\"padding:10px\"><strong>Card A</strong> all green.</div>"
    private let cardB = "<div style=\"padding:10px\"><strong>Card B</strong> two checks.</div>"
    private let islandX = "<div id=x>Island X</div><script>document.getElementById('x').textContent += ' ran'</script>"

    override func setUp() {
        super.setUp()
        MarkdownParser.resetCacheForTesting()
        RichHTMLHeightCache.shared.resetForTesting()
    }

    override func tearDown() {
        RichHTMLHeightCache.shared.resetForTesting()
        super.tearDown()
    }

    private func cell() -> TimelineRichHTMLCell {
        TimelineRichHTMLCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 300))
    }

    /// Two cards drawn by the stream (`live#…` rows), then UIKit binds the saved
    /// rows the other way round: each cell takes the other's web view, the page it
    /// already drew, and loads nothing.
    func testASettledReplyKeepsEachCardsWebViewWhicheverCellItLandsIn() {
        let first = cell(), second = cell()
        first.configureContent(html: cardA, key: "ho-a", streaming: false,
                               rowID: "s|live#0", contentWidth: contentWidth, delegate: nil)
        first.markDocumentReadyForTesting()
        second.configureContent(html: cardB, key: "ho-b", streaming: false,
                                rowID: "s|live#1", contentWidth: contentWidth, delegate: nil)
        second.markDocumentReadyForTesting()
        guard let webA = first.webViewForTesting, let webB = second.webViewForTesting else {
            return XCTFail("no web views")
        }
        let docA = first.loadedDocumentForTesting, docB = second.loadedDocumentForTesting

        TimelineRichHTMLCell.offerDocuments(of: [first, second])
        XCTAssertTrue(first.offeredForTesting)
        XCTAssertTrue(second.offeredForTesting)
        first.configureContent(html: cardB, key: "ho-b", streaming: false,
                               rowID: "s|assistant-1#1", contentWidth: contentWidth, delegate: nil)
        second.configureContent(html: cardA, key: "ho-a", streaming: false,
                                rowID: "s|assistant-1#0", contentWidth: contentWidth, delegate: nil)

        XCTAssertTrue(first.webViewForTesting === webB, "card B loaded again in the cell it landed in")
        XCTAssertTrue(second.webViewForTesting === webA, "card A loaded again in the cell it landed in")
        XCTAssertTrue(webB.superview === first.contentView)
        XCTAssertTrue(webA.superview === second.contentView)
        XCTAssertEqual(first.loadedDocumentForTesting, docB, "a document was loaded at the handover")
        XCTAssertEqual(second.loadedDocumentForTesting, docA, "a document was loaded at the handover")
        XCTAssertEqual(webA.isHidden, false, "card A blanked at the handover")
        XCTAssertEqual(webB.isHidden, false, "card B blanked at the handover")
        XCTAssertFalse(first.offeredForTesting)
        XCTAssertFalse(second.offeredForTesting)
        XCTAssertTrue(webA.navigationDelegate === second)
        XCTAssertTrue(webB.navigationDelegate === first)
    }

    /// The same for an island, the block whose script must not start over.
    func testAnIslandKeepsItsRunningPageWhenItsRowMovesToAnotherCell() {
        let streamed = cell(), other = cell()
        streamed.configureIsland(html: islandX, key: "ho-x", complete: true,
                                 rowID: "s|live#2", contentWidth: contentWidth, delegate: nil)
        streamed.markDocumentReadyForTesting()
        guard let page = streamed.webViewForTesting else { return XCTFail("no web view") }

        TimelineRichHTMLCell.offerDocuments(of: [streamed, other])
        other.configureIsland(html: islandX, key: "ho-x", complete: true,
                              rowID: "s|assistant-1#2", contentWidth: contentWidth, delegate: nil)

        XCTAssertTrue(other.webViewForTesting === page, "the island loaded again at the handover")
        XCTAssertNil(streamed.webViewForTesting)
        XCTAssertEqual(page.isHidden, false)
        XCTAssertEqual(other.islandStoreKeyForTesting,
                       IslandStateStore.storeKey(rowID: "s|assistant-1#2", islandKey: "ho-x"))
    }

    /// Nothing is taken from a cell that was not let go of: one still on screen
    /// keeps its document, and a different document loads as before.
    func testOnlyAnOfferedCellsDocumentIsTakenOver() {
        let shown = cell(), asking = cell()
        shown.configureContent(html: cardA, key: "ho-a2", streaming: false,
                               rowID: "s|m1#0", contentWidth: contentWidth, delegate: nil)
        shown.markDocumentReadyForTesting()
        guard let web = shown.webViewForTesting else { return XCTFail("no web view") }

        asking.configureContent(html: cardA, key: "ho-a2", streaming: false,
                                rowID: "s|m2#0", contentWidth: contentWidth, delegate: nil)
        XCTAssertTrue(shown.webViewForTesting === web)
        XCTAssertFalse(asking.webViewForTesting === web)
    }

    /// A document still loading is not taken over: what its cell shows is not it
    /// yet, and the asking cell loads its own.
    func testADocumentStillLoadingIsNotTakenOver() {
        let loading = cell(), asking = cell()
        loading.configureContent(html: cardB, key: "ho-b2", streaming: false,
                                 rowID: "s|live#0", contentWidth: contentWidth, delegate: nil)
        guard let web = loading.webViewForTesting else { return XCTFail("no web view") }

        TimelineRichHTMLCell.offerDocuments(of: [loading])
        asking.configureContent(html: cardB, key: "ho-b2", streaming: false,
                                rowID: "s|m3#0", contentWidth: contentWidth, delegate: nil)
        XCTAssertTrue(loading.webViewForTesting === web)
        XCTAssertFalse(asking.webViewForTesting === web)
    }
}
