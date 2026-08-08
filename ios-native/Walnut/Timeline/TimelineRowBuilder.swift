import UIKit

/// Shared layout metrics — the ONE place cell padding lives, so the actor's
/// measurement and the cells' rendering can never drift apart.
enum TimelineMetrics {
    /// Horizontal page margin (mirrors the SwiftUI rows' 16pt).
    static let hMargin: CGFloat = 16
    /// Vertical padding around a text row (SwiftUI rows used 2).
    static let textVPad: CGFloat = 2
    /// Trailing gap reserved beside assistant text (Spacer(minLength: 32)).
    static let assistantTrailingGap: CGFloat = 32
    /// Leading gap reserved beside a user bubble (Spacer(minLength: 48)).
    static let bubbleLeadingGap: CGFloat = 48
    static let bubbleHPad: CGFloat = 14
    static let bubbleVPad: CGFloat = 10
    static let bubbleCorner: CGFloat = 20
    static let codePadding: CGFloat = 12
    static let codeVMargin: CGFloat = 4
    static let chipVPad: CGFloat = 4
    static let chipHPad: CGFloat = 10
    static let chipRowVMargin: CGFloat = 1
    static let imageSlotHeight: CGFloat = 220
    static let localImageSide: CGFloat = 120
    static let activityHeight: CGFloat = 28
    static let failedNoticeHeight: CGFloat = 24
    static let loadEarlierHeight: CGFloat = 36
    static let notificationPadding: CGFloat = 12
    static let notificationVMargin: CGFloat = 3
    static let tablePadding: CGFloat = 12
    static let tableRowSpacing: CGFloat = 6
    static let tableColSpacing: CGFloat = 16
    static let maxRenderedTableRows = 60

    /// Width available to assistant text at a given page width.
    static func assistantTextWidth(_ pageWidth: CGFloat) -> CGFloat {
        max(40, pageWidth - hMargin * 2 - assistantTrailingGap)
    }

    /// Width available to user-bubble text.
    static func bubbleTextWidth(_ pageWidth: CGFloat) -> CGFloat {
        max(40, pageWidth - hMargin * 2 - bubbleLeadingGap - bubbleHPad * 2)
    }
}

/// ChatMessage / live state → measured `TimelineRow`s. Pure CPU: runs on the
/// TimelineLayoutActor, never the main thread. Owns the (actor-confined)
/// TextKit measurer.
final class TimelineRowBuilder {
    private let measurer = TimelineTextMeasurer()

    // MARK: - Message rows

    /// Rows for one message. `expandedRowIDs` selects the pre-measured
    /// expanded height for expandable rows (tool chips, notification cards).
    func rows(for message: ChatMessage, width: CGFloat,
              expandedRowIDs: Set<String>) -> [TimelineRow] {
        switch message.kind {
        case .tool:
            return [toolChipRow(message, width: width, expandedRowIDs: expandedRowIDs)]
        case .thinking:
            return [chipRow(id: "\(message.id)#0", icon: "sparkles", text: message.text, width: width)]
        case .notification:
            return [notificationRow(message, width: width, expandedRowIDs: expandedRowIDs)]
        case nil:
            return message.isUser
                ? userRows(message, width: width)
                : assistantRows(message, width: width)
        }
    }

    // MARK: - User bubble

