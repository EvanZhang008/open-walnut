import SwiftUI
import UIKit

/// Installs the timeline's link routing into a hosted SwiftUI subtree.
///
/// A named modifier rather than an inline `.environment` call so a test can apply
/// the REAL thing to a probe and check that a link opened inside it lands on the
/// delegate. `weak` because the delegate is the collection-view controller that
/// (transitively) owns the cell holding this modifier.
struct TimelineHostedLinkRouting: ViewModifier {
    weak var delegate: (any TimelineCellActionDelegate)?

    func body(content: Content) -> some View {
        content.environment(\.openURL, OpenURLAction { url in
            TimelineHostedCell.handleHostedLink(url, delegate: delegate) ? .handled : .systemAction
        })
    }
}

/// Component rows hosted as SwiftUI inside UIKit cells via
/// UIHostingConfiguration — behavior fidelity (tap targets, shimmer, image
/// pipeline) with cost bounded by the visible-cell count. Heights are still
/// pre-computed on the actor; `.margins(.all, 0)` keeps the hosted content
/// flush so the actor's arithmetic is authoritative.
enum TimelineHostedCell {
    static let reuseID = "hosted"

    /// Build the hosted SwiftUI content for a row. Only component kinds land
    /// here — text-heavy kinds have dedicated TextKit cells.
    @MainActor
    static func configure(_ cell: UICollectionViewCell, row: TimelineRow,
                          delegate: TimelineCellActionDelegate?) {
        cell.contentConfiguration = UIHostingConfiguration {
            content(for: row, delegate: delegate)
        }
        .margins(.all, 0)
    }

    /// Internal, not private, so the height-parity gate can render exactly this
    /// content through a UIHostingController and compare it against the height
    /// the actor computed. A hosted row's height is a FORMULA while its content
    /// is laid out by SwiftUI, and SwiftUI does not clip — so the two drifting
    /// apart is not a cosmetic rounding matter, it paints one row over the next.
    ///
    /// Every link inside hosted content is routed through the timeline's own
    /// delegate, exactly like the TextKit cells do. Without this a link in a
    /// markdown TABLE cell was styled as a link and did nothing at all: hosted
    /// content gets SwiftUI's default `openURL`, which hands an unknown scheme
    /// to the system opener, and the system silently drops `walnut-file://`.
    /// A dead link that LOOKS live is worse than plain text, so this seam is not
    /// optional for any hosted content that can carry an attributed link.
    @MainActor
    static func content(for row: TimelineRow,
                        delegate: TimelineCellActionDelegate?) -> some View {
        rowContent(for: row, delegate: delegate)
            .modifier(TimelineHostedLinkRouting(delegate: delegate))
    }

    /// Route a link tapped inside hosted SwiftUI content.
    ///
    /// Separate from the modifier above so it is testable: an `\.openURL`
    /// installed in an environment cannot be invoked from a unit test, so the
    /// test covers this decision and the DEVICE covers the one line that
    /// installs it. Returns false when there is nobody to route to (the
    /// height-parity gate renders this content with no delegate), and in that
    /// case SwiftUI keeps its default behaviour.
    @MainActor
    static func handleHostedLink(_ url: URL, delegate: TimelineCellActionDelegate?) -> Bool {
        guard let delegate else { return false }
        delegate.timelineCell(didRequest: .openURL(url))
        return true
    }

