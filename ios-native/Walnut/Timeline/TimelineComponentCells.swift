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

    /// The tap target HIG asks for. A chip row is ~27pt tall on a ~37pt pitch, so
    /// the last few points can only come from the gap BETWEEN rows — see
    /// `TimelineHostedRowCell`.
    static let minimumTapHeight: CGFloat = 44

    /// Build the hosted SwiftUI content for a row. Only component kinds land
    /// here — text-heavy kinds have dedicated TextKit cells.
    @MainActor
    static func configure(_ cell: UICollectionViewCell, row: TimelineRow,
                          delegate: TimelineCellActionDelegate?) {
        // Chip rows claim the inter-row gap as tap area; every other hosted row
        // keeps strictly to its own bounds (a text row must not steal touches from
        // the chip under it).
        (cell as? TimelineHostedRowCell)?.verticalHitOutset =
            row.content.opensActivityDrawer
                ? max(0, (minimumTapHeight - row.height) / 2)
                : 0
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
        case .toolChip(let name, let detail, _, _, let agent, let phase, _, let stacked):
            TimelineToolChipView(
                name: name, detail: detail, agent: agent, running: phase == .running,
                stacked: stacked,
                onOpen: {
                    // The ROW carries everything the drawer shows, phase included
                    // (see `TimelineActivityDetail.tool(row:)`): the sheet never
                    // infers a call's state from an empty Result section.
                    guard let payload = TimelineActivityDetail.tool(row: row) else { return }
                    delegate?.timelineCell(didRequest: .openActivity(payload))
                }
            )
        case .thinking(let line, let preview, let fullText, let maxLines, let detailRef,
                       let stacked):
            TimelineThinkingChipView(
                line: line, preview: preview, maxLines: maxLines, stacked: stacked,
                onOpen: {
                    delegate?.timelineCell(didRequest: .openActivity(
                        .thinking(id: row.id, text: fullText, detailRef: detailRef)))
                }
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
        case .queuedNotice(let delivering, let stacked):
            // An HStack (or, at accessibility sizes, a VStack), NOT a `Label`: a Label
            // merges its content into ONE accessibility element, which swallows the
            // button next to it and leaves UI automation with nothing to tap.
            //
            // `lineLimit(1)` on BOTH, and it is load-bearing rather than cosmetic: the
            // row's height is arithmetic over one line of each font, so a wrapped word
            // would draw past the row it was given (a hosted cell does not clip to a
            // scroll view, it paints over its neighbour). Truncation at the largest
            // accessibility size costs a few characters of a one-word label whose
            // accessibility text stays complete.
            let badge = Text(delivering ? ChatSendQueueRules.deliveringBadge
                                        : ChatSendQueueRules.badge)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(.secondary)
                .padding(.horizontal, TimelineMetrics.chipHPad)
                .padding(.vertical, TimelineMetrics.chipVPad)
                .background(Color(.tertiarySystemFill), in: Capsule())
                .accessibilityIdentifier("chat.queuedBadge")
                .accessibilityLabel(delivering
                    ? ChatSendQueueRules.deliveringAccessibilityLabel
                    : ChatSendQueueRules.badgeAccessibilityLabel)
            // GONE once a POST is out, not disabled: the server may already have the
            // message, so there is nothing left to take back, and a control that
            // silently does nothing is worse than no control.
            //
            // Padded like the capsule beside it and given a rectangular hit shape: a
            // `.plain` button's target is otherwise its glyphs alone, a 14pt-tall word
            // that a thumb misses and that UI automation reports as not hittable.
            let withdrawButton = Button {
                delegate?.timelineCell(didRequest: .withdrawQueued(
                    messageID: TimelineRow.messageID(fromRowID: row.id)
                ))
            } label: {
                Text(ChatSendQueueRules.withdraw)
                    .font(.caption)
                    .lineLimit(1)
                    .padding(.horizontal, TimelineMetrics.chipHPad)
                    .padding(.vertical, TimelineMetrics.chipVPad)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.tint)
            .accessibilityIdentifier("chat.withdrawQueued")
            .accessibilityLabel(ChatSendQueueRules.withdrawAccessibilityLabel)
            Group {
                if stacked {
                    VStack(alignment: .trailing, spacing: TimelineMetrics.chipStackSpacing) {
                        badge
                        if !delivering { withdrawButton }
                    }
                } else {
                    HStack(spacing: 8) {
                        Spacer(minLength: TimelineMetrics.bubbleLeadingGap)
                        badge
                        if !delivering { withdrawButton }
                    }
                }
            }
            .padding(.horizontal, TimelineMetrics.hMargin)
            .frame(maxWidth: .infinity, alignment: .trailing)
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

/// The cell every hosted row is dequeued into, with an OPTIONAL vertical hit
/// outset for chip rows.
///
/// WHY A CELL SUBCLASS: a chip's capsule is ~21pt of ink in a ~27pt cell laid out
/// on a ~37pt pitch (`TimelineLayout.rowSpacing` is 10), so ~14pt between two
/// chips belonged to no cell at all and a thumb landing there did nothing. HIG's
/// 44pt is TALLER THAN THE PITCH, so it cannot be reached inside one cell's bounds
/// without moving the pitch — the remainder has to come from the gap, and a cell
/// only receives a touch its own `point(inside:)` accepts (the collection view asks
/// each cell in turn, and `contentView.clipsToBounds` then stops any SwiftUI hit
/// test outside those bounds).
///
/// The consequence, stated plainly: two adjacent chips each claim ~4pt into the
/// ~10pt gap, so a band of a few points is contested and resolves to whichever
/// cell is in front. That is deliberate — a tap in the gap now always opens ONE of
/// the two chips it sits between, where before it opened neither, and every chip's
/// own 27pt band stays unambiguous. `hitTest` re-runs the search at the nearest
/// point INSIDE the cell so the chip's own gesture is what fires; returning the
/// bare cell would have made the outset a silent no-op.
final class TimelineHostedRowCell: UICollectionViewCell {
    /// Points above and below `bounds` that still count as a tap on this row.
    /// 0 for every row kind that is not a chip.
    var verticalHitOutset: CGFloat = 0

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        if super.point(inside: point, with: event) { return true }
        guard verticalHitOutset > 0 else { return false }
        return bounds.insetBy(dx: 0, dy: -verticalHitOutset).contains(point)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        // Inside the cell proper: ordinary routing, untouched.
        if super.point(inside: point, with: event) { return hit }
        // Outside the outset too (`hit` is nil because `point(inside:)` refused).
        guard hit != nil else { return nil }
        let inside = CGPoint(
            x: point.x,
            y: point.y < bounds.midY ? bounds.minY + 1 : bounds.maxY - 1
        )
        return super.hitTest(inside, with: event) ?? hit
    }
}

/// A LOT of text, drawn so that all of it actually lands on screen.
///
/// A section the size of the drawer's render window (20,000 characters) at
/// accessibility XXXL drew NOTHING: the footer read "Showing the first 20,000 of 30,000
/// characters", `Show more` sat under it, and the text area was white at the large
/// detent and see-through at the medium one (2026-09-12, iPhone 16 Pro). The same
/// 20,000 characters at the default text size drew fine, and a short section drew fine
/// at XXXL.
///
/// IT TAKES TWO THINGS, established on the device by elimination — each of these was
/// tried on its own and painted nothing:
///
///  - ONE `Text` MAY NOT BE TOO TALL. The 20,000 characters lay out 85,963pt tall at
///    XXXL against 8,645pt at the default size (the sheet's own scroll content), and one
///    text view of the tall one draws nothing.
///  - A SELECTION OVERLAY MAY NOT SPAN A TALL BLOCK. Splitting into ten separately
///    selectable 2,000-character pieces — each of them a height that paints — was still
///    blank, so the overlay's limit is about the block it covers, not the piece.
///    `.textSelection(.disabled)` does NOT count as removing it; that was measured too,
///    and it paints an empty page just the same.
///
/// So the view measures the block with TextKit at the resolved font, and from that one
/// number decides both: pieces no taller than `pieceHeight` each, and a selection
/// overlay only while the whole block is under `selectableHeight`. Every section a live
/// server sends today (a 2,001-character reasoning excerpt, a 700-character result)
/// comes back as ONE selectable piece at every text size, so ordinary rows are drawn
/// exactly as they were. What is given up is dragging a selection through a section tens
/// of thousands of characters long at the largest text sizes, which is the case that
/// showed nothing at all.
struct TimelineLongText: View {
    let text: String
    let font: Font
    /// The UIKit twin of `font`, so the block can be MEASURED. A SwiftUI `Font` has no
    /// metrics to ask; a `UIFont.TextStyle` plus the environment's text size resolves to
    /// the face TextKit will actually lay out with.
    let style: UIFont.TextStyle
    let monospaced: Bool
    let identifier: String

    @Environment(\.dynamicTypeSize) private var typeSize

    init(_ text: String, font: Font, style: UIFont.TextStyle,
         monospaced: Bool = false, identifier: String) {
        self.text = text
        self.font = font
        self.style = style
        self.monospaced = monospaced
        self.identifier = identifier
    }

    /// The tallest selectable block that keeps its paint, IN THIS FILE'S UNITS (see
    /// `measuringWidth`, which is narrower than the sheet's real column and so measures
    /// everything ~25% taller than it draws).
    ///
    /// Bounded by two device measurements, not chosen: 20,000 characters of prose at the
    /// default size measures 10,836pt here and PAINTS, and the same text at accessibility
    /// XXXL measures 114,300pt here and paints NOTHING. 16,384 is the round number a
    /// graphics stack cares about and it sits between them, so the known-good case keeps
    /// selection with room to spare and the known-bad case cannot.
    static let selectableHeight: CGFloat = 16_384

    /// Width to measure against. NARROWER than the sheet's text column on purpose: a
    /// narrower column wraps to a taller block, so the estimate errs towards "too tall
    /// to be selectable" rather than towards the blank page.
    static let measuringWidth: CGFloat = 300

    /// Below this the answer cannot be no — 1,000 characters measure ~5,700pt at the
    /// largest accessibility size — so the measurement is skipped. It has to stay well
    /// under the ceiling in the WORST case: at 4,000 characters the same text measures
    /// 22,860pt at XXXL, which a shortcut would have waved straight through.
    static let alwaysSelectable = 1_000

    /// The tallest ONE `Text` may lay out and still paint, in the same units. Bounded
    /// by device measurements the same way: an unsplit 10,836pt block paints, splitting
    /// the XXXL case into 11,430pt pieces painted, and one 114,300pt `Text` paints
    /// nothing. 12,288 sits above both known-good numbers and far below the bad one.
    static let pieceHeight: CGFloat = 12_288

    var body: some View {
        let plan = Self.plan(text, style: style, monospaced: monospaced, size: typeSize)
        // Two branches rather than a ternary: `.textSelection(.enabled)` and `.disabled`
        // are different types. The unsafe branch applies NO selection modifier at all —
        // `.disabled` was measured on the device and still painted an empty page, so it
        // installs the same machinery and merely refuses the gesture.
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(plan.pieces.enumerated()), id: \.offset) { piece in
                if plan.selectable {
                    Text(piece.element).font(font).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(piece.element).font(font)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        // ONE accessibility element carrying the whole string: a selection-enabled `Text`
        // reports an EMPTY accessibility label (measured in the real hierarchy: both card
        // bodies came back `a=''`), and a reader must not have to swipe through ten
        // pieces to hear one step. The pieces are a drawing detail, not structure.
        .accessibilityElement()
        .accessibilityIdentifier(identifier)
        .accessibilityLabel(text)
    }

    /// How to draw this block: the pieces to lay out, and whether a selection overlay is
    /// safe across them.
    ///
    /// ONE measurement decides both. Ordinary content (every section a live server sends
    /// today) comes back as a single selectable piece, so it is drawn exactly as it was
    /// before this view existed.
    static func plan(_ text: String, style: UIFont.TextStyle, monospaced: Bool,
                     size: DynamicTypeSize,
                     width: CGFloat = measuringWidth) -> (pieces: [String], selectable: Bool) {
        guard text.count > alwaysSelectable else { return ([text], true) }
        let font = resolvedFont(style: style, monospaced: monospaced, size: size)
        let height = measuredHeight(text, uiFont: font, width: width)
        guard height > pieceHeight else { return ([text], height <= selectableHeight) }
        // Characters per piece from the measured height rather than from a character
        // count: the same 20,000 characters are 10,836pt of prose at the default size
        // and 114,300pt at XXXL, and one unbroken 20,000-character token is a different
        // shape again.
        let perPiece = max(500, Int(CGFloat(text.count) * pieceHeight / height))
        return (split(text, limit: perPiece), height <= selectableHeight)
    }

    /// Split at a newline when one is within reach of the limit, else at the last space,
    /// else exactly at the limit (an unbroken token — minified JSON or base64 — has no
    /// good break in it). Never mid-word where a word boundary exists.
    static func split(_ text: String, limit: Int) -> [String] {
        guard limit > 0, text.count > limit else { return text.isEmpty ? [] : [text] }
        var out: [String] = []
        var rest = Substring(text)
        while rest.count > limit {
            let window = rest.prefix(limit)
            // Look for a break in the last fifth of the window, so a piece is never much
            // shorter than the limit just because a newline sat early in it.
            let floor = window.index(window.startIndex, offsetBy: limit * 4 / 5)
            let cut = window.range(of: "\n", options: .backwards,
                                   range: floor..<window.endIndex)?.upperBound
                ?? window.range(of: " ", options: .backwards,
                                range: floor..<window.endIndex)?.upperBound
                ?? window.endIndex
            out.append(String(rest[rest.startIndex..<cut]))
            rest = rest[cut...]
        }
        if !rest.isEmpty { out.append(String(rest)) }
        return out
    }

    /// Is a selection overlay safe over this much text at this size?
    static func isSelectable(_ text: String, style: UIFont.TextStyle,
                             monospaced: Bool = false, size: DynamicTypeSize,
                             width: CGFloat = measuringWidth) -> Bool {
        guard text.count > alwaysSelectable else { return true }
        let font = resolvedFont(style: style, monospaced: monospaced, size: size)
        return measuredHeight(text, uiFont: font, width: width) <= selectableHeight
    }

    /// The face the text draws with at a given size.
    static func resolvedFont(style: UIFont.TextStyle, monospaced: Bool,
                             size: DynamicTypeSize) -> UIFont {
        let traits = UITraitCollection {
            $0.preferredContentSizeCategory = TimelineChipLayout.category(size)
        }
        let base = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
        guard monospaced else { return base }
        return UIFont.monospacedSystemFont(ofSize: base.pointSize, weight: .regular)
    }

    /// Laid-out height of `text` at `uiFont` in a column `width` wide.
    ///
    /// TextKit's own measurement rather than characters-per-line arithmetic: the answer
    /// has to hold for prose, for monospaced log output and for one unbroken 20,000-
    /// character JSON line, which have wildly different heights at the same length.
    static func measuredHeight(_ text: String, uiFont: UIFont,
                               width: CGFloat = measuringWidth) -> CGFloat {
        (text as NSString).boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: uiFont], context: nil).height
    }
}

