import Foundation

// MARK: - Create-time pin placement (POST /api/v1/tasks `pinned` + `focus_tier`)
//
// Filing a task used to be two writes: create, then pin/move-tier. That second
// write is where "I created it but it went to Satellite" came from — a failure
// there silently dropped the task to the default tier with no error anywhere.
// The server now takes the tier IN the create call (api-v1.md, 2026-08-27), and
// this type is the phone's single definition of what that create BODY looks
// like, so every surface (the sheet, the quick-add row, a group header's +)
// sends the same shape.
//
// Three wire rules, straight from the contract — every one of them is encoded
// below rather than restated at call sites:
//
//   1. A tier IMPLIES pinned, so `pinned` is OMITTED next to a `focus_tier`.
//      Sending `pinned: true` alongside is redundant and `pinned: false`
//      alongside is a 400 (a contradiction the server refuses to half-honor).
//   2. `satellite` normalizes AWAY server-side: the row stores as pinned with
//      NO tier, so the 201 response omits `focus_tier`. Its absence is how
//      Satellite is stored — never read it back as a failure.
//   3. An unknown tier is a 400, never a silent downgrade. So a stale custom
//      tier id must surface as an error the human sees, which is why
//      `isResolvable(builtinIds:customTierIds:)` exists for pre-flight checks
//      and nothing here ever "fixes" a bad value by falling back to Satellite.

/// Where a task being created should be filed on the pinned board.
enum TaskPinChoice: Equatable, Hashable {
    /// Say nothing — the create omits both fields and the server applies its
    /// own default (`newTaskPinDefault`: a person's task lands on the board in
    /// Satellite). Byte-for-byte the pre-`focus_tier` create behavior, which is
    /// what keeps an unchanged call site unchanged.
    case unspecified
    /// Explicitly off the board (`pinned: false`).
    case notPinned
    /// Born in this tier: a built-in (`focus` | `satellite` | `backlog` |
    /// `wait`) or a registered custom tier id (`ct_*`).
    case tier(String)

    /// `pinned` for the create body; nil = omit the key.
    var wirePinned: Bool? {
        switch self {
        case .unspecified: return nil
        case .notPinned: return false
        // Rule 1: a tier implies pinned, so the key never rides along.
        case .tier: return nil
        }
    }

    /// `focus_tier` for the create body; nil = omit the key.
    var wireFocusTier: String? {
        if case .tier(let id) = self { return id }
        return nil
    }

    /// Tier id to write into the local `taskTiers` map the instant the row
    /// appears. nil = nothing known to show (either not pinned, or the server
    /// decides and the background tier refresh will say).
    ///
    /// `satellite` stays `"satellite"` here even though the server stores
    /// nothing: that is exactly what `TasksStore.tierMap` derives for a pinned
    /// row in no explicit bucket, so the optimistic value and the reconciled
    /// one agree instead of flickering (rule 2).
    var optimisticTier: String? {
        if case .tier(let id) = self { return id }
        return nil
    }

    /// `pinned` flag for the optimistic local row. nil = unknown, leave the
    /// server row's own value alone.
    var optimisticPinned: Bool? {
        switch self {
        case .unspecified: return nil
        case .notPinned: return false
        case .tier: return true
        }
    }

    /// True when this choice names a tier (the case that needs a "landed in X"
    /// confirmation, since the new row may not be visible from where the user
    /// was standing when they added it).
    var namesTier: Bool { optimisticTier != nil }

    /// Would the server accept this tier? Checked BEFORE sending so a stale
    /// custom tier id (deleted on the desktop since the registry was fetched)
    /// becomes a message about the tier rather than a raw 400 about the task.
    /// `.unspecified` / `.notPinned` are always fine.
    func isResolvable(builtinIds: [String], customTierIds: [String]) -> Bool {
        guard case .tier(let id) = self else { return true }
        return builtinIds.contains(id) || customTierIds.contains(id)
    }

    /// Stable key for SwiftUI state / accessibility identifiers.
    var key: String {
        switch self {
        case .unspecified: return "default"
        case .notPinned: return "none"
        case .tier(let id): return id
        }
    }
}

/// What a group header's `+` hands to the add row underneath it: a task created
/// there inherits the group it was created IN, which is the whole point of the
/// affordance (a project header seeds the project, a tier header seeds the tier).
///
/// Deliberately a value type with a derived `id`: the list tracks WHICH header is
/// currently open by identity, so re-deriving the same seed for the same header
/// on a later body pass must compare equal or the open add row would collapse.
struct NewTaskSeed: Equatable, Identifiable {
    /// Project to file into. "" = Inbox (also what the "Inbox" header means).
    var project: String
    /// Pin placement to file into.
    var pin: TaskPinChoice

    /// Stable identity AND the accessibility-identifier suffix, so it must be
    /// automation-safe: Maestro matches ids as REGEXES, so a raw project name
    /// carrying `|`, `(`, `.`, `+` etc. either matches the wrong element or
    /// nothing at all (a literal `|` separator made `tasks.groupAdd.default|marina`
    /// an alternation and the `+` became unaddressable). Everything outside
    /// `[A-Za-z0-9]` collapses to `_`.
    var id: String { "\(Self.slug(pin.key))_\(Self.slug(project))" }

    /// Lowercase alphanumeric run, other characters folded to `_`. Not reversible
    /// and not meant to be: the seed itself carries the real project/tier, this
    /// is only a key. Two projects that differ solely in punctuation would share
    /// a key, which costs at most one add row opening on the wrong header — the
    /// values compared for identity are the fields, not this string.
    ///
    /// An empty input yields an empty component, which is fine because the `_`
    /// separator sits at a FIXED position: the empty project reads as a trailing
    /// separator (`focus_`) rather than a second underscore.
    static func slug(_ raw: String) -> String {
        String(raw.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "_" })
    }

    /// A project section's header. The display name "Inbox" is the empty
    /// project, not a project literally called Inbox — `TasksView.sections`
    /// renders `project == ""` under that title, so it must map back.
    /// Pin placement is left UNSPECIFIED: adding under a project header is
    /// about the project, and silently changing the pin default there would be
    /// a second decision the user never made.
    static func project(_ header: String) -> NewTaskSeed {
        NewTaskSeed(project: header == inboxHeader ? "" : header, pin: .unspecified)
    }

    /// A pin tier group's header (`focus` / `satellite` / `backlog` / `wait` /
    /// `ct_*`). No project: a tier says where on the board, not which project.
    static func tier(_ id: String) -> NewTaskSeed {
        NewTaskSeed(project: "", pin: .tier(id))
    }

    /// The header title `TasksView.sections` uses for the empty project.
    static let inboxHeader = "Inbox"
}
