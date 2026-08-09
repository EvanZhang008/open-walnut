import Foundation
import Observation

/// Task + session state over the frozen /api/v1 contract. Loads a disk-cached
/// snapshot instantly, refreshes from the network (stale-while-revalidate),
/// then keeps both lists LIVE off one `GET /api/v1/events` SSE feed
/// (snapshot → per-row upsert/delete). Editing rides `PATCH /tasks/:id` with
/// optimistic local apply + rollback on failure.
@Observable
@MainActor
final class TasksStore {
    private let api = WalnutAPI()
    weak var connection: ConnectionStore?

    /// False while backgrounded — every completion re-checks it before touching
    /// observed state, so a fetch that lands during suspension cannot drive
    /// SwiftUI updates from a non-active process (P0-3).
    private var isActive = true

    /// Monotonic request sequence — a slow stale list fetch must not overwrite
    /// a newer one (same pattern as the web SessionSearchPanel requestSeq).
    /// MainActor-confined, so increment/compare are race-free.
    private var taskLoadSeq = 0
    private var sessionLoadSeq = 0

    var tasks: [WalnutTask] = [] {
        didSet { tasksGen &+= 1 }
    }
    var syncedAt: Date?
    var loading = false
    var errorMessage: String?
    /// true when the server returned 503 (fresh companion, projection not
    /// synced yet) — drives the friendly "Tasks not synced yet" state.
    var notSyncedYet = false

    /// Most recently created task id — the Tasks list observes this to scroll
    /// to and briefly highlight the new row so it's visually locatable.
    var lastCreatedTaskId: String?

    // MARK: - Pending-created overlay
    //
    // On a REPLICA, GET /api/v1/tasks serves the git-synced projection, which
    // lags a create by the outbox → primary → git-sync round trip (30s–min).
    // Without an overlay, the loadTasks() right after createTask() REPLACES
    // the list with the server's (new-task-less) projection and the optimistic
    // insert silently vanishes — the "created it but can't find it anywhere"
    // report. Pending tasks are re-merged into every server refresh until the
    // server list contains them (or a TTL expires), and persisted so an app
    // restart inside the sync window doesn't lose them either.

    private struct PendingCreated: Codable {
        let task: WalnutTask
        let createdAt: Date
    }
    private var pendingCreated: [PendingCreated] = []
    /// Generous vs the ~30s git-sync cycle: covers a primary box that's
    /// temporarily asleep without pinning ghost rows forever.
    private static let pendingTTL: TimeInterval = 30 * 60

    /// Ids of tasks currently overlaid (not yet confirmed by the server).
    var pendingCreatedIds: Set<String> { Set(pendingCreated.map(\.task.id)) }

    /// Drop confirmed/expired entries, then prepend the survivors that the
    /// server list is still missing. Called on every server list adoption.
    private func mergePending(into serverTasks: [WalnutTask]) -> [WalnutTask] {
        let serverIds = Set(serverTasks.map(\.id))
        let now = Date()
        pendingCreated.removeAll { serverIds.contains($0.task.id) || now.timeIntervalSince($0.createdAt) > Self.pendingTTL }
        persistPending()
        guard !pendingCreated.isEmpty else { return serverTasks }
        return pendingCreated.map(\.task) + serverTasks
    }

    private func persistPending() {
        DiskCache.save(pendingCreated, key: "tasks-pending-created")
    }

    // Sessions ride the same panel as a smart-list tab (read-only projection).
    var sessions: [WalnutSession] = [] {
        didSet { sessionsGen &+= 1 }
    }
    var sessionsSyncedAt: Date?
    var sessionsNotSyncedYet = false

    // MARK: - Live events feed (GET /api/v1/events)
    //
    // One SSE stream keeps both lists current: snapshot on (re)connect = full
    // replace; then per-row task-upsert / task-delete / session-upsert. While
    // the feed is down (or the server predates it) a 30s poll of the two REST
    // lists covers the gap. Parsing/decoding runs off-main inside
    // EventsFeedClient; this store only applies ≤4Hz batched mutations.

