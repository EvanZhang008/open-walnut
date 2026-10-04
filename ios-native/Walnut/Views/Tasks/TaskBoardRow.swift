import SwiftUI

/// The board's CARD LANGUAGE: the two surfaces every band is made of, in one place.
///
/// # Why the board went back to cards (R29)
///
/// V1 was one edge-to-edge sheet of `systemBackground` with no boxes at all, and it was
/// built to answer a complaint about the boxes ("那个框是方形的,根本就不 elegant").
/// The user then pointed at the app's OTHER task surface — the inset-grouped page with
/// rounded white sections on grouped grey (`TasksView`'s non-board filters: the quick-add
/// capsule, `Active Sessions`, `Pinned`) — and said they prefer THAT style. The box was
/// never the problem; a SQUARE box was. A rounded inset-grouped card on a grouped
/// background is the platform's own answer and the one the rest of this app already
/// speaks, so the board now speaks it too.
///
/// # Two colours, and the delta between them is the whole point
///
/// A card only reads as a card because it steps AWAY from the page behind it. That step
/// is what V1's own chips bar got wrong in the other direction and it is worth stating as
/// a number: with the board's page at `systemBackground` (253.0 grey) the bar's card
/// measured 247.6 — a 5.4 delta, i.e. nothing. The pairing here is the platform's:
/// `systemGroupedBackground` behind, `secondarySystemGroupedBackground` on top, which is
/// +11.3 in light mode and +28.7 in dark, measured off the reference screen in both
/// schemes. Both values are dynamic `UIColor`s so a scheme change repaints without
/// anything re-deriving, and so a test can resolve the PAIR and assert the delta rather
/// than trusting a comment (`BoardBandCardSurfaceTests`).
///
/// Nothing here is a copy of the platform's numbers that could drift: the rows do not
/// paint `surface` at all (they return `nil` and let the inset-grouped section paint its
/// own card, corner radius included, which is how the board's cards are the same object
/// as the reference page's by construction). `surfaceColor` exists for the three places
/// that need the card's colour as a VALUE: the composite under a just-created row, the
/// chips bar's hand-rolled card, and the tick punched out of a done ring.
enum BoardBandCard {

    /// The card's own paper — what an inset-grouped section fills its rows with.
    static let surfaceColor: UIColor = .secondarySystemGroupedBackground

    /// `surfaceColor` as a SwiftUI colour.
    static let surface = Color(surfaceColor)

    /// The page BEHIND the cards. The board's backdrop, and the colour its opaque
    /// navigation bar has to match or a seam appears 44pt down the screen.
    static let pageColor: UIColor = .systemGroupedBackground

    /// `pageColor` as a SwiftUI colour.
    static let page = Color(pageColor)

