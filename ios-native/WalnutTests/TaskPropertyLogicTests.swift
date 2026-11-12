import SwiftUI
import XCTest
@testable import Walnut

/// The task detail sheet's properties list, gated at its logic.
///
/// The user's complaint the list answers was discoverability ("I want to EASILY
/// change every setting, e.g. pinned → Focus / Satellite"), and the part of that
/// which can go silently wrong is the BOARD row: pin state and tier are two
/// server facts behind one control, `PUT /focus/tasks/:id/tier` 400s on a task
/// that is not pinned yet, and a fresh pin already lands in `satellite`. So the
/// mapping from "what the human picked" to "which writes go out, in what order"
/// is pinned here rather than left to a view body nothing can run headless.
final class TaskPropertyLogicTests: XCTestCase {

    /// What `TasksStore.allTierChoices` answers on a box with one custom tier: the two
    /// offered built-ins, then the registry (`PinTierPolicy.choices`).
    private let choices: [(id: String, label: String)] = PinTierPolicy.choices(custom: [
        FocusTierInfo(id: "ct_reading", label: "Reading"),
    ])

    private func placed(pinned: Bool, tierId: String?) -> TaskBoardPlacement {
        TaskPropertyLogic.placement(pinned: pinned, tierId: tierId, tierChoices: choices)
    }

    /// The writes a tap on an option makes, from the placement the menu shows.
    private func writes(picking tier: String, from current: TaskBoardPlacement) -> [PinTierPolicy.Write] {
        PinTierPolicy.writes(picking: tier, selected: current.selectedTier)
    }

    // MARK: - Board value text

    func testBoardValueTextUnpinned() {
        let placement = placed(pinned: false, tierId: nil)
        XCTAssertEqual(placement, .notOnBoard)
        XCTAssertEqual(
            TaskPropertyLogic.boardValueText(placement, tierChoices: choices),
            "Not pinned"
        )
    }

    /// Pinned with nothing in the tier map is Satellite by definition — the
    /// server stores a satellite pin with NO tier (`TaskPinChoice` rule 2), so
    /// "no tier" must never render as "not on the board".
    func testBoardValueTextPinnedWithoutStoredTier() {
        let placement = placed(pinned: true, tierId: nil)
        XCTAssertEqual(placement, .tier("satellite"))
        XCTAssertEqual(
            TaskPropertyLogic.boardValueText(placement, tierChoices: choices),
            "Satellite"
        )
    }

    func testBoardValueTextPinnedFocus() {
        XCTAssertEqual(
            TaskPropertyLogic.boardValueText(placed(pinned: true, tierId: "focus"), tierChoices: choices),
            "Focus"
        )
    }

    func testBoardValueTextCustomTierUsesItsLabel() {
        XCTAssertEqual(
            TaskPropertyLogic.boardValueText(placed(pinned: true, tierId: "ct_reading"), tierChoices: choices),
            "Reading"
        )
    }

    /// A `ct_*` id deleted on the desktop since the registry was fetched. Shows
    /// "Satellite" and never a raw id: that is what the server normalizes the
    /// stale tier to on the next split, so no two surfaces disagree.
    func testBoardValueTextUnknownCustomTierFallsBack() {
        let placement = placed(pinned: true, tierId: "ct_deleted")
        XCTAssertEqual(placement, .tier("satellite"))
        XCTAssertEqual(TaskPropertyLogic.boardValueText(placement, tierChoices: choices), "Satellite")
    }

    /// A task an older client, a plugin or an agent stored in a retired tier (Backlog,
    /// Wait) reads Satellite, the band the board draws it in. Never "Parked".
    func testARetiredStoredTierReadsSatellite() {
        for retired in ["backlog", "wait"] {
            let placement = placed(pinned: true, tierId: retired)
            XCTAssertEqual(placement, .tier("satellite"), retired)
            XCTAssertEqual(TaskPropertyLogic.boardValueText(placement, tierChoices: choices), "Satellite")
            XCTAssertEqual(
                TaskPropertyLogic.boardOptions(tierChoices: choices, current: placement)
                    .filter(\.isCurrent).map(\.tierId),
                ["satellite"]
            )
        }
    }

    func testPinListsAndCustomGroupsUseTheSamePlacement() {
        XCTAssertEqual(TaskFilter.sessions.title, "Pins")
        let customChoices = PinTierPolicy.choices(custom: [
            FocusTierInfo(id: "ct_reading", label: "Reading"),
            FocusTierInfo(id: "ct_helpers", label: "Virtual Teammate"),
        ])
        let current = TaskPropertyLogic.placement(pinned: true, tierId: "ct_helpers", tierChoices: customChoices)
        XCTAssertEqual(TaskPropertyLogic.boardValueText(current, tierChoices: customChoices), "Virtual Teammate")
        XCTAssertEqual(
            TaskPropertyLogic.boardOptions(tierChoices: customChoices, current: current)
                .filter(\.isCurrent).map(\.label),
            ["Virtual Teammate"]
        )
        XCTAssertEqual(writes(picking: "ct_helpers", from: .notOnBoard), [.pin, .setTier("ct_helpers")])
        XCTAssertEqual(writes(picking: "ct_helpers", from: current), [.unpin],
            "a tap on the checked plugin tier unpins it")
    }