    @ObservationIgnored private var feed: EventsFeedClient?
    /// Latest feed transport state (MainActor-confined).
    @ObservationIgnored private(set) var feedState: EventsFeedClient.FeedState = .down
    /// 404 from the feed = server predates it; never retry this app session.
    @ObservationIgnored private var feedUnsupported = false
    @ObservationIgnored private var fallbackPollTask: Task<Void, Never>?
    private static let fallbackPollSeconds: Double = 30

    init() {
        LifecycleHub.shared.register(self)
    }

    private func connectFeed() {
        guard isActive, feed == nil, !feedUnsupported else { return }
        guard let url = WalnutAPI.eventsFeedURL(), let token = AppConfig.token else { return }
        let client = EventsFeedClient(
            url: url,
            token: token,
            // [weak self] belongs on the OUTER closures: with it only on the
            // inner Task, the outer closure strong-captures self and the
            // store ↔ client retain cycle outlives disconnectFeed().
            onMutations: { [weak self] batch in
                Task { @MainActor in self?.applyFeedMutations(batch) }
            },
            onStateChange: { [weak self] state in
                Task { @MainActor in self?.feedStateChanged(state) }
            }
        )
        feed = client
        client.start()
    }

    private func disconnectFeed() {
        feed?.stop()
        feed = nil
        stopFallbackPolling()
    }

    private func feedStateChanged(_ state: EventsFeedClient.FeedState) {
        guard isActive else { return }
        feedState = state
        switch state {
        case .live:
            stopFallbackPolling()
        case .unsupported:
            feedUnsupported = true
            feed = nil // client already stopped itself
            startFallbackPolling()
        case .down:
            startFallbackPolling()
        }
    }

