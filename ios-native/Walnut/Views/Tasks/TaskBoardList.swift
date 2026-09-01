import SwiftUI

/// The board: one scroll of task rows grouped into sticky bands (pin tier, or
/// project when the band bar says so), with a create affordance at the foot of
/// each band that can create there.
///
/// Why a `List` with `Section` headers rather than a hand-rolled `LazyVStack` +
/// pinned headers: `insetGrouped`'s section headers already stick, already float
/// on the right material, and cost nothing extra. A hand-rolled sticky header
/// needs its own scroll-geometry observation, and publishing `@State` from a
/// scroll callback is the P0-2 class of bug this app has already shipped once
/// (see `ScrollBottomTracking`).
///
/// This view knows NOTHING about what a band is grouped by. It reads `bandId` as
/// an opaque identity and `createSeed` as the whole answer to "what does this
/// heading's `+` make", which is what lets a project band file into its project
/// without the layout learning a second mapping (it used to derive the create
/// affordance from `tierId != BoardModel.activeTierId`, i.e. from the id's
/// MEANING — and that tail band is gone now, so the view would have been reading a
/// constant that no longer exists).
///
/// # R29 "cards": each band is an inset-grouped section again
///
/// This look has been round the loop three times and the third round is the one
/// to read, because it reverses the second. Round 1 was cards and was rejected:
/// "那个框是方形的,根本就不 elegant" — the box is a square, it isn't elegant.
/// Round 2 (V1) concluded the CONTAINER was the problem and threw every box away
/// for one edge-to-edge sheet of `systemBackground`. Round 3 is the user pointing
/// at this app's OTHER task surface — the inset-grouped page every non-board
/// filter draws, rounded white sections on grouped grey — and saying they prefer
/// THAT: "我发现我更喜欢这个 style". So the diagnosis in round 2 was half right.
/// A square box is ugly; a ROUNDED card on a grouped background is the platform's
/// own idiom and the one the rest of the app already speaks.
///
/// What that means concretely, and it is mostly SUBTRACTION from V1: each band is
/// a `Section` whose rows take the section's own card (no `listRowBackground`
/// override, no zero-inset full bleed), so the corner radius, the card colour and
/// the row insets are the OS's and are identical to the reference page's rows by
/// construction rather than by a matching constant. The band heading stays
/// OUTSIDE and above the card, where a grouped section header lives. The two
/// colours the board does have to name are on `BoardBandCard`.
///
/// Mechanism, and why it is still not `listStyle`: the board is ONE section set
/// inside the Tasks tab's single shared `List`. That List is load-bearing three
/// times over — the scroll position, the `.searchable` nav-bar drawer, and the
/// chrome-collapse `onScrollGeometryChange` observer all hang off it — and
/// `listStyle` takes a CONCRETE `ListStyle` type, so selecting one per filter
/// means two `List` expressions and therefore two List identities: switching
/// filters would rebuild the scroll view, drop the offset, and re-arm the
/// observer. `.insetGrouped` for every filter was already the answer; what the
/// board stops doing is fighting it.
///
/// Three things the board still says per row, all VALUES rather than structural
/// branches, so nothing about the List's identity depends on the filter:
/// `listRowBackground` (nil for an ordinary row — the section paints its own
/// card; an OPAQUE tint-over-card for a row that wants a human, see `rowSurface`,
/// which the section's rounded mask clips at the band's first and last cell so
/// red cannot bleed past a corner), separators moved to the title with
/// `alignmentGuide(.listRowSeparatorLeading)`, and `listSectionSpacing(0)` so the
/// heading's own padding is the only gap between one card and the next.
///
/// The page colour behind the cards is the one thing this view cannot set (a row
/// cannot paint the scroll view behind it): `TasksView` hides the grouped
/// background and supplies `BoardBandCard.page`. Its navigation bar takes the
/// PLATFORM's background rather than that colour (R30 — a `toolbarBackground`
/// colour cost the screen its large title), which is also what removed the seam
/// the two colours used to have to agree about.
struct TaskBoardList: View {
    let bands: [BoardBand]
    let tierChoices: [(id: String, label: String)]
    // No `hiddenDoneBands` here on purpose. The heading's toggle is phrased from the
    // BAND (`BoardModel.doneToggle`), which is the only thing that knows how many rows
    // it is actually suppressing; handing the view the set as well would let the label
    // and the rows disagree — and with folding now the DEFAULT, the set's own answer
    // for an untouched band ("not expanded") says nothing about whether that band has
    // anything to expand.
    /// Which band's create row is open, by band id (nil = none).
    let openCreateBand: String?
    /// Just-created row id — its whole row takes a green tint so its landing place is
    /// visible ("where did it land?" is answered by a place on screen, not a toast).
    let newRowId: String?
    /// taskId → tier id, for the tier menu's checkmark.
    let tierOf: [String: String]
    /// The row whose tap is currently asking the server where to go (its session by
    /// id, or which sessions its task has). Its trailing dot becomes a spinner.
    ///
    /// ONE id and not a set: a tap is a navigation, so only the newest one can matter,
    /// and a second row spinning would advertise two destinations at once.
    var resolvingRowId: String? = nil

