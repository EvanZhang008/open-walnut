import Foundation

// MARK: - Pin tiers: the ONE rule for what the phone offers and shows
//
// Two built-in tiers are offered, Focus and Satellite (2026-11-11, the user: "just have 2
// focus, satellite, remove park, but the vt we can still keep as it is from plugin"). Custom
// and plugin tiers (`ct_*`, a Virtual Teammate's included) stay exactly as the registry gives
// them. Backlog and Wait (the "Parked" shelf) are retired from every picker, band and chip.
//
// Backward compatible by construction: nothing on the wire or in storage changes. The split
// still carries `backlog_tasks` / `wait_tasks`, the server still accepts both ids, and an
// older client, a plugin or an agent may keep writing them. A task stored in one of them is
// SHOWN in Satellite (`displayTier`), so no old task drops off the board, and it keeps its
// stored tier until someone picks another. Mirrors the web's `displayPinTier` and
// `OFFERED_PIN_TIER_POLICY` (core), the same two retired ids.
//
// The WAITING phase is a different thing that only shares a word: a task parked on something
// outside. Nothing here reads or changes a phase, a snooze or the Waiting sections.
//
// Picking (the user: "don't need unpin also, another click of the selected one is unpin"):
// a tap on the tier a task is shown in unpins it, a tap on another tier moves it there, and
// a tap on a tier of an unpinned task pins it into that tier. There is no separate Unpin.
//
// Every surface reads this file: the board's bands and chips (`BoardModel.assemble`), the
// store's tier map and order (`TasksStore.tierMap` / `tierOrder`), the row menus (board,
// status sections, search rows), the detail sheet's Pin row and the Org node's pin groups.
// `PinTierPolicyGuardTests` fails on a source file that offers a retired tier by itself.

enum PinTierPolicy {
    /// Where a pinned task with no (or an unknown, or a retired) tier is drawn. Also the
    /// server's default for a fresh pin, so a pin needs no tier write to land here.
    static let defaultTier = "satellite"

    /// The built-ins offered and drawn, in reading order.
    static let offeredBuiltins: [(id: String, label: String)] = [
        ("focus", "Focus"), ("satellite", "Satellite"),
    ]

    /// Built-in ids still stored and accepted but never offered or drawn: shown in Satellite.
    static let retiredBuiltins: Set<String> = ["backlog", "wait"]

    static func isRetired(_ tier: String) -> Bool { retiredBuiltins.contains(tier) }

    /// The tier a stored tier id is shown in. nil stays nil (not pinned, or not known yet).
    static func displayTier(_ stored: String?) -> String? {
        guard let stored else { return nil }
        return isRetired(stored) ? defaultTier : stored
    }

    /// Every tier a picker offers and the board draws: Focus, Satellite, then the custom
    /// tiers in registry order. A custom entry with an empty, repeated or retired id is
    /// left out, so no registry shape can bring Parked back.
    static func choices(custom: [FocusTierInfo]) -> [(id: String, label: String)] {
        var seen = Set(offeredBuiltins.map(\.id))
        var out = offeredBuiltins
        for tier in custom where !tier.id.isEmpty && !isRetired(tier.id) && seen.insert(tier.id).inserted {
            out.append((tier.id, tier.label))
        }
        return out
    }

    /// Label for a stored tier id. A tier no choice names (a custom tier deleted on the
    /// desktop) reads Satellite, which is where the server normalizes it on the next split
    /// and where the board draws it. Never a raw `ct_*` id.
    static func label(for tier: String, custom: [FocusTierInfo]) -> String {
        let shown = displayTier(tier) ?? defaultTier
        return choices(custom: custom).first(where: { $0.id == shown })?.label ?? "Satellite"
    }

    /// The tier a picker marks as current: nil when the task is not pinned. A pinned task
    /// whose tier is not known yet, retired or no longer offered reads Satellite, the band
    /// the board draws it in, so the check mark and the band always agree.
    static func selected(
        pinned: Bool, stored: String?, offered: [(id: String, label: String)]
    ) -> String? {
        guard pinned else { return nil }
        guard let shown = displayTier(stored), offered.contains(where: { $0.id == shown }) else {
            return defaultTier
        }
        return shown
    }

    /// `selected` for a task, from the tier map the store holds (`TasksStore.taskTiers`).
    /// A task the map names is pinned even while its own `pinned` flag lags the split,
    /// the same rule that puts it on the board (`BoardModel.boardTier`).
    static func selected(
        task: WalnutTask, tierOf: [String: String], offered: [(id: String, label: String)]
    ) -> String? {
        let stored = tierOf[task.id]
        return selected(pinned: task.pinned == true || stored != nil, stored: stored, offered: offered)
    }

    /// One network write a pick turns into, in the order it must be issued.
    /// `PUT /focus/tasks/:id/tier` refuses a task that is not pinned yet, so a tier for an
    /// unpinned task is a pin first.
    enum Write: Equatable {
        case pin
        case unpin
        case setTier(String)
    }

    /// The writes a tap on `tier` turns into, given the tier the picker shows as selected
    /// (`selected(...)`, nil = not pinned). The selected tier unpins.
    static func writes(picking tier: String, selected: String?) -> [Write] {
        guard let selected else {
            // A fresh pin lands in Satellite server-side, so that one needs no tier write.
            return tier == defaultTier ? [.pin] : [.pin, .setTier(tier)]
        }
        return tier == selected ? [.unpin] : [.setTier(tier)]
    }

    /// The tier menu's title: what a tap in it does to this task.
    static func menuTitle(pinned: Bool) -> String { pinned ? "Move to Tier" : "Pin" }

    static func menuIcon(pinned: Bool) -> String { pinned ? "square.stack.3d.up" : "pin" }

    /// SF Symbol for a tier choice.
    static func icon(_ tier: String) -> String {
        switch tier {
        case "focus": return "scope"
        case "satellite": return "circle.circle"
        default: return "square.stack.3d.up"
        }
    }

    // MARK: - The split as the phone shows it

    /// `taskId -> tier` with every retired tier shown as Satellite.
    static func displayMap(_ raw: [String: String]) -> [String: String] {
        guard raw.values.contains(where: isRetired) else { return raw }
        return raw.mapValues { isRetired($0) ? defaultTier : $0 }
    }

    /// `tier -> ordered ids` with every retired bucket folded into Satellite, in pin order
    /// (`pinnedOrder` is the split's `pinned_tasks`, sorted by `pin_order`), so an old
    /// Backlog or Wait task sits among the Satellite rows where the server's order puts it.
    static func displayOrder(
        _ raw: [String: [String]], pinnedOrder: [String]
    ) -> [String: [String]] {
        guard raw.keys.contains(where: isRetired) else { return raw }
        var out: [String: [String]] = [:]
        var satellite = raw[defaultTier] ?? []
        var seen = Set(satellite)
        for (tier, ids) in raw where !isRetired(tier) && tier != defaultTier { out[tier] = ids }
        // A fixed order, so ids the split has not ranked yet land the same way every time.
        for tier in retiredBuiltins.sorted() {
            for id in raw[tier] ?? [] where seen.insert(id).inserted { satellite.append(id) }
        }
        out[defaultTier] = TasksStore.inPinOrder(satellite, pinnedOrder: pinnedOrder)
        return out
    }
}
