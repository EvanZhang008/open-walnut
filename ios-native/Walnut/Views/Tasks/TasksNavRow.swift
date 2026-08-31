import SwiftUI

/// The Tasks tab's top row: TWO entries, as compact text chips.
///
/// # What this replaced, and why
///
/// It was a 2x3 grid of horizontally scrolling summary cards, one per `TaskFilter`
/// (Board / Today / Calendar / In Progress / All Open / Done), 104pt tall with a
/// big count on each. Six destinations, of which the user used two, above the
/// screen whose whole job is showing rows. Then it was three chips — Pin | All
/// Tasks | Calendar — and it is now Pin | Calendar.
///
/// # Why "All Tasks" is gone (and it is the same question as the tail band)
///
/// "已经有 pin 了,为什么还会有 all task". The board IS the working set, so a flat
/// list of every open task was a SECOND answer to "what am I working on" — and the
/// two disagreed by three thousand rows. It also cost what the board's retired
/// "Everything else" band cost, for the same reason: both were the whole store
/// rendered as a list (see the tombstone in `TaskBoardModel.swift`).
///
/// Unpinned work is reachable by SEARCH, which is a server query rather than a
/// client-side walk, and the board's own search lane already appends matching open
/// tasks below the bands (`TasksView.sections(excluding:)`). So the destination did
/// not disappear; the standing list of it did.
///
/// And this row SCROLLS AWAY with the content ("the first one should only be at
/// top"). Nothing here is pinned; on the board the permanently floating thing is
/// `BoardBandBar`, one row down, because that is the control the user reaches for
/// while reading rows.
///
/// # The enum cases stayed
///
/// `TaskFilter` still has all six cases and they are NOT deprecated: they are the
/// store's own slices (`tasks(for:)`, `count(for:)`), they are the suffix of
/// shipped accessibility ids (`tasks.compactChip.inprogress`), and a stored
/// preference may still name one. Removing a case would have been a data
/// migration in exchange for nothing. What changed is which ones have a HEADER
/// ENTRY, which is what `TasksNavEntry` is: the entry set, and the fallback for a
/// filter that no longer has one — which now catches `.allOpen` too, so a phone
/// that persisted the old pill lands on the board instead of on a chipless header.
enum TasksNavEntry: String, CaseIterable, Identifiable {
    /// The pinned board (`TaskFilter.sessions` — the case keeps its old name so
    /// every stored preference and `tasks.card.sessions`-era id still resolves).
    case pin
    /// The calendar surface (full-bleed; it is not a List).
    case calendar

    var id: String { rawValue }

    var filter: TaskFilter {
        switch self {
        case .pin: return .sessions
        case .calendar: return .calendar
        }
    }

    /// The word on the chip. "Pin" is the user's own name for the board ("他现在每个
    /// 任务都在 pin 里面"), so the chip says what they say.
    var title: String {
        switch self {
        case .pin: return "Pin"
        case .calendar: return "Calendar"
        }
    }

    var systemImage: String {
        switch self {
        case .pin: return "pin"
        case .calendar: return "calendar"
        }
    }

    /// `tasks.nav.pin` / `tasks.nav.calendar`. ASCII by construction (the raw
    /// values are `[a-z]`), because automation matches identifiers as REGEXES.
    ///
    /// `tasks.nav.all` is the ONE shipped identifier this round retires, and it is
    /// retired rather than repointed: an id that still resolves but drives a
    /// different destination is worse than one that resolves to nothing, because a
    /// flow keeps passing while doing something else.
    var identifier: String { "tasks.nav.\(rawValue)" }

    /// The entry that owns a filter, or nil when the filter has no header entry
    /// (Today / In Progress / Done — reachable state, no chip).
    static func entry(for filter: TaskFilter) -> TasksNavEntry? {
        allCases.first { $0.filter == filter }
    }

    /// The filter to actually SHOW, given one that may have no entry any more.
    ///
    /// Falls back to Pin, and the fallback is not theoretical: a stored preference
    /// written by an older build, a deep link, or a future persisted `activeFilter`
    /// can all name `.today`. Without this the header would render with no chip
    /// selected over a list the user cannot switch away from — a soft dead end,
    /// which is the failure mode a fallback is cheap insurance against.
    static func resolve(_ filter: TaskFilter) -> TaskFilter {
        entry(for: filter)?.filter ?? TasksNavEntry.pin.filter
    }
}

/// The entries as compact chips. Deliberately NOT counts: the cards' big numbers
/// were the noisiest thing about them, and the count that matters on the board is
/// per-band, which `BoardBandBar` carries.
struct TasksNavRow: View {
    @Binding var activeFilter: TaskFilter

    /// Gap between chips. Named because the width arithmetic below has to subtract it.
    static let chipSpacing: CGFloat = 8

    /// The row's own width, measured. 0 = not measured yet (first pass), which means
    /// "no cap" rather than "a cap of zero".
    @State private var rowWidth: CGFloat = 0