    private func userRows(_ message: ChatMessage, width: CGFloat) -> [TimelineRow] {
        var rows: [TimelineRow] = []
        var index = 0
        func nextID() -> String { defer { index += 1 }; return "\(message.id)#\(index)" }

        if let images = message.localImages, !images.isEmpty {
            rows.append(TimelineRow(
                id: nextID(), revision: images.count,
                content: .localImages(datas: images, dimmed: message.pending == true),
                height: TimelineMetrics.localImageSide + 4
            ))
        }
        let imageSend = MessageRow.imageSendParts(message.text)
        if let imageSend {
            for path in imageSend.paths {
                rows.append(TimelineRow(
                    id: nextID(), revision: 0,
                    content: .image(raw: path, alt: (path as NSString).lastPathComponent),
                    height: TimelineMetrics.imageSlotHeight
                ))
            }
        }
        let displayText = imageSend?.text ?? message.text
        if !displayText.isEmpty {
            let failed = message.failed == true
            let text = TimelineTextStyler.inlineText(displayText)
            let size = measurer.measure(text, width: TimelineMetrics.bubbleTextWidth(width))
            let height = size.height + TimelineMetrics.bubbleVPad * 2 + TimelineMetrics.textVPad * 2
            rows.append(TimelineRow(
                id: nextID(),
                // Flags mutate on the same optimistic id — carry them in the
                // revision so the cell reloads when pending settles / fails.
                revision: (failed ? 2 : 0) + (message.pending == true ? 1 : 0),
                content: .userBubble(text: text, textSize: size, failed: failed,
                                     pending: message.pending == true),
                height: height
            ))
        }
        if message.failed == true {
            rows.append(TimelineRow(
                id: nextID(), revision: 0, content: .failedNotice,
                height: TimelineMetrics.failedNoticeHeight
            ))
        }
        return rows
    }

    // MARK: - Assistant markdown

    /// `cache` routing mirrors ChatMarkdownBody: history rows go through the
    /// shared parse cache; the live tail must skip it.
    func assistantRows(
        _ message: ChatMessage, width: CGFloat,
        idPrefix: String? = nil, cache: MarkdownParser.CacheMode = .shared,
        clipOversized: Bool = true, revision: Int = 0
    ) -> [TimelineRow] {
        let prefix = idPrefix ?? message.id
        let text = message.text
        var rows: [TimelineRow] = []
        var index = 0
        func nextID() -> String { defer { index += 1 }; return "\(prefix)#\(index)" }
        func appendText(_ attributed: NSAttributedString) {
            let h = measurer.height(attributed, width: TimelineMetrics.assistantTextWidth(width))
            rows.append(TimelineRow(
                id: nextID(), revision: revision, content: .text(attributed),
                height: h + TimelineMetrics.textVPad * 2
            ))
        }

        if ChatMarkdownBody.isBlockMarkdown(text) || ChatMarkdownBody.containsImageRef(text) {
            let blocks = MarkdownParser.parse(text, cache: cache, clipOversized: clipOversized)
            for piece in TimelineTextStyler.pieces(from: blocks) {
                switch piece {
                case .text(let attributed):
                    appendText(attributed)
                case .code(let code):
                    let size = measurer.codeSize(code, font: TimelineTextStyler.codeFont)
                    rows.append(TimelineRow(
                        id: nextID(), revision: revision,
                        content: .code(text: code, contentSize: size),
                        height: size.height + TimelineMetrics.codePadding * 2
                            + TimelineMetrics.codeVMargin * 2
                    ))
                case .image(let raw, let alt):
                    rows.append(TimelineRow(
                        id: nextID(), revision: revision,
                        content: .image(raw: raw, alt: alt),
                        height: TimelineMetrics.imageSlotHeight
                    ))
                case .table(let header, let tableRows):
                    rows.append(tableRow(id: nextID(), revision: revision,
                                         header: header, rows: tableRows))
                }
            }
        } else if !text.isEmpty {
            appendText(TimelineTextStyler.inlineText(text))
        }
        return rows
    }

    // MARK: - Live turn (LiveMarkdownWindow semantics)

