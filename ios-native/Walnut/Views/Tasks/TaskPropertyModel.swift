import SwiftUI

// MARK: - Task detail properties: every decision that is not a pixel
//
// The detail sheet's editable settings used to be chips that read as static
// labels (status/priority/tier were Menus dressed as pills), and pin/star/tier
// ALSO had a second home in a button row at the foot of the sheet. Nothing said
// "tap to change" and the same setting answered in two places. The sheet now
// draws ONE grouped properties list, and the rules that list follows live here
// so WalnutTests can gate them without a simulator.
//
// The board rule is the load-bearing one, and it is not this file's: what the
// Pin row offers, which choice is checked and which writes a tap turns into are
// `PinTierPolicy` (the one rule every tier menu reads). `PUT /focus/tasks/:id/tier`
// refuses a task that is not pinned yet (400 "Task is not pinned"), so a tier for
// an off-board task is TWO writes in order, and a fresh pin already lands in
// `satellite` server-side, which is why picking Satellite from off the board is a
// pin and nothing else (same rule quick-add's `applyPin` follows). A tap on the
// checked tier unpins; there is no "Not pinned" choice.

/// Where a task sits on the pinned board. Pin state and tier as ONE value,
/// because to the person editing it they are one question: where is this?
enum TaskBoardPlacement: Equatable, Hashable {
    /// Not pinned — the task exists but is not on the board at all.
    case notOnBoard
    /// Pinned, shown in this tier: Focus, Satellite or a custom (`ct_*`) tier
    /// (`PinTierPolicy.selected`; a retired or unknown tier reads Satellite).
    case tier(String)

    /// The tier a picker checks, nil when not pinned.
    var selectedTier: String? {
        if case .tier(let tier) = self { return tier }
        return nil
    }
}

/// One pickable row of the Pin menu: a tier.
struct TaskBoardOption: Equatable, Identifiable {
    let tierId: String
    let label: String
    let icon: String
    let isCurrent: Bool

    /// Stable key for SwiftUI identity. Tier ids are already `[a-z_]`/`ct_*`.
    var id: String { tierId }
}

/// Which control the Status row draws.
enum TaskStatusControl: Equatable {
    case segmented
    case menu
}

/// A one-tap due date offered above the calendar.
enum TaskDueQuickChoice: String, CaseIterable, Identifiable {
    case today, tomorrow, nextWeek, clear

    var id: String { rawValue }

    var label: String {
        switch self {
        case .today: return "Today"
        case .tomorrow: return "Tomorrow"
        case .nextWeek: return "Next week"
        case .clear: return "None"
        }
    }

    /// The day this choice means, nil for "clear the date".
    func date(from now: Date, calendar: Calendar = .current) -> Date? {
        let today = calendar.startOfDay(for: now)
        switch self {
        case .today: return today
        case .tomorrow: return calendar.date(byAdding: .day, value: 1, to: today)
        case .nextWeek: return calendar.date(byAdding: .day, value: 7, to: today)
        case .clear: return nil
        }
    }
}

enum TaskPropertyLogic {
    static let notOnBoardLabel = "Not pinned"

    // MARK: - Board

    /// Current placement from the two facts the store holds separately, as shown.
    static func placement(
        pinned: Bool, tierId: String?, tierChoices: [(id: String, label: String)]
    ) -> TaskBoardPlacement {
        PinTierPolicy.selected(pinned: pinned, stored: tierId, offered: tierChoices)
            .map(TaskBoardPlacement.tier) ?? .notOnBoard
    }

    /// Every option the Pin menu offers: the tiers in `TasksStore.allTierChoices`
    /// order, the current one checked. Off the board is no option of its own: a
    /// tap on the checked tier is the unpin.
    static func boardOptions(
        tierChoices: [(id: String, label: String)], current: TaskBoardPlacement
    ) -> [TaskBoardOption] {
        tierChoices.map { choice in
            TaskBoardOption(
                tierId: choice.id, label: choice.label,
                icon: PinTierPolicy.icon(choice.id), isCurrent: current == .tier(choice.id)
            )
        }
    }