    @MainActor
    @ViewBuilder
    private static func rowContent(for row: TimelineRow,
                                   delegate: TimelineCellActionDelegate?) -> some View {
        switch row.content {
        case .toolChip(let name, let detail, let inputPreview, let resultPreview,
                       let agent, let expanded):
            TimelineToolChipView(
                name: name, detail: detail, inputPreview: inputPreview,
                resultPreview: resultPreview, agent: agent, expanded: expanded,
                onToggle: { delegate?.timelineCell(didRequest: .toggleExpanded(rowID: row.id)) }
            )
        case .thinking(let line, let body, let collapsible, let expanded, let maxLines):
            TimelineThinkingChipView(
                line: line, body: body, collapsible: collapsible,
                expanded: expanded, maxLines: maxLines,
                onToggle: { delegate?.timelineCell(didRequest: .toggleExpanded(rowID: row.id)) }
            )
        case .chip(let icon, let text):
            HStack(spacing: 5) {
                Image(systemName: icon).font(.caption2)
                Text(text).font(.caption).lineLimit(1)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, TimelineMetrics.chipHPad)
            .padding(.vertical, TimelineMetrics.chipVPad)
            .background(Color(.tertiarySystemFill), in: Capsule())
            .padding(.horizontal, TimelineMetrics.hMargin)
            .padding(.vertical, TimelineMetrics.chipRowVMargin)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .notification(let badge, let icon, let isError, let body,
                           let collapsedLine, let collapsible, let expanded):
            TimelineNotificationView(
                badge: badge, icon: icon, isError: isError,
                body: body, collapsedLine: collapsedLine,
                collapsible: collapsible, expanded: expanded,
                onToggle: { delegate?.timelineCell(didRequest: .toggleExpanded(rowID: row.id)) }
            )
        case .image(let raw, let alt):
            HStack {
                AttachmentImageView(raw: raw, alt: alt)
                    .frame(maxHeight: TimelineMetrics.imageSlotHeight - 8)
                Spacer(minLength: TimelineMetrics.assistantTrailingGap)
            }
            .padding(.horizontal, TimelineMetrics.hMargin)
            .padding(.vertical, 4)
        case .localImages(let datas, let dimmed):
            HStack(alignment: .top, spacing: 6) {
                Spacer(minLength: TimelineMetrics.bubbleLeadingGap)
                ForEach(Array(datas.enumerated()), id: \.offset) { _, data in
                    TimelineLocalThumb(data: data)
                }
            }
            .opacity(dimmed ? 0.65 : 1)
            .padding(.horizontal, TimelineMetrics.hMargin)
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .table(let header, let rows):
            TimelineTableView(header: header, rows: rows)
        case .truncationChip:
            HStack(spacing: 5) {
                Image(systemName: "ellipsis").font(.caption2)
                Text("Earlier output hidden while streaming").font(.caption)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, TimelineMetrics.chipHPad)
            .padding(.vertical, TimelineMetrics.chipVPad)
            .background(Color(.tertiarySystemFill), in: Capsule())
            .padding(.horizontal, TimelineMetrics.hMargin)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .activity(let activity):
            // ONE line, always. The activity row is a fixed-height 28pt row and
            // `ThinkingRow`'s label has no line limit of its own, so a long label
            // ("Bash · npm run test:quick …", or a sentence of live reasoning)
            // would wrap and paint over the row below it. Truncating is the safe
            // direction for a shimmering status line.
            ThinkingRow(activity: activity)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .failedNotice(let notice):
            // Waiting (an automatic retry is pending) reads as amber + a
            // progress spinner: the message is genuinely not delivered, but
            // telling the user to act would be wrong — the app is on it.
            // Terminal reads as the plain red "Not sent". Both are tappable.
            HStack {
                Spacer()
                Button {
                    delegate?.timelineCell(
                        didRequest: .retry(messageID: TimelineRow.messageID(fromRowID: row.id))
                    )
                } label: {
                    if let notice {
                        HStack(spacing: 4) {
                            ProgressView().controlSize(.mini)
                            Text(notice).font(.caption)
                        }
                        .foregroundStyle(Theme.warning)
                    } else {
                        Label("Not sent — tap to retry", systemImage: "exclamationmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.danger)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat.retryFailed")
            }
            .padding(.horizontal, TimelineMetrics.hMargin)
        case .loadEarlier:
            Button("Load earlier messages") {
                delegate?.timelineCell(didRequest: .loadEarlier)
            }
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        case .text, .userBubble, .code, .richHTML, .richIsland:
            // Dedicated cells own these kinds (TextKit for prose/code, a
            // WKWebView cell for the rich ones); unreachable here.
            EmptyView()
        }
    }
}

/// One labelled section of an expanded card ("Input" / "Result"), monospaced and
/// horizontally scrollable so a wide line is reachable without wrapping the row.
///
/// Not private: the height-parity gate renders the tool card whole, and keeping
/// this a named view is what lets the builder's arithmetic be read against ONE
/// place rather than against an inline closure.
struct TimelineExpandSection: View {
    let label: String
    let body_: String
    let maxHeight: CGFloat
    /// A plain caption note ("Running…", "No output") instead of a code body.
    let isNote: Bool

    /// Stand-in for a Result section with no output. The distinction matters to
    /// the reader: a tool with an input and no result yet is still RUNNING, while
    /// one with neither genuinely produced nothing. A pure function so a test can
    /// pin both words without rendering SwiftUI.
    static func resultNote(hasInput: Bool) -> String {
        hasInput ? "Running…" : "No output"
    }

    init(label: String, body: String, maxHeight: CGFloat, isNote: Bool = false) {
        self.label = label
        self.body_ = body
        self.maxHeight = maxHeight
        self.isNote = isNote
    }

    /// Automation/VoiceOver id for this section's body ("tool.input" /
    /// "tool.result"). Derived from the label so the two can never drift.
    private var bodyIdentifier: String { "tool.\(label.lowercased())" }

    var body: some View {
        VStack(alignment: .leading, spacing: TimelineMetrics.expandLabelGap) {
            Text(label)
                .font(.caption2.weight(.semibold))
                // NOT `.tertiary`: measured 1.70:1 light / 2.48:1 dark, i.e. the
                // label naming the section was the least readable thing in the
                // card. Subordinate is carried by the size (caption2) and the
                // uppercasing; see `ReadableText`.
                .foregroundStyle(ReadableText.secondary)
                .textCase(.uppercase)
            if isNote {
                Text(body_)
                    .font(.caption)
                    .foregroundStyle(ReadableText.secondary)
                    .lineLimit(1)
                    .accessibilityIdentifier(bodyIdentifier)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(body_)
                        .font(.system(.caption2, design: .monospaced))
                        .textSelection(.enabled)
                }
                .frame(maxHeight: maxHeight)
                // A horizontally scrolling, selection-enabled `Text` reports an
                // EMPTY accessibility label (measured in the real hierarchy: both
                // card bodies came back `a=''`), so the one thing the reader
                // tapped the row to see was invisible to VoiceOver. Stating the
                // label explicitly is what puts the bytes back.
                .accessibilityElement()
                .accessibilityIdentifier(bodyIdentifier)
                .accessibilityLabel(body_)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Mirror of MessageRow.ToolChip, driven by pre-computed expansion state
/// (the actor pre-measured BOTH heights; toggling swaps rows, no self-size).
private struct TimelineToolChipView: View {
    let name: String
    let detail: String?
    let inputPreview: String?
    let resultPreview: String?
    let agent: String?
    let expanded: Bool
    let onToggle: () -> Void

    private var input: String? {
        inputPreview?.isEmpty == false ? inputPreview : nil
    }
    private var result: String? {
        resultPreview?.isEmpty == false ? resultPreview : nil
    }
    /// ALWAYS. A tool row that refuses the tap is indistinguishable from a
    /// broken tap, so a row with no result yet expands to its input plus
    /// "Running…", and a row with nothing at all expands to "No output".
    private var isExpandable: Bool { true }

    var body: some View {
        VStack(alignment: .leading, spacing: TimelineMetrics.expandCardGap) {
            HStack(spacing: 5) {
                if let agent, !agent.isEmpty {
                    HStack(spacing: 3) {
                        Image(systemName: "person.2.fill")
                            .font(.system(size: 8, weight: .semibold))
                        Text(agent)
                            .font(.caption2.weight(.semibold))
                            .lineLimit(1)
                    }
                    .foregroundStyle(.indigo)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.indigo.opacity(0.14), in: Capsule())
                    .accessibilityIdentifier("tool.agentBadge")
                }
                Image(systemName: agent == nil ? "wrench.and.screwdriver" : "arrow.triangle.branch")
                    .font(.caption2)
                Text(name)
                    .font(.caption.weight(.medium))
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if isExpandable {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                }
            }
            // ONE readable ink for the whole capsule. NOT `.tertiary` on the
            // detail and the chevron (measured on the phone: 1.69:1 light /
            // 2.34:1 dark, under WCAG's 3:1 floor for a UI affordance let alone
            // 4.5:1 for text), and NOT `.secondary` on the name either (3.24:1
            // light). The chevron is the only thing that says this row OPENS,
            // and the detail is the only thing telling eight stacked `Bash`
            // rows apart, so neither can be paid for in contrast. Subordinate
            // is carried by SIZE and WEIGHT instead: an 8pt glyph, a
            // regular-weight caption detail under a medium-weight caption name.
            // See `ReadableText`; `ReadableTextContrastTests` pins both bars.
            .foregroundStyle(ReadableText.secondary)
            .padding(.horizontal, TimelineMetrics.chipHPad)
            .padding(.vertical, TimelineMetrics.chipVPad)
            .background(Color(.tertiarySystemFill), in: Capsule())
            .contentShape(Capsule())
            .onTapGesture {
                guard isExpandable else { return }
                onToggle()
            }

            if expanded {
                // Input FIRST: "what did it run" is the question a tool name
                // raises. Result second, and it is always present as a section
                // so the card can say "Running…" / "No output" rather than
                // leaving the reader wondering whether the tap worked.
                VStack(alignment: .leading, spacing: TimelineMetrics.expandSectionSpacing) {
                    if let input {
                        TimelineExpandSection(
                            label: "Input", body: input,
                            maxHeight: TimelineMetrics.expandInputMaxHeight)
                    }
                    if let result {
                        TimelineExpandSection(
                            label: "Result", body: result,
                            maxHeight: TimelineMetrics.expandResultMaxHeight)
                    } else {
                        TimelineExpandSection(
                            label: "Result",
                            body: TimelineExpandSection.resultNote(hasInput: input != nil),
                            maxHeight: TimelineMetrics.expandResultMaxHeight, isNote: true)
                    }
                }
                .padding(TimelineMetrics.expandCardPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                // `children: .contain` FIRST, or the identifier propagates down
                // and every element inside the card reports as
                // "tool.expandedCard" — which is what hid `tool.input` /
                // `tool.result` from tooling (measured: three elements in the real
                // hierarchy all carrying the card's id, two of them with empty
                // labels). A container owns its own id; its children keep theirs.
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("tool.expandedCard")
            }
        }
        .padding(.horizontal, TimelineMetrics.hMargin)
        .padding(.vertical, TimelineMetrics.chipRowVMargin)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Reasoning row: the capsule the transcript always showed, now with a chevron
/// and a tap that reveals the excerpt behind it. Collapse state is pre-computed
/// (the actor measured BOTH heights), exactly like the notification card.
///
/// `collapsible == false` means the row has no chevron and takes no tap — either
/// because there is nothing more than the line already shown (history), or
/// because it is the live turn's reasoning, which is always open. A chevron that
/// opens onto the line the capsule already displayed would be the "tapping does
/// nothing" complaint with an extra glyph.
private struct TimelineThinkingChipView: View {
    let line: String
    let body_: String?
    let collapsible: Bool
    let expanded: Bool
    let maxLines: Int
    let onToggle: () -> Void

    init(line: String, body: String?, collapsible: Bool, expanded: Bool,
         maxLines: Int, onToggle: @escaping () -> Void) {
        self.line = line
        self.body_ = body
        self.collapsible = collapsible
        self.expanded = expanded
        self.maxLines = maxLines
        self.onToggle = onToggle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TimelineMetrics.expandCardGap) {
            HStack(spacing: 5) {
                Image(systemName: "sparkles").font(.caption2)
                Text(line).font(.caption).lineLimit(1)
                if collapsible {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, TimelineMetrics.chipHPad)
            .padding(.vertical, TimelineMetrics.chipVPad)
            .background(Color(.tertiarySystemFill), in: Capsule())
            .contentShape(Capsule())
            .onTapGesture {
                guard collapsible else { return }
                onToggle()
            }

            if expanded, let body_ {
                // Prose, so it WRAPS (unlike the tool card's monospaced
                // sections, which scroll horizontally) — reasoning is meant to
                // be read, and a reader should not have to pan a sentence.
                Text(body_)
                    .font(.caption)
                    .foregroundStyle(ReadableText.secondary)
                    .textSelection(.enabled)
                    // Same cap the builder reserved room for (it rides the row,
                    // so history and the live tail can differ). A BACKSTOP, not
                    // the trim: `lineLimit` keeps the FIRST n lines, so leaving it
                    // to choose is what pinned the live card to the OLDEST
                    // reasoning while the capsule advertised the newest. The
                    // builder cuts the live window to exactly this many wrapped
                    // lines (`TimelineLiveThinkingWindow`), so this only ever
                    // fires on a historical excerpt longer than its own cap —
                    // where truncating beats clipping, because the reader sees an
                    // ellipsis rather than a sentence cut in half by the bounds.
                    .lineLimit(maxLines)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(TimelineMetrics.expandCardPadding)
                    .background(Color(.secondarySystemBackground),
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityIdentifier("thinking.expandedBody")
            }
        }
        .padding(.horizontal, TimelineMetrics.hMargin)
        .padding(.vertical, TimelineMetrics.chipRowVMargin)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Mirror of NotificationCard on pre-computed state.
private struct TimelineNotificationView: View {
    let badge: String
    let icon: String
    let isError: Bool
    let body_: NSAttributedString
    let collapsedLine: String
    let collapsible: Bool
    let expanded: Bool
    let onToggle: () -> Void

    init(badge: String, icon: String, isError: Bool, body: NSAttributedString,
         collapsedLine: String, collapsible: Bool, expanded: Bool, onToggle: @escaping () -> Void) {
        self.badge = badge
        self.icon = icon
        self.isError = isError
        self.body_ = body
        self.collapsedLine = collapsedLine
        self.collapsible = collapsible
        self.expanded = expanded
        self.onToggle = onToggle
    }

    private var accent: Color { isError ? Theme.danger : Theme.tint }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            RoundedRectangle(cornerRadius: 2)
                .fill(accent)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: icon).font(.caption2.weight(.semibold))
                    Text(badge).font(.caption2.weight(.semibold)).textCase(.uppercase)
                    Spacer(minLength: 0)
                    if collapsible {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                    }
                }
                .foregroundStyle(accent)
                .contentShape(Rectangle())
                .onTapGesture {
                    guard collapsible else { return }
                    onToggle()
                }
                if expanded {
                    Text(AttributedString(body_))
                        .font(.subheadline)
                } else {
                    Text(inline: collapsedLine)
                        .font(.subheadline)
                        .lineLimit(2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.leading, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(TimelineMetrics.notificationPadding)
        .background(accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(accent.opacity(0.25), lineWidth: 0.5)
        }
        .padding(.horizontal, TimelineMetrics.hMargin)
        .padding(.vertical, TimelineMetrics.notificationVMargin)
    }
}

/// Local (just-sent) image thumbnail — decode off-main with placeholder,
/// same NSCache-backed pipeline pattern as MessageRow.BubbleThumb.
private struct TimelineLocalThumb: View {
    let data: Data
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: TimelineMetrics.localImageSide + 80,
                           maxHeight: TimelineMetrics.localImageSide)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(.tertiarySystemFill))
                    .frame(width: TimelineMetrics.localImageSide,
                           height: TimelineMetrics.localImageSide)
            }
        }
        .task(id: data.count) {
            let decoded = await Task.detached(priority: .userInitiated) {
                SelectedImage.thumbnail(from: data)
            }.value
            if let decoded { image = decoded }
        }
    }
}

/// Markdown table — same Grid rendering as MarkdownView.tableView, on
/// actor-prepared (already row-capped) data.
private struct TimelineTableView: View {
    let header: [AttributedString]
    let rows: [[AttributedString]]

    var body: some View {
        let columns = max(header.count, rows.map(\.count).max() ?? 0)
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading,
                 horizontalSpacing: TimelineMetrics.tableColSpacing,
                 verticalSpacing: TimelineMetrics.tableRowSpacing) {
                GridRow {
                    ForEach(0..<columns, id: \.self) { c in
                        Text(c < header.count ? header[c] : AttributedString(""))
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(0..<columns, id: \.self) { c in
                            Text(c < row.count ? row[c] : AttributedString(""))
                                .font(.subheadline)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .padding(TimelineMetrics.tablePadding)
        }
        .background(Color(.secondarySystemBackground).opacity(0.6),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, TimelineMetrics.hMargin)
        .padding(.vertical, TimelineMetrics.codeVMargin)
    }
}
