import XCTest
@testable import Walnut

/// The chip block's measured height and its placed lines come from one rule, so a block can
/// never place a line its height did not count (2026-11-06: the Team filter's third chip line
/// sat on the first team row and took its taps).
final class OrgChipFlowTests: XCTestCase {
    /// Five Team filter chips as they measure at the default text size.
    private let team: [CGSize] = [
        CGSize(width: 112, height: 44), CGSize(width: 108, height: 44), CGSize(width: 104, height: 44),
        CGSize(width: 196, height: 44), CGSize(width: 122, height: 44),
    ]

    func testLinesAtThePhoneWidthCountEveryChip() {
        let lines = OrgChipFlow.lines(team, width: 300, spacing: 0)
        XCTAssertEqual(lines, [[0, 1], [2, 3], [4]])
        XCTAssertEqual(lines.flatMap { $0 }, Array(team.indices))
        XCTAssertEqual(OrgChipFlow.height(team, lines: lines, spacing: 0), 132)
    }

    func testAWidthAFractionNarrowerBreaksTheSameLines() {
        // 112 + 108 + 104 = 324: a line that exactly fills its width keeps its chips when the
        // placed width is rounded a fraction of a point below the measured one.
        let measured = OrgChipFlow.lines(team, width: 324, spacing: 0)
        for narrower in [323.9, 323.67, 323.5] as [CGFloat] {
            XCTAssertEqual(OrgChipFlow.lines(team, width: narrower, spacing: 0), measured, "width \(narrower)")
        }
    }

    func testHeightCountsTheSpacingBetweenLines() {
        let sizes = [CGSize(width: 50, height: 20), CGSize(width: 50, height: 30), CGSize(width: 50, height: 10)]
        let lines = OrgChipFlow.lines(sizes, width: 60, spacing: 6)
        XCTAssertEqual(lines, [[0], [1], [2]])
        XCTAssertEqual(OrgChipFlow.height(sizes, lines: lines, spacing: 6), 20 + 30 + 10 + 12)
    }

    func testAChipWiderThanTheBlockTakesALineOfItsOwn() {
        let sizes = [CGSize(width: 40, height: 10), CGSize(width: 500, height: 10), CGSize(width: 40, height: 10)]
        XCTAssertEqual(OrgChipFlow.lines(sizes, width: 300, spacing: 4), [[0], [1], [2]])
        XCTAssertEqual(OrgChipFlow.lines([], width: 300, spacing: 4), [])
    }
}