    // MARK: - Board options

    /// The Pin menu lists the tiers and nothing else: no "Not pinned", no Unpin row,
    /// no Backlog, no Wait / Parked.
    func testBoardOptionsListEveryOfferedTierAndNothingElse() {
        let options = TaskPropertyLogic.boardOptions(
            tierChoices: choices, current: placed(pinned: true, tierId: "ct_reading")
        )
        XCTAssertEqual(options.map(\.label), ["Focus", "Satellite", "Reading"])
        XCTAssertEqual(options.map(\.id), ["focus", "satellite", "ct_reading"])
        XCTAssertEqual(options.filter(\.isCurrent).map(\.label), ["Reading"])
    }

    func testBoardOptionsCheckNothingWhenUnpinned() {
        let options = TaskPropertyLogic.boardOptions(
            tierChoices: choices, current: placed(pinned: false, tierId: nil)
        )
        XCTAssertTrue(options.filter(\.isCurrent).isEmpty)
    }

    /// A pinned-but-unmapped row checks Satellite, so the menu agrees with the
    /// value text next to it.
    func testBoardOptionsCheckSatelliteWhenPinnedWithoutStoredTier() {
        let options = TaskPropertyLogic.boardOptions(
            tierChoices: choices, current: placed(pinned: true, tierId: nil)
        )
        XCTAssertEqual(options.filter(\.isCurrent).map(\.label), ["Satellite"])
    }

    // MARK: - Board choice → writes

    /// A tap on the checked tier is the unpin: there is no separate Unpin.
    func testTappingTheCheckedTierUnpins() {
        XCTAssertEqual(writes(picking: "focus", from: .tier("focus")), [.unpin])
        XCTAssertEqual(writes(picking: "satellite", from: .tier("satellite")), [.unpin])
        // A task stored in a retired tier is checked in Satellite, so that tap unpins it.
        XCTAssertEqual(writes(picking: "satellite", from: placed(pinned: true, tierId: "wait")), [.unpin])
    }

    /// The tier endpoint refuses an unpinned task (400 "Task is not pinned"), so
    /// the pin has to go first and the order is load-bearing.
    func testTierFromOffBoardPinsThenSetsTier() {
        XCTAssertEqual(writes(picking: "focus", from: .notOnBoard), [.pin, .setTier("focus")])
    }

    /// A fresh pin already lands in `satellite` server-side, so that one choice
    /// is a pin and nothing else (same rule quick-add's `applyPin` follows).
    func testSatelliteFromOffBoardPinsOnly() {
        XCTAssertEqual(writes(picking: "satellite", from: .notOnBoard), [.pin])
    }

    func testTierWhilePinnedSetsTierOnly() {
        XCTAssertEqual(
            writes(picking: "ct_reading", from: placed(pinned: true, tierId: "wait")),
            [.setTier("ct_reading")]
        )
        XCTAssertEqual(writes(picking: "focus", from: .tier("satellite")), [.setTier("focus")])
    }

    // MARK: - Status segments

    func testStatusIndexRoundTrip() {
        for (index, choice) in TaskPropertyLogic.statusChoices.enumerated() {
            XCTAssertEqual(TaskPropertyLogic.statusIndex(choice.value), index)
            XCTAssertEqual(TaskPropertyLogic.status(atIndex: index), choice.value)
        }
        XCTAssertEqual(
            TaskPropertyLogic.statusChoices.map(\.label),
            ["To do", "In progress", "Done"]
        )
    }

    /// A status the phone does not model selects NO segment rather than
    /// highlighting "To do", which would claim something the task never said.
    func testUnknownStatusSelectsNoSegment() {
        XCTAssertEqual(TaskPropertyLogic.statusIndex("archived"), -1)
        XCTAssertNil(TaskPropertyLogic.status(atIndex: -1))
        XCTAssertNil(TaskPropertyLogic.status(atIndex: 3))
        XCTAssertEqual(TaskPropertyLogic.statusLabel("archived"), "archived")
    }

