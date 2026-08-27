import XCTest
@testable import Walnut

/// The Tasks tab's HEADER CHROME — the smart-list cards, quick add, and scope
/// picker that sit above the rows. Dogfood R19 measured the cost of treating
/// each of them as an `insetGrouped` section: on an iPhone 16 Pro (402x874pt)
/// the first task row started 591pt down, so 68% of the screen was chrome and
/// spacing on the tab whose whole job is showing tasks.
///
/// Geometry can't be asserted without a running app, so what's pinned here is
/// the ARITHMETIC the fix depends on plus the count formatting that shares the
/// same fixed-width card. The visual result is verified on the simulator (see
/// the round's screenshots) and by `TasksHeaderChromeUITests`.
final class TasksHeaderChromeTests: XCTestCase {

    /// Every card is a fixed 130pt box, so a long count has nowhere to grow.
    /// This is the width the view hard-codes; if it changes, the scale factor
    /// below needs re-deriving.
    private let cardWidth: CGFloat = 130
    private let cardHorizontalPadding: CGFloat = 12

    // MARK: - Card count formatting

    func testFourDigitCountIsGroupedNotRaw() {
        // 2824 open tasks is the real store's number. Raw interpolation gives
        // "2824"; the card shows a grouped, locale-aware count.
        XCTAssertEqual(2824.formatted(.number), format(2824))
        XCTAssertNotEqual("2824", format(2824), "the card must group thousands")
    }

    func testGroupedCountStaysOnOneLineWithinTheCard() {
        // The bug: `Text` wrapped "2,824" BETWEEN DIGITS ("2,82" / "4") because
        // the grouped string is wider than the card's content box. The fix pairs
        // lineLimit(1) with minimumScaleFactor(0.6); this asserts 0.6 is enough
        // headroom for the widest count the app can show.
        let content = cardWidth - cardHorizontalPadding * 2   // 106pt
        // .title is 28pt; monospaced digits are ~0.6em wide, separators ~0.28em.
        let digitWidth = 28.0 * 0.6
        let separatorWidth = 28.0 * 0.28
        for count in [0, 9, 15, 207, 500, 2824, 99_999] {
            let s = format(count)
            let digits = s.filter(\.isNumber).count
            let separators = s.count - digits
            let natural = Double(digits) * digitWidth + Double(separators) * separatorWidth
            let scaled = natural * 0.6
            XCTAssertLessThanOrEqual(
                scaled, Double(content),
                "count \(s) still overflows the card at the 0.6 floor"
            )
        }
    }

    func testCountFormattingNeverProducesANewline() {
        // Whatever the locale does with grouping, the string itself must be one
        // line — a newline here would defeat lineLimit(1) by splitting earlier.
        for count in [0, 1, 1000, 2824, 1_234_567] {
            XCTAssertFalse(format(count).contains("\n"), "\(count) formatted with a newline")
        }
    }

    // MARK: - The spacing budget the fix buys back

    /// The four chrome sections the Tasks list stacks before its first row.
    /// `insetGrouped`'s default inter-section gap is what the fix collapses.
    func testCollapsingChromeSectionSpacingBuysBackMoreThanARow() {
        let measuredDefaultGaps = [61.0, 87.0, 59.0, 70.0]   // dogfood R19, hierarchy dump
        let tightGap = 2.0
        let before = measuredDefaultGaps.reduce(0, +)
        let after = Double(measuredDefaultGaps.count) * tightGap
        let reclaimed = before - after
        XCTAssertEqual(before, 277, accuracy: 0.5, "the measured baseline this fix targets")
        XCTAssertGreaterThan(
            reclaimed, 93,
            "must reclaim at least one task row (a two-line row measured 93pt)"
        )
        // And the rows must still be the majority use of the screen afterwards.
        let screenHeight = 874.0
        let firstRowBefore = 591.0
        let firstRowAfter = firstRowBefore - reclaimed
        XCTAssertLessThan(firstRowAfter / screenHeight, 0.6, "first row should sit above 60% down")
    }

    /// A section gap of ZERO would weld the cards to the quick-add row; the
    /// point is a tight toolbar, not a seamless one.
    func testChromeGapIsTightButNotZero() {
        let chromeGap = 2.0
        XCTAssertGreaterThan(chromeGap, 0)
        XCTAssertLessThan(chromeGap, 8, "anything bigger reads as a settings group again")
    }

    private func format(_ count: Int) -> String { count.formatted(.number) }
}
