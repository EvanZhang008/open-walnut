import UIKit

/// Apple Notes-style IN-PLACE table editor. A live grid of `UITextField`s is
/// overlaid exactly on top of a rendered `TableAttachment` inside the note's
/// UITextView (no sheet, no separate screen) — you type straight into the
/// cells. A compact floating pill offers add/remove row & column, delete, and
/// a checkmark to finish. Commit writes the edited table back through the
/// coordinator, which re-renders the attachment and reflows the text.
final class TableInlineEditor: UIView, UITextFieldDelegate {
    private let attachment: TableAttachment
    private let charIndex: Int
    private weak var textView: UITextView?
    /// Working copy of the EDITABLE (rendered) part of the table — the source of
    /// truth while editing; pushed back to the attachment on structural changes
    /// (live reflow) and on commit.
    private var table: EditableTable
    /// Rows past the render cap. They have no cells on screen, so they are kept
    /// verbatim and re-appended on every push back to the attachment — without
    /// this, editing one cell of a 150-row table deleted rows 101+ on autosave.
    /// Cell coordinates therefore map 1:1 to absolute row indices (visible rows
    /// are always the first `TableAttachment.maxRenderedRows`).
    private var hiddenRows: [[String]]

    /// Re-render the attachment for a size change WITHOUT triggering autosave.
    private let onLiveResize: (EditableTable) -> Void
    /// Final write: non-nil table commits edits (+ autosave); nil deletes the
    /// table. The coordinator removes this overlay from the view tree.
    private let onCommit: (EditableTable?) -> Void

    private let gridBackground = GridBackgroundView()
    /// Row-major, header row first: `fields[row * columnCount + col]`.
    private var fields: [UITextField] = []
    private let pill = UIView()
    /// Host text-view content inset before we grew it for the keyboard.
    private var savedBottomInset: CGFloat = 0
    private var keyboardObservers: [NSObjectProtocol] = []

    private var rowHeight: CGFloat { TableAttachment.rowHeight }
    private var rowCount: Int { table.rows.count + 1 }
    private var columnWidth: CGFloat { attachment.renderWidth / CGFloat(max(table.columnCount, 1)) }

    init(
        attachment: TableAttachment, charIndex: Int, in textView: UITextView,
        onLiveResize: @escaping (EditableTable) -> Void,
        onCommit: @escaping (EditableTable?) -> Void
    ) {
        self.attachment = attachment
        self.charIndex = charIndex
        self.textView = textView
        let full = attachment.table
        let cap = TableAttachment.maxRenderedRows
        self.table = EditableTable(header: full.header, rows: Array(full.rows.prefix(cap)))
        self.hiddenRows = full.rows.count > cap ? Array(full.rows.dropFirst(cap)) : []
        self.onLiveResize = onLiveResize
        self.onCommit = onCommit
        self.savedBottomInset = textView.contentInset.bottom
        super.init(frame: .zero)
        backgroundColor = .systemBackground // mask the rendered image beneath
        clipsToBounds = false               // let the pill float outside bounds
        accessibilityIdentifier = "table.inline.editor"
        addSubview(gridBackground)
        buildPill()
        rebuildCells()
        layoutToAttachment()
        observeKeyboard()
    }

    required init?(coder: NSCoder) { nil }

    deinit { keyboardObservers.forEach(NotificationCenter.default.removeObserver) }

