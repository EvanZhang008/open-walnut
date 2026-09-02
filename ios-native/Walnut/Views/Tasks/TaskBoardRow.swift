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
/// that need the card's colour as a VALUE: the composite under a needs-a-human row, the
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

/// The board row's SURFACE — the paper a row is drawn on, and where "this task wants
/// a human" is now said.
///
/// # Why the whole row is red, and not a 3pt bar
///
/// The mark used to be a saturated 3pt capsule at the row's leading edge. It went
/// through two rounds of the same complaint and lost both: the capsule and the done
/// ring wanted the row's first three points ("怎么能重叠呢"), and the answer to that was
/// not a wider gutter but the treatment that was actually asked for — "那个红色…不要变
/// 成一个竖道了,把它变成一整个底都变成红色的吧". The mark IS the paper now, so there is
/// no column left to collide with the ring: nothing overlaps by construction, because
/// nothing is placed.
///
/// # This is the SECOND attempt at a wash, and the difference is the strength
///
/// The first was `rgba(255,59,48,0.08)`, ported verbatim from the desktop's
/// `.todo-panel-item-needs-action`. At that alpha it read as a pink smudge on 8 of 11
/// visible rows — loud enough to make the LIST look broken, too weak to read as a
/// decision about one row. So the tint here is deliberately stronger and it is stated
/// PER SCHEME rather than as one alpha for both: 0.16 over light paper, 0.30 over dark,
/// which is what keeps "clearly red at a glance" true in a mode where the same alpha
/// over black would be nearly invisible.
///
/// It sits UNDER the row's ordinary ink (it is the row's background, not a foreground
/// overlay), so the ring and the title keep their normal colours and their contrast.
/// Both halves are pinned by `BoardRowNeedsActionSurfaceTests`: the red channel has to
/// dominate the composite by a real margin in each scheme, and the title has to clear
/// WCAG 4.5:1 against it.
///
/// Nothing here scales with Dynamic Type, which is how "holds at default type and at
/// accessibility-XXXL" is a property of the code rather than a re-measurement: a
/// background has no metrics, and the row grows VERTICALLY at large sizes because the
/// title is what scales.
///
/// # Inside a card (R29), the tint has to be OPAQUE
///
/// While the board was one flat sheet, a translucent red was the right thing to hand
/// `listRowBackground`: whatever showed through was the sheet. Now the row IS a card cell,
/// and a translucent background REPLACES the card instead of sitting on it — 0.16 red over
/// grouped grey is a grey-pink row in a white card, which reads as a rendering fault. So
/// the tint is composited HERE, over `BoardBandCard.surfaceColor`, and the row paints the
/// opaque result. The card's own rounded mask still clips it, which is what keeps red from
/// bleeding past the band's first/last corner.
///
/// The composite is also what the contrast tests now measure, and that is the point of
/// doing it in the app rather than in the test: the number under WCAG assertion is the
/// number the screen paints, not a re-derivation of it that can agree with a bug.
enum BoardRowSurface {

    /// Alpha of the needs-a-human tint, per colour scheme.
    ///
    /// Light is over the card's white, dark is over the card's near-black. The dark value
    /// is roughly double because the same alpha of red over a near-black card lands at a
    /// near-black brown: the number that has to stay constant is the PERCEIVED redness,
    /// not the alpha.
    static let needsActionAlpha: (light: CGFloat, dark: CGFloat) = (0.16, 0.30)

    /// Alpha of the just-created flash, same reasoning, one step quieter — it answers
    /// "where did it land?" and then goes away, so it must not out-shout a row that is
    /// actually asking for something.
    static let justCreatedAlpha: (light: CGFloat, dark: CGFloat) = (0.14, 0.26)

    /// The tint one row paints OVER its card, or nil for an ordinary row (which paints
    /// nothing of its own and takes the section's card untouched).
    ///
    /// ONE tint, never two: red for a row that wants a human, green for a just-created
    /// row. Red wins, because a task handed back matters more than a task that was just
    /// made, and two tints on one row would be two claims about the same pixels.
    static func tint(needsAction: Bool, isNew: Bool, dark: Bool) -> UIColor? {
        if needsAction {
            return UIColor.systemRed.withAlphaComponent(
                dark ? needsActionAlpha.dark : needsActionAlpha.light)
        }
        if isNew {
            return UIColor.systemGreen.withAlphaComponent(
                dark ? justCreatedAlpha.dark : justCreatedAlpha.light)
        }
        return nil
    }