/// One labelled section of the activity drawer ("Input" / "Result"), monospaced
/// and horizontally scrollable so a wide line is reachable without wrapping.
///
/// `maxHeight` is optional and nil in the drawer: it exists for a section inside
/// a fixed-height row, and the drawer has none — the SHEET scrolls, so capping a
/// section here would put a second scroller inside it and re-create the clipping
/// the drawer was built to remove.
struct TimelineExpandSection: View {
    let label: String
    let body_: String
    let maxHeight: CGFloat?
    /// A plain caption note ("Running…", "No output") instead of a code body.
    let isNote: Bool

    /// Stand-in for a Result section with nothing in it. THREE states, because
    /// two of them are not "no output" at all: a call still in flight has not
    /// answered yet, and a live call that returned may simply not have had its
    /// output relayed to the phone (an older server sends no `resultPreview`, and
    /// the transcript carries it at turn end). Only a transcript row's empty
    /// Result is proof the tool printed nothing.
    ///
    /// Pure and static so the tests pin all three words without rendering SwiftUI.
    static func resultNote(phase: TimelineToolPhase) -> String {
        switch phase {
        case .running: return "Running…"
        case .liveFinished: return "Finished. The output arrives when the turn ends."
        case .transcript: return "No output"
        }
    }

    init(label: String, body: String, maxHeight: CGFloat? = nil, isNote: Bool = false) {
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
                // WRAPS. A note is a whole sentence now ("Finished. The output
                // arrives when the turn ends."), and a one-line limit truncated
                // it at accessibility sizes, and a clipped explanation of missing
                // text is the bug it exists to explain.
                Text(body_)
                    .font(.caption)
                    .foregroundStyle(ReadableText.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(bodyIdentifier)
            } else {
                // IT WRAPS. It used to be a horizontal `ScrollView`, which is fine for
                // log output (already newline-separated) and unusable for the two
                // commonest shapes in here: the 2026-09-12 gate needed 20 drags to
                // reach "Step 015" of a 2,600-character command and 26 to reach the
                // end, with the input and result panning independently — and long
                // commands and one-line JSON are most of what a tool row carries.
                // Reasoning text in the same sheet wrapped, so the drawer behaved two
                // different ways depending which section you were reading.
                //
                // No soft-wrap marker: drawing one means breaking the lines MYSELF at
                // a measured width, which is the same "my line breaking against
                // TextKit's" drift the timeline's height formula exists to avoid. The
                // monospace face plus the card's inset already read as a code block.
                //
                // `fixedSize(horizontal: false, vertical: true)`: inside the sheet's
                // vertical scroller a `Text` is otherwise free to prefer one long line
                // and get clipped instead of wrapping — which is exactly how the last
                // one or two characters ("reade|r") went missing off the right edge.
                //
                // `TimelineLongText` rather than a bare `Text`: one text view stops
                // drawing at all somewhere under a full render window at accessibility
                // sizes, and it carries the accessibility label a selection-enabled
                // `Text` does not report (measured in the real hierarchy: both card
                // bodies came back `a=''`, so the one thing the reader tapped the row
                // to see was invisible to VoiceOver).
                TimelineLongText(body_,
                                 font: .system(.caption2, design: .monospaced),
                                 style: .caption2, monospaced: true,
                                 identifier: bodyIdentifier)
                    .modifier(OptionalMaxHeight(maxHeight: maxHeight))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The chevron that says a chip OPENS. Small on purpose, and it grows with the text
/// beside it.
///
/// `@ScaledMetric`, NOT a point size computed from `TimelineTextStyler`. It was a
/// literal `.font(.system(size: 8))`, which never moved; the first fix routed it
/// through `TimelineTextStyler.scaled(8, relativeTo: .caption2)`, and the gate then
/// measured the shipped app and found the glyph STILL 4x7pt of ink at both default
/// and accessibility XXXL while the icon beside it went 13pt → 48pt. The arithmetic
/// was right and the input was not: that helper resolves against the category the
/// styler has ADOPTED, the only `adopt` call in the app is the layout actor's, and
/// with the box left `.unspecified` `UIFontMetrics` fell back to
/// `UITraitCollection.current` — which, during a SwiftUI body evaluation on a hosted
/// cell, is not the window's. So the row's HEIGHT scaled (the actor's fonts come off
/// the system setting directly) and this one glyph did not.
///
/// `@ScaledMetric` reads `\.dynamicTypeSize` from the environment the view is
/// actually rendered in, which is the same environment the caption next to it uses.
/// There is no global to prime, so no test can pass by priming it — the value is
/// wrong or right for the same reason the neighbouring text is.
///
/// Internal, not private: `ActivityDrawerPolishTests` renders it at two text sizes
/// and compares the measured size. That is the only honest way to test this — a test
/// that calls the sizing helper itself proves the helper, and this bug lived under
/// exactly such a test for a full round.
struct TimelineChipChevron: View {
    @ScaledMetric(relativeTo: .caption2) private var size: CGFloat = 8

    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: size, weight: .semibold))
            .accessibilityHidden(true)
    }
}

