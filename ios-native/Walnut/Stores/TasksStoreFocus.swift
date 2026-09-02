import Foundation

// MARK: - Focus tiers (phone mirror of the desktop focus bar's tier model)
//
// Web semantics (do not invent new tiers): every PINNED task lives in exactly
// one tier — built-ins `focus` (current sprint), `satellite` (default),
// `backlog` (someday), `wait` (parked), or a registered custom tier (`ct_*`).
// The slim task projection carries `pinned` but not the tier, so the phone
// joins `GET /v1/focus/tasks` (id buckets) + `GET /v1/focus/tiers` (custom
// labels) into `taskTiers`/`customTiers` on TasksStore. Tier moves ride
// `PUT /v1/focus/tasks/:id/tier`, optimistic with rollback.

extension TasksStore {
    /// DiskCache key for the authoritative tier split.
    ///
    /// # Why the split is cached at all (it was the one board input that was not)
    ///
    /// The board renders from cache before any request finishes, and every OTHER input
    /// it needs is on disk: the tasks, the sessions, the folder tree. The split was not,
    /// so an offline launch drew every pinned task in ONE band: `tierId(for:)` answers
    /// nil without the map, and `tierBadge` then reads the server default, `satellite`.
    /// Measured on a real vault with the phone offline: All 96, Satellite 96, and no
    /// Focus, Backlog or Wait band at all. The BOARD'S ORGANISATION disappeared at
    /// exactly the moment the user could do least about it.
    ///
    /// The RAW split is what gets cached, not the two maps derived from it, so the cold
    /// path and the live path both go through `adoptSplit` and cannot disagree about
    /// ordering — the order is the load-bearing half (`tierOrder`), and a cache of a
    /// derived value is a second place for that rule to live.
    static let focusSplitCacheKey = "focus-split"

    /// DiskCache key for the custom-tier registry (`ct_*` id → label). A second file
    /// because it is a second endpoint with its own failure: the split can arrive while
    /// the registry does not, and `loadFocusTiers` already treats them that way.
    static let focusTiersCacheKey = "focus-tiers"

    /// Built-in tier order + labels — mirrors the desktop reading order.
    static let builtinTiers: [(id: String, label: String)] = [
        ("focus", "Focus"), ("satellite", "Satellite"),
        ("backlog", "Backlog"), ("wait", "Wait"),
    ]

    /// Tier id for a task ("satellite" when pinned but unmapped yet), nil when
    /// not pinned. Reads the OBSERVED map so SwiftUI tracks it.
    func tierId(for taskId: String) -> String? {
        taskTiers[taskId]
    }

    /// Human label for a tier id: built-ins, then the custom registry, then a
    /// sensible fallback (never show a raw ct_* id).
    func tierLabel(for tierId: String) -> String {
        if let builtin = Self.builtinTiers.first(where: { $0.id == tierId }) {
            return builtin.label
        }
        return customTiers.first(where: { $0.id == tierId })?.label ?? "Satellite"
    }

    /// Tier badge text for a task row (nil = no badge: not pinned).
    func tierBadge(for task: WalnutTask) -> String? {
        guard task.pinned == true else { return nil }
        // Pinned but split not loaded yet → the server default.
        return tierLabel(for: tierId(for: task.id) ?? "satellite")
    }

    /// Pure projection of the split into `tier id → ordered task ids`.
    ///
    /// The ORDER is the load-bearing part and it is why this exists next to
    /// `tierMap`: the server returns every bucket sorted by `pin_order`, and a
    /// new pin gets `pin_order = max + 1`, so following these arrays is what
    /// makes a freshly created task appear at the FOOT of its band instead of
    /// wherever a client-side sort happens to put it. A dictionary alone throws
    /// that away.
    static func tierOrder(from split: FocusTierResult) -> [String: [String]] {
        var order: [String: [String]] = [:]
        order["focus"] = split.focusTasks ?? []
        order["satellite"] = split.satelliteTasks ?? []
        order["backlog"] = split.backlogTasks ?? []
        order["wait"] = split.waitTasks ?? []
        for (tier, ids) in split.customTierTasks ?? [:] { order[tier] = ids }
        // The server omits `satellite_tasks` when it considers it empty, but
        // satellite is also "pinned and in no explicit bucket" — derive those
        // here so the band is ordered even on the omitting path.
        if order["satellite"]?.isEmpty ?? true {
            let explicit = Set(order.filter { $0.key != "satellite" }.flatMap(\.value))
            order["satellite"] = split.pinnedTasks.filter { !explicit.contains($0) }
        }
        return order
    }

    /// Pure join of the tier split + registry into the taskId → tier map.
    /// Static so WalnutTests can gate it without a store or network.
    static func tierMap(from split: FocusTierResult) -> [String: String] {
        var map: [String: String] = [:]
        // Satellite first so explicit buckets win on (impossible) overlap.
        for id in split.satelliteTasks ?? [] { map[id] = "satellite" }
        for id in split.focusTasks ?? [] { map[id] = "focus" }
        for id in split.backlogTasks ?? [] { map[id] = "backlog" }
        for id in split.waitTasks ?? [] { map[id] = "wait" }
        for (tier, ids) in split.customTierTasks ?? [:] {
            for id in ids { map[id] = tier }
        }
        // Any pinned id missing from every bucket is satellite by definition.
        for id in split.pinnedTasks where map[id] == nil { map[id] = "satellite" }
        return map
    }

