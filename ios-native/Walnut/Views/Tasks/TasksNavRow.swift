import SwiftUI

/// The Tasks tab's top row: THREE entries, as compact text chips.
///
/// # What this replaced, and why
///
/// It was a 2x3 grid of horizontally scrolling summary cards, one per `TaskFilter`
/// (Board / Today / Calendar / In Progress / All Open / Done), 104pt tall with a
/// big count on each. Six destinations, of which the user used two, above the
/// screen whose whole job is showing rows. It is now Pin | All Tasks | Calendar:
/// the board, the flat open list, and the calendar.
///
/// And it SCROLLS AWAY with the content ("the first one should only be at top").
/// Nothing here is pinned; on the board the permanently floating thing is
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
/// filter that no longer has one.
enum TasksNavEntry: String, CaseIterable, Identifiable {
    /// The pinned board (`TaskFilter.sessions` — the case keeps its old name so
    /// every stored preference and `tasks.card.sessions`-era id still resolves).
    case pin
    /// Every open task, grouped by project.
    case all
    /// The calendar surface (full-bleed; it is not a List).
    case calendar

    var id: String { rawValue }

    var filter: TaskFilter {
        switch self {
        case .pin: return .sessions
        case .all: return .allOpen
        case .calendar: return .calendar
        }
    }

    /// The word on the chip. "Pin" is the user's own name for the board ("他现在每个
    /// 任务都在 pin 里面"), so the chip says what they say.
    var title: String {
        switch self {
        case .pin: return "Pin"
        case .all: return "All Tasks"
        case .calendar: return "Calendar"
        }
    }

    var systemImage: String {
        switch self {
        case .pin: return "pin"
        case .all: return "tray.full"
        case .calendar: return "calendar"
        }
    }

    /// `tasks.nav.pin` / `tasks.nav.all` / `tasks.nav.calendar`. ASCII by
    /// construction (the raw values are `[a-z]`), because automation matches
    /// identifiers as REGEXES.
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

/// The three entries as compact chips. Deliberately NOT counts: the cards' big
/// numbers were the noisiest thing about them, and the count that matters on the
/// board is per-band, which `BoardBandBar` carries.
struct TasksNavRow: View {
    @Binding var activeFilter: TaskFilter

    var body: some View {
        // ONE horizontal ScrollView, and it is an accessibility fix (2026-08-29
        // refutation). At accessibility-XXXL the three chips could not fit a 402pt row,
        // so each one truncated its label to a single letter: the header read "P | A |
        // C" and the destinations became unguessable. `lineLimit(1)` was doing exactly
        // what it was asked to.
        //
        // Scrolling rather than wrapping, capping the type size, or dropping the
        // labels: this row is three fixed destinations read left to right, a wrap would
        // change the header's height (and with it the collapse arithmetic
        // `TasksChromeMetrics` pins) at one type size and not another, and the chips
        // must stay READABLE at the size the user chose — that is the whole point of
        // the setting. The row scrolls away with the content anyway, so a horizontal
        // scroll here costs nothing that was pinned.
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TasksNavEntry.allCases) { entry in
                    chip(entry)
                }
            }
        }
        // The row is as tall as its chips and never taller, so a large type size grows
        // the row instead of clipping the capsules.
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        // `children: .contain` BEFORE the container id: a container identifier
        // REPLACES every descendant's, and these three chips are exactly what
        // automation taps.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks.nav")
    }

    private func chip(_ entry: TasksNavEntry) -> some View {
        let selected = TasksNavEntry.entry(for: activeFilter) == entry
        return Button {
            guard !selected else { return }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            activeFilter = entry.filter
        } label: {
            HStack(spacing: 5) {
                Image(systemName: entry.systemImage)
                    .font(.caption2.weight(.bold))
                Text(entry.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
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