    /// Rows for the streaming live turn. Head rows are byte-stable across
    /// ticks (LiveMarkdownWindow quantization) — the actor caches them keyed
    /// on the head string; only the tail re-parses/re-measures per tick.
    func liveRows(
        liveText: String, storeTruncated: Bool, activity: String?,
        width: CGFloat, tailRevision: Int,
        cachedHead: (key: String, rows: [TimelineRow])?
    ) -> (rows: [TimelineRow], headCache: (key: String, rows: [TimelineRow])?) {
        var rows: [TimelineRow] = []
        var headCache = cachedHead
        if !liveText.isEmpty {
            let seg = LiveMarkdownWindow.segments(liveText)
            if seg.omittedPrefix || storeTruncated {
                rows.append(TimelineRow(id: "live-truncated", revision: 0,
                                        content: .truncationChip, height: 26))
            }
            if !seg.head.isEmpty {
                if let cached = cachedHead, cached.key == seg.head {
                    rows.append(contentsOf: cached.rows)
                } else {
                    let headRows = assistantRows(
                        ChatMessage(id: "live-head", role: "assistant", text: seg.head,
                                    createdAt: "", kind: nil),
                        width: width, idPrefix: "live-head", cache: .shared,
                        clipOversized: false
                    )
                    headCache = (seg.head, headRows)
                    rows.append(contentsOf: headRows)
                }
            } else {
                headCache = nil
            }
            if !seg.tail.isEmpty {
                rows.append(contentsOf: assistantRows(
                    ChatMessage(id: "live-tail", role: "assistant", text: seg.tail,
                                createdAt: "", kind: nil),
                    width: width, idPrefix: "live-tail", cache: .skip,
                    clipOversized: false, revision: tailRevision
                ))
            }
        } else {
            headCache = nil
        }
        rows.append(TimelineRow(
            id: "live-activity", revision: (activity ?? "").hashValue,
            content: .activity(activity), height: TimelineMetrics.activityHeight
        ))
        return (rows, headCache)
    }

    // MARK: - Chips / tool / notification

    private func chipRow(id: String, icon: String, text: String, width: CGFloat) -> TimelineRow {
        TimelineRow(
            id: id, revision: 0, content: .chip(icon: icon, text: text),
            height: TimelineTextStyler.captionFont.lineHeight
                + TimelineMetrics.chipVPad * 2 + TimelineMetrics.chipRowVMargin * 2
        )
    }

    private func toolChipRow(_ message: ChatMessage, width: CGFloat,
                             expandedRowIDs: Set<String>) -> TimelineRow {
        let id = "\(message.id)#0"
        let expanded = expandedRowIDs.contains(id)
            && message.resultPreview?.isEmpty == false
        let capsuleHeight = TimelineTextStyler.captionFont.lineHeight
            + TimelineMetrics.chipVPad * 2 + TimelineMetrics.chipRowVMargin * 2
        var height = capsuleHeight
        if expanded, let preview = message.resultPreview {
            let size = measurer.codeSize(preview, font: TimelineTextStyler.codePreviewFont)
            // Preview card: 10pt padding + 4pt gap under the capsule.
            height += min(size.height, 320) + 10 * 2 + 4
        }
        return TimelineRow(
            id: id, revision: expanded ? 1 : 0,
            content: .toolChip(name: message.text, detail: message.detail,
                               resultPreview: message.resultPreview,
                               agent: message.agent, expanded: expanded),
            height: height
        )
    }

    private func notificationRow(_ message: ChatMessage, width: CGFloat,
                                 expandedRowIDs: Set<String>) -> TimelineRow {
        let id = "\(message.id)#0"
        let styled = NotificationStyling(message: message)
        let collapsible = styled.isCollapsible
        let expanded = !collapsible || expandedRowIDs.contains(id)
        let bodyWidth = width - TimelineMetrics.hMargin * 2
            - TimelineMetrics.notificationPadding * 2 - 3 - 10 // accent bar + gap
        let headerHeight = TimelineTextStyler.caption2Font.lineHeight + 6
        let body = TimelineTextStyler.inlineText(styled.displayText,
                                                 font: TimelineTextStyler.subheadlineFont)
        let bodyHeight: CGFloat
        if expanded {
            bodyHeight = measurer.height(body, width: max(40, bodyWidth))
        } else {
            // Two-line collapsed preview.
            bodyHeight = TimelineTextStyler.subheadlineFont.lineHeight * 2
        }
        return TimelineRow(
            id: id, revision: expanded ? 1 : 0,
            content: .notification(
                badge: styled.badgeLabel, icon: styled.iconName, isError: styled.isError,
                body: body, collapsedLine: styled.collapsedLine,
                collapsible: collapsible, expanded: expanded
            ),
            height: headerHeight + bodyHeight + TimelineMetrics.notificationPadding * 2
                + TimelineMetrics.notificationVMargin * 2
        )
    }