    /// Fetch the tier split + custom registry. Best-effort: an old server
    /// (404) or a REPLICA hiccup leaves the last known map — rows then show
    /// pin state without a tier, never an error.
    func loadFocusTiers() async {
        guard isActive else { return }
        do {
            async let splitReq = transport.focusTasks()
            // Custom tiers are rare; a failure only affects ct_* labels.
            async let tiersReq = try? transport.focusTiers()
            let split = try await splitReq
            let tiers = await tiersReq
            guard isActive else { return }
            adoptSplit(split)
            if let tiers, tiers != customTiers {
                customTiers = tiers
                // Cached for the same reason the split is: a ct_* band whose LABEL is
                // missing renders as "Satellite" (`tierLabel`'s fallback), so an offline
                // board with the split but not the registry would name a custom band
                // after a built-in one — worse than not knowing.
                DiskCache.save(tiers, key: Self.focusTiersCacheKey)
            }
        } catch {
            AppLog.debug("tasks", "focus tier load failed", [
                "error": error.localizedDescription,
            ])
        }
    }

    /// Debounced background tier reconcile — pin/unpin/tier-move call this
    /// instead of blocking on a refetch.
    func scheduleTierRefresh() {
        tierRefreshTask?.cancel()
        tierRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard let self, self.isActive, !Task.isCancelled else { return }
            await self.loadFocusTiers()
        }
    }

    /// Adopt an authoritative split into BOTH the map and the order. One place,
    /// because a split that updated the map while leaving a stale order would
    /// render a task under the right heading in the wrong position.
    ///
    /// Also the ONE place the split is written to disk, which is why a tier MOVE
    /// survives a relaunch: `setTier` adopts its response through here too, so the
    /// cache never lags a change the user made and then went offline with.
    func adoptSplit(_ split: FocusTierResult) {
        let map = Self.tierMap(from: split)
        if map != taskTiers { taskTiers = map }
        let order = Self.tierOrder(from: split)
        if order != taskTierOrder { taskTierOrder = order }
        // UNCONDITIONAL, unlike the two adoptions above, and the asymmetry is the point.
        // Their guards protect the OBSERVED properties: adopting an identical value would
        // bump `tiersGen` and throw away the board's band memo for nothing. A file has no
        // such cost — this is one small encode on a utility queue every 30-120s — and a
        // change-only write has a hole in it: an unchanged split is the common case, so
        // after `DiskCache.clearAll()` wipes the cache on a disconnect, nothing would ever
        // re-create the file while the store's own copy still matched the server's.
        DiskCache.save(split, key: Self.focusSplitCacheKey)
    }

    /// Hydrate the split + custom-tier labels from disk. Called on the startup path
    /// only, and guarded the way every other adoption in `initialize()` is: a network
    /// answer that already landed WINS, because it is newer by construction.
    func adoptCachedFocusSplit() async {
        if let cached = await DiskCache.loadAsync(FocusTierResult.self, key: Self.focusSplitCacheKey),
           isActive, taskTiers.isEmpty {
            // Through `adoptSplit` and not through its own derivation: the map and the
            // ORDER have to come out of the cached split exactly as they come out of a
            // live one, or an offline board would be a second, subtly different reading
            // of the same bytes. (Its write-back is a no-op here — we just read the file.)
            adoptSplit(cached)
        }
        if let cachedTiers = await DiskCache.loadAsync([FocusTierInfo].self, key: Self.focusTiersCacheKey),
           isActive, customTiers.isEmpty {
            customTiers = cachedTiers
        }
    }

    /// Move a pinned task to a tier — optimistic map write, PUT in the
    /// background, rollback + error message on failure. Returns nil on
    /// success (mirrors setPinned's contract).
    func setTier(taskId: String, tier: String) async -> String? {
        noteUserTouched(taskId)
        let original = taskTiers[taskId]
        taskTiers[taskId] = tier
        // Optimistic order: the row leaves its old band and joins the FOOT of the
        // new one, which is where the server will put it (pin_order = max + 1).
        // Without this the row would render under the new heading at whatever
        // position the tasks-list sort implies, then hop when the split lands.
        let originalOrder = taskTierOrder
        for (key, ids) in taskTierOrder where ids.contains(taskId) {
            taskTierOrder[key] = ids.filter { $0 != taskId }
        }
        taskTierOrder[tier, default: []].append(taskId)
        do {
            let split = try await transport.setTaskFocusTier(id: taskId, tier: tier)
            guard isActive else { return nil }
            // Adopt the authoritative split (covers server-side self-healing
            // of stale custom-tier ids to satellite).
            adoptSplit(split)
            return nil
        } catch {
            taskTiers[taskId] = original
            taskTierOrder = originalOrder
            if let apiError = error as? APIError, apiError.code == "bad_request" {
                return "Pin the task first, then choose a tier."
            }
            return error.localizedDescription
        }
    }

    /// Every pickable tier for menus: built-ins first, then custom tiers.
    var allTierChoices: [(id: String, label: String)] {
        Self.builtinTiers + customTiers.map { ($0.id, $0.label) }
    }
}
