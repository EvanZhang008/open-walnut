import SwiftUI
import UIKit

/// A task's tags as pills, drawn by the server's display rules (`TagDisplayStore`):
/// a ticket pill reads only its id, a label only its word, a hidden tag (a duplicate
/// id, Walnut's own dates) draws no pill, and a linked tag opens its page.
///
/// Hidden tags stay one tap away ("2 hidden") because this is the task's detail: the
/// rule is about clutter, not secrecy, and the console's tag editor lists them the
/// same way. Long press copies the whole tag (`ticket:V1234567890`), which is what a
/// person pastes into another tool.
struct TaskTagPills: View {
    let tags: [String]

    @State private var showHidden = false
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let pills = TagDisplayStore.shared.compiled.pills(for: tags)
        // The toggle sits right after the shown pills and the hidden ones follow it,
        // so revealing them never moves the button out from under the finger.
        WrappingRow(spacing: 6, lineSpacing: 6) {
            ForEach(pills.shown) { pill in
                pillView(pill, muted: false)
            }
            if !pills.hidden.isEmpty {
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { showHidden.toggle() }
                } label: {
                    Text(showHidden ? "Hide \(pills.hidden.count)" : "\(pills.hidden.count) hidden")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .frame(minHeight: 30)
                        .contentShape(Rectangle())
                        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("task.tags.hidden-toggle")
                .accessibilityHint(showHidden ? "Hides the tags that draw no pill" : "Shows the tags that draw no pill")
            }
            if showHidden {
                ForEach(pills.hidden) { pill in
                    pillView(pill, muted: true)
                }
            }
        }
        .task { await TagDisplayStore.shared.refreshIfStale() }
    }

    @ViewBuilder
    private func pillView(_ pill: TagPill, muted: Bool) -> some View {
        let label = pillLabel(pill, muted: muted)
            .contextMenu {
                // Short titles with the tag and the host as subtitles: a long tag or
                // host folded into the title wrapped and was hyphenated mid-name.
                Button {
                    UIPasteboard.general.string = pill.tag
                } label: {
                    Label("Copy Tag", systemImage: "doc.on.doc")
                    Text(pill.tag)
                }
                if let url = pill.url {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Open Link", systemImage: "safari")
                        Text(url.host() ?? url.absoluteString)
                    }
                }
            }
        if let url = pill.url {
            Button { openURL(url) } label: { label }
                .buttonStyle(.plain)
                .accessibilityLabel(pill.tag)
                .accessibilityHint("Opens \(url.host() ?? "the link")")
                .accessibilityAddTraits(.isLink)
                .accessibilityIdentifier("task.tag.\(pill.tag)")
        } else {
            label
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(pill.tag)
                .accessibilityIdentifier("task.tag.\(pill.tag)")
        }
    }

    /// As wide as its text: the row hands a pill wider than the line that line's width
    /// (`WrappingRow`), where it truncates in the middle, on two lines at the
    /// accessibility sizes. The arrow is part of the text, so a pill that wraps breaks
    /// before the arrow and never inside an id. A linked pill wears the tint on its soft
    /// wash, which keeps the text above 4.5:1 in both appearances.
    private func pillLabel(_ pill: TagPill, muted: Bool) -> some View {
        pillText(pill)
            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            .truncationMode(.middle)
            .font(.subheadline)
            .foregroundStyle(pill.url != nil ? AnyShapeStyle(Theme.tint) : muted ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
            .padding(.horizontal, 10)
            .padding(.vertical, typeSize.isAccessibilitySize ? 4 : 0)
            .frame(minHeight: 30)
            .background(
                pill.url != nil ? Theme.tintSoft : muted ? Color(.quaternarySystemFill) : Color(.tertiarySystemFill),
                in: RoundedRectangle(cornerRadius: 15)
            )
            .contentShape(RoundedRectangle(cornerRadius: 15))
            // A ten-digit id plus its arrow is wider than the card at the two largest
            // sizes; the third accessibility size still reads it on one line.
            .dynamicTypeSize(...DynamicTypeSize.accessibility3)
    }

    private func pillText(_ pill: TagPill) -> Text {
        guard pill.url != nil else { return Text(verbatim: pill.text) }
        let arrow = Text(Image(systemName: "arrow.up.right")).font(.caption2.weight(.semibold))
        return Text("\(Text(verbatim: pill.text)) \(arrow)")
    }
}