    let onToggleHideDone: (String) -> Void
    let onToggleCreate: (String) -> Void
    let onToggleDone: (BoardRow) -> Void
    let onPickTier: (BoardRow, BoardModel.TierToken) -> Void
    let onOpenSession: (BoardRow) -> Void
    let onOpenDetail: (BoardRow) -> Void
    /// The band's create row, rendered by the owner (it needs the store).
    ///
    /// Takes the band's own `(bandId, createSeed)`. The SEED is the destination: a
    /// tier band files into that tier, a project band into that project, and this
    /// view never has to know which it handed over (it used to pass a tier id
    /// string, which is exactly the assumption project bands break). The band id
    /// rides along only because the row's accessibility identifier is built from
    /// it, and a shipped automation flow taps `board.createRow.backlog`: deriving
    /// that from the seed instead would rename it.
    let createRow: (String, NewTaskSeed) -> AnyView

    /// The heading dot's diameter, SCALED with the heading's own text style.
    ///
    /// `@ScaledMetric(relativeTo:)` and not a plain constant, for the reason every size in
    /// this header is a style now: at accessibility-XXXL a 7pt dot beside a 40pt label is a
    /// speck, and the pairing here is what keeps the dot proportional to the word it marks.
    @ScaledMetric(relativeTo: BoardHeadingType.label) private var headingDot: CGFloat = 7

    /// Read by the heading's own ladder (`BoardHeadingType.showsControlLabel`). Everything
    /// else in this view is a text style, which the OS scales without being asked.
    @Environment(\.dynamicTypeSize) private var typeSize

    /// A band's heading id, so a chip tap can land on it. Deliberately the RAW
    /// band id and not `slug()`: a scroll anchor has to be unique or the jump goes
    /// to the wrong heading, and two projects differing only in ASCII punctuation
    /// still share a slug. Nothing matches this as a regex, so the raw id is safe
    /// here (accessibility ids are the ones that must fold).
    static func anchorId(_ bandId: String) -> String { "board.band.\(bandId)" }

    /// A ROW's scroll anchor, and it is deliberately the SAME string the task list's
    /// rows use (`taskRowButton` → `.id("task-<id>")`).
    ///
    /// It exists because the "All Tasks" list is gone: the locate-me handler used to
    /// answer "where did my new task land?" by switching to that flat list, whose
    /// rows carried this id, and scrolling to it. With the board as the only task
    /// surface the handler has to be able to scroll to a BOARD row, and a
    /// `scrollTo` for an id no view claims is a silent no-op — the failure mode
    /// being "I created it and can't find it", which is the complaint the flash and
    /// the scroll exist to answer.
    static func rowAnchorId(_ rowId: String) -> String { "task-\(rowId)" }

    /// The colour `listRowBackground` gets for ONE row: red card for a task that wants a
    /// human, a green flash for the row that was just created, and `nil` for every
    /// ordinary row — `nil` meaning the inset-grouped section paints its own card, which
    /// is how a board row and a row on any other Tasks filter are the same object.
    ///
    /// A named function rather than an expression inline in `body`, so the composition
    /// the app actually executes is the one the tests drive — the predicate
    /// (`BoardModel.needsHuman`) and the surface (`BoardRowSurface`) are each covered on
    /// their own, and this is where they are joined. An inline expression would leave the
    /// JOIN untested, which is the half that can silently stop applying the treatment
    /// (pass the wrong row's id, read `isDone` instead of the phase) while both halves
    /// still pass their own cases.
    static func rowSurface(_ row: BoardRow, newRowId: String?) -> Color? {
        BoardRowSurface.color(
            needsAction: BoardModel.needsHuman(row.task),
            isNew: row.id == newRowId
        )
    }