    /// Keep the focused cell (and its pill) clear of the keyboard by growing
    /// the host text view's bottom inset and scrolling the attachment up.
    private func observeKeyboard() {
        let show = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
        ) { [weak self] note in
            MainActor.assumeIsolated { self?.keyboardFrameChanged(note) }
        }
        keyboardObservers = [show]
    }

    private func keyboardFrameChanged(_ note: Notification) {
        guard let textView, textView.window != nil,
              let endFrame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        // `from: nil` interprets the notification's screen-space frame in the
        // window's base coordinates — the standard keyboard-avoidance idiom.
        let kbTop = textView.convert(endFrame, from: nil).minY
        let overlap = max(0, textView.bounds.height - kbTop)
        var inset = textView.contentInset
        inset.bottom = overlap + frame.height + 60
        textView.contentInset = inset
        textView.verticalScrollIndicatorInsets.bottom = overlap
        let target = frame.insetBy(dx: 0, dy: -60)
        textView.scrollRectToVisible(target, animated: true)
    }

    // MARK: - Public lifecycle

    /// Focus the cell under `preferredPoint` (a point in the text view), or the
    /// first cell when there's no tap origin (freshly inserted table).
    func beginEditing(preferredPoint: CGPoint?) {
        guard !fields.isEmpty else { return }
        let target: UITextField
        if let point = preferredPoint {
            let local = convert(point, from: textView)
            let cols = max(table.columnCount, 1)
            let c = min(max(Int(local.x / columnWidth), 0), cols - 1)
            let r = min(max(Int(local.y / rowHeight), 0), rowCount - 1)
            target = fields[r * cols + c]
        } else {
            target = fields[0]
        }
        target.becomeFirstResponder()
    }

    /// Edited visible rows plus the untouched rows past the render cap — the
    /// only value that may be written back to the attachment.
    private var merged: EditableTable {
        EditableTable(header: table.header, rows: table.rows + hiddenRows)
    }

    /// Commit whatever is in the cells and hand control back to the coordinator.
    func commit() {
        syncFieldsToTable()
        restoreHostInset()
        endEditing(true)
        onCommit(merged)
    }

    private func restoreHostInset() {
        guard let textView else { return }
        var inset = textView.contentInset
        inset.bottom = savedBottomInset
        textView.contentInset = inset
        textView.verticalScrollIndicatorInsets.bottom = 0
    }

    // MARK: - Geometry

    /// Size/position the overlay to sit exactly over the attachment's glyph.
    private func layoutToAttachment() {
        guard let textView else { return }
        let range = NSRange(location: charIndex, length: 1)
        let layout = textView.layoutManager
        // Range-bounded (audit GEO-7, pairs with the liveResize call site in
        // WysiwygEditor): boundingRect below only needs THIS attachment's
        // glyph laid out — the old full-container ensureLayout re-laid-out
        // everything after the table on every live-resize repin.
        layout.ensureLayout(forCharacterRange: range)
        let glyphRange = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var rect = layout.boundingRect(forGlyphRange: glyphRange, in: textView.textContainer)
        rect.origin.x += textView.textContainerInset.left
        rect.origin.y += textView.textContainerInset.top
        // Snap to the attachment's exact rendered size (avoids sub-pixel drift).
        frame = CGRect(
            x: rect.origin.x, y: rect.origin.y,
            width: attachment.renderWidth, height: rowHeight * CGFloat(rowCount)
        )
        gridBackground.configure(columns: table.columnCount, rows: rowCount)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        gridBackground.frame = bounds
        layoutCells()
        positionPill()
    }

    private func layoutCells() {
        let cols = max(table.columnCount, 1)
        let pad: CGFloat = 8
        for (i, field) in fields.enumerated() {
            let r = i / cols, c = i % cols
            field.frame = CGRect(
                x: CGFloat(c) * columnWidth + pad, y: CGFloat(r) * rowHeight,
                width: columnWidth - pad * 2, height: rowHeight
            )
        }
    }

    /// Float the pill just above the grid, or below it when the grid sits too
    /// close to the top of the note to leave room above.
    private func positionPill() {
        let above = frame.minY > pill.bounds.height + 16
        pill.frame.origin = CGPoint(
            x: (bounds.width - pill.bounds.width) / 2,
            y: above ? -pill.bounds.height - 10 : bounds.height + 10
        )
    }

    /// The pill lives outside `bounds`, so extend the hit area to cover it —
    /// otherwise its buttons never receive touches (and a tap on it would be
    /// treated as "outside", committing the table).
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event) || pill.frame.contains(point)
    }

    // MARK: - Cells

    private func rebuildCells() {
        fields.forEach { $0.removeFromSuperview() }
        fields.removeAll()
        for r in 0..<rowCount {
            for c in 0..<table.columnCount {
                let field = makeField(row: r, col: c)
                addSubview(field)
                fields.append(field)
            }
        }
    }

    private func makeField(row: Int, col: Int) -> UITextField {
        let field = UITextField()
        field.text = cellText(row: row, col: col)
        field.font = .systemFont(ofSize: 14, weight: row == 0 ? .semibold : .regular)
        field.textColor = .label
        field.tintColor = .label
        field.borderStyle = .none
        field.autocorrectionType = .no
        field.autocapitalizationType = .sentences
        field.returnKeyType = .next
        field.delegate = self
        field.accessibilityIdentifier = "table.cell.\(row).\(col)"
        field.addTarget(self, action: #selector(fieldChanged(_:)), for: .editingChanged)
        return field
    }

    @objc private func fieldChanged(_ field: UITextField) {
        guard let i = fields.firstIndex(of: field) else { return }
        let cols = max(table.columnCount, 1)
        setCell(field.text ?? "", row: i / cols, col: i % cols)
    }

    private func cellText(row: Int, col: Int) -> String {
        row == 0 ? table.header[col] : table.rows[row - 1][col]
    }

    private func setCell(_ text: String, row: Int, col: Int) {
        if row == 0 { table.header[col] = text } else { table.rows[row - 1][col] = text }
    }

    private func syncFieldsToTable() {
        let cols = max(table.columnCount, 1)
        for (i, field) in fields.enumerated() {
            setCell(field.text ?? "", row: i / cols, col: i % cols)
        }
    }

    // MARK: - UITextFieldDelegate (Return = next cell / commit on last)

    func textFieldShouldReturn(_ field: UITextField) -> Bool {
        guard let i = fields.firstIndex(of: field) else { return true }
        if i + 1 < fields.count {
            fields[i + 1].becomeFirstResponder()
        } else {
            commit()
        }
        return false
    }

    // MARK: - Structure changes (live reflow, no autosave until commit)

    @objc private func addRow() {
        syncFieldsToTable()
        let blank = Array(repeating: "", count: table.columnCount)
        // Append at the END of the merged model: with rows past the render cap
        // the new row goes behind them, otherwise it becomes the last visible row.
        if hiddenRows.isEmpty {
            table.rows.append(blank)
        } else {
            hiddenRows.append(blank)
        }
        applyStructureChange(focus: (rowCount - 1) * table.columnCount)
    }

    @objc private func addColumn() {
        syncFieldsToTable()
        table.header.append("Column \(table.columnCount + 1)")
        for r in table.rows.indices { table.rows[r].append("") }
        // Structure changes apply to hidden rows too — they share the header.
        for r in hiddenRows.indices { hiddenRows[r].append("") }
        applyStructureChange(focus: table.columnCount - 1)
    }

    @objc private func removeRow() {
        syncFieldsToTable()
        if !hiddenRows.isEmpty {
            hiddenRows.removeLast()
        } else {
            guard table.rows.count > 1 else { return }
            table.rows.removeLast()
        }
        applyStructureChange(focus: 0)
    }

    @objc private func removeColumn() {
        guard table.columnCount > 1 else { return }
        syncFieldsToTable()
        table.header.removeLast()
        for r in table.rows.indices { table.rows[r].removeLast() }
        for r in hiddenRows.indices where !hiddenRows[r].isEmpty { hiddenRows[r].removeLast() }
        applyStructureChange(focus: 0)
    }

    @objc private func deleteTable() {
        restoreHostInset()
        endEditing(true)
        onCommit(nil)
    }

    @objc private func done() {
        commit()
    }

    /// Re-render the attachment (so the note reflows to the new height), then
    /// rebuild the cell grid and re-anchor the overlay to the new glyph rect.
    private func applyStructureChange(focus: Int) {
        let wasEditing = fields.contains { $0.isFirstResponder }
        onLiveResize(merged)
        rebuildCells()
        layoutToAttachment()
        setNeedsLayout()
        layoutIfNeeded()
        if wasEditing, fields.indices.contains(focus) {
            fields[focus].becomeFirstResponder()
        }
    }

    // MARK: - Control pill

    private func buildPill() {
        pill.backgroundColor = .secondarySystemBackground
        pill.layer.cornerRadius = 18
        pill.layer.cornerCurve = .continuous
        pill.layer.shadowColor = UIColor.black.cgColor
        pill.layer.shadowOpacity = 0.16
        pill.layer.shadowRadius = 8
        pill.layer.shadowOffset = CGSize(width: 0, height: 2)

        let specs: [(String, Selector, UIColor, String)] = [
            ("plus.rectangle", #selector(addRow), .label, "table.addRow"),
            ("plus.rectangle.portrait", #selector(addColumn), .label, "table.addColumn"),
            ("minus.rectangle", #selector(removeRow), .label, "table.removeRow"),
            ("minus.rectangle.portrait", #selector(removeColumn), .label, "table.removeColumn"),
            ("trash", #selector(deleteTable), .systemRed, "table.delete"),
            ("checkmark.circle.fill", #selector(done), .label, "table.done"),
        ]
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 16
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        for (symbol, action, tint, id) in specs {
            let button = UIButton(type: .system)
            button.setImage(
                UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular)),
                for: .normal
            )
            button.tintColor = tint
            button.accessibilityIdentifier = id
            button.addTarget(self, action: action, for: .touchUpInside)
            stack.addArrangedSubview(button)
        }
        pill.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: pill.topAnchor, constant: 6),
            stack.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -6),
        ])
        addSubview(pill)
        let width = CGFloat(specs.count) * 30 + CGFloat(specs.count - 1) * 16 + 32
        pill.bounds = CGRect(x: 0, y: 0, width: width, height: 36)
    }
}

/// Draws the same header wash + thin separator grid the rendered attachment
/// uses, so the live cells sit on an identical-looking grid.
private final class GridBackgroundView: UIView {
    private var columns = 1
    private var rows = 1

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) { nil }

    func configure(columns: Int, rows: Int) {
        self.columns = max(columns, 1)
        self.rows = max(rows, 1)
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let cg = UIGraphicsGetCurrentContext(), bounds.width > 0 else { return }
        let rowHeight = TableAttachment.rowHeight
        let colWidth = bounds.width / CGFloat(columns)

        UIColor.secondarySystemBackground.setFill()
        cg.fill(CGRect(x: 0, y: 0, width: bounds.width, height: rowHeight))

        UIColor.separator.setStroke()
        cg.setLineWidth(0.5)
        for r in 0...rows {
            let y = CGFloat(r) * rowHeight
            cg.move(to: CGPoint(x: 0, y: y)); cg.addLine(to: CGPoint(x: bounds.width, y: y))
        }
        for c in 0...columns {
            let x = CGFloat(c) * colWidth
            cg.move(to: CGPoint(x: x, y: 0)); cg.addLine(to: CGPoint(x: x, y: bounds.height))
        }
        cg.strokePath()
    }
}
