import SwiftUI
import UIKit

/// How a markdown table fits a phone, shared by the chat timeline (which lays it out
/// ahead of time, off the main thread) and `MarkdownView` (letters, sheets).
///
/// Every column is as wide as its widest line when the whole table fits. When it does
/// not, a column narrower than an even share keeps its own width and the wide ones
/// share what is left in proportion to their content, so their cells WRAP; no column
/// shrinks below `minColumnWidth` (or its own content, when that is narrower). Only a
/// table whose columns cannot all keep that floor is wider than the screen, and that
/// one scrolls sideways.
///
/// 2026-10-27: every cell was laid out on one unwrapped line, so a two-column table of
/// task lists ran off the right edge with half a word showing, and with no line
/// between rows the reader could not tell which tasks belonged to which row.
enum MarkdownTableLayout {
    /// The narrowest a wrapping column gets at the default text size: about seven
    /// CJK characters or one long English word a line.
    static let baseMinColumnWidth: CGFloat = 96

    /// Room added to every measured width. SwiftUI's `Text` and the measuring
    /// attributed string can differ by a fraction of a point, and a column one point
    /// short of its widest line wraps that line.
    static let slack: CGFloat = 2

    /// Column widths for cells whose single-line widths are `natural`, inside
    /// `available` points with `spacing` between columns. The sum (plus spacing) is
    /// over `available` only when the floor made it so.
    static func columnWidths(natural: [CGFloat], available: CGFloat,
                             spacing: CGFloat, minColumnWidth: CGFloat) -> [CGFloat] {
        let count = natural.count
        guard count > 0 else { return [] }
        var left = max(0, available - spacing * CGFloat(count - 1))
        if natural.reduce(0, +) <= left { return natural }
        var widths = natural
        var flexible = Array(0..<count)
        // Columns no wider than an even share of what is left keep their width.
        while !flexible.isEmpty {
            let share = left / CGFloat(flexible.count)
            let narrow = flexible.filter { natural[$0] <= share }
            if narrow.isEmpty { break }
            for c in narrow { left -= natural[c] }
            flexible.removeAll { narrow.contains($0) }
        }
        // The wide ones share the rest by their content, each at least the floor.
        while !flexible.isEmpty {
            let total = flexible.reduce(CGFloat(0)) { $0 + natural[$1] }
            guard total > 0 else {
                for c in flexible { widths[c] = 0 }
                break
            }
            let room = max(0, left)
            let floored = flexible.filter {
                room * natural[$0] / total < min(natural[$0], minColumnWidth)
            }
            if floored.isEmpty {
                for c in flexible { widths[c] = (room * natural[c] / total).rounded(.down) }
                break
            }
            for c in floored {
                widths[c] = min(natural[c], minColumnWidth)
                left -= widths[c]
            }
            flexible.removeAll { floored.contains($0) }
        }
        return widths
    }

    /// Total width of columns `widths` laid out with `spacing` between them.
    static func contentWidth(_ widths: [CGFloat], spacing: CGFloat) -> CGFloat {
        widths.reduce(0, +) + spacing * CGFloat(max(0, widths.count - 1))
    }