    /// The corner radius the hand-rolled cards use so they match the platform's.
    ///
    /// The board's BAND cards do not read this: they are real inset-grouped sections and
    /// the OS rounds them, which is the only way to stay right across OS versions. The
    /// chips bar draws its own card (it has to: it is also a floating overlay copy), so it
    /// needs the number as a NUMBER, and that is the whole risk in it: the OS's corner is
    /// measured, not published, so this constant can only be as right as the last
    /// measurement — and R29 shipped it wrong.
    ///
    /// # How it is measured (do this again, do not re-derive it in your head)
    ///
    /// Screenshot the board at the top, then walk the card's top-left corner: at a depth
    /// `dy` below the card's top edge, find the x where the page/card luminance crosses
    /// halfway, as an INSET from the card's leading edge (`dx`). One corner is one
    /// `(dy, dx)` curve, and the summary number is the circular radius that fits it,
    /// `R = dx + dy + sqrt(2·dx·dy)`.
    ///
    /// R29 said 20 from a reading of the reference screen and the pixels disagreed by a
    /// third: the bar measured `dx=10.96` at `dy=2` (R≈19.6) against the OS section card's
    /// `dx=15.90` (R≈25.9) on the same screenshot, i.e. a visibly tighter corner on the one
    /// card in the stack that is not an OS card. 26 is the value whose profile lands on the
    /// section card's: measured after the change, bar `dx=16.12` (R≈26.2) against the
    /// quick-add card's `dx=15.87` (R≈25.8) and the band card's `dx=15.90` (R≈25.9) on one
    /// screenshot — 0.22-0.25pt apart at `dy=2`, and never more than 0.5pt apart anywhere
    /// down the curve.
    ///
    /// # The HEIGHT is half of this number, which is why it moved too
    ///
    /// A rounded rectangle cannot round deeper than half its height, so this constant only
    /// draws in full on a card at least `2 * cornerRadius` tall. That is not a footnote: at
    /// the bar's old 44pt height the platform clamped 26 to 22 and the corner measured
    /// `dx=12.54` — closer than 20 was, still 3.4pt tighter than the OS cards. So
    /// `TasksChromeMetrics.bandBar` went to 52, which is what the reference screen's own
    /// short card measures and what makes the clamp inapplicable. A hand-rolled card that
    /// wants an OS card's corner has to have the height to hold it.
    ///
    /// iOS 18 keeps 10, which is that OS's own inset-grouped radius. The point of the
    /// number is never the number; it is that the bar and the cards around it round the
    /// same way on whichever OS is running.
    static var cornerRadius: CGFloat {
        if #available(iOS 26.0, *) { return 26 }
        return 10
    }

    /// ONE translucent ink flattened onto ONE opaque paper, for a resolved trait
    /// collection — the board's answer to "a material is a value that depends on what is
    /// behind it".
    ///
    /// This is the shared half of a defect class this surface has now shipped three times:
    /// a translucent style (`.bar` material on the chips bar, `.quaternary` on a chip
    /// capsule, a translucent red row tint) renders DIFFERENT pixels in the two copies of
    /// the bar or in the two schemes, because the backdrop differs. Flattening the blend
    /// HERE, per scheme, produces an opaque colour that cannot depend on anything: same
    /// value inline and pinned, and a test can resolve it and assert the number.
    ///
    /// `traits` rather than a `dark: Bool`, because both inputs are usually dynamic colours
    /// and asking an UNRESOLVED dynamic colour for its channels is how a "colour" turns
    /// into a pattern-fill failure at runtime.
    static func flatten(_ ink: UIColor, over paper: UIColor, traits: UITraitCollection) -> UIColor {
        let base = paper.resolvedColor(with: traits)
        let top = ink.resolvedColor(with: traits)
        guard let i = channels(top), let p = channels(base) else { return base }
        return UIColor(
            red: i.r * i.a + p.r * (1 - i.a),
            green: i.g * i.a + p.g * (1 - i.a),
            blue: i.b * i.a + p.b * (1 - i.a),
            alpha: 1
        )
    }

    /// RGBA of a RESOLVED colour, or nil if it isn't an RGB colour at all (a pattern
    /// image). A tuple rather than four `inout` locals at the call site, so every channel
    /// that is written is also read — the "written to but never read" shape is how an
    /// alpha gets dropped from a blend without anyone noticing.
    static func channels(
        _ color: UIColor
    ) -> (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat)? {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
        return (r, g, b, a)
    }

    /// Where a band HEADING's text starts, measured from the card's leading edge.
    ///
    /// The heading is drawn full-bleed (its background has to be able to hide a card
    /// sliding under it while it is pinned), so it cannot inherit the section's own header
    /// margin and has to restate it. 20pt is the platform's row content inset and the
    /// reference screen's own heading offset (measured: card edge 20.1pt, `Active
    /// Sessions` 40.8pt on a 440pt-wide screen), which is what lines a band label up with
    /// the ring column of the rows below it.
    static let headingContentInset: CGFloat = 20
}