    /// Right-hand value text for the Pin row.
    static func boardValueText(
        _ current: TaskBoardPlacement, tierChoices: [(id: String, label: String)]
    ) -> String {
        switch current {
        case .notOnBoard:
            return notOnBoardLabel
        case .tier(let tier):
            return tierChoices.first(where: { $0.id == tier })?.label ?? "Satellite"
        }
    }

    // MARK: - Status

    /// Segment order, left to right. Sentence case: iOS writes control labels
    /// that way, and "In progress" fits three segments at the default size.
    static let statusChoices: [(value: String, label: String)] = [
        ("todo", "To do"), ("in_progress", "In progress"), ("done", "Done"),
    ]

    /// Segment index for a status string. `-1` for a status the phone does not
    /// model (a value a newer server introduced): a Picker with an out-of-range
    /// selection draws with NOTHING selected, which is the honest answer —
    /// better than highlighting a segment that is not what the task says.
    static func statusIndex(_ status: String) -> Int {
        statusChoices.firstIndex(where: { $0.value == status }) ?? -1
    }

    /// Status string for a segment index, nil when the index selects nothing.
    static func status(atIndex index: Int) -> String? {
        statusChoices.indices.contains(index) ? statusChoices[index].value : nil
    }

    static func statusLabel(_ status: String) -> String {
        statusChoices.first(where: { $0.value == status })?.label ?? status
    }

    // MARK: - Row values

    /// Line budget for a row's VALUE text.
    ///
    /// A value with NO space gets ONE line, and that is the whole point: SwiftUI
    /// hyphenates a word too wide for its line, so a project called
    /// "Immigration" rendered as "Immigra-" / "tion" at XXXL. There is no word
    /// boundary to wrap at, so one line plus `minimumScaleFactor` keeps the word
    /// whole (shrunk, then tail-truncated) instead of breaking it. A value that
    /// DOES contain a space can wrap at the space, which never breaks a word, so
    /// it gets two.
    static func valueLineLimit(_ value: String) -> Int {
        value.contains(where: \.isWhitespace) ? 2 : 1
    }

    /// Three segments stop fitting well before the largest accessibility sizes,
    /// so the row falls back to the same label+value+menu shape every other row
    /// uses. Switched at `isAccessibilitySize`, matching the board's chip rail.
    static func statusControl(for size: DynamicTypeSize) -> TaskStatusControl {
        size.isAccessibilitySize ? .menu : .segmented
    }

    // MARK: - Priority

    static let priorityChoices: [(value: String, label: String)] = [
        ("immediate", "Immediate"), ("important", "Important"),
        ("backlog", "Backlog"), ("none", "None"),
    ]

    static func priorityLabel(_ priority: TaskPriority) -> String {
        switch priority {
        case .immediate: return "Immediate"
        case .important: return "Important"
        case .backlog: return "Backlog"
        case .none, .unknown: return "None"
        }
    }

    static func priorityColor(_ priority: TaskPriority) -> Color {
        switch priority {
        case .immediate: return Theme.danger
        case .important: return Theme.warning
        default: return .secondary
        }
    }

    static func priorityIcon(_ priority: TaskPriority) -> String {
        switch priority {
        case .none, .unknown: return "flag"
        default: return "flag.fill"
        }
    }

    // MARK: - Due

    /// Right-hand value for the Due row: the three days a person thinks in by
    /// name, a plain day otherwise, "None" when there is no date. No time of
    /// day — `due_date` is a bare `YYYY-MM-DD` on the wire, so a rendered
    /// midnight would be a precision the data does not have.
    static func dueValueText(
        _ due: Date?, now: Date = AppClock.now(), calendar: Calendar = .current
    ) -> String {
        guard let due else { return "None" }
        if calendar.isDate(due, inSameDayAs: now) { return "Today" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(due, inSameDayAs: tomorrow) { return "Tomorrow" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(due, inSameDayAs: yesterday) { return "Yesterday" }
        return due.formatted(date: .abbreviated, time: .omitted)
    }
}