    /// Three segments stop fitting at accessibility sizes, so the row becomes
    /// the same label+value+menu every other property row is.
    func testStatusControlFallsBackToAMenuAtAccessibilitySizes() {
        XCTAssertEqual(TaskPropertyLogic.statusControl(for: .large), .segmented)
        XCTAssertEqual(TaskPropertyLogic.statusControl(for: .xxxLarge), .segmented)
        XCTAssertEqual(TaskPropertyLogic.statusControl(for: .accessibility1), .menu)
        XCTAssertEqual(TaskPropertyLogic.statusControl(for: .accessibility5), .menu)
    }

    // MARK: - Row value line budget

    /// A single word gets ONE line so SwiftUI has nothing to hyphenate: a project
    /// called "Immigration" rendered as "Immigra-" / "tion" at XXXL before this.
    /// A value with a space can wrap at the space, which never breaks a word.
    func testValueLineLimitKeepsASingleWordWhole() {
        XCTAssertEqual(TaskPropertyLogic.valueLineLimit("Immigration"), 1)
        XCTAssertEqual(TaskPropertyLogic.valueLineLimit("Focus"), 1)
        XCTAssertEqual(TaskPropertyLogic.valueLineLimit("Not pinned"), 2)
        XCTAssertEqual(TaskPropertyLogic.valueLineLimit("Imported from this Mac"), 2)
        XCTAssertEqual(TaskPropertyLogic.valueLineLimit("Sep 28, 2026"), 2)
        XCTAssertEqual(TaskPropertyLogic.valueLineLimit(""), 1)
    }

    // MARK: - Due value text

    func testDueValueTextNone() {
        XCTAssertEqual(TaskPropertyLogic.dueValueText(nil), "None")
    }

    func testDueValueTextRelativeDays() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = WalnutTask.parseISO("2026-09-07T15:00:00Z")!
        XCTAssertEqual(
            TaskPropertyLogic.dueValueText(WalnutTask.parseISO("2026-09-07"), now: now, calendar: calendar),
            "Today"
        )
        XCTAssertEqual(
            TaskPropertyLogic.dueValueText(WalnutTask.parseISO("2026-09-08"), now: now, calendar: calendar),
            "Tomorrow"
        )
        XCTAssertEqual(
            TaskPropertyLogic.dueValueText(WalnutTask.parseISO("2026-09-06"), now: now, calendar: calendar),
            "Yesterday"
        )
    }

    /// Anything further out is a plain day. No time of day: `due_date` is a bare
    /// `YYYY-MM-DD` on the wire, so a rendered midnight would be invented
    /// precision.
    func testDueValueTextFartherDatesShowADayWithNoTime() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = WalnutTask.parseISO("2026-09-07T15:00:00Z")!
        let text = TaskPropertyLogic.dueValueText(
            WalnutTask.parseISO("2026-12-24"), now: now, calendar: calendar
        )
        XCTAssertTrue(text.contains("24"), text)
        XCTAssertFalse(text.contains(":"), "a bare due date must not render a time: \(text)")
    }

    // MARK: - Due quick choices

    func testDueQuickChoicesResolveToDays() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = WalnutTask.parseISO("2026-09-07T15:00:00Z")!
        XCTAssertEqual(
            TaskDueQuickChoice.allCases.map(\.label),
            ["Today", "Tomorrow", "Next week", "None"]
        )
        XCTAssertEqual(TaskDueQuickChoice.today.date(from: now, calendar: calendar), calendar.startOfDay(for: now))
        XCTAssertEqual(
            TaskDueQuickChoice.tomorrow.date(from: now, calendar: calendar),
            calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))
        )
        XCTAssertEqual(
            TaskDueQuickChoice.nextWeek.date(from: now, calendar: calendar),
            calendar.date(byAdding: .day, value: 7, to: calendar.startOfDay(for: now))
        )
        XCTAssertNil(TaskDueQuickChoice.clear.date(from: now, calendar: calendar))
    }

    // MARK: - Priority labels

    /// "None" and not "Priority": the row's left side already says which setting
    /// this is, so the right side is free to say what the value actually is.
    func testPriorityLabels() {
        XCTAssertEqual(TaskPropertyLogic.priorityLabel(.immediate), "Immediate")
        XCTAssertEqual(TaskPropertyLogic.priorityLabel(.important), "Important")
        XCTAssertEqual(TaskPropertyLogic.priorityLabel(.backlog), "Backlog")
        XCTAssertEqual(TaskPropertyLogic.priorityLabel(.none), "None")
        XCTAssertEqual(TaskPropertyLogic.priorityLabel(.unknown), "None")
        XCTAssertEqual(TaskPropertyLogic.priorityIcon(.none), "flag")
        XCTAssertEqual(TaskPropertyLogic.priorityIcon(.immediate), "flag.fill")
        XCTAssertEqual(
            TaskPropertyLogic.priorityChoices.map(\.value),
            ["immediate", "important", "backlog", "none"]
        )
    }
}