/// The board row's SURFACE — the paper a row is drawn on. An ordinary row paints
/// nothing (the section's card shows through); the one exception is the just-created
/// flash that answers "where did it land?".
///
/// # The red wash is gone (2026-10-04)
///
/// A row waiting on a human used to paint its whole card cell red (0.16 over light paper,
/// 0.30 over dark), after a 3pt capsule and an 0.08 desktop wash had both been rejected.
/// The user retired the wash too ("no red highlight"): the web's hollow red dot in
/// the leading gutter (`TaskBoardRow.gutterMark`) says the same thing without making the
/// list look alarmed. So a row's paper no longer says anything about its task's state.
///
/// # Inside a card (R29), the tint has to be OPAQUE
///
/// The row IS a card cell, and a translucent background REPLACES the card instead of
/// sitting on it — a translucent green over grouped grey is a grey-green row in a white
/// card, which reads as a rendering fault. So the tint is composited HERE, over
/// `BoardBandCard.surfaceColor`, and the row paints the opaque result. The card's own
/// rounded mask still clips it, which keeps the flash from bleeding past the band's
/// first/last corner.
enum BoardRowSurface {

    /// Alpha of the just-created flash, per colour scheme. The dark value is roughly
    /// double because the same alpha over a near-black card lands at a near-black green:
    /// the number that has to stay constant is the PERCEIVED colour, not the alpha.
    static let justCreatedAlpha: (light: CGFloat, dark: CGFloat) = (0.14, 0.26)

    /// The tint one row paints OVER its card, or nil for an ordinary row (which paints
    /// nothing of its own and takes the section's card untouched).
    static func tint(isNew: Bool, dark: Bool) -> UIColor? {
        guard isNew else { return nil }
        return UIColor.systemGreen.withAlphaComponent(
            dark ? justCreatedAlpha.dark : justCreatedAlpha.light)
    }

    /// `tint` composited over the card, as the OPAQUE colour a flashed row's cell takes —
    /// and `nil` for an ordinary row.
    ///
    /// `nil` is load-bearing: `listRowBackground(nil)` leaves the inset-grouped section to
    /// paint its OWN card, so an ordinary board row is the same object as a row on the
    /// reference page (same colour, same corner radius, same behaviour when the OS changes
    /// any of them). Returning `BoardBandCard.surface` instead would be a second copy of
    /// the platform's colour, free to drift from the card next to it.
    ///
    /// A DYNAMIC `UIColor` and not two SwiftUI branches, for the reason
    /// `BoardBandBar.cardSurface` is one: the value has to answer for both schemes at
    /// once so a test can resolve it per scheme, and so a scheme change repaints without
    /// anything having to re-derive.
    static func color(isNew: Bool) -> Color? {
        guard tint(isNew: isNew, dark: false) != nil else { return nil }
        return Color(UIColor { traits in opaqueSurface(isNew: isNew, traits: traits) })
    }

    /// The flashed row's paper for ONE trait collection: the tint flattened onto the card.
    ///
    /// Resolved through `traits` rather than through the `dark` flag alone, because both
    /// halves are dynamic colours (`systemGreen`, `secondarySystemGroupedBackground`) and
    /// asking an unresolved dynamic colour for its channels is how a "colour" turns into a
    /// pattern-fill failure at runtime.
    static func opaqueSurface(isNew: Bool, traits: UITraitCollection) -> UIColor {
        let card = BoardBandCard.surfaceColor.resolvedColor(with: traits)
        guard let tinted = tint(isNew: isNew, dark: traits.userInterfaceStyle == .dark)
        else { return card }
        // ONE blend, shared with the chips bar's capsule fill (`BoardBandCard.flatten`):
        // two copies of an alpha composite is how one of them loses the alpha.
        return BoardBandCard.flatten(tinted, over: card, traits: traits)
    }
}