/// Everything a drawer-opening chip row shares: the capsule's ink and padding, the
/// row margins, the tap target, and the ONE accessibility element.
///
/// It is a shared container and not two copies because the two rows must not be
/// able to drift — the whole point of the 2026-09-11 unification. Three rules it
/// encodes, each a gate finding:
///
///  - THE TAP TARGET IS THE WHOLE ROW, not the capsule. The capsule is ~21pt of
///    ink; with `.contentShape(Capsule())` a thumb landing in the 14pt between two
///    chips hit nothing at all. Full row width matters as much as height: a
///    `Thinking` capsule is 70pt wide on a 393pt row, and the empty space beside
///    it now belongs to the row rather than to nobody. (The cell adds the last
///    few points — see `TimelineHostedRowCell` — because HIG's 44pt is taller than
///    the row PITCH, so the remainder can only come from the gap.)
///  - ONE ACCESSIBILITY ELEMENT with the button trait. As three separate elements
///    VoiceOver read out SF Symbol names: "wrench.and.screwdriver", "Sparkle",
///    "Forward" (measured in the real hierarchy).
///  - The chip's ink is ONE readable colour. NOT `.tertiary` on the detail or the
///    chevron (measured on the phone: 1.69:1 light / 2.34:1 dark, under WCAG's
///    3:1 floor for a UI affordance let alone 4.5:1 for text), and NOT `.secondary`
///    on the name either (3.24:1 light). The chevron is the only thing that says
///    this row OPENS and the detail is the only thing telling eight stacked `Bash`
///    rows apart, so neither can be paid for in contrast; subordinate is carried
///    by SIZE and WEIGHT instead. See `ReadableText`, `ReadableTextContrastTests`.
private struct TimelineChipRow<Content: View>: View {
    let identifier: String
    let label: String
    let onOpen: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(spacing: 5) { content() }
            .foregroundStyle(ReadableText.secondary)
            .padding(.horizontal, TimelineMetrics.chipHPad)
            .padding(.vertical, TimelineMetrics.chipVPad)
            .background(Color(.tertiarySystemFill), in: Capsule())
            // The row's own vertical margin sits INSIDE the tap shape: it is
            // otherwise dead space in the middle of a 37pt pitch.
            .padding(.vertical, TimelineMetrics.chipRowVMargin)
            .padding(.horizontal, TimelineMetrics.hMargin)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { onOpen() }
            .accessibilityElement(children: .ignore)
            .accessibilityIdentifier(identifier)
            .accessibilityLabel(label)
            .accessibilityAddTraits(.isButton)
    }
}

