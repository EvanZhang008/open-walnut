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
    /// Vertical padding inside a tool chip's subagent badge (its own capsule,
    /// nested in the chip's) — the term the chip's height formula used to omit.
    static let badgeVPad: CGFloat = 2
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
    /// Vertical padding around a rich-HTML row. A little more than the code
    /// card's, because a card's neighbours are often other rounded containers:
    /// at 4pt a `<details>` border landed ~2pt from a chip row's outline, and two
    /// rounded boxes almost touching reads as a rendering bug.
    static let richVMargin: CGFloat = 6
    /// A rich card can never be shorter than this — a document that measures
    /// near zero (all-CSS, an image still decoding) must still be a visible,
    /// tappable row rather than a 1pt sliver.
    static let richMinHeight: CGFloat = 40
    /// …nor taller than this, and past it the cell hands scrolling back to the
    /// web view so nothing is unreachable. Deliberately far above the web
    /// console's 1600pt island cap: a nested scroller is much worse on a phone
    /// than in a mouse-driven pane (a vertical pan that starts inside the card
    /// steals the transcript's own scroll), so the cap is set past what a
    /// transcript row can even hold — a row's markup is clipped server-side at
    /// 12 KB — and a tall card scrolls WITH the conversation. The nested-scroll
    /// path survives only as the "someone found a way" backstop.
    static let richMaxHeight: CGFloat = 4000
    /// Height of the "building interactive block…" placeholder shown while an
    /// island is still arriving.
    static let richIslandBuildingHeight: CGFloat = 34

    /// One line of SwiftUI `Text` at `font`, which is TALLER than `UIFont`'s own
    /// line height (measured off `UIHostingController.sizeThatFits`: caption 13.67
    /// against 13.13, subheadline 19.33 against 17.02).
    ///
    /// It matters because the SwiftUI-hosted rows get their height from a FORMULA
    /// on the layout actor while SwiftUI lays their content out for real, and the
    /// two rounding in opposite directions is not symmetric: a row taller than its
    /// content adds a hair of space nobody sees, while a row SHORTER than its
    /// content has its ink shaved off (the cell clips — see
    /// TimelineCollectionController's dequeue). So a formula modelling another
    /// layout engine rounds UP, and by how much is measured, not derived —
    /// TimelineHostedHeightParityTests pins both directions.
    static func hostedLineHeight(_ font: UIFont) -> CGFloat { font.lineHeight + 2.5 }

    /// Width available to assistant text at a given page width.
    static func assistantTextWidth(_ pageWidth: CGFloat) -> CGFloat {
        max(40, pageWidth - hMargin * 2 - assistantTrailingGap)
    }

    /// Width a rich card's web view gets at a given page width — the width its
    /// measured height is keyed on, so the builder's lookup and the cell's
    /// report have to agree on exactly this expression.
    static func richContentWidth(_ pageWidth: CGFloat) -> CGFloat {
        max(40, pageWidth - hMargin * 2)
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
            // Revision distinguishes the waiting copy from the terminal one so
            // the cell reloads when the automatic ladder gives up.
            rows.append(TimelineRow(
                id: nextID(), revision: message.retryNotice == nil ? 0 : 1,
                content: .failedNotice(notice: message.retryNotice),
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
        if RichHTMLSegments.isRich(text) {
            return richRows(text, width: width, idPrefix: prefix, cache: cache,
                            clipOversized: clipOversized, revision: revision)
        }

        var rows: [TimelineRow] = []
        var index = 0
        func nextID() -> String { defer { index += 1 }; return "\(prefix)#\(index)" }

        if ChatMarkdownBody.isBlockMarkdown(text) || ChatMarkdownBody.containsImageRef(text) {
            appendBlockRows(text, width: width, revision: revision, cache: cache,
                            clipOversized: clipOversized, nextID: nextID, into: &rows)
        } else if !text.isEmpty {
            rows.append(textRow(id: nextID(), revision: revision,
                                attributed: TimelineTextStyler.inlineText(text), width: width))
        }
        return rows
    }

    /// Rows for a reply that carries raw HTML: markdown runs stay native text
    /// rows, html runs become web documents, in source order.
    ///
    /// ONE id counter across the whole reply, so a card appearing between two
    /// paragraphs doesn't renumber (and therefore re-create) the rows after it.
    ///
    /// Split out from `assistantRows` so a caller that ALREADY classified the
    /// text can come straight here: the live path re-classifies its whole window
    /// every tick, and paying that scan twice per tick bought nothing.
    private func richRows(_ text: String, width: CGFloat, idPrefix: String,
                          cache: MarkdownParser.CacheMode, clipOversized: Bool,
                          revision: Int) -> [TimelineRow] {
        var rows: [TimelineRow] = []
        var index = 0
        func nextID() -> String { defer { index += 1 }; return "\(idPrefix)#\(index)" }

        // `cache == .skip` is this builder's existing "you are looking at the
        // live tail" signal (liveRows routes the live window that way), which is
        // exactly what the segmenter needs to know: a card the model is still
        // writing must not be frozen as a finished segment.
        let live = cache == .skip
        let segments = RichHTMLSegments.segments(text, streaming: live)
        for (position, segment) in segments.enumerated() {
            // Only the LAST segment can still grow — every earlier one is frozen
            // byte-for-byte once emitted (the segmenter's prefix invariant). So
            // "churning" is a property of the trailing run, not of the message:
            // flagging a settled card as streaming would make its cell throttle
            // reloads it is never going to get, and spending the caller's
            // per-tick revision on a frozen run reloads a cell whose content
            // cannot have changed.
            let churning = live && position == segments.count - 1
            switch segment {
            case .markdown(let markdown):
                appendBlockRows(markdown, width: width, revision: churning ? revision : 0,
                                cache: cache, clipOversized: clipOversized,
                                nextID: nextID, into: &rows)
            case .html(let html, let key):
                // A segment with nothing to draw gets no row at all. While
                // streaming, a `<style>` block the model writes before its card is
                // its own segment, and rendering it produced an empty 40pt box
                // above the card the reader is watching. Its rules still reach the
                // card: the segmenter copies every message-level `<style>` into
                // every html segment.
                guard RichHTMLSegments.hasRenderableContent(html: html) else { continue }
                rows.append(richRow(id: nextID(), html: html, key: key,
                                    streaming: churning, width: width))
            case .island(let html, let key, let complete):
                rows.append(islandRow(id: nextID(), html: html, key: key,
                                      complete: complete, width: width))
            }
        }
        return rows
    }

    /// The block pipeline (parse → styled pieces → one row per piece). Factored
    /// out because a rich reply runs it once per markdown run: two copies would
    /// drift, and the copy the rich path used would be the one nobody notices
    /// is out of date.
    private func appendBlockRows(
        _ text: String, width: CGFloat, revision: Int,
        cache: MarkdownParser.CacheMode, clipOversized: Bool,
        nextID: () -> String, into rows: inout [TimelineRow]
    ) {
        let blocks = MarkdownParser.parse(text, cache: cache, clipOversized: clipOversized)
        for piece in TimelineTextStyler.pieces(from: blocks) {
            switch piece {
            case .text(let attributed):
                rows.append(textRow(id: nextID(), revision: revision,
                                    attributed: attributed, width: width))
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
    }

    private func textRow(id: String, revision: Int, attributed: NSAttributedString,
                         width: CGFloat) -> TimelineRow {
        let h = measurer.height(attributed, width: TimelineMetrics.assistantTextWidth(width))
        return TimelineRow(id: id, revision: revision, content: .text(attributed),
                           height: h + TimelineMetrics.textVPad * 2)
    }

    // MARK: - Rich HTML rows

    /// One web document.
    ///
    /// `revision` rides the document key's hash rather than the caller's
    /// revision: a streaming card keeps the SAME row id across ticks (that is
    /// what stops the cell from being torn down and losing `<details>` state),
    /// so without a content-derived revision the diff would see "same id, same
    /// height" and never hand the cell the markup that just arrived.
    private func richRow(id: String, html: String, key: String,
                         streaming: Bool, width: CGFloat) -> TimelineRow {
        TimelineRow(
            id: id, revision: key.hashValue,
            content: .richHTML(html: html, key: key, streaming: streaming),
            height: richRowHeight(id: id, html: html, key: key, width: width)
        )
    }

    private func islandRow(id: String, html: String, key: String,
                           complete: Bool, width: CGFloat) -> TimelineRow {
        // An incomplete island renders as a LABEL, never a web view: mounting
        // it would run half a script (the web console refuses for the same
        // reason). Its placeholder height is a constant, so the row does not
        // resize on every tick while the model finishes writing the block.
        let height = complete
            ? richRowHeight(id: id, html: html, key: key, width: width)
            : TimelineMetrics.richIslandBuildingHeight + TimelineMetrics.richVMargin * 2
        return TimelineRow(
            // Completion must be visible to the diff even if the html between
            // the last building tick and the closing fence is byte-identical.
            id: id, revision: key.hashValue &+ (complete ? 1 : 0),
            content: .richIsland(html: html, key: key, complete: complete),
            height: height
        )
    }

    /// A rich row's FULL height: best-known document height, clamped, plus the
    /// row's own margins. One formula, shared by the first build and by a
    /// re-bank — a second copy would drift the moment the clamps move.
    private func richRowHeight(id: String, html: String, key: String,
                               width: CGFloat) -> CGFloat {
        documentHeight(id: id, html: html, key: key, width: width)
            + TimelineMetrics.richVMargin * 2
    }

    /// The height-cache identities the rich rows in `rows` read: a rich row's
    /// height comes from its DOCUMENT key or, mid-stream, from its ROW id, so a
    /// measurement that moves either one moves this row. Empty means "no row
    /// here can be revised after the fact", which is how the actor knows a memo
    /// entry (or the live head) is none of a measurement's business.
    static func richIdentities(in rows: [TimelineRow]) -> Set<String> {
        var identities: Set<String> = []
        for row in rows {
            switch row.content {
            case .richHTML(_, let key, _), .richIsland(_, let key, _):
                identities.insert(RichHTMLHeightCache.documentIdentity(key))
                identities.insert(RichHTMLHeightCache.rowIdentity(row.id))
            default:
                continue
            }
        }
        return identities
    }

    /// Re-resolve the heights of exactly the rich rows whose banked height just
    /// moved, leaving every other row — and the markdown parse behind it —
    /// alone.
    ///
    /// A measurement changes a HEIGHT, never markup, so the alternative (throw
    /// the memo entry away and rebuild the message) re-segmented the reply and
    /// re-parsed its markdown to arrive at byte-identical rows. On a reply that
    /// segments into many documents that is once per card as the cards measure
    /// themselves one by one; here it is two dictionary lookups per moved row.
    func rebankRichHeights(_ rows: [TimelineRow], width: CGFloat,
                           changed: Set<String>) -> [TimelineRow] {
        var out = rows
        for (index, row) in rows.enumerated() {
            switch row.content {
            case .richHTML(let html, let key, _):
                guard Self.moved(row.id, key, changed) else { continue }
                out[index] = TimelineRow(
                    id: row.id, revision: row.revision, content: row.content,
                    height: richRowHeight(id: row.id, html: html, key: key, width: width))
            case .richIsland(let html, let key, let complete):
                // A building island is a fixed-height placeholder, never a
                // measured document: re-banking it would hand the placeholder
                // the height of the card it is going to become.
                guard complete, Self.moved(row.id, key, changed) else { continue }
                out[index] = TimelineRow(
                    id: row.id, revision: row.revision, content: row.content,
                    height: richRowHeight(id: row.id, html: html, key: key, width: width))
            default:
                continue
            }
        }
        return out
    }

    private static func moved(_ rowID: String, _ key: String, _ changed: Set<String>) -> Bool {
        changed.contains(RichHTMLHeightCache.documentIdentity(key))
            || changed.contains(RichHTMLHeightCache.rowIdentity(rowID))
    }

    /// Height for a rich document, best source first: the exact measurement
    /// banked for this document at this width → whatever this ROW last
    /// measured → a rough estimate.
    ///
    /// The per-ROW fallback is not only for streaming. A `<style>` block the
    /// model writes LATE is harvested into every earlier html segment (the
    /// alternative being a permanently unstyled card), so a settled card's key
    /// can change once, late. Keyed on the row instead, its height survives
    /// that: without the fallback a finished card would visibly jump back to
    /// the estimate and then re-measure.
    ///
    /// Clamped HERE as well as in the cell: an estimate or a stale row height
    /// must never claim more room than the cell will ever report, or the card
    /// keeps a permanent gap underneath it.
    private func documentHeight(id: String, html: String, key: String,
                                width: CGFloat) -> CGFloat {
        let contentWidth = TimelineMetrics.richContentWidth(width)
        let cache = RichHTMLHeightCache.shared
        let height = cache.height(key: key, width: contentWidth)
            ?? cache.lastHeight(rowID: id)
            ?? RichHTMLHeightCache.estimate(html: html, width: contentWidth)
        return min(TimelineMetrics.richMaxHeight, max(TimelineMetrics.richMinHeight, height))
    }

    // MARK: - Live turn (LiveMarkdownWindow semantics)

    /// Rows for the streaming live turn. Head rows are byte-stable across
    /// ticks (LiveMarkdownWindow quantization) — the actor caches them keyed
    /// on the head string; only the tail re-parses/re-measures per tick.
    ///
    /// A RICH window is the one exception: it is rendered whole (see below), so
    /// there is no head to memoize while the model is writing markup.
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
            // The text LiveMarkdownWindow decided to render, as one string. The
            // head/tail pair is a MEMOIZATION device, not a rendering boundary;
            // `head + tail` is the window by construction, and is `liveText`
            // itself whenever nothing was dropped (so an ordinary tick copies
            // nothing).
            let window = seg.omittedPrefix ? seg.head + seg.tail : liveText
            if RichHTMLSegments.isRich(window) {
                // A rich window is segmented WHOLE, never split into head and
                // tail. `safeBoundary` balances code fences and nothing else, so
                // it happily cuts on a blank line at HTML depth 1. Measured on a
                // 12K card-shaped reply whose card straddles the boundary: the
                // head document ended mid-`<div>`, and the tail — whose own depth
                // scan starts at zero — then cut the remainder at every blank line
                // inside the card, turning ONE card into eight documents, the last
                // of them nothing but the orphaned `</div>`. None of them carried
                // the harvested `<style>` either, because the harvest is
                // MESSAGE-scoped inside the segmenter and a second call cannot see
                // the first call's CSS: the reader watched the bottom of a card
                // render naked until the turn settled and the finalized message
                // was segmented in one piece. Both halves of that are structural —
                // one document needs one segmentation over one text — so the split
                // has to go rather than be repaired.
                //
                // The cost this gives up is the head's parse memo, and it stays
                // bounded because the WINDOW is bounded (`windowKeep`) — which is
                // the guarantee LiveMarkdownWindow actually makes. Per-tick work
                // is O(window), never O(reply), which is the 0x8BADF00D bug class
                // the window exists to close.
                //
                // ONE id namespace for the whole window, too: a card keeps its
                // row id (and therefore its banked height and its `<details>`
                // state) as the window slides, where the two-prefix split
                // renumbered every tail row and changed its prefix each time the
                // head boundary advanced a quantum.
                headCache = nil
                rows.append(contentsOf: richRows(
                    window, width: width, idPrefix: "live", cache: .skip,
                    clipOversized: false, revision: tailRevision
                ))
            } else {
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
            height: Self.capsuleRowHeight(badged: false)
        )
    }

    /// Height of a one-line capsule row (a thinking chip, a tool chip's own
    /// capsule). `badged` covers the subagent badge, which is a SECOND capsule
    /// nested inside this one and therefore the tallest thing on the line — the
    /// formula omitted it entirely, so every delegated tool row was 4pt short of
    /// what SwiftUI laid out.
    private static func capsuleRowHeight(badged: Bool) -> CGFloat {
        let line = TimelineMetrics.hostedLineHeight(TimelineTextStyler.captionFont)
        let badge = TimelineMetrics.hostedLineHeight(TimelineTextStyler.caption2Font)
            + TimelineMetrics.badgeVPad * 2
        return max(line, badged ? badge : 0)
            + TimelineMetrics.chipVPad * 2 + TimelineMetrics.chipRowVMargin * 2
    }

    private func toolChipRow(_ message: ChatMessage, width: CGFloat,
                             expandedRowIDs: Set<String>) -> TimelineRow {
        let id = "\(message.id)#0"
        let expanded = expandedRowIDs.contains(id)
            && message.resultPreview?.isEmpty == false
        let capsuleHeight = Self.capsuleRowHeight(badged: message.agent?.isEmpty == false)
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
        let headerHeight = TimelineMetrics.hostedLineHeight(TimelineTextStyler.caption2Font) + 6
        let body = TimelineTextStyler.inlineText(styled.displayText,
                                                 font: TimelineTextStyler.subheadlineFont)
        let bodyHeight: CGFloat
        if expanded {
            bodyHeight = measurer.height(body, width: max(40, bodyWidth))
        } else {
            // Two-line collapsed preview, at the height SwiftUI gives a line
            // (this branch is a `Text(...).lineLimit(2)`, not a TextKit measurement,
            // so `UIFont.lineHeight` was 4.5pt short across the two lines).
            bodyHeight = TimelineMetrics.hostedLineHeight(TimelineTextStyler.subheadlineFont) * 2
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
        // A Grid's rows come out at the font's own line height (unlike a lone
        // `Text`), so the shortfall here is not per line — measured at 1.4pt total,
        // from the divider and the grid's spacing rounding. Rounded UP, because the
        // cell clips: 2pt of slack beats a shaved bottom row.
        contentH += 2
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