    // MARK: - Table

    private func tableRow(id: String, revision: Int,
                          header: [AttributedString], rows: [[AttributedString]]) -> TimelineRow {
        let rendered = rows.count > TimelineMetrics.maxRenderedTableRows
            ? Array(rows.prefix(TimelineMetrics.maxRenderedTableRows)) : rows
        let omitted = rows.count - rendered.count
        // Cells never wrap (horizontal scroll), so height is line arithmetic:
        // header + divider + body rows (+ omitted line), spacing 6, padding 12.
        let lineH = TimelineTextStyler.subheadlineFont.lineHeight
        var contentH = lineH // header
        contentH += TimelineMetrics.tableRowSpacing + 1 // divider
        contentH += CGFloat(rendered.count) * (lineH + TimelineMetrics.tableRowSpacing)
        if omitted > 0 { contentH += 1 + TimelineTextStyler.captionFont.lineHeight + TimelineMetrics.tableRowSpacing * 2 }
        return TimelineRow(
            id: id, revision: revision,
            content: .table(header: header, rows: rendered
                + (omitted > 0 ? [[AttributedString("… \(omitted) more rows")]] : [])),
            height: contentH + TimelineMetrics.tablePadding * 2 + TimelineMetrics.codeVMargin * 2
        )
    }

    /// Utility row (load-earlier button).
    func loadEarlierRow() -> TimelineRow {
        TimelineRow(id: "load-earlier", revision: 0, content: .loadEarlier,
                    height: TimelineMetrics.loadEarlierHeight)
    }
}

/// Notification badge/icon/text derivation — mirror of NotificationCard's
/// private helpers (kept as data-only logic so the actor can pre-compute).
struct NotificationStyling {
    let message: ChatMessage
    private static let collapseThreshold = 280

    var isCollapsible: Bool { message.text.count > Self.collapseThreshold }

    var isError: Bool {
        message.source == "session-error" || message.source == "agent-error"
            || message.text.contains("**Session Error**")
            || message.text.contains("**Subagent Error**")
    }

    var iconName: String {
        switch message.source {
        case "session-error", "agent-error": return "exclamationmark.triangle.fill"
        case "cron": return "clock.badge.checkmark"
        case "compaction": return "arrow.down.right.and.arrow.up.left"
        case "session": return "checkmark.seal"
        case "interrupt": return "stop.circle"
        default: return isError ? "exclamationmark.triangle.fill" : "bell"
        }
    }

    var badgeLabel: String {
        switch message.source {
        case "session-error": return "Session error"
        case "agent-error": return "Agent error"
        case "cron": return "Scheduled"
        case "compaction": return "Compacted"
        case "session": return "Session result"
        case "subagent": return "Subagent"
        case "interrupt": return "Interrupted"
        default: return "Notification"
        }
    }

    /// Strip the "**Session Error** (…):" boilerplate — same logic as
    /// NotificationCard.displayText.
    var displayText: String {
        var text = message.text
        for prefix in ["**Session Error**", "**Session Result**", "**Session Delivery Failed**",
                       "**Subagent Error**", "**Subagent Result**", "**Agent Error**", "**Cron**"] {
            if text.hasPrefix(prefix) {
                text = String(text.dropFirst(prefix.count))
                if let colon = text.firstIndex(of: ":"),
                   text.distance(from: text.startIndex, to: colon) < 120 {
                    let head = text[text.startIndex..<colon].trimmingCharacters(in: .whitespaces)
                    let rest = String(text[text.index(after: colon)...])
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if head.isEmpty { return rest }
                    if head.hasPrefix("("), head.hasSuffix(")") {
                        let label = String(head.dropFirst().dropLast())
                        return rest.isEmpty ? label : "\(label) — \(rest)"
                    }
                }
                return text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return text
    }

    var collapsedLine: String { NotificationCard.firstMeaningfulLine(displayText) }
}
