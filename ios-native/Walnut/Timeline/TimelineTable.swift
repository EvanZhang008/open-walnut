import UIKit

/// A markdown table laid out for one page width on the TimelineLayoutActor: its
/// cells, each column's width and each row's height. The hosted view draws it at
/// exactly these sizes, so the row height the collection view reserves is the
/// height the table paints (the cell clips).
struct TimelineTable: Hashable {
    let header: [AttributedString]
    let rows: [[AttributedString]]
    let columnWidths: [CGFloat]
    /// The header's height first, then one per body row.
    let rowHeights: [CGFloat]
    /// Body rows past `maxRenderedTableRows`, named in one caption line.
    let omitted: Int
    let omittedHeight: CGFloat
    /// Wider than the page: the table scrolls sideways and shows its indicator.
    let overflows: Bool

    /// Height of the grid itself (inside the padding): every row, a rule under the
    /// header and between rows, the caption line, and the grid's spacing between
    /// all of them.
    var gridHeight: CGFloat {
        let spacing = TimelineMetrics.tableRowSpacing
        // One rule under the header (always, even with no body rows yet, as while a
        // reply streams), one between body rows, one above the caption.
        let rules = 1 + max(0, rows.count - 1) + (omitted > 0 ? 1 : 0)
        let children = 1 + rows.count + rules + (omitted > 0 ? 1 : 0)
        return rowHeights.reduce(0, +) + (omitted > 0 ? omittedHeight : 0)
            + CGFloat(rules) * MarkdownTableLayout.ruleThickness + spacing * CGFloat(children - 1)
    }

    /// Lays `header` and `rows` out for a page `width` points wide. `lineCount`
    /// asks TextKit how many lines a wrapped cell takes (the actor's measurer).
    static func layout(header: [AttributedString], rows: [[AttributedString]],
                       width: CGFloat,
                       lineCount: (NSAttributedString, CGFloat) -> Int) -> TimelineTable {
        let rendered = rows.count > TimelineMetrics.maxRenderedTableRows
            ? Array(rows.prefix(TimelineMetrics.maxRenderedTableRows)) : rows
        let columns = max(1, header.count, rendered.map(\.count).max() ?? 0)
        let font = TimelineTextStyler.subheadlineFont
        let available = TimelineMetrics.tableContentWidth(width)
        let measured = MarkdownTableLayout.measure(
            header: header, rows: rendered, columns: columns, font: font)
        let widths = MarkdownTableLayout.columnWidths(
            natural: measured.natural, available: available,
            spacing: TimelineMetrics.tableColSpacing,
            minColumnWidth: TimelineTextStyler.scaled(MarkdownTableLayout.baseMinColumnWidth,
                                                      relativeTo: .subheadline))
        // A Text's first line is the font's line height; each line after it adds the
        // font's LEADING too. Measured on the pinned simulator, subheadline (lineHeight
        // 17.9, leading 2.1): 1 line 18pt, 2 lines 38, 3 lines 58, for Latin, CJK, Thai
        // and emoji alike, and the same for a wrapped line as for a `<br>`. The header
        // too: SwiftUI's semibold subheadline is still the text style, with its leading
        // (a plain `systemFont(ofSize:weight:)` has none, so never read it from that).
        let lineH = font.lineHeight
        func height(_ r: Int) -> CGFloat {
            let cells = r == 0 ? header : rendered[r - 1]
            var lines = 1
            for c in 0..<measured.strings[r].count {
                if measured.widths[r][c] <= widths[c] {
                    lines = max(lines, MarkdownParser.explicitLineCount(cells[c]))
                } else {
                    // Measured a little narrower than drawn, and a word that must
                    // break mid-word gets a spare line: where TextKit and SwiftUI
                    // break a cell differently, the cell keeps room, never a cut.
                    let text = measured.strings[r][c]
                    let spare = MarkdownTableLayout.longestWordWidth(text) > widths[c] ? 1 : 0
                    lines = max(lines, lineCount(text, max(1, widths[c] - MarkdownTableLayout.slack)) + spare)
                }
            }
            return ceil(lineH + CGFloat(lines - 1) * (lineH + font.leading))
        }
        let heights = (0...rendered.count).map(height)
        return TimelineTable(
            header: header, rows: rendered, columnWidths: widths, rowHeights: heights,
            omitted: rows.count - rendered.count,
            omittedHeight: ceil(TimelineTextStyler.captionFont.lineHeight),
            overflows: MarkdownTableLayout.contentWidth(
                widths, spacing: TimelineMetrics.tableColSpacing) > available + 0.5
        )
    }
}
