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
/// affordance from `tierId != activeTierId`, i.e. from the id's MEANING).
///
/// # V1 "edge-to-edge": ONE List, no cards
///
/// The user rejected the previous look twice, in the same words both times: "那个
/// 框是方形的,根本就不 elegant" — the box is a square, it isn't elegant. The
/// diagnosis (mockup `variants.html`, variant V1, the one they picked) was that
/// the CONTAINER was the problem and the row was not: every band sat in an
/// `insetGrouped` card, so a board of 14 rows read as a stack of boxes. V1 throws
/// the boxes away and keeps one sheet of paper: plain background, full-bleed
/// rows, a 0.5pt hairline between rows inset to the TITLE (the ring's gutter
/// stays clear), 12-14pt of vertical air, and a band heading that floats on a
/// blurred material.
///
/// Mechanism, and why it is not `listStyle`: the board is ONE section set inside
/// the Tasks tab's single shared `List`. That List is load-bearing three times
/// over — the scroll position, the `.searchable` nav-bar drawer, and the
/// chrome-collapse `onScrollGeometryChange` observer all hang off it — and
/// `listStyle` takes a CONCRETE `ListStyle` type, so selecting one per filter
/// means two `List` expressions and therefore two List identities: switching
/// filters would rebuild the scroll view, drop the offset, and re-arm the
/// observer. So the style stays `.insetGrouped` for every filter and the board
/// neutralises the card per ROW instead: `listRowBackground(Color.clear)` (no
/// box, and no rounded-corner artefacts either, which is what a coloured row
/// background would have left behind), zero horizontal `listRowInsets` so the
/// section's own margin IS the sheet's gutter, native separators moved to the
/// title with `alignmentGuide(.listRowSeparatorLeading)`, and `listSectionSpacing(0)`
/// so the heading's own padding is the only gap between bands. Every one of
/// those is a VALUE, not a structural branch, so nothing about the List's
/// identity depends on which filter is showing.
///
/// The sheet colour itself is the one thing this view cannot set (a row cannot
/// paint the scroll view behind it): `TasksView` hides the grouped background and
/// supplies `systemBackground` on the board, `systemGroupedBackground` everywhere
/// else, which is again one modifier with a computed value.
struct TaskBoardList: View {
    let bands: [BoardBand]
    let tierChoices: [(id: String, label: String)]
    /// Band ids whose `hide done` is on. A BAND id, not a tier id: under project
    /// grouping these are `proj:<name>`, which is why the model namespaces them.
    let hiddenDoneBands: Set<String>
    /// Which band's create row is open, by band id (nil = none).
    let openCreateBand: String?
    /// Just-created row id — keeps a green edge so its landing place is visible.
    let newRowId: String?
    /// taskId → tier id, for the tier menu's checkmark.
    let tierOf: [String: String]

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

    /// A band's heading id, so a chip tap can land on it. Deliberately the RAW
    /// band id and not `slug()`: a scroll anchor has to be unique or the jump goes
    /// to the wrong heading, and two projects differing only in ASCII punctuation
    /// still share a slug. Nothing matches this as a regex, so the raw id is safe
    /// here (accessibility ids are the ones that must fold).
    static func anchorId(_ bandId: String) -> String { "board.band.\(bandId)" }