/// Tool row: ONE capsule, tapped to open the activity drawer.
///
/// Every tool row takes the tap, including one with no result yet: a row that
/// refuses it is indistinguishable from a broken tap, so the drawer says
/// "Running…" / "No output" instead of nothing happening. The chevron points
/// RIGHT rather than down — it opens a sheet, and a down chevron promises the row
/// itself will grow.
///
/// `running` breathes the icon. It is the only thing distinguishing a call the
/// agent is inside from one that has returned, now that a finished live call keeps
/// its chip instead of vanishing (see `LiveToolCall`), and it costs no height —
/// which matters, because the row's height is a formula the cell must not outgrow.
private struct TimelineToolChipView: View {
    let name: String
    let detail: String?
    let agent: String?
    let running: Bool
    /// The detail gets its own line (see `TimelineChipLayout`). Passed IN with the
    /// row, never read from the environment here: the row's height was reserved for
    /// exactly this shape.
    let stacked: Bool
    let onOpen: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var breathing = false
    /// The subagent badge's glyph, sized off the environment for the same reason the
    /// chevron is (see `TimelineChipChevron`).
    @ScaledMetric(relativeTo: .caption2) private var badgeGlyph: CGFloat = 8

    private var animates: Bool { running && scenePhase == .active && !reduceMotion }

    var body: some View {
        TimelineChipRow(
            identifier: "tool.chip",
            label: TimelineChipAccessibility.tool(name: name, detail: detail,
                                                  agent: agent, running: running),
            onOpen: onOpen
        ) {
            if let agent, !agent.isEmpty {
                HStack(spacing: 3) {
                    Image(systemName: "person.2.fill")
                        .font(.system(size: badgeGlyph, weight: .semibold))
                    Text(agent)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(.indigo)
                .padding(.horizontal, 6)
                .padding(.vertical, TimelineMetrics.badgeVPad)
                .background(Color.indigo.opacity(0.14), in: Capsule())
            }
            Image(systemName: agent == nil ? "wrench.and.screwdriver" : "arrow.triangle.branch")
                .font(.caption2)
                .opacity(breathing ? ReadableText.shimmerFloor : 1)
                .animation(
                    animates
                        ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true)
                        : nil,
                    value: breathing
                )
                .onAppear { breathing = animates }
                .onChange(of: animates) { _, on in breathing = on }
            // The NAME wins the squeeze, and truncates in the MIDDLE when it must.
            // At XXXL an `mcp__walnut__task_create` came back as `mcp__walnu…`,
            // which is every MCP tool on the server; the distinguishing half of
            // such a name is its tail, and the detail is the term that can yield
            // (it is a summary of something the drawer shows in full).
            //
            // STACKED, the two stop competing: at accessibility sizes there is no
            // width left to share, and squeezing the detail to 8 characters
            // ("Re…ciple") loses the only thing telling eight `Bash` rows apart.
            //
            // …and stacked, the detail truncates at its TAIL, not its middle. On the
            // phone at XXXL its own line still only fits about a dozen glyphs, and a
            // middle ellipsis spends them on both ends at once: "Check walnut CLI
            // session tools and latest CMES task note" came back as "Chec…sk note",
            // which names nothing. "Check walnu…" is the same width and is the half
            // that identifies the call, because a command and a summary both read from
            // the left. The name keeps its middle ellipsis for the opposite reason.
            //
            // It stays ONE line: the row's height was reserved for one, and a second
            // line here would have to be measured — the same formula-vs-layout drift
            // that shaves ink off a row. The drawer has the whole string.
            if stacked, let detail, !detail.isEmpty {
                VStack(alignment: .leading, spacing: TimelineMetrics.chipStackSpacing) {
                    Text(name)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(detail)
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            } else {
                Text(name)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(2)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(1)
                }
            }
            TimelineChipChevron()
        }
    }
}

/// The status bar's line for a section that is not showing everything: both numbers,
/// and the next step WHEN THERE IS ONE.
///
/// Its own internal view because the interesting property is not the words but whether
/// a control appears at all, and that has to be measurable. A section can be withheld
/// with nothing to press: the server says the source is 24,291 characters, it sent 19,
/// and it sent no cursor because the remainder is unreachable. The numbers are a fact
/// to state; a button there could not do anything, and pressing it twice would look
/// like the app losing text.
struct TimelineActivityWithheldRow: View {
    /// "Input" / "Result" when the sheet shows more than one section, else nil.
    let label: String?
    let section: TimelineDrawerSection
    let widen: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let words = (label.map { "\($0) · " } ?? "")
            + TimelineActivitySheet.withheldText(
                shown: section.shownChars, total: section.total)
        TimelineActivityBarRow(stacked: TimelineChipLayout.stacksDetail(typeSize)) {
            Text(verbatim: words)
                .font(.caption2)
                .foregroundStyle(ReadableText.secondary)
        } control: {
            if TimelineActivitySheet.offersShowMore(section) {
                TimelineActivityButton("Show more", identifier: "activity.showMore",
                                       action: widen)
            }
        }
        .accessibilityIdentifier("activity.withheld")
    }
}

