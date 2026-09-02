import SwiftUI

/// One toggle chip's whole presentation, as a VALUE.
///
/// A struct rather than four expressions inside the view body, for one reason: the chip's
/// promise is that its LABEL says what the board is doing and its HINT says what a tap
/// will do. Both are derived from the same enum value here, once, so a test can assert the
/// pair for every case instead of a screenshot being the only place the two are compared.
struct BoardViewChipSpec: Equatable {
    /// SF Symbol drawn before the label. The desktop chip's glyph, in the platform's own
    /// vocabulary (`↕` → `arrow.up.arrow.down`, `◷` → `clock`, its folder → `folder`).
    let symbol: String
    /// The word on the chip. The value's own `label`, never a second spelling of it —
    /// see `BoardViewBarModel`.
    let label: String
    /// What a tap does, for VoiceOver. A HINT and not a label: the label has to stay the
    /// visible word so a flow (or a person) matching "By project" finds this chip.
    ///
    /// It NAMES its destination using that value's own `label`, verbatim — so a listener hears
    /// the exact word the chip will show, and a renamed value cannot leave a stale spelling
    /// behind in an English sentence (`BoardViewBarTests` pins that).
    let hint: String
}

/// What the two toggle chips say, and what a tap lands on.
///
/// Pure, and deliberately separate from the view: "tap cycles the value" and "the label
/// names the ACTIVE value, not the one a tap would bring" are the two rules the shipped
/// menu could not get wrong (a menu lists every value) and a toggle chip can. They are
/// unit-tested (`BoardViewBarTests`) rather than eyeballed.
enum BoardViewBarModel {

    /// The grouping chip.
    ///
    /// # `Custom order` is the desktop's word for this mode, and it is the honest one
    ///
    /// The desktop's tier bar toggles `By project` ⇄ `↕ Custom order`, where "custom" means
    /// the manual pin order rather than project clusters. The phone's `BoardGrouping.tier`
    /// IS that mode: `BoardModel.tierBands` walks the tier split's own arrays, which the
    /// server returns in `pin_order` — so the rows under `.tier` are in the order the user
    /// arranged, and the only difference from the desktop is that the phone shows every
    /// tier at once (its bands ARE the tiers) where the desktop is already inside one tier
    /// tab. Same decision, same words, one screen shape apart.
    ///
    /// What the phone deliberately does NOT claim: it cannot EDIT that order (there is no
    /// drag on this board). The chip says what the board is showing, and the hint says what
    /// the tap does — neither promises a rearrange gesture.
    static func grouping(_ value: BoardGrouping) -> BoardViewChipSpec {
        switch value {
        case .project:
            return BoardViewChipSpec(
                symbol: "folder",
                label: value.label,
                hint: "Grouped by project, with folder headings. "
                    + "Tap for \(value.nextChoice.label), the order you pinned."
            )
        case .tier:
            return BoardViewChipSpec(
                symbol: "arrow.up.arrow.down",
                label: value.label,
                hint: "Your pinned order, in tier bands. "
                    + "Tap to switch to \(value.nextChoice.label)."
            )
        }
    }

    /// The date chip. The clock rides BOTH values, exactly as the desktop's `◷` does: the
    /// glyph names the DIMENSION (dates) and the word names the value, so the chip does not
    /// change shape when it changes state.
    static func date(_ value: BoardDateFilter) -> BoardViewChipSpec {
        switch value {
        case .now:
            return BoardViewChipSpec(
                symbol: "clock",
                label: value.label,
                hint: "Work with a future start date is hidden. "
                    + "Tap to show \(value.nextChoice.label)."
            )
        case .all:
            return BoardViewChipSpec(
                symbol: "clock",
                label: value.label,
                hint: "Every pinned task, deferred ones included. "
                    + "Tap to switch to \(value.nextChoice.label)."
            )
        }
    }
}

extension BoardFilterChoice {
    /// The value a chip tap lands on: the next case, wrapping.
    ///
    /// Derived from `allCases` rather than written out per enum, so this stays correct if a
    /// third value is ever added (the chip then cycles through it instead of silently
    /// skipping it — a toggle that cannot reach a stored value is how a board gets stuck in
    /// a filter with no control that turns it off).
    var nextChoice: Self {
        let all = Array(Self.allCases)
        guard let index = all.firstIndex(of: self), !all.isEmpty else { return self }
        return all[(index + 1) % all.count]
    }
}