    /// The widest ONE chip may be so that `count` of them always fit the row, whatever
    /// their labels say — or nil when the row's width isn't known yet.
    ///
    /// The FAIR SHARE, and it is the only cap that can be computed without measuring text:
    /// with two chips capped at half the row each, the pair fits by arithmetic. It is the
    /// LAST resort of the three layouts below, so it only ever bites on a row where even the
    /// leanest full-label layout does not fit — and there it truncates with an ellipsis
    /// inside an intact capsule, which is what the sliced-capsule defect was missing.
    ///
    /// Fair share and not a constant, because the row's width is the device's: 402pt of
    /// screen minus the List's 16pt margins here, 343 on an SE, more on a Max.
    static func chipMaxWidth(container: CGFloat, count: Int, spacing: CGFloat) -> CGFloat? {
        guard container > 0, count > 0 else { return nil }
        let gaps = spacing * CGFloat(count - 1)
        let share = (container - gaps) / CGFloat(count)
        // A share this small means the caller measured something that is not a row yet;
        // capping to it would draw two ellipses instead of two words.
        guard share > 40 else { return nil }
        return share
    }

    var body: some View {
        // THREE layouts, richest first, and the platform picks the first that FITS
        // (`ViewThatFits`). It replaces a horizontal `ScrollView`, and the replacement is
        // the R30 accessibility fix.
        //
        // The history matters because each round fixed the previous round's failure mode.
        // (1) Fixed chips + `lineLimit(1)`: at accessibility-XXXL three chips truncated to
        // single letters, "P | A | C". (2) A scroll view: labels stayed whole, but the
        // VIEWPORT then sliced the last capsule flat mid-word at x=370, no ellipsis, no
        // rounded cap — a rendering fault, and a scroll affordance nobody can see is not an
        // affordance. (3) This: the row asks for what it can afford.
        //
        //   - glyph + full label — the ordinary look, chosen at every ordinary type size.
        //   - full label, NO glyph — the accessibility case. The icon and the word say the
        //     same thing and the icon costs ~42pt per chip of a 370pt row, which is what
        //     the pair was overflowing by, so spending the decoration keeps both WORDS.
        //   - no glyph, label capped at `chipMaxWidth` — fits by construction on any width,
        //     and truncates honestly (tail ellipsis, capsule intact) when it has to.
        //
        // Nothing here can be clipped by a viewport, so there is nothing left to scroll:
        // the last candidate always fits. And the row still grows VERTICALLY with the type
        // size, which is what it always did (the chips are intrinsically sized).
        ViewThatFits(in: .horizontal) {
            chipRow(glyphs: true, cap: nil)
            chipRow(glyphs: false, cap: nil)
            chipRow(glyphs: false, cap: Self.chipMaxWidth(
                container: rowWidth,
                count: TasksNavEntry.allCases.count,
                spacing: Self.chipSpacing
            ))
        }
        // Leading, so the chips start at the row's edge rather than centring when they are
        // narrower than it.
        .frame(maxWidth: .infinity, alignment: .leading)
        // Measure the row, don't guess it — the fair-share cap needs a real width. A
        // `background` probe rather than wrapping the row in a `GeometryReader`: a
        // GeometryReader fills the proposal in BOTH axes, so it would take the row's height
        // away from its chips (and this row's height feeds `TasksChromeMetrics`).
        .background(alignment: .top) {
            GeometryReader { geo in
                Color.clear
                    .onChange(of: geo.size.width, initial: true) { _, width in
                        rowWidth = width
                    }
            }
        }
        // `children: .contain` BEFORE the container id: a container identifier
        // REPLACES every descendant's, and these chips are exactly what automation
        // taps (`tasks.nav.pin`, `tasks.nav.calendar`).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks.nav")
    }

    /// One candidate layout: the same chips, told how much they may draw.
    private func chipRow(glyphs: Bool, cap: CGFloat?) -> some View {
        HStack(spacing: Self.chipSpacing) {
            ForEach(TasksNavEntry.allCases) { entry in
                chip(entry, glyph: glyphs, maxWidth: cap)
            }
        }
    }

    private func chip(_ entry: TasksNavEntry, glyph: Bool, maxWidth: CGFloat?) -> some View {
        let selected = TasksNavEntry.entry(for: activeFilter) == entry
        return Button {
            guard !selected else { return }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            activeFilter = entry.filter
        } label: {
            HStack(spacing: 5) {
                if glyph {
                    Image(systemName: entry.systemImage)
                        .font(.caption2.weight(.bold))
                }
                Text(entry.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    // Tail ellipsis, stated: a capped label must LOOK truncated. The
                    // failure this replaces was a capsule sliced by the viewport, which
                    // says nothing at all.
                    .truncationMode(.tail)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            // The cap goes OUTSIDE the padding and INSIDE the background, so the capsule
            // is drawn around the capped frame and keeps both of its round caps.
            .frame(maxWidth: maxWidth, alignment: .leading)
            .foregroundStyle(selected ? Theme.onTint : Color.secondary)
            .background(
                selected ? AnyShapeStyle(Theme.tint) : AnyShapeStyle(.quaternary),
                in: Capsule()
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(entry.identifier)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}