    /// A cell as the UIKit string that measures like SwiftUI draws it: `Text` with
    /// the parser's runs (code at the SAME size, unlike the chat text cells' 0.88
    /// code; `**bold**` at `.bold`, which is what SwiftUI draws, not the semibold a
    /// bold trait gives a text-style font), wrapping with the standard strategy.
    /// `weight` is the cell's own: semibold for a header.
    static func measurable(_ cell: AttributedString, font: UIFont,
                           weight: UIFont.Weight = .regular) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakStrategy = .standard
        let out = NSMutableAttributedString()
        for run in cell.runs {
            let intent = run.inlinePresentationIntent ?? []
            let runWeight: UIFont.Weight = intent.contains(.stronglyEmphasized) ? .bold : weight
            var runFont = intent.contains(.code)
                ? UIFont.monospacedSystemFont(ofSize: font.pointSize, weight: runWeight)
                : UIFont.systemFont(ofSize: font.pointSize, weight: runWeight)
            if intent.contains(.emphasized) { runFont = runFont.withTraits(.traitItalic) }
            out.append(NSAttributedString(
                string: String(cell[run.range].characters),
                attributes: [.font: runFont, .paragraphStyle: paragraph]
            ))
        }
        return out
    }

    /// Width of the widest line (a `<br>` starts a new one), plus `slack`.
    /// NSString drawing measurement is safe off the main thread.
    static func naturalWidth(_ text: NSAttributedString) -> CGFloat {
        guard text.length > 0 else { return 0 }
        let rect = text.boundingRect(
            with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin], context: nil
        )
        return ceil(rect.width) + slack
    }

    /// One table measured once: every cell's string and single-line width (header
    /// row first), and each column's natural width.
    struct Measured {
        let strings: [[NSAttributedString]]
        let widths: [[CGFloat]]
        let natural: [CGFloat]
    }

    /// Width of the widest run between spaces or breaks (a path, a URL, a long
    /// word), plus `slack`. Wider than its column, it must break mid-word, and
    /// TextKit and SwiftUI do that differently (measured 2026-10-28: a code path
    /// at an accessibility size took one line more in SwiftUI).
    static func longestWordWidth(_ text: NSAttributedString) -> CGFloat {
        let ns = text.string as NSString
        var widest: CGFloat = 0
        var start = 0
        for i in 0...ns.length {
            let atEnd = i == ns.length
            if atEnd || CharacterSet.whitespacesAndNewlines.contains(UnicodeScalar(ns.character(at: i)) ?? " ") {
                if i > start {
                    widest = max(widest, naturalWidth(text.attributedSubstring(
                        from: NSRange(location: start, length: i - start))))
                }
                start = i + 1
            }
        }
        return widest
    }

    /// Measures a header and body rows of `columns` columns at `font` (the header
    /// at semibold, as the views draw it).
    static func measure(header: [AttributedString], rows: [[AttributedString]],
                        columns: Int, font: UIFont) -> Measured {
        var strings: [[NSAttributedString]] = []
        var widths: [[CGFloat]] = []
        var natural = [CGFloat](repeating: 0, count: columns)
        for (r, row) in ([header] + rows).enumerated() {
            let texts = row.prefix(columns).map {
                measurable($0, font: font, weight: r == 0 ? .semibold : .regular)
            }
            let lineWidths = texts.map(naturalWidth)
            for (c, w) in lineWidths.enumerated() { natural[c] = max(natural[c], w) }
            strings.append(texts)
            widths.append(lineWidths)
        }
        return Measured(strings: strings, widths: widths, natural: natural)
    }

    /// The rule under a header and between rows, in points.
    static let ruleThickness: CGFloat = 1
}

/// The line under a table's header and between its rows. A Grid child that is not a
/// `GridRow` spans every column; it must not size them.
struct MarkdownTableRule: View {
    var body: some View {
        Rectangle()
            .fill(Color(.separator))
            .frame(height: MarkdownTableLayout.ruleThickness)
            .gridCellUnsizedAxes(.horizontal)
    }
}

/// The table `MarkdownView` draws (letters, sheets): the same columns and rules as
/// the chat's, laid out live for the width it is given; SwiftUI sizes each row to
/// its wrapped cells.
struct MarkdownTableView: View {
    let header: [AttributedString]
    let rows: [[AttributedString]]
    let omitted: Int

    static let padding: CGFloat = 12
    static let columnSpacing: CGFloat = 16

    /// Column widths for the width last given (empty until then: that first pass
    /// draws cells unwrapped), measured when the width or the text size changes,
    /// never on an ordinary redraw.
    @State private var widths: [CGFloat] = []
    @State private var overflows = false
    @State private var available: CGFloat = 0
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var columns: Int { max(1, header.count, rows.map(\.count).max() ?? 0) }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: overflows) {
            Grid(alignment: .topLeading, horizontalSpacing: Self.columnSpacing, verticalSpacing: 6) {
                cells(header, font: .subheadline.weight(.semibold))
                MarkdownTableRule()
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { MarkdownTableRule() }
                    cells(row, font: .subheadline)
                }
                if omitted > 0 {
                    MarkdownTableRule()
                    GridRow {
                        Text("\u{2026} \(omitted) more row\(omitted == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .gridCellColumns(columns)
                    }
                }
            }
            .padding(Self.padding)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        // A table wider than the page says so when it appears: nothing else hints
        // that the cut-off column scrolls into view.
        .scrollIndicatorsFlash(onAppear: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            let next = max(0, width - Self.padding * 2)
            guard abs(next - available) > 0.5 else { return }
            available = next
            relayout()
        }
        .onChange(of: dynamicTypeSize) { relayout() }
        .background(Color(.secondarySystemBackground).opacity(0.6),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func relayout() {
        guard available > 0 else { return }
        let font = UIFont.preferredFont(forTextStyle: .subheadline)
        let measured = MarkdownTableLayout.measure(header: header, rows: rows,
                                                   columns: columns, font: font)
        widths = MarkdownTableLayout.columnWidths(
            natural: measured.natural, available: available, spacing: Self.columnSpacing,
            minColumnWidth: UIFontMetrics(forTextStyle: .subheadline)
                .scaledValue(for: MarkdownTableLayout.baseMinColumnWidth))
        overflows = MarkdownTableLayout.contentWidth(widths, spacing: Self.columnSpacing)
            > available + 0.5
    }

    @ViewBuilder
    private func cells(_ row: [AttributedString], font: Font) -> some View {
        GridRow {
            ForEach(0..<columns, id: \.self) { c in
                let text = Text(c < row.count ? row[c] : AttributedString("")).font(font)
                if c < widths.count {
                    text.frame(width: widths[c], alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    text.fixedSize()
                }
            }
        }
    }
}