/// Words beside their control, or above it once the words need the whole width. Same
/// stacking rule as a chip's detail (`TimelineChipLayout`), for the same reason: at
/// accessibility sizes there is no width left to share.
struct TimelineActivityBarRow<Words: View, Control: View>: View {
    let stacked: Bool
    @ViewBuilder let words: () -> Words
    @ViewBuilder let control: () -> Control

    var body: some View {
        if stacked {
            VStack(alignment: .leading, spacing: 4) { words(); control() }
        } else {
            HStack(spacing: 8) { words(); control() }
        }
    }
}

/// A control in the activity drawer's status bar ("Show more", "Try again").
///
/// Its own view, and internal, for two reasons: the sheet needs the same control in
/// two places, and a test has to be able to MEASURE the real one. A hosted SwiftUI
/// tree publishes no accessibility elements unless an assistive technology is running,
/// so the size of a button buried in the sheet cannot be read back — measuring this
/// view directly is the only ambient-free way to hold the tap target to its floor.
///
/// 44pt of TARGET around 14pt of text. `Show more` is the only way onward past the
/// render window and it shipped as a 61x14pt hit area (2026-09-12 gate) — the smallest
/// control in the app guarding the most content. The horizontal padding lets a thumb
/// land beside the words, `contentShape` makes that padding tappable rather than
/// merely present, and the height is STATED rather than arrived at by padding: 15pt
/// each side of caption2 measured 43.33pt on the phone, and a floor must not come out
/// 0.67 short because a text style is 13.33 rather than 14.
struct TimelineActivityButton: View {
    let title: String
    let identifier: String
    let action: () -> Void

    init(_ title: String, identifier: String, action: @escaping () -> Void) {
        self.title = title
        self.identifier = identifier
        self.action = action
    }

    var body: some View {
        Button(title, action: action)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .frame(minHeight: TimelineHostedCell.minimumTapHeight)
            .contentShape(Rectangle())
            .accessibilityIdentifier(identifier)
    }
}

