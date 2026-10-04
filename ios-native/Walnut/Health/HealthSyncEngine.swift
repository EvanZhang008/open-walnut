import Foundation

/// Reads Apple Health and keeps the Mac's copy current.
///
/// One run at a time: a trigger during a run sets a rerun flag (and widens what
/// the rerun covers) instead of starting a second run.
///
/// The commit rule, for every type: an anchor moves only after EVERY part of the
/// batch built from that query answered 200 and the Mac stored it (not paused,
/// not `unsupported`, no `unitMismatch` or `refused`). So any failure, a kill or
/// a timeout means the same samples go out again next time, which is harmless:
/// raw rows dedupe by HealthKit uuid and buckets replace by key.
///
/// A run, in order:
///  1. guards (on, paired, HealthKit present), then GET status: a new store id
///     voids every anchor, `paused` stops the run, `supported` decides the types;
///  2. priming: a raw type with no anchor sends its last 7 days newest first, so
///     the Mac's agent sees recent nights within seconds of turning this on;
///  3. rounds over every type, a few anchored pages each per round so a long
///     heart-rate history never starves the types after it;
///  4. the characteristics, when one changed.
actor HealthSyncEngine {
    static let anchoredLimit = 2000
    static let primeLimit = 3000
    static let primeWindow: TimeInterval = 7 * 86_400
    static let pagesPerRound = 2
    static let bucketPagesPerRound = 10
    static let hourlyWindow: TimeInterval = 30 * 86_400
    static let lateWindow: TimeInterval = 2 * 86_400
    /// While a type's history is still being read, its last `lateWindow` goes
    /// out again at most this often (and at once for a type a delivery named).
    static let catchUpInterval: TimeInterval = 300
    /// A call is not started with less time than this left in the budget.
    static let minimumCallTime: TimeInterval = 2
    static let callTimeout: TimeInterval = 30

    let source: HealthDataSource
    private let transport: HealthSyncTransport
    let state: HealthSyncStateStore
    let env: HealthSyncEnvironment
    private let catalog: [HealthTypeSpec]
    private let onProgress: @Sendable (HealthSyncProgress) -> Void

    private var running = false
    private var rerunRequested = false
    /// What the rerun covers: nil = everything.
    private var rerunOnly: Set<String>? = []
    private var lastCatchUpAt: Date?
    /// Types a background delivery named since the last catch-up.
    private var catchUpNamed: Set<String> = []
    private var progress = HealthSyncProgress()
    /// Types the Mac declined in this run (unsupported, unit mismatch, category
    /// off) or HealthKit would not read: counted as done for the progress line,
    /// so one declined type never leaves "Syncing history" up forever.
    private var skippedThisRun: Set<String> = []
    /// The state generation when the current run began (see HealthSyncStateStore).
    private var startGeneration = 0

    /// The characteristics count as one entry in the progress.
    static let characteristicsKey = "x.characteristics"

    init(
        source: HealthDataSource, transport: HealthSyncTransport, state: HealthSyncStateStore,
        environment: HealthSyncEnvironment, catalog: [HealthTypeSpec] = HealthTypeCatalog.all,
        onProgress: @escaping @Sendable (HealthSyncProgress) -> Void = { _ in }
    ) {
        self.source = source
        self.transport = transport
        self.state = state
        self.env = environment
        self.catalog = catalog
        self.onProgress = onProgress
    }

    var isRunning: Bool { running }

    /// Run until every type is current, the budget runs out, or something stops
    /// the run. `only` limits it to these type names (a background delivery
    /// names what changed); characteristics are read on full runs only.
    @discardableResult
    func run(reason: String, budget: TimeInterval, only: Set<String>? = nil) async -> HealthRunOutcome {
        if running {
            catchUpNamed.formUnion(only ?? [])
            rerunRequested = true
            rerunOnly = Self.union(rerunOnly, only)
            return .coalesced
        }
        running = true
        rerunRequested = false
        rerunOnly = []
        let deadline = env.now().addingTimeInterval(budget)
        var outcome = await runOnce(reason: reason, deadline: deadline, only: only)
        while rerunRequested, outcome == .synced, deadline.timeIntervalSince(env.now()) > Self.minimumCallTime {
            let next = rerunOnly
            rerunRequested = false
            rerunOnly = []
            outcome = await runOnce(reason: "\(reason)+rerun", deadline: deadline, only: next)
        }
        running = false
        return outcome
    }

    private static func union(_ a: Set<String>?, _ b: Set<String>?) -> Set<String>? {
        guard let a, let b else { return nil }
        return a.union(b)
    }

    // MARK: - One run

    /// Why a run stops early. Thrown so every step can end the run in one line.
    enum Stop: Error {
        case outcome(HealthRunOutcome)
        case storeMismatch(String?)
    }

    /// What one type did in a round.
    enum Step {
        case finished, more, skipped
    }

    struct Run {
        let deadline: Date
        let generation: Int
        let zone: TimeZone
        let device: HealthSyncHeader.Device
        let catchUpAll: Bool
        let catchUpNames: Set<String>
    }

    private func runOnce(reason: String, deadline: Date, only: Set<String>?) async -> HealthRunOutcome {
        startGeneration = state.generation
        guard env.isEnabled() else { return finish(.off, reason: reason) }
        guard env.isPaired() else { return finish(.notPaired, reason: reason) }
        let demo = env.isDemo()
        if !demo && !source.isAvailable { return finish(.unavailable, reason: reason) }
        guard state.isReadable else { return finish(.locked, reason: reason) }

        var restarted = false
        while true {
            let generation = state.generation
            do {
                return try await attempt(reason: reason, deadline: deadline, only: only, demo: demo,
                                         generation: generation)
            } catch Stop.storeMismatch(let newId) {
                // The Mac's copy was deleted and re-created: every anchor is void.
                // Start over under the new id, once.
                state.update(generation: generation) { $0.reset(storeId: newId) }
                AppLog.info("health", "store changed, anchors reset", ["reason": reason])
                if restarted { return finish(.failed, reason: reason) }
                restarted = true
            } catch Stop.outcome(let outcome) {
                return finish(outcome, reason: reason)
            } catch {
                return finish(.failed, reason: reason)
            }
        }
    }

    private func attempt(
        reason: String, deadline: Date, only: Set<String>?, demo: Bool, generation: Int
    ) async throws -> HealthRunOutcome {
        progress.running = true
        skippedThisRun = []
        publish()

        try checkTime(deadline)
        let status: HealthStatusResponse
        do {
            status = try await transport.healthStatus(timeout: callTimeout(deadline))
        } catch {
            throw Stop.outcome(Self.outcome(for: error))
        }
        if let id = status.storeId {
            let known = state.read().storeId
            if known != id {
                state.update(generation: generation) { snapshot in
                    if snapshot.storeId != nil { snapshot.reset(storeId: id) } else { snapshot.storeId = id }
                }
            }
        }
        if status.paused == true { throw Stop.outcome(.paused) }
        if state.read().historyEpoch != Self.historyEpoch {
            state.update(generation: generation) { snapshot in
                snapshot.forgetAll()
                snapshot.historyEpoch = Self.historyEpoch
            }
        }

        let plan = Self.plan(catalog: catalog, status: status)
        progress.typesTotal = plan.count + (Self.genericSupported(status) ? 1 : 0)
        if demo {
            // The demo answers from fixtures: a believable finished sync, and
            // HealthKit is never touched.
            progress.typesDone = progress.typesTotal
            return finish(.synced, reason: reason)
        }

        if state.read().installId == nil {
            state.update(generation: generation) { $0.installId = UUID().uuidString.lowercased() }
        }
        let catchUpAll = lastCatchUpAt.map { env.now().timeIntervalSince($0) >= Self.catchUpInterval } ?? true
        if catchUpAll { lastCatchUpAt = env.now() }
        let run = Run(
            deadline: deadline, generation: generation, zone: env.timeZone(),
            device: HealthSyncHeader.Device(installId: state.read().installId, model: env.deviceModel, os: env.deviceOS),
            catchUpAll: catchUpAll, catchUpNames: catchUpNamed.union(only ?? [])
        )
        catchUpNamed = []
        let selected = only.map { names in plan.filter { names.contains($0.name) } } ?? plan
        let forget = Self.typesWithoutMacData(selected, status: status)
        if !forget.isEmpty {
            state.update(generation: generation) { $0.forget(forget) }
        }
        refreshDone(plan: plan, status: status)

        for spec in selected {
            try await prime(spec, run)
        }
        var pending = selected.filter { !skippedThisRun.contains($0.name) }
        while !pending.isEmpty {
            var next: [HealthTypeSpec] = []
            for spec in pending {
                let step: Step
                if spec.kind == .raw {
                    step = try await rawRound(spec, run)
                } else {
                    step = try await bucketRound(spec, run)
                }
                switch step {
                case .finished: state.update(generation: generation) { $0.completed.insert(spec.name) }
                case .more: next.append(spec)
                case .skipped: skippedThisRun.insert(spec.name)
                }
                refreshDone(plan: plan, status: status)
            }
            pending = next
        }
        if only == nil && Self.genericSupported(status) {
            try await syncCharacteristics(run)
            state.update(generation: generation) { $0.completed.insert(Self.characteristicsKey) }
        }
        refreshDone(plan: plan, status: status)
        return finish(.synced, reason: reason)
    }

    /// Which types this server takes, in sync order.
    static func plan(catalog: [HealthTypeSpec], status: HealthStatusResponse) -> [HealthTypeSpec] {
        let raw = status.supported?.raw.map(Set.init)
        let buckets = status.supported?.buckets.map(Set.init)
        let generic = genericSupported(status)
        let covered = Set(status.supported?.generic?.covered ?? [])
        let disabled = Set((status.types ?? []).filter { $0.enabled == false }.map(\.type))
        return catalog.filter { spec in
            if disabled.contains(spec.name) { return false }
            // An old server (no `supported.generic`) gets catalog types only,
            // and the generic ones are not even queried.
            if spec.isGeneric { return generic && !covered.contains(spec.name) }
            switch spec.kind {
            case .raw: return raw?.contains(spec.name) ?? true
            case .buckets: return buckets?.contains(spec.name) ?? true
            }
        }
    }

    /// Types the Mac holds nothing of, read again from their beginning on every
    /// run. While Apple Health access is off, HealthKit answers every query empty
    /// but still hands out an anchor past the whole history; keeping that anchor
    /// would skip everything recorded before access was turned on (2026-10-03:
    /// a phone that tapped Don't Allow, then turned access on, never sent its
    /// history). An empty type costs one empty query per run. A status without
    /// `types` (an older server) forgets nothing.
    static func typesWithoutMacData(_ plan: [HealthTypeSpec], status: HealthStatusResponse) -> Set<String> {
        guard let types = status.types else { return [] }
        let held = Set(types.filter { $0.lastSampleAt != nil }.map(\.type))
        return Set(plan.map(\.name)).subtracting(held)
    }

    /// The anchor a page moves the type to, or nil to stay where it started. An
    /// empty page stays: with access to a type off, HealthKit answers empty and
    /// still hands out an anchor past everything recorded, and moving there would
    /// skip it all once access is back. That covers more than the first sync: on
    /// 2026-10-04 a phone that turned access on after Don't Allow sent only its
    /// last few days of steps, and access switched off for a week would lose that week.
    /// An empty page from the old anchor costs next to nothing.
    static func anchorToKeep(_ page: HealthAnchoredPage) -> Data? {
        page.fetched + page.deleted.count > 0 ? page.anchor : nil
    }

    /// Raised when progress made by an earlier build cannot be trusted. 1: builds
    /// up to 95 moved anchors on empty pages, so a phone that ever read with
    /// access off holds anchors past history it never sent.
    static let historyEpoch = 1

    /// The server takes `q.` / `c.` / `x.` names, and their category (`other`,
    /// which such a server always lists while it is on) is not switched off.
    static func genericSupported(_ status: HealthStatusResponse) -> Bool {
        status.supported?.generic != nil && (status.categories?.contains("other") ?? true)
    }

    // MARK: - Priming

    /// A type's first sync: its last 7 days go first, so the Mac's agent sees
    /// recent nights and days within seconds, before the backfill walks the
    /// whole history from its beginning. Raw types send those samples newest
    /// first (the backfill sends them again later and the Mac ignores the
    /// repeats); bucket types send 7 days of day and hour buckets (the full
    /// recompute replaces them by key).
    ///
    /// Until the backfill reaches the end, what was recorded lately waits behind
    /// years of history (it reads oldest first), so the last 2 days go out again
    /// on later runs too: every `catchUpInterval`, and at once for a type a
    /// background delivery named. 2026-10-04: mid-backfill, the Mac had no step
    /// after midnight and not last night's sleep, both already on the phone.
    private func prime(_ spec: HealthTypeSpec, _ run: Run) async throws {
        let snapshot = state.read()
        let first = snapshot.anchors[spec.name] == nil && !snapshot.primed.contains(spec.name)
        let catchUp = !first && snapshot.primed.contains(spec.name) && !snapshot.completed.contains(spec.name)
            && (run.catchUpAll || run.catchUpNames.contains(spec.name))
        guard first || catchUp else { return }
        try check(run)
        let now = env.now()
        let since = now.addingTimeInterval(first ? -Self.primeWindow : -Self.lateWindow)
        let items: [Data]
        do {
            switch spec.kind {
            case .raw:
                let recent = try await source.recent(spec, since: since, limit: Self.primeLimit, batchTimeZone: run.zone)
                items = HealthBatcher.encode(recent)
            case .buckets:
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = run.zone
                let from = calendar.startOfDay(for: since)
                let days = try await source.statistics(spec, interval: .day, from: from, to: now,
                                                       includeEmpty: false, batchTimeZone: run.zone)
                let hours = try await source.statistics(spec, interval: .hour, from: from, to: now,
                                                        includeEmpty: false, batchTimeZone: run.zone)
                items = HealthBatcher.encode(days + hours)
            }
        } catch {
            try stopIfFatal(error)
            skippedThisRun.insert(spec.name)
            return
        }
        if !items.isEmpty {
            guard try await post(spec, items: items, deleted: [], run) else {
                skippedThisRun.insert(spec.name)
                return
            }
        }
        if first { state.update(generation: run.generation) { $0.primed.insert(spec.name) } }
    }

    // MARK: - Raw types

    private func rawRound(_ spec: HealthTypeSpec, _ run: Run) async throws -> Step {
        for _ in 0..<Self.pagesPerRound {
            try check(run)
            let anchor = state.read().anchors[spec.name]
            let page: HealthAnchoredPage
            do {
                page = try await source.anchored(spec, anchor: anchor, limit: Self.anchoredLimit, encode: true,
                                                 batchTimeZone: run.zone)
            } catch {
                try stopIfFatal(error)
                return .skipped
            }
            if !page.samples.isEmpty || !page.deleted.isEmpty {
                let stored = try await post(spec, items: HealthBatcher.encode(page.samples), deleted: page.deleted, run)
                guard stored else { return .skipped }
            }
            state.update(generation: run.generation) { snapshot in
                if let next = Self.anchorToKeep(page) { snapshot.anchors[spec.name] = next }
                snapshot.oldestDate = Self.earlier(snapshot.oldestDate, page.earliestStart)
            }
            if page.fetched + page.deleted.count < Self.anchoredLimit { return .finished }
        }
        return .more
    }

    // MARK: - Posting

    /// Send one type's items in as many calls as the caps need. True when every
    /// call was stored; false when the Mac declined the type this time (the
    /// anchor stays). Throws to stop the run.
    func post(_ spec: HealthTypeSpec, items: [Data], deleted: [String], _ run: Run) async throws -> Bool {
        let header = HealthSyncHeader(spec: spec, storeId: state.read().storeId, device: run.device,
                                      tz: run.zone.identifier)
        return try await send(header: header, itemsKey: spec.kind == .raw ? "samples" : "buckets",
                              items: items, deleted: deleted, run)
    }

    func send(header: HealthSyncHeader, itemsKey: String, items: [Data], deleted: [String],
                      _ run: Run) async throws -> Bool {
        let headerData = try JSONEncoder().encode(header)
        let batches = HealthBatcher.batches(header: headerData, itemsKey: itemsKey, items: items, deleted: deleted)
        for batch in batches {
            guard try await send(batch, type: header.type ?? header.metric ?? "", run, depth: 0) else { return false }
        }
        return true
    }

    private func send(_ batch: HealthBatch, type: String, _ run: Run, depth: Int) async throws -> Bool {
        try check(run)
        let reply: HealthSyncReply
        do {
            do {
                reply = try await transport.healthSync(body: batch.body, timeout: callTimeout(run.deadline))
            } catch where Self.isDroppedConnection(error) {
                // iOS drops the connections an app held while it was in the
                // background, and the first call after it is back fails at once
                // ("connection lost"). On 2026-10-04 that ended the history read
                // every time the user came back to Walnut. The Mac ignores a batch
                // it already has, so send this one once more.
                AppLog.info("health", "connection dropped, batch sent again", ["type": Self.logLabel(type)])
                try? await Task.sleep(for: .milliseconds(500))
                try check(run)
                reply = try await transport.healthSync(body: batch.body, timeout: callTimeout(run.deadline))
            }
        } catch let stop as Stop {
            throw stop
        } catch {
            throw Stop.outcome(Self.outcome(for: error))
        }
        switch reply {
        case .ok(let result):
            if result.paused == true { throw Stop.outcome(.paused) }
            if !result.stored {
                AppLog.info("health", "type not stored, anchor kept", [
                    "type": Self.logLabel(type),
                    "why": result.unsupported == true ? "unsupported"
                        : result.unitMismatch != nil ? "unitMismatch"
                        : result.refused != nil ? "refused" : "categoryDisabled",
                ])
                return false
            }
            return true
        case .storeMismatch(let id):
            throw Stop.storeMismatch(id)
        case .tooLarge:
            guard depth < 12, let halves = batch.halves() else {
                // One item the Mac can never take: drop it rather than stall the type.
                AppLog.error("health", "single item over the size cap dropped", ["type": Self.logLabel(type)])
                return true
            }
            guard try await send(halves.0, type: type, run, depth: depth + 1) else { return false }
            return try await send(halves.1, type: type, run, depth: depth + 1)
        case .unavailable:
            throw Stop.outcome(.macUnreachable)
        }
    }

    // MARK: - Helpers

    /// A HealthKit read failed: a locked phone (or a cancelled run) stops the
    /// run; anything else only skips this type for this run.
    func stopIfFatal(_ error: Error) throws {
        if (error as? HealthSourceError) == .locked { throw Stop.outcome(.locked) }
        if error is CancellationError || Task.isCancelled { throw Stop.outcome(.cancelled) }
    }

    private func checkTime(_ deadline: Date) throws {
        if Task.isCancelled { throw Stop.outcome(.cancelled) }
        if deadline.timeIntervalSince(env.now()) < Self.minimumCallTime { throw Stop.outcome(.budget) }
    }

    /// Before every query and call: time left, not cancelled, and the state not
    /// erased under the run (Disconnect, or "Delete Health Data on Mac").
    func check(_ run: Run) throws {
        try checkTime(run.deadline)
        if state.generation != run.generation || !env.isEnabled() { throw Stop.outcome(.off) }
    }

    private func callTimeout(_ deadline: Date) -> TimeInterval {
        min(Self.callTimeout, max(5, deadline.timeIntervalSince(env.now())))
    }

    static func outcome(for error: Error) -> HealthRunOutcome {
        if error is CancellationError { return .cancelled }
        if let api = error as? APIError {
            switch api {
            case .cancelled: return .cancelled
            case .network, .rateLimited: return .macUnreachable
            case .unauthorized: return .unauthorized
            case .notConfigured: return .notPaired
            case .server(let status, _, _, _, _): return status >= 500 ? .macUnreachable : .failed
            default: return .failed
            }
        }
        if error is URLError { return .macUnreachable }
        return .failed
    }

    /// NSURLErrorNetworkConnectionLost (-1005), as the transport reports it.
    static func isDroppedConnection(_ error: Error) -> Bool {
        let underlying: Error
        if case APIError.network(let inner) = error { underlying = inner } else { underlying = error }
        let ns = underlying as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorNetworkConnectionLost
    }

    /// A generic name in a log line keeps only its prefix (the app log reaches the
    /// Mac's logs): that someone has, say, c.Pregnancy data is itself personal.
    static func logLabel(_ type: String) -> String {
        type.contains(".") ? "\(type.prefix(2))*" : type
    }

    static func earlier(_ a: Date?, _ b: Date?) -> Date? {
        switch (a, b) {
        case let (a?, b?): return min(a, b)
        default: return a ?? b
        }
    }

    private func refreshDone(plan: [HealthTypeSpec], status: HealthStatusResponse) {
        let snapshot = state.read()
        var done = plan.filter { snapshot.completed.contains($0.name) || skippedThisRun.contains($0.name) }.count
        if Self.genericSupported(status) && snapshot.completed.contains(Self.characteristicsKey) { done += 1 }
        progress.typesDone = done
        progress.oldestDate = snapshot.oldestDate
        progress.lastSuccessAt = snapshot.lastSuccessAt
        publish()
    }

    private func finish(_ outcome: HealthRunOutcome, reason: String) -> HealthRunOutcome {
        let now = env.now()
        // Nothing is recorded for a switched-off sync, or into a state that was
        // erased during the run: Disconnect leaves no Health file behind.
        if outcome != .off {
            state.update(generation: startGeneration) { snapshot in
                snapshot.lastRunAt = now
                snapshot.lastOutcome = outcome.rawValue
                if outcome == .synced {
                    snapshot.lastSuccessAt = now
                    snapshot.lastFullSyncAt = now
                }
            }
        }
        state.flush()
        let snapshot = state.read()
        progress.running = false
        progress.lastOutcome = outcome
        progress.lastRunAt = now
        progress.lastSuccessAt = snapshot.lastSuccessAt
        progress.oldestDate = snapshot.oldestDate
        publish()
        AppLog.info("health", "sync run ended", [
            "reason": reason, "outcome": outcome.rawValue,
            "typesDone": String(progress.typesDone), "typesTotal": String(progress.typesTotal),
        ])
        return outcome
    }

    private func publish() {
        onProgress(progress)
    }
}