    var body: some View {
        ForEach(bands) { band in
            Section {
                ForEach(band.rows) { row in
                    TaskBoardRow(
                        row: row,
                        // `knownSessionIds` rides along so a row whose session the
                        // session LIST does not carry still reports that it HAS one
                        // (`.earlierSession`) instead of "no session yet".
                        state: BoardModel.state(
                            task: row.task, session: row.session,
                            knownSessionIds: row.knownSessionIds
                        ),
                        isResolving: row.id == resolvingRowId,
                        onToggleDone: { onToggleDone(row) },
                        onOpenSession: { onOpenSession(row) }
                    )
                    // Scroll anchor for locate-me. It REPLACES the `ForEach`'s own
                    // identity with the same string, which stays unique because
                    // `row.id` is (ONE id space, see `BoardRow.id`).
                    .id(Self.rowAnchorId(row.id))
                    // NO `listRowInsets` any more, and the absence is the R29 restyle.
                    //
                    // V1 set zero horizontal insets so the row ran full bleed on the
                    // section margin, and 12pt of vertical air to replace the card's own.
                    // Both were replacements for what the card already provides, so both
                    // are now the platform's: the row's content sits inside the card at
                    // the OS's own inset (~20pt) with the OS's own vertical rhythm, which
                    // is what makes a board row and a row on the reference page line up on
                    // the same pixels. The row keeps its own `padding(.vertical, 2)`.
                    //
                    // The row's SURFACE, and the one place the board says "this task
                    // wants a human": an ordinary row is `nil` so the section's card is
                    // untouched, and a needs-action row's whole CARD CELL takes the red
                    // ("把它变成一整个底都变成红色的吧"), clipped by the card's own
                    // corners. The tint, the per-scheme strength, the opaque composite and
                    // the three rounds of history behind it are on `BoardRowSurface`.
                    //
                    // Applied HERE and not inside the row, because a row cannot paint
                    // outside its own content box: `listRowBackground` is the only thing
                    // that reaches the row's full rect, which is what "the whole row"
                    // means. It is also why the old mark was a 3pt capsule INSIDE the row
                    // and ended up fighting the done ring for the same three points.
                    //
                    // The predicate is the model's (`BoardModel.needsHuman`, the port of
                    // the desktop's `taskNeedsAction`) and the row reads the same one for
                    // its ink, so "red row" and "quiet state word" can never disagree.
                    .listRowBackground(Self.rowSurface(row, newRowId: newRowId))
                    // The hairline starts at the TITLE, not at the row edge, so the
                    // ring's gutter stays clear (mockup: `left: 48px`). The guide is
                    // measured in the row's own content space, which is why the
                    // constant lives next to the ring/spacing arithmetic that
                    // produces it.
                    .alignmentGuide(.listRowSeparatorLeading) { _ in
                        TaskBoardRow.separatorLeadingInset
                    }
                    // The TRAILING end goes back to the platform's inset, and this is one
                    // of the two places R29 reverses a V1 decision on purpose.
                    //
                    // V1 ran the hairline all the way out because the row's trailing edge
                    // WAS the sheet's edge, so full bleed was the honest statement "the
                    // sheet ends here" and stopping 32pt short read as pointing at
                    // nothing. Inside a card the CARD's edge makes that statement, and a
                    // hairline that runs into a rounded corner reads as a crack in the
                    // wall. The reference screen stops its separators ~15pt short of the
                    // card, which is exactly the default — so the default is what this row
                    // now takes.
                    //
                    // Separators BETWEEN cells only. The last TASK row keeps its hairline
                    // when a create foot follows it inside the same card (the card has not
                    // ended, so neither has the list of rows), and drops it when it really
                    // is the card's last cell.
                    .listRowSeparator(
                        row.id == band.rows.last?.id && band.createSeed == nil
                            ? .hidden : .visible,
                        edges: .bottom
                    )
                    // And nothing above the first row: the card's own top edge is the
                    // band's boundary, and a hairline there would draw a line across it.
                    .listRowSeparator(row.id == band.rows.first?.id ? .hidden : .automatic, edges: .top)
                    .modifier(BoardRowGestures(
                        row: row,
                        tierChoices: tierChoices,
                        currentTier: row.task.flatMap { tierOf[$0.id] },
                        onToggleDone: { onToggleDone(row) },
                        onPickTier: { onPickTier(row, $0) },
                        onOpenSession: { onOpenSession(row) },
                        onOpenDetail: { onOpenDetail(row) }
                    ))
                }
                // Create at the FOOT of the band — where the just-created row
                // then stays put, because a new pin's pin_order is max+1. The
                // affordance and the outcome are in the same place, which is
                // what the Reminders behaviour is actually about.
                //
                // Every band the board renders carries a seed now (the tail band,
                // the one band that could not name a destination, is gone), so the
                // `if` is a guard rather than a branch two band kinds take. It stays
                // because the alternative is this view deriving the destination from
                // the band's ID again — the assumption that shipped
                // `focus_tier: "proj:marina"`.
                if let seed = band.createSeed {
                    createFoot(band, seed: seed)
                }
            } header: {
                heading(band)
            }
            // ZERO section spacing, and it stays zero now that the bands are cards:
            // the gap between one card and the next heading is the HEADING's own
            // padding (17pt above the label, 14pt below it), which is the only place
            // that rhythm is stated. Adding section spacing on top would double it,
            // and the two numbers would then disagree about the same gap.
            .listSectionSpacing(0)
        }
    }

    // MARK: - Sticky heading

    /// The gap ABOVE a band's label, i.e. between the previous band's card and this
    /// heading. `listSectionSpacing(0)` means this padding IS that gap and nothing else
    /// contributes to it (reference screen: 15.8pt).
    static let headingTopGap: CGFloat = 17

    /// The gap BELOW the last line of a heading and the top of its own card (reference
    /// screen: 14.6pt).
    ///
    /// Named because there are TWO heading shapes whose last line can be the one that
    /// meets the card — a flush tier/project heading, and a nested folder heading — and a
    /// card that sat closer to its label in one grouping than the other would read as two
    /// different lists.
    static let headingLabelToCard: CGFloat = 14