/// One board row. A row, and nothing else: a dot in the leading gutter (unread, or
/// waiting on you), the done ring, the title, and the project in grey when the band
/// heading does not already say it.
///
/// TAP GOES STRAIGHT INTO THE SESSION. There is no expansion. The first version
/// of this row grew an inline panel on tap (session header, host/model/count
/// capsules, a wrapping tier picker, an Open button, a Details button) and it was
/// rejected on sight: a tap that yields a menu of six choices is a tap that made
/// the user do the routing. One tap, one destination.
///
/// Everything the panel held is still reachable, through the gestures iOS
/// already spends on rows: swipe for done and pin, long-press for the task's own
/// settings (tier, details). Those cost no row height and no scanning attention,
/// which is why a Reminders row can afford them and an inline panel cannot.
///
/// # What the row no longer says (2026-10-04)
///
/// The second line used to read "running · 2h · Project", the state word coloured, with
/// a coloured dot on the right edge and the whole row washed red when the task wanted a
/// human. The user called it confusing (the word said "handed back" while the open
/// conversation said "Running") and asked for the web's language instead: a filled red
/// dot for unread, a hollow red dot for read-but-waiting-on-you, no state word, no age,
/// no red row. `BoardModel.dot` is that rule; this view only draws it.
struct TaskBoardRow: View {
    let row: BoardRow
    /// False under a heading that already names the project ("By project"), where the
    /// grey line would repeat it on every row. The line is then absent, not empty.
    var showsProject = true
    /// True while this row's tap is asking the server where to go — its session by id,
    /// or which sessions its task has (`BoardModel.tapRoute`).
    ///
    /// It takes the leading gutter's place with a spinner, which is the whole design:
    /// the feedback belongs on the row that was tapped, in the slot the row already
    /// spends on its mark, so a lookup is visible without the list moving. A modal or a
    /// toast would be a bigger interruption than the wait.
    var isResolving = false
    // NO `isNew`. The just-created flash is the row's BACKGROUND, which only
    // `listRowBackground` can reach, so the decision lives where the paint does
    // (`TaskBoardList` → `BoardRowSurface`). A stored property this view does not read
    // would be exactly the dead arithmetic that lets a treatment silently stop applying.

    let onToggleDone: () -> Void
    /// The row's tap: open the session, or start one when the task has none.
    let onOpenSession: () -> Void

    // MARK: - The leading column's arithmetic
    //
    // Five numbers that only make sense together, so they are stated together and the
    // one thing anybody downstream reads (`separatorLeadingInset`) is DERIVED from them
    // rather than restated. The ring's hit area and its layout width are deliberately
    // DIFFERENT numbers, which is the part a single literal could not express.

    /// The glyph's own box: 21pt circle centred in it, and this is the geometry that
    /// decides where the ring is DRAWN. Unchanged since the row shipped.
    static let ringGlyphSize = CGSize(width: 34, height: 30)

    /// Width of the ring's TAP AREA, which is not its drawn size.
    ///
    /// It was the glyph box, 34x30 — under the platform's 44pt minimum in both axes, and
    /// top-aligned, so on a two-line row the lower half of the ring's own column hit
    /// nothing at all. That matters more here than on an ordinary control because the
    /// ring's neighbour is not empty space: everything to its right opens the session, so
    /// a thumb that misses the ring does not do nothing, it goes somewhere else.
    static let ringTargetWidth: CGFloat = 44

    /// Negative leading padding that puts the CIRCLE flush with the row's leading edge
    /// (the glyph box is wider than the glyph).
    static let ringLeadingBleed: CGFloat = 6

    /// How much of the widened hit box is given back to the layout, so growing the target
    /// moves nothing: the title, the hairline and the band headings all stay where they
    /// were. The 11pt HStack gap absorbs it, and giving back 10 rather than 11 leaves a
    /// 1pt strip so the two tap targets never actually touch.
    static let ringTrailingBleed: CGFloat = 10

    /// Horizontal space the ring occupies in the row's layout: 28pt, exactly what the
    /// 34pt glyph box with `-6` leading padding occupied before the target grew.
    static var ringLayoutWidth: CGFloat {
        ringTargetWidth - ringLeadingBleed - ringTrailingBleed
    }