/// The board's VIEW BAR: the grouping and date decisions as TWO inline toggle chips, side
/// by side, on the bar rather than one tap inside a menu.
///
/// # Why it exists, in the user's words
///
/// "它不是在一个菜单里面,它就是在那个 bar 里面" — the two controls are not menu rows, they
/// are chips you can see and tap. This is the phone's copy of the desktop's own
/// `tier-view-bar` (`TodoPanel.tsx`): exactly two chips, each showing the ACTIVE value,
/// each cycling on tap, no menu and no submenu. Structure and affordance ported; nothing
/// about the desktop's CSS is (the capsule is the same tinted control the band headings'
/// `show done` already uses, so the board has one control language).
///
/// # Where it sits, and why not inside the band bar
///
/// It is header ROW THREE: band chips (row 2, the only row that pins), then this, then the
/// quick add. It is NOT a third zone inside the band bar's card, and that is arithmetic
/// rather than taste — the band bar's card is partitioned `rail + railSpacing +
/// filtersColumn`, with the rail holding over 80% of the card width
/// (`TasksBoardChipRowTests.testTheRailKeepsMostOfTheCard`). Two chips of real words are
/// ~150pt of a 370pt card, so putting them in there would take the band rail below that
/// floor: the constantly-tapped control (which band am I looking at) would lose its width
/// to two controls set once a session. A row of its own costs `TasksChromeMetrics.viewBar`
/// once and takes nothing from the rail.
///
/// The band bar's trailing filters control stays where it is, holding the SAME two values
/// through the same bindings (one source of truth, no second copy of the state). It is no
/// longer the way you set them — it is what remains reachable once row 3 has scrolled away
/// under the pinned band bar, and it is the presentation that scrolls at accessibility type
/// sizes (`BoardBandBar.filtersPresentation`). A control that can be reached at only one
/// scroll position would be a regression dressed as a simplification.
///
/// # Fixed height, capped type
///
/// The height is a constant (`TasksChromeMetrics.viewBar`) because of what this row IS, not
/// because an arithmetic term needs it: it is a header row on the screen whose job is showing
/// rows, so a row that grew with the content size category would push every task row down at
/// accessibility sizes. (`chromeHeight` does count it, but nothing in the app reads the
/// board's chrome height — the board has no compact bar. Its live threshold is
/// `chipsPinThreshold`, which counts only what rides above row 2.) So the chips cap their type
/// the way the band chips do (`BoardBandBar.chipTypeCap`) instead of the row growing to fit
/// them, and the bar scrolls horizontally rather than wrapping — a second line would move
/// every task row under it just as surely.
struct BoardViewBar: View {
    @Binding var grouping: BoardGrouping
    @Binding var dateFilter: BoardDateFilter

    /// Gap between the two chips.
    static let chipSpacing: CGFloat = 8

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Self.chipSpacing) {
                chip(
                    BoardViewBarModel.grouping(grouping),
                    identifier: "board.view.grouping"
                ) { grouping = grouping.nextChoice }
                chip(
                    BoardViewBarModel.date(dateFilter),
                    identifier: "board.view.date"
                ) { dateFilter = dateFilter.nextChoice }
            }
            // The chips line up with the band HEADINGS below them (same content inset),
            // which is what makes this row read as part of the board's own column rather
            // than as a floating strip.
            .padding(.horizontal, BoardBandCard.headingContentInset)
            .frame(height: TasksChromeMetrics.viewBar)
        }
        .frame(height: TasksChromeMetrics.viewBar)
        .dynamicTypeSize(...BoardBandBar.chipTypeCap)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("board.viewBar")
    }

    /// One toggle chip: tinted label in a soft tinted capsule — the same treatment the
    /// band headings' `show done` control carries, so the board has one word for "this is
    /// a control you can tap" instead of a new one per row.
    private func chip(
        _ spec: BoardViewChipSpec, identifier: String, cycle: @escaping () -> Void
    ) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            cycle()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: spec.symbol)
                    .font(.caption2.weight(.bold))
                Text(spec.label)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(Theme.tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Theme.tintSoft, in: Capsule())
            // MIN height, not a fixed one: the label scales up to the cap, and a hard
            // height would clip it there (the `show done` control learned this first).
            .frame(minHeight: 28)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
        // The visible word stays the accessibility LABEL (a flow, or a person, matching
        // "By project" has to find this chip); what a tap will do is the HINT.
        .accessibilityLabel(spec.label)
        .accessibilityHint(spec.hint)
    }
}
