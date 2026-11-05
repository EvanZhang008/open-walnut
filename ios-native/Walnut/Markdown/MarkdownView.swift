import SwiftUI

/// Rendered markdown note body — Apple Notes-like typography. Task checkboxes
/// are live: tapping calls `onToggleTask(sourceLine, newChecked)`.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    var onToggleTask: ((Int, Bool) -> Void)?
    /// The paragraph, list and quote text style; `.markdownBodyFont(_:)` sets it for a compact
    /// place (a thread card), everything else keeps `.body`.
    @Environment(\.markdownBodyFont) private var bodyFont

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 6) {
            ForEach(blocks) { block in
                blockView(block)
            }
        }
        // Absolute paths inside a note / letter / plan are linkified by
        // MarkdownParser.inline, and until this line nothing listened: SwiftUI
        // handed the walnut-file:// scheme to the system opener, which dropped it
        // silently. Non-file URLs still open the usual way.
        .handlingFilePathLinks()
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
                .font(bodyFont)
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
                        .font(bodyFont.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Text(text)
                    .font(bodyFont)
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
                    .font(bodyFont)
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

        case .code(let language, let text):
            MarkdownCodeBlockView(language: language, text: text)
                .padding(.vertical, 4)

        case .quote(let lines):
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Theme.tint.opacity(0.6))
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(bodyFont)
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

    /// Wrapping, row-ruled grid that scrolls sideways only when it must
    /// (`MarkdownTableView`).
    private func tableView(header: [AttributedString], rows: [[AttributedString]]) -> some View {
        let rendered = rows.count > Self.maxRenderedTableRows
            ? Array(rows.prefix(Self.maxRenderedTableRows))
            : rows
        return MarkdownTableView(header: header, rows: rendered, omitted: rows.count - rendered.count)
            .padding(.vertical, 4)
    }
}

private struct MarkdownBodyFontKey: EnvironmentKey {
    static let defaultValue: Font = .body
}

extension EnvironmentValues {
    var markdownBodyFont: Font {
        get { self[MarkdownBodyFontKey.self] }
        set { self[MarkdownBodyFontKey.self] = newValue }
    }
}

extension View {
    /// The body text style of every `MarkdownView` inside.
    func markdownBodyFont(_ font: Font) -> some View { environment(\.markdownBodyFont, font) }
}

/// A fenced block in a letter, note or sheet: the same header (language, Wrap,
/// Copy) and colors as a chat code block (`TimelineCodeCell`). Wrap is the
/// block's own, as there.
struct MarkdownCodeBlockView: View {
    let language: String?
    let text: String
    @State private var wrap = false
    @State private var copied = false

    private var fence: CodeHighlighter.Fence { CodeHighlighter.fence(language) }

    private var colored: AttributedString {
        let font = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
        let ns = CodeHighlighter.attributed(text, grammar: fence.grammar, font: font)
        return (try? AttributedString(ns, including: \.uiKit)) ?? AttributedString(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 2) {
                Text(fence.label)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Button {
                    wrap.toggle()
                } label: {
                    Label("Wrap", systemImage: "arrow.turn.down.left")
                        .font(.system(size: 13, weight: .medium))
                        .labelStyle(.titleAndIcon)
                        .padding(.horizontal, 8)
                        .frame(height: 32)
                        .background(wrap ? Color.primary.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 7))
                        .foregroundStyle(wrap ? Color.primary : Color.secondary)
                }
                .accessibilityLabel(wrap ? "Stop wrapping long lines" : "Wrap long lines")
                .accessibilityAddTraits(wrap ? .isSelected : [])
                Button {
                    UIPasteboard.general.string = text
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13, weight: .medium))
                        .labelStyle(.titleAndIcon)
                        .padding(.horizontal, 8)
                        .frame(height: 32)
                        .foregroundStyle(copied ? Color.green : Color.secondary)
                }
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            .buttonStyle(.plain)
            .padding(.leading, 12)
            .padding(.trailing, 4)
            .frame(height: 36)
            Divider()
            if wrap {
                Text(colored)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(12)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(colored)
                        .textSelection(.enabled)
                        .padding(12)
                }
            }
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
