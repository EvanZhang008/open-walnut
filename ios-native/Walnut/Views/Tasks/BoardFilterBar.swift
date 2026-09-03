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
    /// LEGACY: the single grouping value builds up to 2026-09-02 wrote. Still READ (see
    /// `grouping(scope:modes:legacy:)`) so a user's current setting migrates instead of
    /// being silently reset; no longer written, because `groupingModesKey` is the store.
    static let groupingKey = "tasks.board.grouping"
    /// grouping-per-tier, as a JSON object (`{"focus":"project","__all__":"tier"}`).
    ///
    /// A MAP and not one value, mirroring the desktop's `walnut-todo-tier-view-modes`: the
    /// grouping is a property of the tier you are looking at, so each tier remembers how it
    /// was last viewed and switching tiers restores that tier's own mode rather than
    /// carrying one over.
    static let groupingModesKey = "tasks.board.groupingModes"
    static let dateFilterKey = "tasks.board.dateFilter"
    /// The TIER the chip rail has narrowed to ("" = the whole board).
    ///
    /// Persisted, which is a change: it used to be `@State` cleared on every grouping
    /// switch, on the reasoning that `focus` and `proj:marina` are different id spaces.
    /// That reasoning is gone — the rail only ever holds tier ids now — and what is left is
    /// an ordinary view preference, so it survives a grouping switch, a tab switch and a
    /// relaunch like the two above it.
    static let tierScopeKey = "tasks.board.tierScope"

    /// The map key the `All` scope stores its grouping under. Underscored so it cannot
    /// collide with a tier id (`focus`, `ct_*`).
    static let allScopeKey = "__all__"

    static func modeKey(_ scope: String?) -> String { scope ?? allScopeKey }

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

    // MARK: - The grouping map (one mode per tier)

    /// The stored map, decoded PER ENTRY.
    ///
    /// Nothing here can throw a whole preference away: a value that is not JSON, not an
    /// object, or an object holding a number/null yields an empty map, and ONE unreadable
    /// entry inside an otherwise good object drops only that entry. A partly written or
    /// hand-edited plist must cost the tier it names, not every tier.
    static func groupingModes(_ raw: String) -> [String: BoardGrouping] {
        guard let data = raw.data(using: .utf8), !data.isEmpty else { return [:] }
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any]
        else { return [:] }
        var modes: [String: BoardGrouping] = [:]
        for (key, value) in dictionary {
            guard
                !key.isEmpty, let raw = value as? String,
                let grouping = BoardGrouping(rawValue: raw)
            else { continue }
            modes[key] = grouping
        }
        return modes
    }

    /// The grouping in force for one scope.
    ///
    /// Three layers, most specific first: this tier's own stored mode, then the LEGACY
    /// single value (so a setting an installed build already wrote becomes every tier's
    /// starting point rather than being discarded), then the default.
    static func grouping(scope: String?, modes: String, legacy: String) -> BoardGrouping {
        if let stored = groupingModes(modes)[modeKey(scope)] { return stored }
        return grouping(legacy)
    }

    /// The map to store after the reader switched ONE scope's grouping. Every other
    /// scope's entry is carried through untouched — that is what "each tier remembers its
    /// own" means as code.
    static func withGrouping(
        _ grouping: BoardGrouping, scope: String?, modes: String
    ) -> String {
        var updated = groupingModes(modes)
        updated[modeKey(scope)] = grouping
        let encodable = updated.mapValues(\.rawValue)
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: encodable, options: [.sortedKeys]
            ),
            let json = String(data: data, encoding: .utf8)
        else { return modes }
        return json
    }

    // MARK: - The tier scope

    /// A stored tier scope, or nil for the whole board.
    ///
    /// Two rules, both about never honouring an unreachable state. Blank (and blank after
    /// trimming) is "no scope", which is what an untouched install holds. And a value
    /// carrying a `:` is refused outright: every band prefix on this board has one
    /// (`proj:`, `folder:`) and no tier id ever does, so a band id left behind by an older
    /// build — or typed into a plist — reads as the whole board instead of as a scope the
    /// rail has no chip for.
    static func scope(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains(":") else { return nil }
        return trimmed
    }

    /// What `scope` reads back: the inverse, for writing.
    static func rawScope(_ scope: String?) -> String { scope ?? "" }
}
