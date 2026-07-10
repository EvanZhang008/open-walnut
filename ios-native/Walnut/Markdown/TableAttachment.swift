import UIKit

/// Parsed markdown table model shared by the attachment (render) and the
/// edit sheet (mutate). Serialization is canonical `| a | b |` markdown.
struct EditableTable: Equatable {
    var header: [String]
    var rows: [[String]]

    var columnCount: Int { header.count }

    static func parse(lines: [String]) -> EditableTable? {
        guard lines.count >= 2 else { return nil }
        func cells(_ line: String) -> [String] {
            var t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("|") { t.removeFirst() }
            if t.hasSuffix("|") { t.removeLast() }
            return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        let header = cells(lines[0])
        guard !header.isEmpty else { return nil }
        var rows: [[String]] = []
        for line in lines.dropFirst(2) {
            var row = cells(line)
            // Normalize ragged rows to the header width.
            while row.count < header.count { row.append("") }
            if row.count > header.count { row = Array(row.prefix(header.count)) }
            rows.append(row)
        }
        return EditableTable(header: header, rows: rows)
    }

    func serialize() -> String {
        func line(_ cells: [String]) -> String {
            "| " + cells.map { $0.replacingOccurrences(of: "|", with: "\\|") }.joined(separator: " | ") + " |"
        }
        let separator = "| " + Array(repeating: "---", count: columnCount).joined(separator: " | ") + " |"
        return ([line(header), separator] + rows.map(line)).joined(separator: "\n")
    }

    static func empty(columns: Int = 2, rows: Int = 2) -> EditableTable {
        EditableTable(
            header: (1...columns).map { "Column \($0)" },
            rows: Array(repeating: Array(repeating: "", count: columns), count: rows)
        )
    }
}

/// Inline attachment that renders a markdown table as a real grid (bordered
/// cells, bold header) instead of literal pipe text. Tapping it opens the
/// in-place TableInlineEditor. `table` is mutable: the editor rewrites it in
/// place and re-renders, and the serializer emits `table.serialize()`.
final class TableAttachment: NSTextAttachment {
    var table: EditableTable
    private(set) var renderWidth: CGFloat
    /// Exact source text this table was parsed from. Serialized verbatim
    /// while the table is untouched (round-trip byte-identity); cleared on
    /// the first real edit, after which canonical `serialize()` is used.
    private(set) var originalSource: String?

    init(table: EditableTable, maxWidth: CGFloat, originalSource: String? = nil) {
        self.table = table
        self.renderWidth = max(maxWidth, 120)
        self.originalSource = originalSource
        super.init(data: nil, ofType: nil)
        rerender()
    }

    required init?(coder: NSCoder) { nil }

    var markdown: String {
        originalSource ?? table.serialize()
    }

    func update(table: EditableTable) {
        guard table != self.table else { return }
        self.table = table
        self.originalSource = nil
        rerender()
    }

    /// Baked-image attachments don't re-resolve dynamic colors on appearance
    /// change — re-draw with the given traits current (dark-mode visibility).
    func rerender(for traits: UITraitCollection) {
        traits.performAsCurrent { rerender() }
    }

    private func rerender() {
        let image = Self.render(table: table, width: renderWidth)
        self.image = image
        self.bounds = CGRect(x: 0, y: 0, width: image.size.width, height: image.size.height)
    }

    /// Shared with TableInlineEditor so the editing grid overlays the
    /// rendered image cell-for-cell.
    static let rowHeight: CGFloat = 34

    private static func render(table: EditableTable, width: CGFloat) -> UIImage {
        let cols = max(table.columnCount, 1)
        let rowHeight = Self.rowHeight
        let rowCount = table.rows.count + 1
        let height = rowHeight * CGFloat(rowCount)
        let colWidth = width / CGFloat(cols)
        let headerFont = UIFont.systemFont(ofSize: 14, weight: .semibold)
        let bodyFont = UIFont.systemFont(ofSize: 14)

        // Render at the current display scale; label/separator colors resolve
        // against the current trait collection (light/dark) at render time.
        let format = UIGraphicsImageRendererFormat.default()
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
        return renderer.image { ctx in
            let cg = ctx.cgContext

            // Header background wash
            UIColor.secondarySystemBackground.setFill()
            cg.fill(CGRect(x: 0, y: 0, width: width, height: rowHeight))

            // Grid lines
            UIColor.separator.setStroke()
            cg.setLineWidth(0.5)
            for r in 0...rowCount {
                let y = CGFloat(r) * rowHeight
                cg.move(to: CGPoint(x: 0, y: y))
                cg.addLine(to: CGPoint(x: width, y: y))
            }
            for c in 0...cols {
                let x = CGFloat(c) * colWidth
                cg.move(to: CGPoint(x: x, y: 0))
                cg.addLine(to: CGPoint(x: x, y: height))
            }
            cg.strokePath()

            func draw(_ text: String, row: Int, col: Int, font: UIFont) {
                let rect = CGRect(
                    x: CGFloat(col) * colWidth + 8,
                    y: CGFloat(row) * rowHeight + (rowHeight - font.lineHeight) / 2,
                    width: colWidth - 16,
                    height: font.lineHeight
                )
                (text as NSString).draw(
                    in: rect,
                    withAttributes: [.font: font, .foregroundColor: UIColor.label]
                )
            }
            for (c, text) in table.header.enumerated() {
                draw(text, row: 0, col: c, font: headerFont)
            }
            for (r, row) in table.rows.enumerated() {
                for (c, text) in row.enumerated() {
                    draw(text, row: r + 1, col: c, font: bodyFont)
                }
            }
        }
    }
}