    /// The band heading: a grouped-section header, OUTSIDE and above its card, on the
    /// page colour (R29). It used to float on `.bar` material, which was right over V1's
    /// one white sheet and wrong over cards — a translucent header lets the white card
    /// edge ghost through the label as it slides under. The header is opaque page colour
    /// now, so a card passing beneath a pinned heading simply disappears behind the page,
    /// which is what a grouped list does.
    ///
    /// # R30 typography: the reference screen's heading, not a bespoke one
    ///
    /// It used to be 11pt BOLD UPPERCASE with 0.6 kerning behind a 3x13 accent bar. The
    /// user picked the app's own reference screen instead, and that screen's headings are
    /// plain `Section("Active Sessions")` headers: SENTENCE CASE, grey, and the size the
    /// platform picks (measured off the reference: ink `secondaryLabel` at 123 grey on the
    /// 242 page, ~12pt cap height, label 20pt in from the card edge). So the heading now
    /// says the band's name the way the rest of the app says a section's name, and the
    /// tier's identity survives as a small coloured DOT — the same dot its chip carries,
    /// which is what makes chip and heading read as one object without either shouting.
    ///
    /// The sizes are TEXT STYLES now (`BoardHeadingType`), and that is the Dynamic Type
    /// fix rather than a cosmetic change: `Font.system(size: 11, weight: .bold)` is a fixed
    /// point size, so at accessibility-XXXL the rows grew and every heading, count and
    /// `hide done` stayed 11pt — measured on the pinned simulator, which is how it was
    /// found. A style scales because the OS scales it.
    ///
    /// # Two levels, ONE sticky header per band
    ///
    /// Under `By project` the board nests: a project's loose rows and each of its
    /// folders are separate bands, and a folder band's heading is drawn INDENTED under a
    /// rail with a hollow folder glyph, one type step smaller than the project heading
    /// above it — three differences from a project/tier heading (flush, dotted, a step
    /// larger), so the two levels cannot be mistaken for siblings. That was the exact
    /// complaint the desktop's own first attempt drew: a folder styled like a project
    /// reads as a project.
    ///
    /// The project heading is drawn INSIDE the header of whichever band leads the
    /// project (`BoardBandNest.leadsProject`), rather than as a section of its own,
    /// because `insetGrouped` sticks ONE header per section: two stacked sections would
    /// mean the project heading scrolls away while its folder's sticks, which is the
    /// opposite of a hierarchy. In the common case the project's loose band leads and
    /// its own heading IS the project heading, so nothing extra is drawn at all.
    @ViewBuilder
    private func heading(_ band: BoardBand) -> some View {
        if let nest = band.nest {
            VStack(alignment: .leading, spacing: 0) {
                // A project whose loose band is empty (every pinned row filed in a
                // folder) still gets its heading, on its first folder band.
                if nest.leadsProject {
                    headingBar(
                        label: nest.projectLabel,
                        // The colour the project's OWN band would have drawn, so the
                        // heading looks the same wherever it happens to be rendered.
                        color: Self.bandColor(nest.projectBandId),
                        identifier: "board.heading.\(Self.slug(nest.projectBandId))"
                    )
                }
                folderHeading(band, nest: nest)
            }
            .modifier(BoardHeadingChrome(
                anchorId: Self.anchorId(band.bandId),
                identifier: "board.folder.\(Self.slug(nest.folderId))"
            ))
        } else {
            HStack(spacing: 7) {
                bandDot(band.bandId)
                Text(band.label)
                    .font(.system(BoardHeadingType.label, weight: .semibold))
                    .foregroundStyle(BoardHeadingType.ink)
                    // The band's NAME wins the line. One line and highest priority, both
                    // measured: without the priority the control and the count took their
                    // ideal widths first and the label was squeezed into a hyphenated
                    // two-line "Fo-cus" at accessibility-XXXL; without `lineLimit(1)` a long
                    // project name would still wrap under its own dot.
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(2)
                hideDoneButton(band)
                Spacer(minLength: 6)
                if BoardHeadingType.showsCount(typeSize) { countLabel(band) }
            }
            .padding(.top, Self.headingTopGap)
            .padding(.bottom, Self.headingLabelToCard)
            .modifier(BoardHeadingChrome(
                anchorId: Self.anchorId(band.bandId),
                identifier: "board.heading.\(Self.slug(band.bandId))"
            ))
        }
    }

    /// One project-heading line, drawn above the folder band that leads its project.
    /// Same type style and dot as an ordinary band heading, because it IS one — it just
    /// happens to live in a nested band's header.
    private func headingBar(label: String, color: Color, identifier: String) -> some View {
        HStack(spacing: 7) {
            dot(color)
            Text(label)
                .font(.system(BoardHeadingType.label, weight: .semibold))
                .foregroundStyle(BoardHeadingType.ink)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 6)
        }
        .padding(.top, Self.headingTopGap)
        // NOT `headingLabelToCard`: what follows this line is the folder heading, not the
        // card, and the two labels belong together as one two-line header.
        .padding(.bottom, 3)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    /// A FOLDER band's heading: indented behind a vertical rail, hollow folder glyph,
    /// label in sentence case. The rail is what makes the indent read as "inside the
    /// project above" rather than as a heading that happens to start further right.
    private func folderHeading(_ band: BoardBand, nest: BoardBandNest) -> some View {
        HStack(spacing: 7) {
            // The rail: one hairline standing in the project's gutter, the same trick
            // the desktop's V2 tree uses (`竖线 rail`) after chip-styled folders read
            // as sibling projects.
            Rectangle()
                .fill(.quaternary)
                .frame(width: 1)
                .padding(.leading, 5)
            Image(systemName: "folder")
                .font(.system(BoardHeadingType.folderGlyph, weight: .semibold))
                // Same concrete ink as the label beside it: `.tertiary` here resolved to
                // quaternary in the header context (1.37:1), i.e. a glyph that is not there.
                .foregroundStyle(BoardHeadingType.ink)
            Text(band.label)
                .font(.system(BoardHeadingType.folderLabel, weight: .semibold))
                .foregroundStyle(BoardHeadingType.ink)
                .lineLimit(1)
                .truncationMode(.tail)
            hideDoneButton(band)
            Spacer(minLength: 6)
            if BoardHeadingType.showsCount(typeSize) { countLabel(band) }
        }
        .padding(.top, nest.leadsProject ? 1 : Self.headingTopGap - 4)
        // This IS the line that meets the card under a folder band, so it owes the same
        // gap a flush heading does.
        .padding(.bottom, Self.headingLabelToCard)
    }