    var body: some View {
        ForEach(bands) { band in
            Section {
                ForEach(band.rows) { row in
                    TaskBoardRow(
                        row: row,
                        state: BoardModel.state(task: row.task, session: row.session),
                        isNew: row.id == newRowId,
                        onToggleDone: { onToggleDone(row) },
                        onOpenSession: { onOpenSession(row) }
                    )
                    // V1: full bleed. ZERO horizontal insets, so the row's content
                    // starts on the section's own margin — that margin is the
                    // sheet's 16pt gutter and it is the ONE horizontal number here,
                    // which is why the whole board shifts together if the OS ever
                    // changes it. Vertical 12 + the row's own 2 = the 13-14pt of
                    // air the mockup specifies.
                    .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0))
                    // No card. `Color.clear` and not a solid colour on purpose: a
                    // coloured row background is still a BOX (insetGrouped rounds
                    // the section's first/last row, so a solid fill would leave
                    // visible corner joins mid-band), while clear lets the one
                    // sheet TasksView paints show through unbroken.
                    .listRowBackground(Color.clear)
                    // The hairline starts at the TITLE, not at the row edge, so the
                    // ring's gutter stays clear (mockup: `left: 48px`). The guide is
                    // measured in the row's own content space, which is why the
                    // constant lives next to the ring/spacing arithmetic that
                    // produces it.
                    .alignmentGuide(.listRowSeparatorLeading) { _ in
                        TaskBoardRow.separatorLeadingInset
                    }
                    // …and it runs all the way to the sheet's edge. The default
                    // trailing inset left the hairline stopping 32pt short of the
                    // screen (16pt sheet gutter + a 16pt separator inset) while the
                    // leading end was inset 55pt, and the asymmetry read as a mistake
                    // rather than as a decision: the line looked like it was pointing
                    // at nothing. The mockup runs it to the edge, and the geometry is
                    // now deliberate on both ends — the LEADING inset says "the ring's
                    // gutter is not part of the row's text", and the TRAILING end says
                    // "the sheet ends here", which is the same x the section margin
                    // gives every other element on the board.
                    .alignmentGuide(.listRowSeparatorTrailing) { dimension in
                        dimension[.trailing]
                    }
                    // Separators BETWEEN rows only (mockup: `.row + .row::before`).
                    // The last row of a band must not draw one, or a line would sit
                    // immediately above the create ring / the next band's heading —
                    // which is exactly the "box edge" look this restyle removes.
                    .listRowSeparator(row.id == band.rows.last?.id ? .hidden : .visible, edges: .bottom)
                    // And nothing above the first row: the floating heading is the
                    // band's top edge.
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
                // A band with no `createSeed` gets no ring: the tail band is the
                // COMPLEMENT of the others, so "create here" has no destination
                // to mean. That used to be spelled `tierId != activeTierId`,
                // which quietly assumed every non-tail band was a TIER band.
                if let seed = band.createSeed {
                    createFoot(band, seed: seed)
                }
            } header: {
                heading(band)
            }
            // V1 has no gap between bands: the heading's own 17pt of top padding
            // is the rhythm. A section gap here would re-draw the seam this
            // restyle exists to remove.
            .listSectionSpacing(0)
        }
    }

    // MARK: - Sticky heading

    /// The band heading: floats on a blurred material so rows sliding underneath
    /// stay legible (mockup V1: `backdrop-filter: blur(14px)` over a 90%-opaque
    /// sheet). `.bar` is the same material the app's other floating headers use,
    /// so this reads as one system rather than a bespoke blur.
    private func heading(_ band: BoardBand) -> some View {
        HStack(spacing: 7) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Self.bandColor(band.bandId))
                .frame(width: 3, height: 13)
            Text(band.label.uppercased())
                .font(.system(size: 11, weight: .bold))
                .kerning(0.6)
                .foregroundStyle(.secondary)
            // The done toggle lives on the heading it affects — a global switch
            // would hide completions in bands the user isn't looking at.
            //
            // EVERY band has one now, the tail included (2026-08-29). It used to be
            // omitted there because `BoardModel.unfiledRows` did not read the hide-done
            // set, and a control that quietly does nothing is worse than an absent one
            // — but the honest fix was the model's, not the heading's: the tail is the
            // complement of every tier, i.e. the band most likely to be buried under a
            // completed backlog (2,903 of 3,161 rows on the real board), so it is the
            // last band that should have been unable to fold them away. Project bands
            // can never collide with this id because their own ids are `proj:`-prefixed.
            Button {
                onToggleHideDone(band.bandId)
            } label: {
                Text(hiddenDoneBands.contains(band.bandId)
                    ? "show done\(band.hiddenDone > 0 ? " (\(band.hiddenDone))" : "")"
                    : "hide done")
                    .font(.system(size: 10.5, weight: .semibold))
                    .textCase(nil)
                    .foregroundStyle(Theme.tint)
                    .frame(height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("board.hideDone.\(Self.slug(band.bandId))")
            Spacer(minLength: 6)
            Text(band.count.formatted(.number))
                .font(.system(size: 11, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .accessibilityIdentifier("board.count.\(Self.slug(band.bandId))")
        }
        // Grouped-list headers uppercase their text for free; the label is already
        // uppercased by hand (so the kerning is ours) and `hide done` must stay
        // lowercase, so the automatic transform is switched off for the whole row.
        .textCase(nil)
        .padding(.top, 17)
        .padding(.bottom, 7)
        .padding(.trailing, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
        // Full bleed for the material, same zero-inset rule as the rows: the
        // heading's text then lines up with the titles below it, because both
        // start on the section margin.
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .id(Self.anchorId(band.bandId))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("board.heading.\(Self.slug(band.bandId))")
    }

    // MARK: - Create at the foot

    @ViewBuilder
    private func createFoot(_ band: BoardBand, seed: NewTaskSeed) -> some View {
        if openCreateBand == band.bandId {
            createRow(band.bandId, seed)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                .listRowBackground(Color.clear)
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
                .frame(height: 34)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 8, trailing: 0))
            .listRowBackground(Color.clear)
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
        case BoardModel.activeTierId: return Theme.success
        default: return Theme.tint
        }
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
                Button(action: onOpenSession) {
                    Label(row.session == nil ? "Start Session" : "Open Session",
                          systemImage: row.session == nil ? "play.circle" : "bubble.left.and.text.bubble.right")
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
