import SwiftUI

// MARK: - The board's two filters: what they mean, and where they are persisted
//
// The desktop keeps these in a View dropdown (`ViewDropdown.tsx`): a grouping
// pair (`[['project','By project'],['none','Flat']]`) and a date pair
// (`[['','All'],['now','Now']]`). The phone gets the same two decisions in the
// same words.
//
// WHERE THEY ARE PICKED MOVED (2026-08-29, T84), and this file kept only the
// half that is not about layout. There used to be a `BoardFilterBar` view here:
// one scrolling List row above the bands holding two capsule segmented controls
// (Tier | By project, All | Now). It is gone because the board grew a permanently
// floating band bar, and two rows of chips would have been two places to pick a
// band: the bar's chips took over band selection, so grouping and dates folded
// into that bar's trailing edge (`BoardBandBar.filtersMenu`) rather than keeping
// a row of their own. One set of controls, one place, which is the whole point.
//
// What that leaves here is the vocabulary (`BoardFilterChoice`, so one generic
// builder can render either enum) and the persistence (`BoardFilterPrefs`).
// `TaskBoardModel` owns what the filters MEAN; this file owns how a stored string
// reads back. A retroactive conformance inside the same module keeps that split
// without a second copy of either.

/// The shape both board filters share, so ONE generic builder renders both.
protocol BoardFilterChoice: CaseIterable, Hashable {
    /// Doubles as the accessibility-identifier suffix, which is safe because both
    /// enums spell their raw values in `[a-z]` (`tier` / `project` / `all` /
    /// `now`): automation matches identifiers as REGEXES, and a raw value
    /// carrying `|`, `(`, `.` or `+` would either match the wrong element or
    /// nothing at all.
    var rawValue: String { get }
    /// The word on the control (the desktop's vocabulary, verbatim).
    var label: String { get }
}

extension BoardGrouping: BoardFilterChoice {}
extension BoardDateFilter: BoardFilterChoice {}

/// Where the board's filter choices are persisted, and how a stored string reads
/// back.
///
/// UserDefaults through `@AppStorage`, the way this app already persists a view
/// preference (`SettingsView`'s mic route, `NotesView`'s `notes.pinnedCollapsed`)
/// and the mirror of the desktop's own localStorage keys (`walnut-todo-groupBy` /
/// `walnut-todo-dateFilter`). No new store, and the raw STRING is what lands in
/// defaults because `@AppStorage` wants a plain type.
enum BoardFilterPrefs {
    static let groupingKey = "tasks.board.grouping"
    static let dateFilterKey = "tasks.board.dateFilter"

    /// Defaults, and the one place this surface deliberately disagrees with the
    /// desktop (which defaults to `project` + `now`).
    ///
    /// Tier, because the tier split IS the board's own structure: opening the
    /// screen into project headings would replace the board the user already
    /// knows with a different one they never asked for. All, because `now` HIDES
    /// rows, and the last bug on this screen was a task that existed everywhere
    /// except here ("I created a task in Pinned and it just disappeared"). A
    /// filter is allowed to hide work once the user has switched it on; it is not
    /// allowed to be the reason a board looks empty on first run.
    static let defaultGrouping = BoardGrouping.tier
    static let defaultDateFilter = BoardDateFilter.all

    /// A stored value that no longer parses (an older build, a hand-edited
    /// defaults plist) falls back to the default rather than to nothing: a
    /// preference is never worth an empty screen.
    static func grouping(_ raw: String) -> BoardGrouping {
        BoardGrouping(rawValue: raw) ?? defaultGrouping
    }

    static func dateFilter(_ raw: String) -> BoardDateFilter {
        BoardDateFilter(rawValue: raw) ?? defaultDateFilter
    }
}