    /// `tint` composited over the card, as the OPAQUE colour a marked row's cell takes —
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
    static func color(needsAction: Bool, isNew: Bool) -> Color? {
        guard tint(needsAction: needsAction, isNew: isNew, dark: false) != nil else {
            return nil
        }
        return Color(UIColor { traits in
            opaqueSurface(needsAction: needsAction, isNew: isNew, traits: traits)
        })
    }

    /// The marked row's paper for ONE trait collection: the tint flattened onto the card.
    ///
    /// Resolved through `traits` rather than through the `dark` flag alone, because both
    /// halves are dynamic colours (`systemRed`, `secondarySystemGroupedBackground`) and
    /// asking an unresolved dynamic colour for its channels is how a "colour" turns into a
    /// pattern-fill failure at runtime.
    static func opaqueSurface(
        needsAction: Bool, isNew: Bool, traits: UITraitCollection
    ) -> UIColor {
        let card = BoardBandCard.surfaceColor.resolvedColor(with: traits)
        guard let tinted = tint(
            needsAction: needsAction, isNew: isNew,
            dark: traits.userInterfaceStyle == .dark
        ) else { return card }
        // ONE blend, shared with the chips bar's capsule fill (`BoardBandCard.flatten`):
        // two copies of an alpha composite is how one of them loses the alpha.
        return BoardBandCard.flatten(tinted, over: card, traits: traits)
    }
}

/// One board row. A row, and nothing else: leading ring, title, ONE grey second
/// line, a state dot on the right edge.
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
/// A row whose task is waiting on a human paints its WHOLE BACKGROUND red — the
/// desktop's rule for WHEN (`taskNeedsAction`: phase AGENT_COMPLETE and not done,
/// ported as `BoardModel.needsHuman`), the user's answer for HOW. Inside the R29 cards
/// that means the row's own CARD CELL is tinted (and clipped by the card's corners, so
/// red never bleeds outside the rounded shape), not a red stripe drawn over the page. The
/// surface and the three rounds of history behind it are on `BoardRowSurface`; what this
/// file owns is that the row's own INK is untouched by it, so the ring and the title read
/// exactly as they do on an ordinary row.
/// The three tokens of a board row's second line, after the type size has had its say.
///
/// A value rather than three locals in a body, so the ladder can be asserted directly
/// (`TaskBoardModelTests`): `state` is what must survive, `age` is what is spent to keep
/// it, and `project` is always present because the VIEW decides how much of it fits.
struct BoardRowMeta: Equatable {
    /// The work-state word, or nil when the task has no session state at all.
    var state: String?
    /// The relative age, or nil when there is none or when the type size spent it.
    var age: String?
    /// The project ("Inbox" for a task in none), or nil when the type size spent it.
    var project: String?

    /// What the line actually draws, in order. Read by the view AND by the tests, so the
    /// ladder is asserted as the sequence the row renders rather than as three fields that
    /// might not be read.
    var tokens: [String] { [state, age, project].compactMap { $0 } }
}

struct TaskBoardRow: View {
    let row: BoardRow
    let state: BoardRowState
    /// True while this row's tap is asking the server where to go — its session by id,
    /// or which sessions its task has (`BoardModel.tapRoute`).
    ///
    /// It replaces the trailing state dot with a spinner IN THE SAME PLACE, which is
    /// the whole design: the feedback belongs on the row that was tapped, at the size
    /// the row already spends on its state, so a lookup is visible without the list
    /// moving. A modal or a toast would be a bigger interruption than the wait.
    var isResolving = false
    // NO `isNew` any more. The just-created flash used to be the same 3pt capsule the
    // needs-a-human mark was, so the row had to know about it; both are the row's
    // BACKGROUND now, which only `listRowBackground` can reach, so the decision lives
    // where the paint does (`TaskBoardList` → `BoardRowSurface`). A stored property this
    // view no longer reads would be exactly the dead arithmetic that lets a treatment
    // silently stop being applied.

