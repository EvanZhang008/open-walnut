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
    /// The link tags as the server names them (`LinkTagView`): such a pill reads its name
    /// ("Fix plan r5b") after its kind's icon, like the console's, never the raw path or URL.
    var links: [LinkTagView] = []

    @State private var showHidden = false
    @State private var shownFile: LinkTagView?
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let pills = TagDisplayStore.shared.compiled.pills(for: Self.withoutGoneLinks(tags, links: links))
        let byTag = Dictionary(links.map { (Self.key($0.tag), $0) }, uniquingKeysWith: { first, _ in first })
        // The toggle sits right after the shown pills and the hidden ones follow it,
        // so revealing them never moves the button out from under the finger.
        WrappingRow(spacing: 6, lineSpacing: 6) {
            ForEach(pills.shown) { pill in
                if let link = byTag[pill.tag] {
                    linkPillView(link)
                } else {
                    pillView(pill, muted: false)
                }
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
                    // A link a rule hides still reads its name when revealed, never its raw path.
                    if let link = byTag[pill.tag] {
                        linkPillView(link, muted: true)
                    } else {
                        pillView(pill, muted: true)
                    }
                }
            }
        }
        .task { await TagDisplayStore.shared.refreshIfStale() }
        .alert(shownFile?.name ?? "", isPresented: Binding(get: { shownFile != nil }, set: { if !$0 { shownFile = nil } }), presenting: shownFile) { link in
            Button("Copy Path") { UIPasteboard.general.string = link.target }
            Button("OK", role: .cancel) {}
        } message: { link in
            Text(verbatim: "\(link.kind.replacingOccurrences(of: "-", with: " ")): \(link.target)")
        }
    }

    /// A link pill: the kind's icon and the name, like the console's (no trailing arrow: the icon
    /// already says it is a link). A URL opens; a file shows its whole path (the phone cannot open
    /// a file on the host from here). One a display rule hides reads muted when revealed.
    @ViewBuilder
    private func linkPillView(_ link: LinkTagView, muted: Bool = false) -> some View {
        let url = link.file == true ? nil : URL(string: link.target)
        let label = HStack(spacing: 4) {
            // Bold: at semibold the review glyph (a thin arrow) read as a stray stroke.
            Image(systemName: Self.icon(link.group))
                .font(.caption.weight(.bold))
            Text(verbatim: link.name)
        }
        // A name is at most three words: room for all three at the accessibility sizes.
        .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
        .font(.subheadline)
        .foregroundStyle(muted ? AnyShapeStyle(.secondary) : AnyShapeStyle(Theme.tint))
        .padding(.horizontal, 10)
        .padding(.vertical, typeSize.isAccessibilitySize ? 4 : 0)
        .frame(minHeight: 30)
        .background(muted ? Color(.quaternarySystemFill) : Theme.tintSoft, in: RoundedRectangle(cornerRadius: 15))
        .contentShape(RoundedRectangle(cornerRadius: 15))
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        .contextMenu {
            Button {
                UIPasteboard.general.string = link.target
            } label: {
                Label(url != nil ? "Copy Link" : "Copy Path", systemImage: "doc.on.doc")
                Text(link.target)
            }
            if let url {
                Button { openURL(url) } label: {
                    Label("Open Link", systemImage: "safari")
                    Text(url.host() ?? url.absoluteString)
                }
            }
        }
        Button {
            if let url { openURL(url) } else { shownFile = link }
        } label: { label }
            .buttonStyle(.plain)
            .accessibilityLabel("\(link.name), \(link.kind.replacingOccurrences(of: "-", with: " "))")
            .accessibilityHint(url != nil ? "Opens \(url?.host() ?? "the link")" : "Shows the file's path")
            .accessibilityAddTraits(url != nil ? .isLink : .isButton)
            .accessibilityIdentifier("task.tag.\(link.tag)")
    }

    /// The tags without the links to files that are gone: such a link draws no pill, shown or
    /// hidden, and a task left with none draws no Tags row (2026-10-26, the user: "if a file is
    /// removed please don't show the tag"). It comes back with the file, on the next detail read.
    static func withoutGoneLinks(_ tags: [String], links: [LinkTagView]) -> [String] {
        let gone = Set(links.filter { $0.gone == true }.map { key($0.tag) })
        return gone.isEmpty ? tags : tags.filter { !gone.contains(key($0)) }
    }

    /// The tags the Tags row draws. Until the detail read lands (`ready` false, or it failed) no
    /// tag that looks like a link is drawn, since nothing yet says whether its file is gone; once
    /// it lands, the gone links are left out (an older server sends no `links`: every tag stays).
    static func visibleTags(_ tags: [String], links: [LinkTagView]?, ready: Bool) -> [String] {
        guard ready else { return tags.filter { !looksLikeLink($0) } }
        return withoutGoneLinks(tags, links: links ?? [])
    }

    /// `kind:/abs/path`, `kind:~/path` or `kind:https://…`: the shapes the server reads as a link
    /// tag (src/core/link-tags.ts), told apart here only to hold them until the server names them.
    static func looksLikeLink(_ tag: String) -> Bool {
        guard let colon = tag.firstIndex(of: ":"), colon != tag.startIndex else { return false }
        let value = tag[tag.index(after: colon)...].lowercased()
        return value.hasPrefix("/") || value.hasPrefix("~/") || value.hasPrefix("http://") || value.hasPrefix("https://")
    }

    private static func key(_ tag: String) -> String { TagModel.normalize(tag, derived: true) ?? tag }

    /// The SF Symbol for a link's kind group (the console draws the same five glyphs).
    static func icon(_ group: String?) -> String {
        switch group {
        case "review": return "arrow.triangle.pull"
        case "ticket": return "smallcircle.filled.circle"
        case "thread": return "bubble.left"
        case "link": return "link"
        default: return "doc.text"
        }
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