    /// The done toggle lives on the heading it affects — a global switch would hide
    /// completions in bands the user isn't looking at. Keyed by BAND id, so a project,
    /// a folder and a tier can never collide (each id carries its own prefix).
    ///
    /// It READS as a control now (R30): tinted text in a soft tinted capsule, next to a
    /// grey heading. As bare 10.5pt tint text beside a bold uppercase label it was neither
    /// — the same colour as a link, the same weight as the heading, no shape of its own —
    /// so a toggle that changes what the band shows looked like part of the band's name.
    private func hideDoneButton(_ band: BoardBand) -> some View {
        // ONE value decides the word, the glyph and the VoiceOver label, and it is read
        // off the band rather than off a set the view holds — see `BoardModel.doneToggle`.
        let toggle = BoardModel.doneToggle(band)
        let word = toggle.word
        return Button {
            onToggleHideDone(band.bandId)
        } label: {
            Group {
                if BoardHeadingType.showsControlLabel(typeSize) {
                    Text(word)
                        .textCase(nil)
                        .lineLimit(1)
                } else {
                    // The glyph says the same thing the word does: an eye that is closed
                    // hides, an open one shows.
                    Image(systemName: toggle.glyph)
                }
            }
            .font(.system(BoardHeadingType.control, weight: .semibold))
            .foregroundStyle(Theme.tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Theme.tintSoft, in: Capsule())
            // MIN height, not a fixed one: the label inside scales with Dynamic Type,
            // so a hard height would clip it at accessibility sizes (the create foot
            // learned this the same way).
            .frame(minHeight: 26)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("board.hideDone.\(Self.slug(band.bandId))")
        // The WORD is the label whichever form is drawn, so VoiceOver and any text-matching
        // flow read the same thing at every type size.
        .accessibilityLabel(word)
    }

    private func countLabel(_ band: BoardBand) -> some View {
        Text(band.count.formatted(.number))
            .font(.system(BoardHeadingType.count, weight: .semibold))
            .monospacedDigit()
            // A COUNT MUST NEVER WRAP BETWEEN DIGITS OR TRUNCATE. That is dogfood R19's own
            // defect ("2,82" / "4" on the retired summary cards), and this heading
            // reproduced both halves at accessibility-XXXL the moment the label started
            // winning the line: 152 came out as "15" over "2", and then as "1…".
            //
            // `fixedSize` rather than a `layoutPriority`: a priority only reorders who is
            // asked first, and with a 33pt footnote, a dot, a control and a spacer on one
            // line the count was still handed 25pt for a 60pt number. A count is one to four
            // digits — its ideal width is small and bounded, so refusing to be squeezed at
            // all is safe here in a way it would not be for a label.
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(BoardHeadingType.countInk)
            .accessibilityIdentifier("board.count.\(Self.slug(band.bandId))")
    }

    /// The band's identity, as a dot: the same colour and the same shape its chip carries
    /// (`BoardBandBar.chipButton`), so heading and chip are one object.
    ///
    /// It replaces a 3x13 accent BAR. The bar was the loud half of the old heading (a bar
    /// plus bold caps reads as a warning label), and a bar also has to pick a height,
    /// which is exactly the kind of constant that stops matching its text at
    /// accessibility sizes. A dot has one number and it scales.
    private func bandDot(_ bandId: String) -> some View {
        dot(Self.bandColor(bandId))
    }

    private func dot(_ color: Color) -> some View {
        Circle()
            .fill(color)
            .frame(width: headingDot, height: headingDot)
    }

    // MARK: - Create at the foot

    /// The band's quick add, and it is the LAST CELL OF THE CARD (R29) rather than a
    /// transparent row sitting under it.
    ///
    /// This is the board's answer to the reference page's quick-add capsule, and it is the
    /// same component (`QuickAddRow`, handed the band's own seed) — the difference being
    /// that the destination is already decided by WHICH card's foot you tapped, so it files
    /// into that tier or that project instead of asking. Both cells therefore keep the
    /// card: `listRowBackground(Color.clear)` here used to be correct over one flat sheet
    /// and would now punch a hole through the bottom of the card, page colour showing
    /// through the rounded corners it is supposed to fill.
    @ViewBuilder
    private func createFoot(_ band: BoardBand, seed: NewTaskSeed) -> some View {
        if openCreateBand == band.bandId {
            createRow(band.bandId, seed)
                .listRowSeparator(.hidden)
        } else {
            Button {
                onToggleCreate(band.bandId)
            } label: {
                HStack(spacing: 11) {
                    Circle()
                        .strokeBorder(Theme.tint, style: StrokeStyle(lineWidth: 1.4, dash: [3, 2.5]))
                        .frame(width: 21, height: 21)
                    Text("New task in \(band.label)")
                        .font(.subheadline)
                        .foregroundStyle(Theme.tint)
                    Spacer(minLength: 0)
                }
                // MIN height, not a fixed one, and the difference is an accessibility bug
                // the V1 row had: `frame(height: 34)` pinned the cell while the label
                // inside it scales with Dynamic Type, so at accessibility-XXXL the text
                // overflowed a box that could not grow. A floor keeps the tap target
                // honest at default type and lets the row grow at large ones. Shorter than
                // a task row on purpose: it is an affordance, not an item.
                .frame(minHeight: 26)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowSeparator(.hidden)
            .accessibilityIdentifier("board.create.\(Self.slug(band.bandId))")
        }
    }

    // MARK: - Ids and colours

    /// Automation matches accessibility ids as REGEXES, so every band id is folded
    /// to `[a-z0-9_]` before it becomes one. This matters more than it did: a band
    /// id used to be a tier id (`focus`, `ct_abc12345`), and it is now also
    /// `proj:<name>` carrying whatever the user called their project, and a `|` there
    /// would read as an alternation and a `(` as a group, and a raw project name
    /// in an id has already made one element unaddressable in this app.
    ///
    /// ASCII specifically, and that word is the whole bug fix (2026-08-29 review).
    /// `Character.isLetter` / `.isNumber` are UNICODE-aware: they answer true for
    /// CJK ideographs, for `é`, for Devanagari digits. So a project named in Chinese
    /// used to sail through this fold unchanged and produce
    /// `board.heading.proj_<CJK>`, breaking the repo's rule that every id stays
    /// inside [A-Za-z0-9._-] — the id looked folded, and the one thing it had to
    /// fold was the thing it kept.
    ///
    /// # And why a hash rides along (the CJK collision, adversarially proven)
    ///
    /// Folding to ASCII fixed the character set and immediately created a worse
    /// problem: `工作` and `生活` BOTH fold to `proj___`, so their heading, their
    /// `hide done` toggle, their count, their create ring and now their band chip
    /// all shared one identifier. Automation taps the FIRST match, so a flow aimed
    /// at 生活 silently drove 工作 — an ambiguous id is more dangerous than an
    /// unaddressable one, because it does something plausible.
    ///
    /// So when the fold LOSES INFORMATION THAT ASCII COULD NOT CARRY (any non-ASCII
    /// scalar in the input), a short stable hash of the name is appended. Two
    /// properties matter and both are pinned by tests:
    ///
    ///  - STABLE: FNV-1a over the lowercased UTF-8 bytes, so the same project name
    ///    yields the same id on every call, in every process, forever. Nothing
    ///    here reads a dictionary, an ordering or a launch counter — an id that
    ///    changed between body passes would be worse than a colliding one.
    ///  - BYTE-IDENTICAL FOR ASCII: a pure-ASCII name is returned by the old code
    ///    path untouched, because shipped flows tap `board.createRow.backlog` and
    ///    `board.create.focus` today. The hash is not a new format for every id;
    ///    it is a suffix on exactly the names that previously became ambiguous.
    ///
    /// Two costs kept on purpose. ASCII names that differ only in punctuation
    /// (`walnut-ios` / `walnut.ios`) still collide, unchanged, because fixing that
    /// would rename ids automation already depends on. And 16 bits of hash can
    /// collide: `日本語` and `проект` both hash to `c13c`, measured, in a nine-name
    /// sample — so the hash is NOT the only thing carrying information here, the
    /// folded body is too (`proj_____c13c` vs `proj________c13c`), which is why the
    /// suffix is appended to the fold rather than replacing it. Both costs are safe
    /// for the same reason: a slug identifies an ELEMENT for automation, never a
    /// band for the app — `anchorId` keeps the raw id, which is why
    /// `testAnchorIdsStayDistinctWhereSlugsCollide` must keep passing.
    static func slug(_ raw: String) -> String {
        let lowered = raw.lowercased()
        let folded = String(lowered.map { $0.isASCIILetterOrDigit ? $0 : "_" })
        // The fold is lossless-enough for ASCII (it was already the shipped id, and
        // an ASCII name has an ASCII fold). Non-ASCII is where "looked folded" and
        // "is distinguishable" came apart, so that is the only case that grows a
        // suffix.
        guard lowered.unicodeScalars.contains(where: { !$0.isASCII }) else { return folded }
        return "\(folded)_\(shortHash(lowered))"
    }

    /// Four lowercase hex chars of FNV-1a/32 over the string's UTF-8 bytes.
    ///
    /// FNV-1a and not `hashValue`: Swift's `Hashable` is seeded per process, so
    /// `hashValue` would hand out a DIFFERENT id every launch — an accessibility
    /// identifier has to be the same string tomorrow, in the next build, on the
    /// CI simulator, or the flow that tapped it stops working for reasons nobody
    /// can reproduce. This is 12 lines of arithmetic with no state and no
    /// dependencies, which is exactly what a stable id needs.
    static func shortHash(_ raw: String) -> String {
        var hash: UInt32 = 2_166_136_261            // FNV-1a 32-bit offset basis
        for byte in raw.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619               // FNV prime, wrapping on purpose
        }
        // The low 16 bits: 4 hex chars keep the id readable in a failing flow's
        // error message, which the full 8 would not. Zero-padded by hand rather
        // than with `String(format:)` — that one is Foundation, this file only needs
        // the stdlib, and a hash whose length varied with its VALUE would produce
        // ids of two different shapes for no reason.
        let hex = String(hash & 0xFFFF, radix: 16)
        return String(repeating: "0", count: max(0, 4 - hex.count)) + hex
    }

    /// The band bar's chip identifier. nil = the `All` chip.
    ///
    /// A function rather than string interpolation at the call site so the tests
    /// can pin the SHIPPED id (`board.chip.all`, `board.chip.focus`) rather than
    /// re-deriving it from `slug` and agreeing with a bug — the trap
    /// `testCJKProjectNamesFoldToAsciiOnlyIdentifiers` was written for.
    static func chipId(_ bandId: String?) -> String {
        guard let bandId else { return "board.chip.all" }
        return "board.chip.\(slug(bandId))"
    }

    /// Band accent. Built-in TIERS get the desktop's colours so the two surfaces
    /// read as the same board; everything else (a custom tier, a project band)
    /// gets the app tint rather than a random hue nobody chose.
    ///
    /// Project bands share one colour deliberately. A per-project hue would have
    /// to come from hashing the name, which means the same project changes colour
    /// when it is renamed and two unrelated projects can collide. A colour that
    /// carries no meaning is worse than no colour.
    static func bandColor(_ bandId: String) -> Color {
        switch bandId {
        case "focus": return Color(red: 0.0, green: 0.48, blue: 1.0)
        case "satellite": return Color(red: 0.35, green: 0.34, blue: 0.84)
        case "backlog": return Color(red: 0.19, green: 0.69, blue: 0.78)
        case "wait": return Theme.warning
        default: return Theme.tint
        }
    }
}

/// Everything a band heading is, apart from its own content: the opaque page backdrop, the
/// full-bleed insets, the card-aligned content inset, the scroll anchor and the
/// accessibility identity.
///
/// A modifier and not copied lines, because there are TWO heading shapes (a flush
/// project/tier heading and a nested folder heading) and every one of these values has to
/// stay identical between them — the backdrop especially. A heading that missed it would
/// let cards slide visibly under its text while it is pinned, and that is the kind of
/// difference nobody notices in a diff.
private struct BoardHeadingChrome: ViewModifier {
    let anchorId: String
    let identifier: String