/// Thinking row: a capsule reading the fixed word "Thinking", tapped to open the
/// activity drawer with the WHOLE reasoning.
///
/// The word is a constant here, not a row field, so a live row and a history row
/// cannot print two different names for one thing (they did: "Reasoning" live,
/// the server's excerpt line in history).
///
/// `preview` is the live turn's newest-anchored window and is a PREVIEW only. It
/// keeps its `lineLimit` as a backstop against a window that measured shorter
/// than it renders — the builder already cut it to `maxLines`, so this only ever
/// clips a rounding error, never the reader's content: everything is in the
/// drawer. The row is tappable in BOTH states; unlike the old inline expansion
/// there is never "nothing more to show", because the capsule shows no content
/// at all.
private struct TimelineThinkingChipView: View {
    let line: String?
    let preview: String?
    let maxLines: Int
    /// The line gets its own row inside the capsule (see `TimelineChipLayout`). Passed
    /// IN with the row for the same reason the tool chip's is: the height was reserved
    /// for exactly this shape.
    let stacked: Bool
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: TimelineMetrics.expandCardGap) {
            TimelineChipRow(
                identifier: "thinking.chip",
                label: TimelineChipAccessibility.thinking(line: line),
                onOpen: onOpen
            ) {
                Image(systemName: "sparkles").font(.caption2)
                // The row's CONTENT sits exactly where a tool row prints its detail,
                // and behaves the same way at every text size. Without it a column of
                // reasoning rows was five identical `Thinking ›` capsules and finding
                // the one you wanted meant opening five drawers (2026-09-12); STACKED,
                // it survives accessibility sizes, where a single line left it as
                // "Thinking A s…" next to tool chips that stayed readable.
                //
                // The word stays a constant, so this is a legible line, not a second
                // vocabulary. Truncation is at the TAIL in both shapes: it is a
                // sentence of reasoning, which reads from the left.
                if stacked, let line, !line.isEmpty {
                    VStack(alignment: .leading, spacing: TimelineMetrics.chipStackSpacing) {
                        Text(TimelineActivityVocabulary.thinking)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                        Text(line)
                            .font(.caption)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                } else {
                    Text(TimelineActivityVocabulary.thinking)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                        .layoutPriority(2)
                    if let line, !line.isEmpty {
                        Text(line)
                            .font(.caption)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .layoutPriority(1)
                    }
                }
                TimelineChipChevron()
            }

            if let preview {
                // Prose, so it WRAPS — like the drawer's monospaced tool sections,
                // which used to scroll horizontally and now wrap too. Reasoning is
                // read, and a reader should not have to pan a sentence.
                Text(preview)
                    .font(.caption)
                    .foregroundStyle(ReadableText.secondary)
                    .textSelection(.enabled)
                    .lineLimit(maxLines)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(TimelineMetrics.expandCardPadding)
                    .background(Color(.secondarySystemBackground),
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityIdentifier("thinking.livePreview")
                    // The card keeps its own leading inset: the row margin moved
                    // INSIDE the capsule's tap shape (see `TimelineChipRow`), so
                    // it is no longer applied to the whole stack.
                    .padding(.horizontal, TimelineMetrics.hMargin)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Applies a max-height cap only when there is one (see `TimelineExpandSection`).
private struct OptionalMaxHeight: ViewModifier {
    let maxHeight: CGFloat?

    func body(content: Content) -> some View {
        if let maxHeight {
            content.frame(maxHeight: maxHeight)
        } else {
            content
        }
    }
}

/// One section's text as the drawer holds it: what the row already carried, what a
/// fetch replaced it with, and how much of it is currently rendered.
///
/// EVERY NUMBER HERE IS A COUNT OF UTF-16 CODE UNITS, because the server's are. Its
/// `*Chars` and `offset` come from JavaScript's `string.length`, which counts UTF-16
/// units: one emoji is 2, and `\r\n` is 2. Swift's `String.count` counts GRAPHEMES —
/// one for the emoji, and one for `\r\n` as well, since Swift treats CRLF as a single
/// Character. So a section carrying 40 emoji reported 2,717 from the server against
/// 2,605 counted locally and a COMPLETE section announced "Showing the first 2,605 of
/// 2,717 characters." with no Show more to press (2026-09-12 gate; 120 CRLF line
/// endings did the same). Mixing the two units is not a rounding error, it is a
/// different question, so this type asks the server's question everywhere.
///
/// `chars` is banked at assignment because counting is O(n) and a tool result can be
/// hundreds of KB — a per-render count would be paid on every scroll tick.
struct TimelineDrawerSection: Equatable {
    var text = ""
    /// `text` measured in UTF-16 code units, i.e. in the server's units.
    private(set) var chars = 0
    /// Total the SERVER holds for this section (may exceed what it sent), in UTF-16
    /// code units — see the type comment.
    var serverChars: Int?
    /// The server had more than it put in this page.
    var cut = false
    /// UTF-16 code units rendered right now. Raised by the reader, never
    /// automatically: a 200,000-character page in one `Text` is a frozen sheet, and a
    /// drawer that takes three seconds to open is its own bug.
    var window = TimelineDrawerSection.renderWindow

    static let renderWindow = 20_000

    init() {}

    init(_ text: String, serverChars: Int? = nil, cut: Bool = false) {
        self.text = text
        self.chars = text.utf16.count
        self.serverChars = serverChars
        self.cut = cut
    }

    var isEmpty: Bool { text.isEmpty }
    /// What to draw: everything, or the first `window` code units of it.
    var visible: String {
        chars <= window ? text : Self.prefix(text, utf16Limit: window)
    }
    /// What `visible` ACTUALLY renders, in the server's units — never more than
    /// `window`, and a little less when the cut lands inside a cluster. The footer
    /// prints this rather than `window`, so its two numbers describe the same text.
    var shownChars: Int { chars <= window ? chars : visible.utf16.count }
    /// Everything that exists, as far as anyone knows.
    var total: Int { max(serverChars ?? chars, chars) }
    /// Is text being withheld right now — by the render window or by the server's
    /// own page cut? If so the drawer SAYS so, with both numbers.
    var withholding: Bool { chars > window || cut }

    /// The first `utf16Limit` code units of `text`, cut back to a Character boundary.
    ///
    /// A UTF-16 offset can land INSIDE a surrogate pair or a multi-scalar cluster,
    /// where `String` has no index at all — so the cut walks back until it finds one.
    /// Never `text.prefix(utf16Limit)`: that counts graphemes, so a window of 20,000
    /// would hand `Text` up to 40,000 code units of emoji while the footer claimed
    /// 20,000.
    static func prefix(_ text: String, utf16Limit: Int) -> String {
        guard utf16Limit > 0 else { return "" }
        let units = text.utf16
        guard units.count > utf16Limit else { return text }
        var cursor = units.index(units.startIndex, offsetBy: utf16Limit)
        while cursor > units.startIndex {
            if let boundary = String.Index(cursor, within: text) {
                return String(text[..<boundary])
            }
            cursor = units.index(before: cursor)
        }
        return ""
    }
}

/// The activity drawer: the ONE surface that shows a thinking or tool row's full
/// content, on both the Personal AI chat and a coding session.
///
/// It is a sheet and not a taller row on purpose. The content is unbounded (a
/// turn's reasoning, a tool's output), and the transcript is a fixed-height-row
/// collection view — so growing the row means either a cap (what truncated the
/// reasoning at 48 wrapped lines) or a nested scroller inside the transcript's
/// own. A sheet has neither problem, and it is what the reader asked for: tap the
/// row, read everything, dismiss.
///
/// THE TEXT ARRIVES IN TWO STAGES. The list payload carries a server-clipped
/// excerpt (reasoning at 2,000 characters, a tool result at 700, both marked "…")
/// because that read is polled and rides a 1MB bridge cap. So the drawer paints the
/// excerpt on its FIRST FRAME and then replaces it with the full text it fetches
/// (`TimelineActivityFullText`). Three rules that ordering has to obey:
///
///  - never a spinner where text already is — the excerpt is real content, and
///    hiding it to show a progress view makes a fast reader wait for nothing;
///  - never a silent truncation — whenever anything is withheld, by the server's
///    page cut or by this view's own render window, the sheet says so WITH THE
///    NUMBERS and offers the next step;
///  - a failed fetch is a note beside the excerpt, never an empty sheet. `nil`
///    `detailRef` is not a failure at all: it means the excerpt IS the whole text,
///    which is also what an older PRIMARY reports (a relaying replica hands back the
///    primary's rows, so its own age does not decide this).
struct TimelineActivitySheet: View {
    let detail: TimelineActivityDetail

    @Environment(\.dismiss) private var dismiss
    /// Read for ONE decision: whether the status bar's words and its control still fit
    /// on one line (see `barRow`).
    @Environment(\.dynamicTypeSize) private var typeSize

    @State private var reasoning: TimelineDrawerSection
    @State private var input: TimelineDrawerSection
    @State private var result: TimelineDrawerSection
    @State private var loading = false
    /// The last fetch's outcome, or nil when nothing has failed. Typed rather than a
    /// Bool because the bar answers two different questions from it — does this earn
    /// WORDS, and can a retry change it — and the answers differ per status.
    @State private var fetchOutcome: TimelineActivityFullText.Failure?
    /// The row whose FULL text we hold, or nil while all we have is an excerpt. A row
    /// id rather than a Bool: `.sheet(item:)` can hand this view a different row without
    /// re-creating it, and a plain "resolved" flag then blocked the reseed and showed the
    /// previous step's text under the new title.
    @State private var resolvedID: String?

    init(detail: TimelineActivityDetail) {
        self.detail = detail
        // THE EXCERPT IS STATE ZERO, not the result of the first tick. It used to be
        // seeded from `.task`, which meant one frame of "No reasoning recorded" before
        // the text appeared — and in a hosted controller (no scene) `.task` never runs
        // at all, so the sheet stayed empty forever. Nothing here can fail or wait.
        let seed = Self.seed(for: detail)
        _reasoning = State(initialValue: seed.reasoning)
        _input = State(initialValue: seed.input)
        _result = State(initialValue: seed.result)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let agent = detail.agent, !agent.isEmpty {
                        Label(agent, systemImage: "person.2.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.indigo)
                    }
                    switch detail.kind {
                    case .thinking: reasoningBody
                    case .tool: toolBody
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // EVERY STATUS LINE AND CONTROL IS PINNED HERE, not left at the end of the
            // text. They used to sit under their section, which meant that at
            // accessibility sizes they were unreachable: the same reasoning block that
            // is 11 scroll pages at default type is 216 at XXXL, and a reader who
            // needed "Show more" had to swipe through all of it to find the only
            // control that reveals the rest (2026-09-12 gate: still 112 pages left
            // after 12 swipes). A bottom inset is on screen at every text size and
            // every scroll offset.
            .safeAreaInset(edge: .bottom, spacing: 0) { statusBar }
            .navigationTitle(detail.title)
            .navigationBarTitleDisplayMode(.inline)
            // An explicit close, not drag-to-dismiss alone: the drag indicator is
            // the only affordance this sheet had, and the app's every other sheet
            // offers Done. Same placement and same word, deliberately.
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("activity.done")
                }
            }
        }
        // Half-height first, draggable to full: the reader is checking one step
        // without losing their place in the conversation, which is the whole
        // interaction the reference app uses for this.
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("activity.sheet")
        // Keyed on the row: tapping a different chip while this is open re-presents
        // it, and the fetch has to follow the new row rather than the old one.
        .task(id: detail.id) { await load() }
    }

    // MARK: - Bodies

    private var reasoningBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Prose: wrapped, selectable, and NO line limit — the whole point of
            // the drawer. Drawn in pieces (`TimelineLongText`) because a single text
            // view of this length draws nothing at all at accessibility sizes.
            TimelineLongText(reasoning.isEmpty ? Self.noReasoning : reasoning.visible,
                             font: .callout, style: .callout,
                             identifier: "activity.thinkingBody")
        }
    }

    @ViewBuilder
    private var toolBody: some View {
        // Input FIRST: "what did it run" is the question a tool name raises.
        if let subtitle = detail.subtitle, !subtitle.isEmpty, subtitle != input.text {
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(ReadableText.secondary)
        }
        if !input.isEmpty {
            TimelineExpandSection(label: "Input", body: input.visible)
        }
        if !result.isEmpty {
            TimelineExpandSection(label: "Result", body: result.visible)
        } else {
            // Which of the three notes this earns turns on where the CALL stands,
            // which only the row knows (see `TimelineToolPhase`), never on the
            // emptiness of the section itself.
            TimelineExpandSection(
                label: "Result",
                body: TimelineExpandSection.resultNote(phase: detail.phase),
                isNote: true)
        }
    }

    // MARK: - The pinned status bar

    /// One section that is not showing everything, plus how to widen it.
    private struct Withheld: Identifiable {
        let id: String
        /// "Input" / "Result" when the sheet has more than one — a bare pair of numbers
        /// cannot say WHICH section fell short when two of them are on screen.
        let label: String?
        let section: TimelineDrawerSection
        let widen: () -> Void
    }

    private var withheldSections: [Withheld] {
        var out: [Withheld] = []
        if reasoning.withholding {
            out.append(Withheld(id: "reasoning", label: nil, section: reasoning,
                                widen: { reasoning.window += TimelineDrawerSection.renderWindow }))
        }
        if input.withholding {
            out.append(Withheld(id: "input", label: "Input", section: input,
                                widen: { input.window += TimelineDrawerSection.renderWindow }))
        }
        if result.withholding {
            out.append(Withheld(id: "result", label: "Result", section: result,
                                widen: { result.window += TimelineDrawerSection.renderWindow }))
        }
        // One section ⇒ no label to disambiguate against.
        if out.count == 1 {
            out = [Withheld(id: out[0].id, label: nil, section: out[0].section,
                            widen: out[0].widen)]
        }
        return out
    }

    /// The drawer's whole status surface: what is loading, what failed, what is being
    /// withheld, and every control that acts on those. Absent when there is nothing to
    /// say, so an ordinary complete row still opens onto plain text.
    @ViewBuilder
    private var statusBar: some View {
        let withheld = withheldSections
        if loading || fetchOutcome != nil || !withheld.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if loading { fetchNote("Loading the rest…", icon: "arrow.down.circle") }
                if let outcome = fetchOutcome { failureRow(outcome) }
                ForEach(withheld) { row in
                    TimelineActivityWithheldRow(label: row.label, section: row.section,
                                                widen: row.widen)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            .accessibilityIdentifier("activity.statusBar")
        }
    }

    /// A fetch that did not land. NO CAUSE IS EVER NAMED — the reader cannot act on a
    /// status code, and 404 in particular means "this box predates the route", which
    /// would announce "the text is gone" on nearly every drawer.
    ///
    /// What IS said is what the app knows for certain: the row carries a ref, so the
    /// excerpt on screen is not the whole text, and it may stop mid-word. Saying
    /// nothing left the reader at "Step 005 of …" with no statement and no way on
    /// (2026-09-12 gate). A retry appears only where retrying can change the answer —
    /// the same rule as `Show more`: a control that cannot do anything is worse than
    /// no control.
    private func failureRow(_ outcome: TimelineActivityFullText.Failure) -> some View {
        TimelineActivityBarRow(stacked: TimelineChipLayout.stacksDetail(typeSize)) {
            Label(Self.explains(outcome) ? Self.goneText : Self.excerptOnly,
                  systemImage: Self.explains(outcome)
                    ? "clock.arrow.circlepath" : "text.append")
                .font(.caption)
                .foregroundStyle(ReadableText.secondary)
        } control: {
            if Self.shouldRetry(outcome) {
                TimelineActivityButton("Try again", identifier: "activity.retry",
                                       action: { Task { await retry() } })
            }
        }
        .accessibilityIdentifier("activity.fetchNote")
    }



    private func fetchNote(_ text: String, icon: String) -> some View {
        Label(text, systemImage: icon)
            .font(.caption)
            .foregroundStyle(ReadableText.secondary)
            .accessibilityIdentifier("activity.fetchNote")
    }

    // MARK: - Loading

    /// Paint what the row carried, then ask for the rest exactly once.
    ///
    /// EVERY FAILED FETCH IS STATED; WHAT DIFFERS IS THE WORDS AND THE BUTTON. A silent
    /// dead end is a defect on its own (2026-09-12 gate: the reader was left at "Step
    /// 005 of …" with a clipped excerpt, no statement, and no way on), so the excerpt
    /// stays on screen and the status bar carries a line beside it:
    ///
    ///  - 410 `detail_gone` — the ref parsed and the row is genuinely unreachable
    ///    (rewound, compacted, slid out of the window). The one outcome worded as
    ///    itself (`goneText`), because the server states it unambiguously and no retry
    ///    can change it. It is why 410 and 404 had to stop sharing a status code.
    ///  - 404 — this box predates the route. Says `excerptOnly` and offers NO retry:
    ///    the route is not there and asking again cannot make it appear. Deliberately
    ///    NOT worded as "the text is gone", which is what a shared status code forced
    ///    and what would have announced a missing row on nearly every drawer.
    ///  - 400 — a malformed ref, i.e. a bug on one side. Same `excerptOnly` line, no
    ///    retry: the reader cannot act on it and the next attempt is rejected too.
    ///  - 503 / transport — the box could not read the source in time. `excerptOnly`
    ///    plus `Try again`, the only outcome where pressing it can change the answer.
    ///
    /// So the words never name a status code (the reader cannot act on one) and the
    /// button appears exactly where retrying is not a lie — `explains` and
    /// `shouldRetry` are those two questions, asked per outcome.
    ///
    /// A row with NO `detailRef` is not a failure and reaches none of this: the excerpt
    /// IS the whole text, which is also what an older PRIMARY reports.
    private func load() async {
        reseedIfRowChanged()
        guard let ref = detail.detailRef, resolvedID != detail.id else { return }
        loading = true
        fetchOutcome = nil
        defer { loading = false }
        do {
            apply(try await TimelineActivityFullText.fetch(ref: ref))
        } catch let error as TimelineActivityFullText.Failure {
            // ONE retry, and only for the outcome retrying can fix.
            guard Self.shouldRetry(error) else { return note(error) }
            do {
                apply(try await TimelineActivityFullText.fetch(ref: ref))
            } catch let retried as TimelineActivityFullText.Failure {
                note(retried)
            } catch {
                // Transport, second time. Excerpt only.
            }
        } catch {
            // Excerpt only. Deliberately no state to render.
        }
    }

    private func note(_ failure: TimelineActivityFullText.Failure) {
        fetchOutcome = failure
    }

    /// The reader asked again. Same one-shot path as the first attempt, so a retry that
    /// fails leaves exactly the state a first failure would.
    private func retry() async {
        resolvedID = nil
        await load()
    }

    /// Is this outcome worth one more attempt? Only the unreachable one: a 400 is a
    /// bug on one side, and neither 410 nor 404 can answer differently next time.
    static func shouldRetry(_ failure: TimelineActivityFullText.Failure) -> Bool {
        failure == .unavailable
    }

    /// Does this outcome earn words? Only the typed-gone one (see `load`).
    static func explains(_ failure: TimelineActivityFullText.Failure) -> Bool {
        failure == .gone
    }

    /// The excerpt a row already holds. Pure, and static, so `init` can use it as the
    /// state's initial value — the sheet's first frame already has the text.
    static func seed(for detail: TimelineActivityDetail)
        -> (reasoning: TimelineDrawerSection, input: TimelineDrawerSection,
            result: TimelineDrawerSection) {
        switch detail.kind {
        case .thinking:
            return (TimelineDrawerSection(
                        detail.body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""),
                    TimelineDrawerSection(), TimelineDrawerSection())
        case .tool:
            return (TimelineDrawerSection(),
                    TimelineDrawerSection(detail.input ?? ""),
                    TimelineDrawerSection(detail.body ?? ""))
        }
    }

    /// Put the excerpt back when the sheet is handed a DIFFERENT row without being
    /// re-created (see `resolvedID`). A no-op on the row we already hold in full.
    private func reseedIfRowChanged() {
        guard resolvedID != detail.id else { return }
        let seed = Self.seed(for: detail)
        reasoning = seed.reasoning
        input = seed.input
        result = seed.result
    }

    /// Replace the excerpts with what the server sent. `nil` (the retry failed too)
    /// changes NOTHING — the excerpt is never traded for an empty section.
    private func apply(_ fetched: TimelineActivityFullText.Detail?) {
        guard let fetched else { return }
        fetchOutcome = nil
        if let section = fetched.reasoning { reasoning = Self.drawerSection(section) }
        if let section = fetched.input { input = Self.drawerSection(section) }
        if let section = fetched.result { result = Self.drawerSection(section) }
        resolvedID = detail.id
    }

    /// Is there a button? ONLY when widening the local render window can reveal text
    /// this drawer already holds.
    ///
    /// A section can be withheld and still have nothing to press: the server says its
    /// source is 24,291 characters, it sent 19, and it sent NO cursor because the
    /// remainder is unreachable. The footer states both numbers; offering "Show more"
    /// there would be a control that cannot do anything, and pressing it twice would
    /// look like the app losing text.
    static func offersShowMore(_ section: TimelineDrawerSection) -> Bool {
        section.chars > section.window
    }

    /// `cut` is DERIVED, and from THREE things that cannot false-positive.
    ///
    /// A cursor means "there is more AND you can fetch it". The server can also send
    /// less than the row holds with NO cursor — the remainder is genuinely unreachable
    /// (the row slid out of a huge transcript's read window, or its host is offline) —
    /// and it reports the true source length either way. Reading withheld-ness off the
    /// cursor alone made that case silent: the footer said nothing while the server had
    /// just said M > N, which is the one thing this drawer is not allowed to do.
    ///
    /// So all three signals are ORed, and each is only ever true when there really is
    /// more text — none of them can invent a withheld remainder:
    ///
    ///  - the section's own `<name>Truncated` flag. The authority, and the ONLY one
    ///    that sees a clipped `input` whose reported total is a lower bound equal to
    ///    the text it came with (arithmetic is blind to that one).
    ///  - a cursor, which is given only when asking again would advance.
    ///  - `<name>Chars` exceeding what we hold, which is what a PRIMARY that has not
    ///    shipped the flags still answers with. Version skew is a PRIMARY question
    ///    only: the cloud replica relays the primary's response body verbatim, so it
    ///    cannot strip a field it has never heard of, however old the replica is.
    ///    COMPARED IN UTF-16 CODE UNITS, which is what the server counted: against
    ///    `String.count` (graphemes) this test reported a whole section as clipped
    ///    for any text carrying emoji or CRLF — see `TimelineDrawerSection`.
    ///
    /// The payload-wide `truncated` is NOT one of them, deliberately: it is the OR of
    /// all three sections, so applying it to a section would make a complete input
    /// claim it was elided next to a cut result.
    static func drawerSection(_ s: TimelineActivityFullText.Section) -> TimelineDrawerSection {
        let holdsLess = (s.totalChars ?? 0) > s.text.utf16.count
        return TimelineDrawerSection(s.text, serverChars: s.totalChars,
                                     cut: s.truncated || s.nextOffset != nil || holdsLess)
    }

    // MARK: - Copy

    /// Empty reasoning still gets an honest sentence rather than a blank sheet —
    /// a tap that opens onto nothing reads as a bug.
    static let noReasoning = "No reasoning recorded for this step."

    /// The ONE failure sentence in the drawer. It says what happened and what the
    /// reader is looking at instead, and it never suggests an action — there is
    /// nothing the reader can do about a compacted transcript.
    static let goneText = "The server no longer keeps the full text of this step — "
        + "this is the excerpt it saved."

    /// What the app knows when a fetch did not land: the row carries a ref, so what is
    /// on screen is a prefix and it may stop mid-word. Deliberately says nothing about
    /// WHY — a status code is not something the reader can act on, and the retry button
    /// beside it (when retrying can help) is the actionable half.
    static let excerptOnly = "Excerpt only — the rest of this step could not be loaded."

    /// Both numbers are UTF-16 code units, the units the server counts in (see
    /// `TimelineDrawerSection`) — so `shown` is `section.shownChars`, never a
    /// grapheme count and never the raw window.
    static func withheldText(shown: Int, total: Int) -> String {
        total > shown
            ? "Showing the first \(shown.formatted()) of \(total.formatted()) characters."
            : "Showing \(shown.formatted()) characters."
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