    /// 30s REST refresh while the live feed can't deliver. Idempotent.
    private func startFallbackPolling() {
        guard isActive, fallbackPollTask == nil else { return }
        fallbackPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.fallbackPollSeconds))
                guard let self, self.isActive, !Task.isCancelled else { return }
                async let t: Void = self.loadTasks()
                async let s: Void = self.loadSessions()
                _ = await (t, s)
            }
        }
    }

    private func stopFallbackPolling() {
        fallbackPollTask?.cancel()
        fallbackPollTask = nil
    }

    /// Apply one coalesced batch from the feed. Same-value writes are skipped
    /// (the reducer reports `changed`) so idle upsert echoes never invalidate
    /// SwiftUI. A snapshot replaces both lists wholesale (pending overlay
    /// preserved); upserts/deletes edit in place, arrival order kept.
    private func applyFeedMutations(_ batch: [EventsFeedMutation]) {
        guard isActive else { return }
        MainWork.track("tasks.feed", count: batch.count) {
            applyFeedMutationsTracked(batch)
        }
    }

    private func applyFeedMutationsTracked(_ batch: [EventsFeedMutation]) {
        var nextTasks = tasks
        var nextSessions = sessions
        var tasksChanged = false
        var sessionsChanged = false
        for mutation in batch {
            switch mutation {
            case .snapshot(let snapTasks, let snapSessions):
                nextTasks = mergePending(into: snapTasks)
                nextSessions = snapSessions
                tasksChanged = true
                sessionsChanged = true
                notSyncedYet = false
                sessionsNotSyncedYet = false
            case .taskUpsert(let row):
                // The authoritative row confirms any matching pending overlay.
                if pendingCreated.contains(where: { $0.task.id == row.id }) {
                    pendingCreated.removeAll { $0.task.id == row.id }
                    persistPending()
                }
                // A PATCH is in flight for this id: the server row may predate
                // the edit (emitted for an unrelated reason) — replay the edit
                // on top so the optimistic value never visibly flashes back.
                let effective = inFlightEdits[row.id].map { Self.applyEdit($0, to: row) } ?? row
                let result = EventsFeedReducer.upsertTask(nextTasks, effective)
                nextTasks = result.rows
                tasksChanged = tasksChanged || result.changed
            case .taskDelete(let id):
                // Clear any pending overlay too — otherwise a task created on
                // this phone then deleted elsewhere gets resurrected by the
                // overlay on the next snapshot/refresh (TTL is 30 min).
                if pendingCreated.contains(where: { $0.task.id == id }) {
                    pendingCreated.removeAll { $0.task.id == id }
                    persistPending()
                }
                let result = EventsFeedReducer.deleteTask(nextTasks, id: id)
                nextTasks = result.rows
                tasksChanged = tasksChanged || result.changed
            case .sessionUpsert(let row):
                let result = EventsFeedReducer.upsertSession(nextSessions, row)
                nextSessions = result.rows
                sessionsChanged = sessionsChanged || result.changed
            }
        }
        let now = Date()
        if tasksChanged {
            tasks = nextTasks
            syncedAt = now
            DiskCache.save(tasks, key: "tasks-list")
        }
        if sessionsChanged {
            sessions = nextSessions
            sessionsSyncedAt = now
            DiskCache.save(sessions, key: "sessions-list")
        }
        if tasksChanged || sessionsChanged {
            connection?.reportReachability(true, source: "events-sse")
        }
    }

    // MARK: - Test seams (WalnutTests drive the REAL mutation/overlay logic
    // without a network; production code must never call these).

    func _applyFeedMutationsForTesting(_ batch: [EventsFeedMutation]) {
        applyFeedMutationsTracked(batch)
    }

    func _registerPendingCreatedForTesting(_ task: WalnutTask) {
        pendingCreated.append(PendingCreated(task: task, createdAt: Date()))
    }

    func _setInFlightEditForTesting(id: String, edit: TaskEdit?) {
        inFlightEdits[id] = edit
    }

    func _mergePendingForTesting(into serverTasks: [WalnutTask]) -> [WalnutTask] {
        mergePending(into: serverTasks)
    }

    /// Render from cache, then refresh. The cache reads are OFF-MAIN (P0-1): a
    /// synchronous decode here was cold-start work that could get a
    /// background / prewarm launch killed for blowing the scene-update budget.
    /// Each adoption is guarded on "nothing canonical landed yet" because the
    /// network refresh can win the race.
    func initialize() async {
        isActive = true
        if let cachedPending = await DiskCache.loadAsync([PendingCreated].self, key: "tasks-pending-created"),
           isActive, pendingCreated.isEmpty {
            pendingCreated = cachedPending
        }
        if let cached = await DiskCache.loadAsync([WalnutTask].self, key: "tasks-list"),
           isActive, tasks.isEmpty {
            tasks = cached
        }
        if let cachedSynced = await DiskCache.loadAsync(String.self, key: "tasks-syncedAt"),
           isActive, syncedAt == nil {
            syncedAt = WalnutTask.parseISO(cachedSynced)
        }
        if let cachedSessions = await DiskCache.loadAsync([WalnutSession].self, key: "sessions-list"),
           isActive, sessions.isEmpty {
            sessions = cachedSessions
        }
        // Live feed + one REST refresh in parallel: the feed's snapshot frame
        // usually lands first, and the REST answers are then no-ops.
        connectFeed()
        async let t: Void = loadTasks()
        async let s: Void = loadSessions()
        _ = await (t, s)
    }

    func loadTasks() async {
        guard isActive else { return }
        taskLoadSeq += 1
        let seq = taskLoadSeq
        loading = true
        defer { loading = false }
        do {
            let response = try await api.tasks()
            guard isActive, !Task.isCancelled, seq == taskLoadSeq else { return }
            // Overlay pending creates: on a REPLICA the projection lags the
            // create, so a raw adoption here would delete the optimistic row.
            MainWork.track("tasks.load", count: response.tasks.count) {
                tasks = mergePending(into: response.tasks)
            }
            syncedAt = WalnutTask.parseISO(response.syncedAt)
            notSyncedYet = false
            errorMessage = nil
            connection?.reportReachability(true, source: "tasks-rest")
            // Cache the MERGED list: a cold start adopts tasks-list verbatim
            // (before any network), so the pending rows must be in it too.
            DiskCache.save(tasks, key: "tasks-list")
            DiskCache.save(response.syncedAt, key: "tasks-syncedAt")
        } catch let error as APIError where error.isUnavailable {
            // 503 — projection hasn't synced; keep any cached tasks but flag it.
            guard isActive, seq == taskLoadSeq else { return }
            notSyncedYet = true
            if tasks.isEmpty { errorMessage = nil }
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            guard isActive, seq == taskLoadSeq else { return }
            reportIfNetwork(error)
            if tasks.isEmpty { errorMessage = error.localizedDescription }
        }
    }

    func loadSessions() async {
        guard isActive else { return }
        sessionLoadSeq += 1
        let seq = sessionLoadSeq
        do {
            let response = try await api.sessions()
            guard isActive, !Task.isCancelled, seq == sessionLoadSeq else { return }
            MainWork.track("tasks.loadSessions", count: response.sessions.count) {
                sessions = response.sessions
            }
            sessionsSyncedAt = WalnutTask.parseISO(response.syncedAt)
            sessionsNotSyncedYet = false
            connection?.reportReachability(true, source: "tasks-rest")
            DiskCache.save(response.sessions, key: "sessions-list")
        } catch let error as APIError where error.isUnavailable {
            guard isActive, seq == sessionLoadSeq else { return }
            sessionsNotSyncedYet = true
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            guard isActive, seq == sessionLoadSeq else { return }
            reportIfNetwork(error)
        }
    }

    /// Create a task. Optimistic: the server's created task is inserted into
    /// the local list immediately AND registered as a pending overlay — on a
    /// REPLICA the GET projection lags the create by the outbox → primary →
    /// git-sync round trip, so without the overlay the very next refresh
    /// would silently delete the row ("created it but can't find it").
    /// The overlay survives refreshes (and restarts, via DiskCache) until the
    /// server list contains the id. Throws on failure — the sheet surfaces it.
    @discardableResult
    func createTask(
        title: String, project: String? = nil, priority: String? = nil,
        dueDate: String? = nil, description: String? = nil
    ) async throws -> WalnutTask {
        let created = try await api.createTask(
            title: title, project: project, priority: priority,
            dueDate: dueDate, description: description
        )
        if isActive {
            pendingCreated.append(PendingCreated(task: created, createdAt: Date()))
            persistPending()
            if !tasks.contains(where: { $0.id == created.id }) {
                tasks.insert(created, at: 0)
                DiskCache.save(tasks, key: "tasks-list")
            }
            // Locate-me signal: the list scrolls to + highlights this row.
            lastCreatedTaskId = created.id
        }
        // Reconcile with the projection in the background (it may lag a few
        // seconds behind the SQLite write; mergePending keeps the new row).
        Task { await self.loadTasks() }
        return created
    }

    /// NL quick-parse (Wave 2) — stateless pass-through to the API so views
    /// don't hold their own client. Throws on failure; caller shows the error.
    func quickParse(_ text: String) async throws -> QuickParsedTask {
        try await api.quickParseTask(text: text)
    }

    // MARK: - Task editing (PATCH /tasks/:id — optimistic, rollback on failure)

    /// One optimistic edit. Non-nil fields apply; `dueDate` "" = clear.
    struct TaskEdit {
        var status: String? = nil
        var priority: String? = nil
        var dueDate: String? = nil
        var project: String? = nil
        var title: String? = nil

        var isEmpty: Bool {
            status == nil && priority == nil && dueDate == nil && project == nil && title == nil
        }
    }

    /// Pure optimistic projection of an edit onto a task row — what the list
    /// shows while the PATCH is in flight. Static + pure so WalnutTests can
    /// drive the apply/rollback state machine without a network. `now` is
    /// injectable because the projection stamps timestamps: two calls straddling
    /// a second produce UNEQUAL rows, which is exactly why the rollback guard
    /// must compare against the stored optimistic instance, never a recompute.
    static func applyEdit(_ edit: TaskEdit, to task: WalnutTask, now: Date = .now) -> WalnutTask {
        WalnutTask(
            id: task.id,
            title: edit.title ?? task.title,
            status: edit.status ?? task.status,
            phase: task.phase,
            priority: edit.priority ?? task.priority,
            project: edit.project ?? task.project,
            dueDate: edit.dueDate.map { $0.isEmpty ? nil : $0 } ?? task.dueDate,
            createdAt: task.createdAt,
            updatedAt: ISO8601DateFormatter().string(from: now),
            completedAt: edit.status == "done"
                ? (task.completedAt ?? ISO8601DateFormatter().string(from: now))
                : (edit.status != nil ? nil : task.completedAt),
            starred: task.starred,
            pinned: task.pinned,
            tags: task.tags,
            summary: task.summary
        )
    }

    /// Edits with a PATCH in flight, keyed by task id. A feed `task-upsert`
    /// arriving mid-PATCH (server emitted for an unrelated reason, content
    /// still pre-edit) replays the in-flight edit on top of the server row, so
    /// the optimistic value never visibly flashes back to the old one.
    @ObservationIgnored private var inFlightEdits: [String: TaskEdit] = [:]

    /// Optimistic update: swap the row locally, PATCH, then adopt the server's
    /// authoritative row. On failure the original row is restored and the
    /// error is rethrown for the caller's banner. Returns the server row.
    @discardableResult
    func updateTask(id: String, edit: TaskEdit) async throws -> WalnutTask {
        guard !edit.isEmpty else { throw APIError.badResponse }
        guard let idx = tasks.firstIndex(where: { $0.id == id }) else {
            // Row not in the local list (stale sheet) — go straight to the server.
            return try await patchTask(id: id, edit: edit)
        }
        let original = tasks[idx]
        // Store the exact optimistic row we wrote: applyEdit stamps a fresh
        // `updatedAt` (and possibly `completedAt`) on every call, so a second
        // applyEdit in the catch below would NEVER equal it — the rollback
        // guard must compare against this instance, not a recomputation.
        let optimistic = Self.applyEdit(edit, to: original)
        tasks[idx] = optimistic
        inFlightEdits[id] = edit
        defer { inFlightEdits[id] = nil }
        do {
            let updated = try await patchTask(id: id, edit: edit)
            guard isActive else { return updated }
            // Adopt the authoritative row (index may have shifted meanwhile).
            if let now = tasks.firstIndex(where: { $0.id == id }) {
                tasks[now] = updated
            }
            DiskCache.save(tasks, key: "tasks-list")
            return updated
        } catch {
            // Roll back — unless a feed upsert already replaced our optimistic
            // row with newer server truth (never clobber authority with a memory).
            if let now = tasks.firstIndex(where: { $0.id == id }),
               tasks[now] == optimistic {
                tasks[now] = original
            }
            throw error
        }
    }

    private func patchTask(id: String, edit: TaskEdit) async throws -> WalnutTask {
        try await api.updateTask(
            id: id, status: edit.status, priority: edit.priority,
            dueDate: edit.dueDate, project: edit.project, title: edit.title
        )
    }

    // MARK: - Pin toggle (Wave 1 — POST/DELETE /focus/tasks/:id)

    /// Pin/unpin with optimistic row update + rollback. Returns an error
    /// message on failure (409 = pinning a completed task), nil on success.
    func setPinned(_ task: WalnutTask, pinned: Bool) async -> String? {
        // Optimistic: flip the row's pinned flag in place.
        let apply = { (value: Bool?) in
            if let idx = self.tasks.firstIndex(where: { $0.id == task.id }) {
                let t = self.tasks[idx]
                self.tasks[idx] = WalnutTask(
                    id: t.id, title: t.title, status: t.status, phase: t.phase,
                    priority: t.priority, project: t.project, dueDate: t.dueDate,
                    createdAt: t.createdAt, updatedAt: t.updatedAt,
                    completedAt: t.completedAt, starred: t.starred,
                    pinned: value, tags: t.tags, summary: t.summary
                )
            }
        }
        apply(pinned)
        do {
            _ = pinned
                ? try await api.pinTask(id: task.id)
                : try await api.unpinTask(id: task.id)
            // Authoritative refresh (pin state is exported on the projection).
            await loadTasks()
            return nil
        } catch {
            apply(task.pinned) // rollback
            if let apiError = error as? APIError, apiError.isConflict {
                return "Completed tasks can't be pinned."
            }
            return error.localizedDescription
        }
    }

    // MARK: - Batch actions (Wave 1 — POST /tasks/batch/phase|delete)

    /// Batch-complete (or reopen). PARTIAL SUCCESS by contract: returns a
    /// human summary line on any failure, nil when everything succeeded.
    /// The server emits per-task events, so the list converges via the feed;
    /// a REST refresh covers the no-feed fallback.
    func batchSetDone(_ taskIds: [String], done: Bool) async -> String? {
        guard !taskIds.isEmpty else { return nil }
        do {
            let result = try await api.batchSetPhase(taskIds: taskIds, phase: done ? "COMPLETE" : "TODO")
            await loadTasks()
            if result.failed.isEmpty { return nil }
            let reason = result.failed.first?.error ?? "unknown error"
            return "\(result.changed.count) updated, \(result.failed.count) failed — \(reason)"
        } catch {
            return error.localizedDescription
        }
    }

    /// Batch-delete. Same partial-success contract as batchSetDone.
    func batchDelete(_ taskIds: [String], force: Bool = false) async -> String? {
        guard !taskIds.isEmpty else { return nil }
        do {
            let result = try await api.batchDeleteTasks(taskIds: taskIds, force: force)
            let deletedIds = Set(result.deleted.map(\.id))
            if !deletedIds.isEmpty {
                tasks.removeAll { deletedIds.contains($0.id) }
                DiskCache.save(tasks, key: "tasks-list")
            }
            await loadTasks()
            if result.failed.isEmpty { return nil }
            let reason = result.failed.first?.error ?? "unknown error"
            return "\(result.deleted.count) deleted, \(result.failed.count) failed — \(reason)"
        } catch {
            return error.localizedDescription
        }
    }

    /// One-tap todo↔done toggle for list rows (swipe / long-press).
    func toggleDone(_ task: WalnutTask) async -> String? {
        let next = task.statusKind == .done ? "todo" : "done"
        do {
            _ = try await updateTask(id: task.id, edit: TaskEdit(status: next))
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    // MARK: - Derived-slice memoization (audit MAIN-5/OBS-3/TMR-9, 2026-08-08)
    //
    // TasksView recomputes its derived collections on EVERY body evaluation
    // (each search keystroke, each store refresh, each connectivity flip) —
    // filter+sort over the full projection, several times per pass. At field
    // scale (766 tasks / 351 sessions) one pass measured ~324ms, ~0.7s of
    // main thread per search keystroke. Fix layers: parseISO memo cache
    // (Models.swift), decorated sorts (openSorted/doneSorted/recencySorted),
    // and this generation-keyed memo so repeat body evaluations of an
    // unchanged list are dictionary hits. Gated by TasksDerivedPerfTests.
    //
    // The caches are @ObservationIgnored (writes must not invalidate views);
    // every getter reads the OBSERVED backing array first so SwiftUI
    // dependency tracking still registers even on a cache hit.

    @ObservationIgnored private var tasksGen: UInt64 = 0
    @ObservationIgnored private var sessionsGen: UInt64 = 0
    @ObservationIgnored private var taskSliceCache:
        (gen: UInt64, day: Date, byFilter: [TaskFilter: [WalnutTask]]) = (0, .distantPast, [:])
    @ObservationIgnored private var sessionSliceCache:
        (gen: UInt64, active: [WalnutSession]?, pinned: [WalnutSession]?) = (0, nil, nil)

    // MARK: - Derived session slices

    /// Sessions with a live CLI process (running or idle), pinned first.
    var activeSessions: [WalnutSession] {
        let all = sessions // observed read FIRST (dependency tracking on hits)
        if sessionSliceCache.gen != sessionsGen {
            sessionSliceCache = (sessionsGen, nil, nil)
        }
        if let hit = sessionSliceCache.active { return hit }
        let rows = all.filter { $0.statusKind.isAlive }.sorted(by: sessionOrder)
        sessionSliceCache.active = rows
        return rows
    }

    var pinnedSessions: [WalnutSession] {
        let all = sessions
        if sessionSliceCache.gen != sessionsGen {
            sessionSliceCache = (sessionsGen, nil, nil)
        }
        if let hit = sessionSliceCache.pinned { return hit }
        let rows = all.filter { $0.isPinned }.sorted(by: sessionOrder)
        sessionSliceCache.pinned = rows
        return rows
    }

    /// Pinned first (focus tier before the rest), then most recently active.
    private func sessionOrder(_ a: WalnutSession, _ b: WalnutSession) -> Bool {
        if a.isPinned != b.isPinned { return a.isPinned }
        let af = a.focusTier == "focus", bf = b.focusTier == "focus"
        if af != bf { return af }
        return WalnutSession.recencySort(a, b)
    }

    // MARK: - Derived slices (smart lists)

    var openTasks: [WalnutTask] {
        tasks.filter { $0.statusKind == .todo || $0.statusKind == .inProgress }
    }

    var inProgressTasks: [WalnutTask] {
        tasks.filter { $0.statusKind == .inProgress }
    }

    var todayTasks: [WalnutTask] {
        openTasks.filter { $0.isDueToday || $0.isOverdue }
    }

    var doneTasks: [WalnutTask] {
        tasks.filter { $0.statusKind == .done }
    }

    /// Tasks for a smart-list filter, already sorted for section rendering.
    /// (.sessions renders its own list — returns [] here.) Memoized per
    /// tasks-generation; the `.today` slice additionally keys on the local
    /// day so "due today / overdue" rolls over at midnight like it used to.
    func tasks(for filter: TaskFilter) -> [WalnutTask] {
        guard filter != .sessions else { return [] }
        _ = tasks.count // observed read FIRST (dependency tracking on hits)
        let day = Calendar.current.startOfDay(for: Date())
        if taskSliceCache.gen != tasksGen || taskSliceCache.day != day {
            taskSliceCache = (tasksGen, day, [:])
        }
        if let hit = taskSliceCache.byFilter[filter] { return hit }
        let rows: [WalnutTask]
        switch filter {
        case .today: rows = WalnutTask.openSorted(todayTasks)
        case .inProgress: rows = WalnutTask.openSorted(inProgressTasks)
        case .sessions: rows = []
        case .allOpen: rows = WalnutTask.openSorted(openTasks)
        case .done: rows = WalnutTask.doneSorted(doneTasks)
        }
        taskSliceCache.byFilter[filter] = rows
        return rows
    }

    func count(for filter: TaskFilter) -> Int {
        // Rides the memoized slices — the smart-list cards call this 5x per
        // body pass, which used to be 5 more full-projection filter walks.
        filter == .sessions ? sessions.count : tasks(for: filter).count
    }

    private func reportIfNetwork(_ error: Error) {
        if let apiError = error as? APIError {
            if apiError.isCancelled { return }
            if case .network = apiError {
                connection?.reportReachability(false, source: "tasks-rest", error: error)
            }
        }
    }
}

extension TasksStore: LifecycleSuspendable {
    /// Background: drop the events feed (iOS would kill the socket anyway) and
    /// stop mutating observed state (`isActive`). Foreground: reconnect — the
    /// snapshot frame on attach heals anything missed while backgrounded.
    func suspendForBackground() {
        isActive = false
        disconnectFeed()
    }

    func resumeForForeground() {
        isActive = true
        connectFeed()
        // The feed snapshot covers tasks+sessions, but reconnect can lag —
        // fire one REST refresh so the lists are fresh immediately.
        Task { [weak self] in
            guard let self else { return }
            async let t: Void = self.loadTasks()
            async let s: Void = self.loadSessions()
            _ = await (t, s)
        }
    }
}

/// The Reminders-style smart lists (+ the Sessions tab).
enum TaskFilter: String, CaseIterable, Identifiable {
    // Declaration order IS the card order: Sessions leads — live agent work
    // is the primary daily surface, task lists follow.
    case sessions, today, inProgress, allOpen, done
    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: return "Today"
        case .inProgress: return "In Progress"
        case .sessions: return "Sessions"
        case .allOpen: return "All Open"
        case .done: return "Done"
        }
    }

    var systemImage: String {
        switch self {
        case .today: return "calendar"
        case .inProgress: return "arrow.triangle.2.circlepath"
        case .sessions: return "terminal"
        case .allOpen: return "tray.full"
        case .done: return "checkmark"
        }
    }

    /// accessibilityIdentifier suffix ("today"/"inprogress"/"sessions"/"all"/"done").
    var identifierKey: String {
        switch self {
        case .today: return "today"
        case .inProgress: return "inprogress"
        case .sessions: return "sessions"
        case .allOpen: return "all"
        case .done: return "done"
        }
    }
}