    func body(content: Content) -> some View {
        content
            // Grouped-list headers uppercase their text for free; project/tier labels
            // are uppercased by hand (so the kerning is ours), a folder label is
            // deliberately sentence case, and `hide done` must stay lowercase — so the
            // automatic transform is switched off for the whole row.
            .textCase(nil)
            // The heading's BACKGROUND runs full bleed (zero insets, below) while its
            // CONTENT is inset to where the card's own content starts, so a band label
            // lines up with the ring column of the rows under it exactly as `Active
            // Sessions` lines up with its rows on the reference page. The two cannot be
            // one value: an inset background would leave two strips of card visible
            // either side of a pinned heading.
            .padding(.horizontal, BoardBandCard.headingContentInset)
            .frame(maxWidth: .infinity, alignment: .leading)
            // OPAQUE page colour, not `.bar`: see the heading's own doc. A material here
            // would tint with whatever card is passing under it.
            .background(BoardBandCard.page)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .id(anchorId)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(identifier)
    }
}

/// The row's SECOND affordance: everything about the task that isn't "open the
/// session".
///
/// This exists because the row's tap was spent on the session, on purpose. The
/// rejected design put all of this inline — a tier picker, a Details button, an
/// Open button — so one tap produced a menu and the user did the routing. Here
/// the tap is a destination and the settings live where iOS already puts row
/// settings: swipe for the two frequent toggles, long-press for the rest.
///
/// It is a ViewModifier rather than lines inside `TaskBoardRow` because
/// `swipeActions` only works on a direct child of a `List` row — applied inside
/// the row's own body it silently does nothing.
private struct BoardRowGestures: ViewModifier {
    let row: BoardRow
    let tierChoices: [(id: String, label: String)]
    let currentTier: String?
    let onToggleDone: () -> Void
    let onPickTier: (BoardModel.TierToken) -> Void
    let onOpenSession: () -> Void
    let onOpenDetail: () -> Void