    let onToggleDone: () -> Void
    /// The row's tap: open the session, or start one when the task has none.
    let onOpenSession: () -> Void

    /// Read for the second line's token ladder (`meta`), and nothing else: the row's own
    /// type sizes are all text styles, which the OS scales without being asked.
    @Environment(\.dynamicTypeSize) private var typeSize

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
                secondLine
            }
            // Spans to the indicator so the whole width right of the ring opens
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
            // The hint follows where the tap GOES, which is not "does the list have a
            // session for this task": a task whose session is known only by id opens
            // that session, and a task nobody has asked about yet opens whichever of the
            // two the probe finds. `BoardModel.affordance` is the same rule the context
            // menu's label reads, so the two can never describe different destinations —
            // and neither of them may promise a NEW session on a row that has one.
            .accessibilityHint(BoardModel.affordance(row).accessibilityHint)
            .accessibilityAddTraits(.isButton)
            indicator
        }
        .padding(.vertical, 2)
        // NO leading accent overlay any more, and its absence is the fix.
        //
        // It was a `Capsule` in an `.overlay(alignment: .leading)` drawing at x 0..3
        // while the ring below carried `padding(.leading, -6)` to put its glyph flush
        // at x≈0.5 — two claims on the row's first three points, which is why the mark
        // and the ring overlapped by 2.5pt on every marked row. The mark is the row's
        // BACKGROUND now (`BoardRowSurface`, applied by `TaskBoardList` as the row's
        // `listRowBackground` because a row cannot paint outside its own content box),
        // so there is nothing here to collide with anything.
        .accessibilityElement(children: .contain)
    }

    // MARK: - The row wants a human

    /// The desktop's rule, one indirection away (`BoardModel.needsHuman`, which is the
    /// port of `web/src/utils/session-status.ts` `taskNeedsAction`).
    ///
    /// Read HERE for the row's own ink decisions (the state word, the trailing dot) and
    /// read by `TaskBoardList` for the row's SURFACE. Same predicate both times, which
    /// is what keeps "the row is red" and "the row is quiet because it is red" from ever
    /// disagreeing.
    private var needsAction: Bool { BoardModel.needsHuman(row.task) }

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

    /// ONE grey line: the work state (coloured when it wants a human), then the
    /// project. Never a second sentence — the point of the row is that it is a row.
    ///
    /// # THREE tokens, not one string, and that is an accessibility fix
    ///
    /// It used to be two `Text`s, the first of them the pre-joined string
    /// "handed back · 2h". At accessibility-XXXL the line has less room than one token
    /// needs, so the `HStack` squeezed BOTH of them equally and every token lost its tail
    /// at once: the row read "hand… · Immi…" — the state word, the single most valuable
    /// thing on the line, destroyed to keep an age and a project that were also destroyed.
    ///
    /// The fix is a value order rather than a font size: the state word gets its ideal width
    /// first (`layoutPriority`) and lower-value tokens are DROPPED, whole, from the cheap end
    /// (`meta`). So the line degrades by saying fewer true things, which is legible at every
    /// step, instead of by shortening all of them into initials.
    private var secondLine: some View {
        let meta = Self.meta(
            word: state.hasSession ? state.word : nil,
            age: ageText,
            project: row.project,
            typeSize: typeSize
        )
        return HStack(spacing: 5) {
            if let word = meta.state {
                Text(word)
                    .foregroundStyle(stateColor)
                    .fontWeight(state == .running || state == .waiting || state == .handedBack ? .semibold : .regular)
                    .lineLimit(1)
                    // The state word is never the token that shrinks. A priority and not
                    // `fixedSize`: priority asks for the ideal width and still yields if
                    // the word alone cannot fit, where `fixedSize` would draw past the
                    // row's edge.
                    .layoutPriority(2)
            }
            if let age = meta.age {
                separator
                Text(age)
                    .foregroundStyle(stateColor)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
            if let project = meta.project {
                if meta.state != nil || meta.age != nil { separator }
                Text(project)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .font(.caption)
        // No identifier of its own: the parent combines this subtree into one
        // element, so an id here would be discarded anyway. The state IS readable
        // in automation — it is part of the combined row's label.
    }

    /// The interpunct between two tokens. Its own view because the line can draw two of
    /// them and they must not be able to disagree.
    private var separator: some View {
        Text("·").foregroundStyle(.tertiary)
    }

    /// What the second line SHOWS, given the tokens it could show and the type size.
    ///
    /// A pure function, so the degradation ladder is a tested rule rather than an inline
    /// condition in a body. The order of value is fixed and the drops follow it:
    ///
    ///  1. THE STATE WORD. It is why the row is red, and it is the only token that says
    ///     what is being asked of the reader. It is never dropped and never truncated.
    ///  2. The age. First to go, and it goes at every accessibility size: a relative age is
    ///     read whole or not at all ("2h" tells you nothing as "2…"), and it is the one
    ///     token whose absence changes no decision.
    ///  3. The project. Dropped next, and only when there IS a state word to protect —
    ///     measured at accessibility-XXXL, the caption is ~32pt and the column fits ONE
    ///     word, so keeping the project cost the line "handed back · I", where the second
    ///     half is noise and the first half is what matters. A row with no session state
    ///     keeps its project, because then the project IS the line.
    static func meta(
        word: String?, age: String?, project: String, typeSize: DynamicTypeSize
    ) -> BoardRowMeta {
        // "" is the Inbox, which is a place with a name, not a missing value.
        let projectLabel = project.isEmpty ? "Inbox" : project
        guard typeSize.isAccessibilitySize else {
            return BoardRowMeta(state: word, age: age, project: projectLabel)
        }
        guard let word else { return BoardRowMeta(state: nil, age: nil, project: projectLabel) }
        return BoardRowMeta(state: word, age: nil, project: nil)
    }

    private var ageText: String? {
        guard let at = row.session?.lastActiveValue else { return nil }
        return BoardModel.shortAge(Date().timeIntervalSince(at))
    }

    /// Colour for the state word on the second line.
    ///
    /// A needs-a-human row reads it GREY: the red PAPER already says "red" louder
    /// than 11pt text can, so colouring the word too was the third copy of one
    /// message on a single row (surface, dot, word). The word still carries the
    /// information — it literally says "handed back" — it just doesn't compete for
    /// the alarm. And grey on the tinted surface is the reading the contrast test
    /// covers, which is why it stays `.secondary` rather than becoming a bespoke
    /// colour picked against red.
    private var stateColor: Color {
        if needsAction { return .secondary }
        switch state {
        case .running: return Theme.success
        case .handedBack: return Theme.danger
        case .waiting: return Theme.warning
        case .failed: return Theme.danger
        // `.earlierSession` is NEUTRAL on purpose: the row knows work happened and
        // knows nothing about how it ended, so a colour claiming success, trouble or
        // activity would be an invention. Grey plus the word is the whole statement.
        case .ended, .earlierSession, .none: return .secondary
        }
    }

    /// The dot on the right edge says "this task has a session" on a scanning
    /// pass, which is what lets the row stay a row.
    ///
    /// It goes QUIET when the surface is already carrying the same message: a red
    /// row with a red dot on it is one fact stated twice, and doubling it is what
    /// made the list look alarmed instead of informative. A needs-a-human row keeps
    /// a small grey dot (there IS still a session, and the right edge is where that
    /// reads) while the paper owns the urgency.
    @ViewBuilder
    private var indicator: some View {
        if isResolving {
            // Same 9pt slot, so nothing in the row moves while the lookup runs.
            // `.small` + a scale, rather than `.mini`: `.mini` is a macOS-shaped size
            // and the platform's smallest spinner here is still ~16pt, which would
            // spill out of the dot's slot (a `frame` does not clip).
            ProgressView()
                .controlSize(.small)
                .scaleEffect(0.6)
                .frame(width: 9, height: 9)
                .padding(.top, 6)
                .accessibilityIdentifier("board.resolving.\(row.id)")
                .accessibilityLabel("Opening the session")
        } else if state.hasSession {
            Circle()
                .fill(needsAction ? Color.secondary.opacity(0.4) : stateColor)
                .frame(width: 9, height: 9)
                .padding(.top, 6)
                .accessibilityHidden(true)
        } else {
            // Keep the title's right edge in the same place with or without a
            // session, so a band of mixed rows doesn't look ragged.
            Color.clear.frame(width: 9, height: 9)
        }
    }
}
