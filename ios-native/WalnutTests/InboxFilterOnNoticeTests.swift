import XCTest
@testable import Walnut

/// A filter remembered from last launch hid letters with no word on screen (UI audit,
/// 2026-11-21): the Inbox opened on Completion and read as an inbox with three letters. The line
/// under the filter row says which filter is on and how many letters there are in all.
final class InboxFilterOnNoticeTests: XCTestCase {
    func testItNamesTheFilterAndTheWholeCount() {
        XCTAssertEqual(InboxFilterOnNotice.text(filter: .completion, total: 14),
                       "Showing \(InboxFilter.completion.title) only (14 letters in all)")
        XCTAssertEqual(InboxFilterOnNotice.text(filter: .unread, total: 1),
                       "Showing \(InboxFilter.unread.title) only (1 letter in all)")
    }

    func testARailFadesOnlyTheSideThatHasMore() {
        XCTAssertEqual(RailOverflow(), RailOverflow(leading: false, trailing: false))
        XCTAssertNotEqual(RailOverflow(leading: false, trailing: true), RailOverflow())
    }
}