    func body(content: Content) -> some View {
        content
            // Leading swipe = done↔reopen, matching Reminders and the other task
            // list in this app (TasksView's own rows do exactly this).
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button(action: onToggleDone) {
                    Label(row.isDone ? "Reopen" : "Done",
                          systemImage: row.isDone ? "arrow.uturn.backward.circle" : "checkmark.circle.fill")
                }
                .tint(row.isDone ? .secondary : Theme.success)
            }
            // Trailing swipe = the task's own page. The row's tap opens the
            // SESSION, so this is the other half of the pair the user asked for:
            // "one is tapping the session, one is going into the task".
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(action: onOpenDetail) {
                    Label("Task", systemImage: "info.circle")
                }
                .tint(Theme.tint)
            }
            .contextMenu {
                // THREE answers, not two (`BoardModel.affordance`). A task whose session is
                // known only by id (aged out of the session list) is a session to OPEN; a
                // task nobody has asked about yet gets the neutral word, because "Start
                // Session" on a row that already has sessions is an offer to duplicate one.
                // The menu item and the tap read the same rule, so they cannot disagree.
                let affordance = BoardModel.affordance(row)
                Button(action: onOpenSession) {
                    Label(affordance.menuLabel, systemImage: affordance.menuIcon)
                }
                Button(action: onToggleDone) {
                    Label(row.isDone ? "Mark as To Do" : "Mark as Done",
                          systemImage: row.isDone ? "circle" : "checkmark.circle.fill")
                }
                // Tier move — this is where the wrapping token row went. A menu
                // shows the same closed set without spending any row height, and
                // it can't be clipped by anything at the row's trailing edge
                // (which is what forced the inline version to wrap in the first
                // place).
                if row.canRetier {
                    Menu {
                        ForEach(BoardModel.tokens(current: currentTier, choices: tierChoices)) { token in
                            Button {
                                onPickTier(token)
                            } label: {
                                if token.selected {
                                    Label(token.label, systemImage: "checkmark")
                                } else {
                                    Text(token.label)
                                }
                            }
                        }
                    } label: {
                        Label("Move to Tier", systemImage: "square.stack.3d.up")
                    }
                }
                Button(action: onOpenDetail) {
                    Label("Details, dates & priority", systemImage: "slider.horizontal.3")
                }
            }
    }
}

// The right-edge letter rail is GONE (2026-08-29, T84). It was one glyph per band
// pinned to the trailing edge, tapped to teleport to that heading. The user threw
// it out in the same breath as the card look: "不应该是一个侧面的一个东西" — the
// band switcher should not be a thing off to the SIDE, it belongs across the top
// where a thumb already is. That is now `BoardBandBar`, which does strictly more
// (it filters the board, it shows counts, it shows which band you are in) in a
// place the user can read.
//
// Two known rail defects died with it rather than being fixed, which is worth
// recording because both were real and neither is reachable any more: the "•"
// fallback (a band whose label had no usable ASCII letter left AND all ten digits
// taken produced a bullet, i.e. a non-ASCII accessibility id, exactly the class of
// bug `AutomationIdentifiers` exists to prevent), and the overflow past ~34 bands
// (the rail was a plain VStack of 19pt buttons with no scroll and no cap, so on a
// tall project list the glyphs ran off both ends of the screen). The bar is a
// horizontal ScrollView, so "too many bands" is a scroll, not a clipped column.

