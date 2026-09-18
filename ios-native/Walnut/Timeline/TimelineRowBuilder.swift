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
    /// Gap between a stacked chip's name line and its detail line.
    static let chipStackSpacing: CGFloat = 1
    /// Vertical padding inside a tool chip's subagent badge (its own capsule,
    /// nested in the chip's) — the term the chip's height formula used to omit.
    static let badgeVPad: CGFloat = 2
    /// Card geometry, shared by the live thinking preview and the activity
    /// drawer's sections so the builder's arithmetic and the cells' padding
    /// cannot drift. `expandCardPadding` is the card's inner inset,
    /// `expandCardGap` the gap between the capsule and the card,
    /// `expandLabelGap` the gap under a section's "Input"/"Result" label,
    /// `expandSectionSpacing` the gap between two sections.
    static let expandCardPadding: CGFloat = 10
    static let expandCardGap: CGFloat = 4
    static let expandLabelGap: CGFloat = 2
    static let expandSectionSpacing: CGFloat = 6
    /// The LIVE thinking row's preview cap, in WRAPPED lines. It is on screen for
    /// the whole turn and must not push the reply off the phone, so it stays
    /// tight — the WHOLE reasoning is one tap away in the drawer, which is why a
    /// tight preview costs the reader nothing. The window it bounds is cut from
    /// the NEWEST end, in this same unit — see `TimelineLiveThinkingWindow`.
    ///
    /// There is deliberately NO history counterpart any more. A collapsed
    /// history row shows no excerpt at all (one capsule, fixed word), and the
    /// drawer that replaced the inline expansion scrolls, so nothing needs a
    /// line cap: the old `expandThinkingMaxLines = 48` existed only to stop an
    /// inline card growing without bound, and it truncated the tail of any
    /// reasoning longer than itself with no way to reach the rest.
    static let liveThinkingMaxLines = 8
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

    /// ONE line of hosted `Text`, tight. Measured through
    /// `UIHostingController` at the default text size: a caption line renders at
    /// `lineHeight + 0.54`, so +1 rounds up without the ~2pt cushion
    /// `hostedLineHeight` carries. The cushion is right for a row whose whole
    /// height IS that one line (a capsule) and wrong for a line that is one term
    /// of a sum, where it is pure reserved emptiness.
    static func hostedTightLine(_ font: UIFont) -> CGFloat { font.lineHeight + 1 }

    /// Height a hosted, WRAPPED `Text` of `lines` lines occupies.
    ///
    /// Deliberately NOT `lines * hostedLineHeight(font)`. That constant's slack is
    /// per-row, so multiplying it by a line count multiplies the slack too, and an
    /// 8-line caption body came out 23pt taller than SwiftUI laid it out — a
    /// visible band of nothing under the text.
    ///
    /// SwiftUI stacks the SECOND line onward at `lineHeight + leading` and the
    /// first at `lineHeight`, then rounds the total up to the display grid.
    /// Measured through `UIHostingController` on `Text(…).font(.caption)`, 1 / 2 /
    /// 8 lines: 14.33 / 30.33 / 126.33 at the default text size (lineHeight 14.32,
    /// leading 1.68), 13.33 / 26.33 / 104.33 at extraSmall (13.13, -0.13) and
    /// 51.33 / 102.33 / 408.33 at AccessibilityXXXL (51.31, -0.31). The +1 covers
    /// that grid round-up, which is the only part of the sum this cannot name.
    ///
    /// `leading` is why the per-line term has to come off the FONT rather than
    /// being a flat cushion: it is positive at the default caption size and
    /// negative at extraSmall and at the accessibility sizes, so any one constant
    /// shaves ink at one end of the range while reserving dead space at the other.
    static func hostedTextHeight(lines: Int, font: UIFont) -> CGFloat {
        guard lines > 0 else { return 0 }
        return CGFloat(lines) * font.lineHeight + CGFloat(lines - 1) * font.leading + 1
    }

    /// Width available to assistant text at a given page width.
    static func assistantTextWidth(_ pageWidth: CGFloat) -> CGFloat {
        max(40, pageWidth - hMargin * 2 - assistantTrailingGap)
    }

    /// Width the content of an expanded card (tool sections, reasoning excerpt)
    /// wraps at: the page minus the row margins minus the card's own padding.
    static func expandCardContentWidth(_ pageWidth: CGFloat) -> CGFloat {
        max(40, pageWidth - hMargin * 2 - expandCardPadding * 2)
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
    ///
    /// `scope` is the conversation the message belongs to and rides in every row
    /// id it produces — the server numbers messages positionally, so the message
    /// id alone is NOT unique across conversations (see `TimelineScope`).
    func rows(for message: ChatMessage, width: CGFloat,
              expandedRowIDs: Set<String>,
              scope: String = TimelineScope.unscoped) -> [TimelineRow] {
        let namespace = TimelineScope.namespace(scope, message.id)
        switch message.kind {
        case .tool:
            return [toolChipRow(message, namespace: namespace)]
        case .thinking:
            return [thinkingRow(message, namespace: namespace, width: width)]
        case .notification:
            return [notificationRow(message, namespace: namespace, width: width,
                                    expandedRowIDs: expandedRowIDs)]
        case nil:
            return message.isUser
                ? userRows(message, namespace: namespace, width: width)
                : assistantRows(message, width: width, idPrefix: namespace)
        }
    }

    // MARK: - User bubble

    private func userRows(_ message: ChatMessage, namespace: String,
                          width: CGFloat) -> [TimelineRow] {
        var rows: [TimelineRow] = []
        var index = 0
        func nextID() -> String { defer { index += 1 }; return "\(namespace)#\(index)" }

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
    ///
    /// `idPrefix` is the row-id namespace, already scoped to the conversation by
    /// the caller (`TimelineScope.namespace`); omitting it falls back to the bare
    /// message id, which is the unscoped id space direct callers use.
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
    ///
    /// The live rows are scoped like every other row: a live turn belongs to ONE
    /// conversation, and an unscoped "live-tail#0" would diff clean against the
    /// previous conversation's live tail.
    func liveRows(
        liveText: String, storeTruncated: Bool, activity: String?,
        width: CGFloat, tailRevision: Int,
        cachedHead: (key: String, rows: [TimelineRow])?,
        scope: String = TimelineScope.unscoped,
        liveThinking: String = "",
        liveTools: [LiveToolCall] = []
    ) -> (rows: [TimelineRow], headCache: (key: String, rows: [TimelineRow])?) {
        var rows: [TimelineRow] = []
        var headCache = cachedHead
        // Reasoning comes BEFORE the reply in a turn, so its row goes above the
        // live text. It disappears the moment the store clears its accumulation
        // (a canonical history load lands), which is the same instant the fetched
        // `kind:"thinking"` rows appear — so the same reasoning is never on
        // screen twice.
        let thinkingRows = liveThinkingRows(liveThinking: liveThinking,
                                            width: width, scope: scope)
        rows.append(contentsOf: thinkingRows)
        if !liveText.isEmpty {
            let seg = LiveMarkdownWindow.segments(liveText)
            if seg.omittedPrefix || storeTruncated {
                rows.append(TimelineRow(id: TimelineScope.namespace(scope, "live-truncated"),
                                        revision: 0,
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
                    window, width: width,
                    idPrefix: TimelineScope.namespace(scope, "live"), cache: .skip,
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
                            width: width,
                            idPrefix: TimelineScope.namespace(scope, "live-head"),
                            cache: .shared, clipOversized: false
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
                        width: width,
                        idPrefix: TimelineScope.namespace(scope, "live-tail"),
                        cache: .skip, clipOversized: false, revision: tailRevision
                    ))
                }
            }
        } else {
            headCache = nil
        }
        // This turn's tool calls, as REAL tool rows under the reply — running and
        // finished alike, so none of them vanishes mid-turn.
        rows.append(contentsOf: liveToolRows(liveTools, width: width, scope: scope))
        // The shimmer is the FALLBACK pulse and never a second copy of a row above
        // it. Two ways it used to duplicate one:
        //  - a RUNNING tool chip names the call and breathes, and `activity` is
        //    that very pair folded into "name · detail" — one call printed twice,
        //    once as a row that opens and once as a status line that does not;
        //  - a label-less shimmer renders "Thinking…", which is exactly what the
        //    live Thinking capsule beside it already says (the 2026-09-12 gate's
        //    "two Thinkings at once").
        // A status only this surface has ("Starting session…") is duplicated by
        // nothing, so it still gets the line.
        let running = liveTools.contains { !$0.finished }
        if !running && !(activity == nil && !thinkingRows.isEmpty) {
            rows.append(TimelineRow(
                id: TimelineScope.namespace(scope, "live-activity"),
                revision: (activity ?? "").hashValue,
                content: .activity(activity),
                height: TimelineMetrics.activityHeight
            ))
        }
        return (rows, headCache)
    }

    // MARK: - Chips / tool / notification

    /// Generic one-line capsule. Kept as the constructor for `.chip`, the
    /// plain non-expandable capsule; reasoning rows have their own builder
    /// below because they carry a second, pre-measured height.
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
    /// `stacked` adds the detail's own line under the first one (see
    /// `TimelineChipLayout`): one TIGHT caption line plus the stack's spacing, because
    /// the cushion in `hostedLineHeight` belongs to a row whose whole height is one
    /// line, not to each term of a sum.
    private static func capsuleRowHeight(badged: Bool, stacked: Bool = false) -> CGFloat {
        let line = TimelineMetrics.hostedLineHeight(TimelineTextStyler.captionFont)
        let badge = TimelineMetrics.hostedLineHeight(TimelineTextStyler.caption2Font)
            + TimelineMetrics.badgeVPad * 2
        let second = stacked
            ? TimelineMetrics.hostedTightLine(TimelineTextStyler.captionFont)
                + TimelineMetrics.chipStackSpacing
            : 0
        return max(line, badged ? badge : 0) + second
            + TimelineMetrics.chipVPad * 2 + TimelineMetrics.chipRowVMargin * 2
    }

    /// History thinking row: ONE capsule reading the fixed word "Thinking", with
    /// the whole reasoning behind a tap.
    ///
    /// The row has exactly one height, and no expansion state, so nothing about
    /// it can disagree with the cell — which is the point. The two things it
    /// replaces both truncated: the capsule printed the server's collapsed ≤160
    /// line (so the row's own text was already a fragment), and expanding grew an
    /// inline card capped at 48 wrapped lines with no way to reach the tail.
    ///
    /// `fullText` prefers the server's fuller `thinkingText` excerpt and falls
    /// back to `text` — an older server sends no excerpt, and on that server the
    /// collapsed line IS everything there is, so the drawer still has content and
    /// the tap is still honest.
    private func thinkingRow(_ message: ChatMessage, namespace: String,
                             width: CGFloat) -> TimelineRow {
        let excerpt = message.thinkingText?.trimmingCharacters(in: .whitespacesAndNewlines)
        let full = (excerpt?.isEmpty == false ? excerpt! : message.text)
        // `message.text` IS the server's collapsed one-line reasoning
        // (`thinkingLine`, whitespace-folded and clipped) — the row's content next
        // to the fixed word, exactly as `detail` sits next to a tool's name. It was
        // dropped for one round and a column of reasoning rows became five
        // identical `Thinking ›` capsules.
        let line = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Same rule as a tool chip's detail: at accessibility sizes the line gets its
        // own row inside the capsule. Single-line, this chip degraded to "Thinking A
        // s…" at XXXL while tool chips beside it stayed readable (2026-09-12 gate).
        let stacked = Self.stacksDetail(line.isEmpty ? nil : line)
        return TimelineRow(
            id: "\(namespace)#0", revision: 0,
            content: .thinking(line: line.isEmpty ? nil : line, preview: nil,
                               fullText: full, maxLines: 0,
                               detailRef: message.activityDetailRef, stacked: stacked),
            height: Self.capsuleRowHeight(badged: false, stacked: stacked)
        )
    }

    /// The reasoning row on its own (0 or 1 rows). Reachable from outside
    /// `liveRows` because it OUTLIVES `streaming`: a turn that has just ended
    /// keeps its reasoning until the canonical `kind:"thinking"` rows land, which
    /// is what stops the row from blinking out for the length of the refetch —
    /// and from staying blank if that refetch fails.
    func liveThinkingRows(liveThinking: String, width: CGFloat,
                          scope: String = TimelineScope.unscoped) -> [TimelineRow] {
        liveThinkingRow(liveThinking,
                        id: TimelineScope.namespace(scope, "live-thinking"),
                        width: width).map { [$0] } ?? []
    }

    /// The IN-FLIGHT turn's reasoning: the same "Thinking" capsule a history row
    /// shows, with the NEWEST `liveThinkingMaxLines` wrapped lines previewed in
    /// the card under it, so the reader watches the reasoning arrive instead of
    /// watching one word blink.
    ///
    /// The window is cut in WRAPPED lines, at the same width and font the cell
    /// renders at, and from the newest end — see `TimelineLiveThinkingWindow`
    /// for what the newline-counting version this replaces did on the phone.
    ///
    /// The row carries the FULL accumulation as `fullText`, never the window: the
    /// preview is bounded because it is on screen for the whole turn, and the tap
    /// has to answer "show me all of it" — which is exactly what the windowed
    /// card could not do when it was the only view of live reasoning (the reader
    /// saw a middle slice, marked `… `, with no way to reach either end).
    private func liveThinkingRow(_ text: String, id: String, width: CGFloat) -> TimelineRow? {
        let font = TimelineTextStyler.captionFont
        let contentWidth = TimelineMetrics.expandCardContentWidth(width)
        guard let window = TimelineLiveThinkingWindow.window(
            of: text, maxLines: TimelineMetrics.liveThinkingMaxLines,
            wrappedLines: { candidate in
                self.wrappedLineCount(candidate, font: font, width: contentWidth)
            }
        ) else { return nil }
        let height = Self.capsuleRowHeight(badged: false)
            + TimelineMetrics.hostedTextHeight(lines: window.lines, font: font)
            + TimelineMetrics.expandCardPadding * 2 + TimelineMetrics.expandCardGap
        return TimelineRow(
            // The row keeps ONE id across the whole turn (so it is reloaded, not
            // re-created, per tick); the revision is content-derived because the
            // text changes underneath that stable id. Hashed on the WINDOW, never
            // on the accumulation, so the per-tick cost is bounded.
            id: id, revision: window.body.hashValue,
            // No `line`: the preview card under the capsule already shows the
            // newest reasoning, so a line in the capsule would be the same
            // sentence twice in one row. And no `detailRef`: a live turn's
            // reasoning is not in any transcript the server can be asked for yet —
            // `fullText` here IS everything there is.
            content: .thinking(line: nil, preview: window.body,
                               fullText: TimelineLiveThinkingWindow.normalized(text),
                               maxLines: TimelineMetrics.liveThinkingMaxLines,
                               // No line to stack, at any text size.
                               detailRef: nil, stacked: false),
            height: height
        )
    }

    /// Tool row: ONE capsule, one height, tap opens the drawer with the full
    /// Input and Result.
    ///
    /// Nothing here measures an expanded state any more. The inline card it
    /// replaces had to model its own SwiftUI subtree as arithmetic (a second
    /// description of the same layout, pinned by a parity test) and still capped
    /// both sections — so "what did it run?" was answered with a clipped window.
    private func toolChipRow(_ message: ChatMessage, namespace: String) -> TimelineRow {
        let stacked = Self.stacksDetail(message.detail)
        return TimelineRow(
            id: "\(namespace)#0", revision: 0,
            // `.transcript` unconditionally: a history row is a call that ALREADY
            // RETURNED, and one with no `resultPreview` there produced no output.
            // Only the live region knows a call still in flight, or one whose
            // output has not been relayed yet.
            content: .toolChip(name: message.text, detail: message.detail,
                               inputPreview: message.inputPreview,
                               resultPreview: message.resultPreview,
                               agent: message.agent, phase: .transcript,
                               detailRef: message.activityDetailRef, stacked: stacked),
            height: Self.capsuleRowHeight(badged: message.agent?.isEmpty == false,
                                          stacked: stacked)
        )
    }

    /// Does this chip's detail need its own line? The rule lives in
    /// `TimelineChipLayout`; the CATEGORY comes from the styler the actor has already
    /// adopted for this build, so the height computed here and the shape the cell
    /// draws are answers to the same question.
    static func stacksDetail(_ detail: String?) -> Bool {
        guard let detail, !detail.trimmingCharacters(in: .whitespaces).isEmpty else {
            return false
        }
        return TimelineChipLayout.stacksDetail(TimelineTextStyler.adoptedCategory)
    }

    /// The tool running RIGHT NOW, as a real tool row.
    ///
    /// WHY THIS EXISTS: the live stream's `tool` event carries only `{name,
    /// detail}`, and that pair used to reach the timeline folded into ONE string
    /// on the shimmering `.activity` row. So a `Bash` mid-turn rendered as a
    /// status line with no input, no result and no tap — a different shape from
    /// the `.toolChip` the very same call becomes once the transcript lands, and
    /// on the Personal AI chat (whose history carried no tool rows at all) it was
    /// the ONLY form the tool ever took, which is why it vanished at turn end.
    ///
    /// The rows are deliberately built from the same case the transcript uses, so
    /// a poorer payload shows up as an empty Result rather than as a
    /// different-looking row.
    ///
    /// The wire now carries the SAME two previews the transcript rows do
    /// (`tool { inputPreview }`, `tool-result { resultPreview }`), so a live row
    /// answers "what did it run?" with the command and "what came back?" with the
    /// output. On a server that sends neither, `detail` is still all the input
    /// there is, and the missing result is reported as pending rather than as "No
    /// output" (that pair is exactly the 2026-09-16 report: a finished Bash row
    /// whose drawer showed its DESCRIPTION as the input and claimed no output).
    ///
    /// EVERY call the turn made gets a row, finished ones included. A finished call
    /// used to be dropped by its own `tool-result`, so the chip appeared and then
    /// vanished mid-turn, reappearing only when the whole turn ended and the
    /// transcript landed (sampled once a second by the 2026-09-12 gate). A call is
    /// on screen continuously from `tool` to history; the result frame changes the
    /// chip's STATE, not whether it exists.
    ///
    /// Row ids are ordinal, not id-derived: `toolUseId` is absent on older servers,
    /// and a stable position is what keeps a chip's cell from being re-created on
    /// every tick. Since the list only ever grows within a turn (and its head is
    /// dropped only past `maxLiveTools`), position is stable in practice.
    func liveToolRows(_ tools: [LiveToolCall], width: CGFloat,
                      scope: String = TimelineScope.unscoped) -> [TimelineRow] {
        tools.enumerated().compactMap { index, call in
            guard !call.name.isEmpty else { return nil }
            let stacked = Self.stacksDetail(call.detail)
            // The relayed input if there is one, `detail` otherwise: on an older
            // server the one-line detail is the only input that exists, and an
            // empty Input section would be worse than a description.
            let input = call.inputPreview ?? call.detail
            // Content-derived, over EVERY field that can move under this stable id:
            // the call finishing, its output landing, its input being re-relayed.
            // The row id is ordinal, so a revision that missed the result meant the
            // drawer kept serving the payload from before it arrived.
            var hasher = Hasher()
            hasher.combine(call.detail)
            hasher.combine(input)
            hasher.combine(call.resultPreview)
            hasher.combine(call.finished)
            return TimelineRow(
                id: TimelineScope.namespace(scope, "live-tool-\(index)"),
                revision: hasher.finalize(),
                content: .toolChip(name: call.name, detail: call.detail,
                                   inputPreview: input,
                                   resultPreview: call.resultPreview,
                                   agent: nil,
                                   phase: call.finished ? .liveFinished : .running,
                                   detailRef: nil, stacked: stacked),
                height: Self.capsuleRowHeight(badged: false, stacked: stacked)
            )
        }
    }

    /// How many lines SwiftUI will wrap `text` into at `width` — a TextKit line
    /// COUNT, deliberately not a TextKit height.
    ///
    /// The distinction is the whole point: SwiftUI's line box is TALLER than
    /// `UIFont.lineHeight` (see `TimelineMetrics.hostedLineHeight`), so handing a
    /// TextKit height straight to a hosted row leaves it a few points short per
    /// line — and the cell clips, so those points are shaved INK. Counting lines
    /// and then paying SwiftUI's line height per line rounds the right way.
    /// Not private: the live-reasoning tests assert against the count the row was
    /// built from, and a second implementation in the test would be free to agree
    /// with the assertion while disagreeing with the row.
    func wrappedLineCount(_ text: String, font: UIFont, width: CGFloat) -> Int {
        guard !text.isEmpty else { return 0 }
        // Counted, never divided out of a height: TextKit stacks its line
        // fragments at `lineHeight + leading` (16.0 for the default caption,
        // whose lineHeight is 14.32), so `height / lineHeight` reads 5 lines as 6
        // and 8 as 9 — and every extra line is a line of reserved emptiness under
        // the card. No lineSpacing in the attributes either: the count has to be
        // the one SwiftUI will wrap this text into, and a styled paragraph's
        // extra leading is not part of that question.
        let attributed = NSAttributedString(string: text, attributes: [.font: font])
        return max(1, measurer.lineCount(attributed, width: max(40, width)))
    }

    private func notificationRow(_ message: ChatMessage, namespace: String, width: CGFloat,
                                 expandedRowIDs: Set<String>) -> TimelineRow {
        let id = "\(namespace)#0"
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
    func loadEarlierRow(scope: String = TimelineScope.unscoped) -> TimelineRow {
        TimelineRow(id: TimelineScope.namespace(scope, "load-earlier"), revision: 0,
                    content: .loadEarlier, height: TimelineMetrics.loadEarlierHeight)
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