    /// The HStack's gap between the ring column and the text column.
    static let rowSpacing: CGFloat = 11

    /// Where the V1 hairline starts: at the TITLE, so the done-ring's gutter stays
    /// clear (mockup V1: `.row + .row::before { left: 48px }` against a 16px page
    /// margin, i.e. 32pt into the row's own content).
    ///
    /// COMPUTED, not written down: it used to be the literal 39 with a comment
    /// explaining that it was 28 + 11, which is a rule that holds only as long as
    /// someone re-does the arithmetic by hand after touching either number. Widening
    /// the ring's hit area was exactly that kind of change.
    static var separatorLeadingInset: CGFloat { ringLayoutWidth + rowSpacing }

    var body: some View {
        HStack(alignment: .top, spacing: Self.rowSpacing) {
            ring
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.body)
                    .foregroundStyle(row.isDone ? .secondary : .primary)
                    .strikethrough(row.isDone, color: .secondary)
                    // Two lines while scanning. The row never expands now, so
                    // this clamp is permanent — a title long enough to need a
                    // third line is a title to read on the task's own page.
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if showsProject { projectLine }
            }
            // Spans to the trailing edge so the whole width right of the ring opens
            // the session, not just the glyph-width of the text.
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpenSession)
            // NOTE the shape here: the ring is a SIBLING of this tap target, not
            // inside it, and the target is `children: .combine`.
            //
            // Both halves are load-bearing and were found by driving the real UI.
            // An identifier on the enclosing HStack propagates to every
            // descendant, so the hierarchy carried THREE elements called
            // `board.row.<id>` (ring, title, second line) and none called
            // `board.ring.<id>` — the container id had overwritten the ring's
            // own. Automation taps the first match, which was the ring's 34x30
            // box, so "tap the row" toggled the task DONE. `.combine` collapses
            // the text column into ONE element that owns the id, and keeping the
            // ring outside it leaves the ring addressable.
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("board.row.\(row.id)")
            .accessibilityLabel(row.title)
            // The dot is drawn, never read, so its meaning rides on the row itself.
            .accessibilityValue(dot?.accessibilityValue ?? "")
            // The hint follows where the tap GOES, which is not "does the list have a
            // session for this task": a task whose session is known only by id opens
            // that session, and a task nobody has asked about yet opens whichever of the
            // two the probe finds. `BoardModel.affordance` is the same rule the context
            // menu's label reads, so the two can never describe different destinations —
            // and neither of them may promise a NEW session on a row that has one.
            .accessibilityHint(BoardModel.affordance(row).accessibilityHint)
            .accessibilityAddTraits(.isButton)
        }
        // The mark lives in the card's own leading inset, LEFT of the ring, where the
        // web puts its dot. An overlay rather than a column, so the ring, the title and
        // the hairline sit on the same pixels with or without a mark.
        //
        // The old capsule overlapped the ring because both claimed the row's first three
        // points; this one is placed entirely at negative x, in the ~20pt the cell keeps
        // between the card edge and the row's content, so there is nothing to share.
        .overlay(alignment: .topLeading) { gutterMark }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }

    // MARK: - The leading gutter: the web's dots

    /// The row's one mark (`BoardModel.dot`, the web's pinned-card rule).
    private var dot: BoardRowDot? { BoardModel.dot(row.task) }

    /// Side of the gutter's slot. The dot is smaller than the slot; the resolving
    /// spinner fills it.
    static let gutterSlot: CGFloat = 12

    /// The dot's diameter: the web's 7px, one point up for the phone's density.
    static let dotSize: CGFloat = 8

    /// Where the gutter's CENTRE sits, measured from the row content's leading edge
    /// (which is where the ring's circle starts).
    ///
    /// Measured on the pinned iPhone 16 Pro, the cell keeps 16pt between the card edge
    /// and the content, so -8 centres the dot between the two. -10 (half of the 20pt a
    /// Pro Max keeps) put it 6pt from the card's edge and 10pt from the ring, where it
    /// read as belonging to the card rather than to the row. On a wider phone the inset
    /// grows and the dot stays 4pt from its ring, which is the side it belongs to.
    static let gutterCenterX: CGFloat = -8

    @ViewBuilder
    private var gutterMark: some View {
        Group {
            if isResolving {
                // `.small` + a scale, rather than `.mini`: `.mini` is a macOS-shaped size
                // and the platform's smallest spinner here is still ~16pt.
                ProgressView()
                    .controlSize(.small)
                    .scaleEffect(0.6)
                    .accessibilityIdentifier("board.resolving.\(row.id)")
                    .accessibilityLabel("Opening the session")
            } else if let dot {
                Circle()
                    .strokeBorder(Theme.danger, lineWidth: 1.5)
                    .background {
                        if dot == .unread { Circle().fill(Theme.danger) }
                    }
                    .frame(width: Self.dotSize, height: Self.dotSize)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: Self.gutterSlot, height: Self.gutterSlot)
        // Centred on the ring's circle, which is centred in its glyph box.
        .offset(
            x: Self.gutterCenterX - Self.gutterSlot / 2,
            y: (Self.ringGlyphSize.height - Self.gutterSlot) / 2
        )
        .allowsHitTesting(false)
    }

    // MARK: - Row parts

    /// One glyph: an open ring, or a filled ring with a tick when done. It is the
    /// done TOGGLE (Reminders muscle memory) — the row's tap belongs to the
    /// session, so the ring needs its own hit shape.
    private var ring: some View {
        Button(action: onToggleDone) {
            ZStack {
                Circle()
                    .strokeBorder(row.isDone ? Color.secondary : Color(.systemGray3), lineWidth: 1.6)
                    .background(row.isDone ? Circle().fill(Color.secondary) : Circle().fill(Color.clear))
                    .frame(width: 21, height: 21)
                if row.isDone {
                    Image(systemName: "checkmark")
                        // The tick is PUNCHED OUT of the ring, so its colour is the paper
                        // behind the row — which is the card now, not the window's
                        // background. In dark mode those are different colours (28,28,30
                        // against black), so a tick left on `systemBackground` would read
                        // as a hole through the card instead of as a hole in the ring.
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(BoardBandCard.surface)
                }
            }
            .frame(width: Self.ringGlyphSize.width, height: Self.ringGlyphSize.height)
            // The TARGET, which is not the glyph box: 44pt wide (the platform minimum)
            // and the full height of the row, with the glyph still pinned top-leading so
            // nothing moves on screen. `maxHeight` rather than a fixed 44 on purpose —
            // a fixed height would set a floor the SHORT rows do not have today, and
            // filling the row is both taller and honest about what the column is.
            .frame(width: Self.ringTargetWidth, alignment: .leading)
            .frame(maxHeight: .infinity, alignment: .top)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The glyph box is wider than the 21pt circle, so this pulls the column back
        // until the CIRCLE lands flush with the row's leading edge. It was the reason
        // the old accent capsule overlapped the ring; with the mark moved to the row's
        // background there is nothing in this space to share it with.
        .padding(.leading, -Self.ringLeadingBleed)
        // …and this gives the widened target's extra width back to the LAYOUT, so the
        // bigger tap area costs no pixels: the title's leading edge and the hairline are
        // where they were (`separatorLeadingInset` is derived from these two numbers).
        .padding(.trailing, -Self.ringTrailingBleed)
        .accessibilityIdentifier("board.ring.\(row.id)")
        .accessibilityLabel(row.isDone ? "Reopen" : "Mark done")
    }

    /// ONE grey line: the project ("Inbox" for a task in none). Never a second
    /// sentence, and no longer a state word or an age (see the type's doc): the point
    /// of the row is that it is a row. At accessibility sizes it truncates rather than
    /// wraps, because the title is the line worth the height.
    private var projectLine: some View {
        Text(row.project.isEmpty ? NewTaskSeed.inboxHeader : row.project)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
    }
}