// MARK: - Heading type scale

/// The band heading's TYPE SCALE, stated as text STYLES rather than point sizes.
///
/// Every one of these used to be a `Font.system(size:)` literal — 11 bold for the band
/// label, 11.5 for a folder label, 11 for the count, 10.5 for `hide done`, 9.5 for the
/// folder glyph — and a fixed point size does not answer Dynamic Type. That is not a
/// theoretical objection: at accessibility-XXXL the ROWS grew to ~40pt text while every
/// heading, count and toggle above them stayed at 11, so the band label ended up smaller
/// than the task titles it was labelling (measured on the pinned simulator, R29 QA sweep).
///
/// A STYLE fixes it at the source, because the OS owns the size: `.subheadline` is 15pt at
/// the default content size and grows with the setting, and it is also what makes the
/// heading match the reference screen's own `Section("…")` header instead of approximating
/// it with a number. The one thing a style cannot state is a NON-text size, which is why
/// the dot is a `@ScaledMetric(relativeTo: BoardHeadingType.label)` rather than a literal.
///
/// The five entries are a scale, not five independent choices: label (the band's name) is
/// one step above folderLabel / count / control (its satellites), and the folder glyph is
/// the smallest thing on the line because it is an icon beside a word, not a word.
enum BoardHeadingType {
    /// A tier/project band's own name.
    static let label: Font.TextStyle = .subheadline
    /// A folder band's name, one step down so a folder cannot read as a project.
    static let folderLabel: Font.TextStyle = .footnote
    /// The row count at the trailing edge.
    static let count: Font.TextStyle = .footnote
    /// The `hide done` control.
    static let control: Font.TextStyle = .footnote
    /// The folder glyph.
    static let folderGlyph: Font.TextStyle = .caption2

    /// The heading's INK, as a CONCRETE platform label colour and never a hierarchy level.
    ///
    /// `.foregroundStyle(.secondary)` looks like the right way to say "grey heading" and is
    /// not, inside a grouped section HEADER: a hierarchical style resolves RELATIVE to the
    /// level its context already sits at, and a List header starts one level down — so
    /// `.secondary` came out as `tertiaryLabel` and `.tertiary` came out as quaternary.
    /// Measured on the pinned simulator (R28c QA sweep): the band label's ink was 187.4
    /// luminance on the 242 page = 1.71:1, and the count 215 = 1.37:1, on the FIRST screen
    /// of the app. 187.4 is exactly `tertiaryLabel` composited over that page
    /// (0.3·60 + 0.7·242), which is what identified the resolution level as the cause
    /// rather than the colour choice.
    ///
    /// A concrete `Color(.secondaryLabel)` cannot be re-levelled by a context, because it is
    /// not a level: it is the platform's own secondary label colour in both schemes, which is
    /// also what the reference screen's `Section("…")` header draws (~132 grey on the 242
    /// page, ~3.3:1). Same class of fix as the `hide done` capsule the round before — a
    /// value the app names, instead of a style something else resolves.
    ///
    /// Kept as a `UIColor` alongside the SwiftUI colour, the same way `BoardBandCard` keeps
    /// its two surfaces: that is what lets a unit test RESOLVE the heading's ink for a scheme
    /// and compute its real contrast over the page, instead of trusting a comment.
    static let inkColor: UIColor = .secondaryLabel
    static let ink = Color(inkColor)
    /// The count's ink. Named separately from `ink` so it can be tuned on its own, and equal
    /// to it deliberately: the stock colour one real step quieter is `tertiaryLabel`, which
    /// composites to 1.71:1 on this page — the very number this round is fixing. There is no
    /// stock label grey between the two, so the count's step DOWN from the band's name is
    /// carried by TYPE SIZE (`count` is a footnote, `label` a subheadline) rather than by ink,
    /// which is how the platform's own grouped headers do it.
    static let countInkColor: UIColor = .secondaryLabel
    static let countInk = Color(countInkColor)

    /// Does the `hide done` control spell itself out, or draw as a glyph?
    ///
    /// A WORD at ordinary sizes, a GLYPH at accessibility sizes, and the reason is the same
    /// ladder the board's rows use: a heading is a label, a control and a count competing for
    /// one line, and at accessibility-XXXL "hide done" alone wants ~166pt of a 370pt row. The
    /// build that shipped this comment's predecessor squeezed the band label instead and
    /// hyphenated it — the heading read "Fo-cus" over two lines while the control still
    /// truncated to "hid…", i.e. every element lost. The glyph keeps the control's tap target
    /// and its accessibility label while giving the band's NAME the room.
    static func showsControlLabel(_ size: DynamicTypeSize) -> Bool { !size.isAccessibilitySize }

    /// Does the heading draw its row COUNT? Not at accessibility sizes.
    ///
    /// The last rung of the heading's ladder, and it was reached by measurement rather than
    /// taste. At accessibility-XXXL the heading has 330pt of content width and the four
    /// things on it want 16.5 (dot) + 118 ("Focus") + 84 (the control) + 85 (the count) + 27
    /// of spacing = 330.5 — half a point over, which is enough for the label to truncate to
    /// "Fo…". Every arrangement that keeps all four loses the band's NAME, so the count goes.
    ///
    /// It costs nothing a reader cannot get: the same number is on the band's own chip in
    /// the bar above ("Focus 152"), which is where a count is read from anyway. This is the
    /// same rule the rows use for the age token — the cheapest true thing is the first to go.
    static func showsCount(_ size: DynamicTypeSize) -> Bool { !size.isAccessibilitySize }
}
