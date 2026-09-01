import SwiftUI
import UIKit

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

    @MainActor
    @ViewBuilder
    private static func content(for row: TimelineRow,
                                delegate: TimelineCellActionDelegate?) -> some View {
        switch row.content {
        case .toolChip(let name, let detail, let resultPreview, let agent, let expanded):
            TimelineToolChipView(
                name: name, detail: detail, resultPreview: resultPreview,
                agent: agent, expanded: expanded,
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
            ThinkingRow(activity: activity)
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

/// Mirror of MessageRow.ToolChip, driven by pre-computed expansion state
/// (the actor pre-measured BOTH heights; toggling swaps rows, no self-size).
private struct TimelineToolChipView: View {
    let name: String
    let detail: String?
    let resultPreview: String?
    let agent: String?
    let expanded: Bool
    let onToggle: () -> Void

    private var isExpandable: Bool { resultPreview?.isEmpty == false }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
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
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if isExpandable {
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
                guard isExpandable else { return }
                onToggle()
            }

            if expanded, let resultPreview {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(resultPreview)
                        .font(.system(.caption2, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(10)
                }
                .frame(maxHeight: 320 + 20)
                .background(Color(.secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
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
