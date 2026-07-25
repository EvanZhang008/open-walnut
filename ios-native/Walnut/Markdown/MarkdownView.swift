import SwiftUI

/// Rendered markdown note body — Apple Notes-like typography. Task checkboxes
/// are live: tapping calls `onToggleTask(sourceLine, newChecked)`.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    var onToggleTask: ((Int, Bool) -> Void)?

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 6) {
            ForEach(blocks) { block in
                blockView(block)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block.kind {
        case .heading(let level, let text):
            Text(text)
                .font(headingFont(level))
                .padding(.top, level <= 2 ? 14 : 10)
                .padding(.bottom, 2)

        case .paragraph(let text):
            Text(text)
                .font(.body)
                .lineSpacing(4)
                .padding(.vertical, 2)
                .textSelection(.enabled)

        case .listItem(let indent, let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                switch marker {
                case .bullet:
                    Circle()
                        .fill(Color.secondary)
                        .frame(width: 5, height: 5)
                        .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 5 }
                case .number(let n):
                    Text("\(n).")
                        .font(.body.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Text(text)
                    .font(.body)
                    .lineSpacing(3)
                    .textSelection(.enabled)
            }
            .padding(.leading, CGFloat(indent) * 18 + 4)
            .padding(.vertical, 1)

        case .taskItem(let indent, let checked, let text, let sourceLine):
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(checked ? Theme.tint : Color(.tertiaryLabel))
                    .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 7 }
                Text(text)
                    .font(.body)
                    .lineSpacing(3)
                    .foregroundStyle(checked ? Color.secondary : Color.primary)
                    .strikethrough(checked, color: .secondary)
            }
            .padding(.leading, CGFloat(indent) * 18)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
            .onTapGesture {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                onToggleTask?(sourceLine, !checked)
            }
            .animation(.snappy(duration: 0.15), value: checked)

        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
            }
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.vertical, 4)

        case .quote(let lines):
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Theme.tint.opacity(0.6))
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.body)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, 12)
            }
            .padding(.vertical, 4)

        case .rule:
            Divider()
                .padding(.vertical, 8)

        case .image(let raw, let alt):
            AttachmentImageView(raw: raw, alt: alt)
                .padding(.vertical, 4)

        case .embed(let name):
            // Note/synced-block embed — content lives in another note; show a chip.
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                    .font(.caption)
                Text(name)
                    .font(.subheadline)
                    .lineLimit(1)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Theme.tintSoft, in: Capsule())
            .padding(.vertical, 2)

        case .table(let header, let rows):
            tableView(header: header, rows: rows)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .system(.title, design: .rounded, weight: .bold)
        case 2: return .system(.title2, design: .rounded, weight: .bold)
        case 3: return .system(.title3, design: .rounded, weight: .semibold)
        default: return .system(.headline, design: .rounded)
        }
    }

    /// Max body rows rendered in a chat/notes markdown table.
    ///
    /// `Grid` lays out EVERY row eagerly (nothing lazy about it), so cost is
    /// linear in rows and is paid even for rows scrolled off-screen. A verbose
    /// model reply with a 150-row table pinned the main thread near 100% CPU and
    /// blew the enclosing scroll container's geometry far past the viewport. Chat
    /// is a live surface: cap it and point at the full table instead. (The
    /// TextKit editor path has its own cap — TableAttachment.maxRenderedRows.)
    private static let maxRenderedTableRows = 60

    /// Simple horizontal-scrolling grid — graceful for the occasional table.
    private func tableView(header: [AttributedString], rows: [[AttributedString]]) -> some View {
        let columns = max(header.count, rows.map(\.count).max() ?? 0)
        let rendered = rows.count > Self.maxRenderedTableRows
            ? Array(rows.prefix(Self.maxRenderedTableRows))
            : rows
        let omitted = rows.count - rendered.count
        return ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow {
                    ForEach(0..<columns, id: \.self) { c in
                        Text(c < header.count ? header[c] : AttributedString(""))
                            .font(.subheadline.weight(.semibold))
                    }
                }
                Divider()
                ForEach(Array(rendered.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(0..<columns, id: \.self) { c in
                            Text(c < row.count ? row[c] : AttributedString(""))
                                .font(.subheadline)
                        }
                    }
                }
                if omitted > 0 {
                    Divider()
                    GridRow {
                        Text("… \(omitted) more row\(omitted == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .gridCellColumns(max(1, columns))
                    }
                }
            }
            .padding(12)
        }
        .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.vertical, 4)
    }
}
