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
    /// Internal (not private) so same-module extensions in other files can
    /// ride the same client (TasksStoreQuickAdd's backfill PATCH).
    let api = WalnutAPI()
    /// Mutation seam: production uses the same WalnutAPI instance; WalnutTests
    /// pass a scripted mock so the REAL optimistic apply/rollback state
    /// machines run without a network.
    @ObservationIgnored let transport: WalnutTaskTransport
    weak var connection: ConnectionStore?

    /// False while backgrounded — every completion re-checks it before touching
    /// observed state, so a fetch that lands during suspension cannot drive
    /// SwiftUI updates from a non-active process (P0-3). Readable (not
    /// settable) from same-module extensions (TasksStoreQuickAdd).
    private(set) var isActive = true

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

    /// Adopt an upgraded row into the pending overlay (quick-add parse
    /// backfill) so a REPLICA refresh re-merges the upgraded task, not the
    /// raw-title original it was created with. No-op when not overlaid.
    func refreshPendingCreated(_ task: WalnutTask) {
        guard let idx = pendingCreated.firstIndex(where: { $0.task.id == task.id }) else { return }
        pendingCreated[idx] = PendingCreated(task: task, createdAt: pendingCreated[idx].createdAt)
        persistPending()
    }

    // MARK: - User-touched tracking (quick-add backfill race guard)
    //
    // The NL quick-add creates a raw-title task instantly and PATCHes parse
    // results onto it seconds later (TasksStoreQuickAdd). If the USER edits,
    // completes, pins, or deletes the row in that window, the late backfill
    // must never clobber their change — every user-initiated mutation marks
    // the id here and the backfill skips marked rows entirely.

    @ObservationIgnored private var userTouchedIds: Set<String> = []

    /// Record a user-initiated mutation on a task id.
    func noteUserTouched(_ id: String) { userTouchedIds.insert(id) }

    /// True when the user has mutated this task since it appeared.
    func isUserTouched(_ id: String) -> Bool { userTouchedIds.contains(id) }

    // Sessions ride the same panel as a smart-list tab (read-only projection).
    var sessions: [WalnutSession] = [] {
        didSet { sessionsGen &+= 1 }
    }
    var sessionsSyncedAt: Date?
    var sessionsNotSyncedYet = false

    // MARK: - Focus tier state (GET /focus/tasks + /focus/tiers)
    //
    // The slim task projection carries `pinned` but NOT `focus_tier`, so the
    // phone joins the tier split endpoint by task id. Satellite entries are
    // explicit in the map so every pinned row resolves a label.

    /// taskId → tier id ("focus" | "satellite" | "backlog" | "wait" | "ct_*")
    /// for every currently pinned task.
    var taskTiers: [String: String] = [:]
    /// Custom tier registry (ct_* id → label), refreshed with the split.
    var customTiers: [FocusTierInfo] = []
    /// Debounce handle for scheduleTierRefresh (extension file).
    @ObservationIgnored var tierRefreshTask: Task<Void, Never>?
    /// Transient failure line for fire-and-forget mutations — TasksView shows
    /// it as a small auto-dismissing toast (never a modal).
    var transientError: String?
    /// Transient info line ("Pinned · Satellite") — same toast surface.
    var transientNotice: String?
    /// Task ids whose delete came back 409 (active sessions) — the next
    /// delete confirm for these offers "Stop Sessions & Delete".
    var deleteNeedsForceIds: Set<String> = []

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
    /// 404/401/403 from the feed = don't reconnect-loop. NOT permanent: each
    /// foreground reset retries ONCE — a transient 401 (cloud box mid-restart,
    /// proxy hiccup) used to freeze the app on 30s polling for its whole
    /// lifetime, the top phone-side "status is stale" mechanism.
    @ObservationIgnored private var feedUnsupported = false
    @ObservationIgnored private var fallbackPollTask: Task<Void, Never>?
    /// Feed down → real fallback cadence.
    private static let fallbackPollSeconds: Double = 30
    /// Feed LIVE → slow trust-but-verify cadence. The cloud relay lane is
    /// fire-and-forget (a dropped bridge frame is healed only by the next
    /// snapshot, i.e. the next reconnect), so a healthy-looking feed can
    /// silently miss rows; a slow REST reconcile bounds that staleness.
    private static let verifyPollSeconds: Double = 120

    /// Weak app-wide reference so session-page control objects created by
    /// views can apply optimistic list updates. The app's single store
    /// instance owns its own lifetime; tests overwrite it harmlessly.
    static weak var shared: TasksStore?

    /// `transport` nil (production) = the store's own WalnutAPI instance.
    /// WalnutTests pass a scripted mock to drive the real mutation paths.
    init(transport: WalnutTaskTransport? = nil) {
        self.transport = transport ?? api
        LifecycleHub.shared.register(self)
        Self.shared = self
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
            // Feed authoritative — drop to the slow verify cadence (the
            // bridge relay lane can drop frames silently; see the constant).
            restartPolling(every: Self.verifyPollSeconds)
        case .unsupported:
            feedUnsupported = true
            feed = nil // client already stopped itself
            restartPolling(every: Self.fallbackPollSeconds)
        case .down:
            restartPolling(every: Self.fallbackPollSeconds)
        }
    }

    /// Cadence of the currently running poll task (0 = none). Guards against
    /// timer resets: the feed emits `.down` on EVERY failed reconnect attempt,
    /// and blindly restarting the poll each time would keep pushing the next
    /// refresh out — potentially forever under a steady 30s backoff loop.
    @ObservationIgnored private var pollCadence: Double = 0

    /// (Re)start the background REST refresh at the given cadence. No-op when
    /// a poll at the same cadence is already running.
    private func restartPolling(every seconds: Double) {
        guard isActive else { return }
        if pollCadence == seconds, fallbackPollTask != nil { return }
        stopFallbackPolling()
        pollCadence = seconds
        fallbackPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(seconds))
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
        pollCadence = 0
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
        async let f: Void = loadFocusTiers()
        _ = await (t, s, f)
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
            // Replay in-flight optimistic edits on top (same rule as the feed
            // upsert path): the fetched projection can predate a PATCH that is
            // still running, and adopting it verbatim flashes the old value.
            MainWork.track("tasks.load", count: response.tasks.count) {
                var merged = mergePending(into: response.tasks)
                if !inFlightEdits.isEmpty {
                    merged = merged.map { row in
                        inFlightEdits[row.id].map { Self.applyEdit($0, to: row) } ?? row
                    }
                }
                tasks = merged
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
    /// `startDate`/`endDate` create the task already on the calendar (the
    /// "tap a day / drag a range" gesture); an end needs a start.
    @discardableResult
    func createTask(
        title: String, project: String? = nil, priority: String? = nil,
        dueDate: String? = nil, startDate: String? = nil, endDate: String? = nil,
        description: String? = nil
    ) async throws -> WalnutTask {
        let created = try await api.createTask(
            title: title, project: project, priority: priority,
            dueDate: dueDate, startDate: startDate, endDate: endDate,
            description: description
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

    // MARK: - Quick-add plumbing (state ops for TasksStoreQuickAdd)
    //
    // The NL quick-add flow lives in TasksStoreQuickAdd.swift; these helpers
    // stay here because they touch the private pendingCreated overlay. All
    // are pure local-state ops (no network) so WalnutTests can drive them.

    /// Instant local insert of a not-yet-POSTed placeholder row. NOT added to
    /// the pending overlay (it has no server id yet) — a refresh landing in
    /// the POST window may briefly drop it; adoptCreated restores it.
    func insertPlaceholder(_ task: WalnutTask) {
        guard isActive else { return }
        tasks.insert(task, at: 0)
    }

    /// Remove a placeholder row (create POST failed).
    func removePlaceholder(id: String) {
        tasks.removeAll { $0.id == id }
    }

    /// Adopt the server-created row: register the pending overlay (REPLICA
    /// refreshes must keep it) and swap the placeholder in place. If the SSE
    /// feed already delivered the created row (it can beat the POST response),
    /// the placeholder is dropped instead — never two rows for one task.
    func adoptCreated(_ created: WalnutTask, replacingPlaceholder placeholderId: String?) {
        guard isActive else { return }
        pendingCreated.append(PendingCreated(task: created, createdAt: Date()))
        persistPending()
        let alreadyPresent = tasks.contains { $0.id == created.id }
        if let placeholderId, let idx = tasks.firstIndex(where: { $0.id == placeholderId }) {
            if alreadyPresent { tasks.remove(at: idx) } else { tasks[idx] = created }
        } else if !alreadyPresent {
            tasks.insert(created, at: 0)
        }
        DiskCache.save(tasks, key: "tasks-list")
        lastCreatedTaskId = created.id
    }

    /// Adopt the parse-upgraded row (quick-add backfill PATCH response) —
    /// unless the user touched the task while the parse was in flight, in
    /// which case their edit wins and the backfill result is discarded.
    func adoptBackfilled(_ updated: WalnutTask) {
        guard isActive, !isUserTouched(updated.id) else { return }
        if let idx = tasks.firstIndex(where: { $0.id == updated.id }) {
            tasks[idx] = updated
        }
        refreshPendingCreated(updated)
        DiskCache.save(tasks, key: "tasks-list")
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
        /// Calendar block (additive, 2026-08). "" clears either one; clearing
        /// the start clears the end server-side too.
        var startDate: String? = nil
        var endDate: String? = nil
        var project: String? = nil
        var title: String? = nil

        var isEmpty: Bool {
            status == nil && priority == nil && dueDate == nil && startDate == nil
                && endDate == nil && project == nil && title == nil
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
            summary: task.summary,
            // Same "" = clear convention as dueDate above. Clearing the start
            // drops the end too, mirroring the server's cascade — otherwise the
            // optimistic row would show an end the server just removed.
            startDate: edit.startDate.map { $0.isEmpty ? nil : $0 } ?? task.startDate,
            endDate: (edit.startDate?.isEmpty == true)
                ? nil
                : (edit.endDate.map { $0.isEmpty ? nil : $0 } ?? task.endDate)
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
        // Human edit — a late quick-add parse backfill must not clobber it.
        noteUserTouched(id)
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
        try await transport.updateTask(
            id: id, status: edit.status, priority: edit.priority,
            dueDate: edit.dueDate, startDate: edit.startDate, endDate: edit.endDate,
            project: edit.project, title: edit.title,
            description: nil
        )
    }

    // MARK: - Pin toggle (Wave 1 — POST/DELETE /focus/tasks/:id)

    /// Same row with a different pinned flag (WalnutTask is immutable).
    static func withPinned(_ t: WalnutTask, _ value: Bool?) -> WalnutTask {
        WalnutTask(
            id: t.id, title: t.title, status: t.status, phase: t.phase,
            priority: t.priority, project: t.project, dueDate: t.dueDate,
            createdAt: t.createdAt, updatedAt: t.updatedAt,
            completedAt: t.completedAt, starred: t.starred,
            pinned: value, tags: t.tags, summary: t.summary,
            startDate: t.startDate, endDate: t.endDate
        )
    }

    /// Pin/unpin with optimistic row update + rollback. Returns an error
    /// message on failure (409 = pinning a completed task), nil on success.
    /// No blocking list refetch on success: the row is already right, the
    /// events feed (or the verify poll) confirms it; only the tier map is
    /// refreshed so the badge appears/disappears.
    func setPinned(_ task: WalnutTask, pinned: Bool) async -> String? {
        noteUserTouched(task.id)
        // Optimistic: flip the row's pinned flag + tier map in place.
        let apply = { (value: Bool?) in
            if let idx = self.tasks.firstIndex(where: { $0.id == task.id }) {
                self.tasks[idx] = Self.withPinned(self.tasks[idx], value)
            }
        }
        let originalTier = taskTiers[task.id]
        apply(pinned)
        // New pins land in satellite (the server default tier).
        taskTiers[task.id] = pinned ? "satellite" : nil
        do {
            _ = pinned
                ? try await transport.pinTask(id: task.id)
                : try await transport.unpinTask(id: task.id)
            // Reconcile the tier map in the background (never blocks the UI).
            scheduleTierRefresh()
            return nil
        } catch {
            apply(task.pinned) // rollback
            taskTiers[task.id] = originalTier
            if let apiError = error as? APIError, apiError.isConflict {
                return "Completed tasks can't be pinned."
            }
            return error.localizedDescription
        }
    }

    // MARK: - Batch actions (Wave 1 — POST /tasks/batch/phase|delete)

    /// Batch-complete (or reopen). PARTIAL SUCCESS by contract: returns a
    /// human summary line on any failure, nil when everything succeeded.
    /// Optimistic: every selected row flips locally BEFORE the POST; failed
    /// ids (partial failure or thrown error) roll back to their originals.
    func batchSetDone(_ taskIds: [String], done: Bool) async -> String? {
        guard !taskIds.isEmpty else { return nil }
        for id in taskIds { noteUserTouched(id) }
        // Optimistic apply, remembering originals for rollback.
        var originals: [String: WalnutTask] = [:]
        let edit = TaskEdit(status: done ? "done" : "todo")
        for id in taskIds {
            if let idx = tasks.firstIndex(where: { $0.id == id }) {
                originals[id] = tasks[idx]
                let optimistic = Self.applyEdit(edit, to: tasks[idx])
                tasks[idx] = optimistic
                inFlightEdits[id] = edit
            }
        }
        defer { for id in taskIds { inFlightEdits[id] = nil } }
        let rollback = { (ids: any Sequence<String>) in
            for id in ids {
                if let original = originals[id],
                   let idx = self.tasks.firstIndex(where: { $0.id == id }) {
                    self.tasks[idx] = original
                }
            }
        }
        do {
            let result = try await transport.batchSetPhase(taskIds: taskIds, phase: done ? "COMPLETE" : "TODO")
            if isActive { DiskCache.save(tasks, key: "tasks-list") }
            if result.failed.isEmpty { return nil }
            rollback(result.failed.compactMap(\.id))
            let reason = result.failed.first?.error ?? "unknown error"
            return "\(result.changed.count) updated, \(result.failed.count) failed — \(reason)"
        } catch {
            rollback(taskIds)
            return error.localizedDescription
        }
    }

    /// Batch-delete. Same partial-success contract as batchSetDone.
    /// Optimistic: selected rows vanish immediately; failures reappear.
    func batchDelete(_ taskIds: [String], force: Bool = false) async -> String? {
        guard !taskIds.isEmpty else { return nil }
        for id in taskIds { noteUserTouched(id) }
        // Remember (row, index) so a rollback can reinsert near its old spot.
        var removed: [(task: WalnutTask, index: Int)] = []
        for id in taskIds {
            if let idx = tasks.firstIndex(where: { $0.id == id }) {
                removed.append((tasks[idx], idx))
                tasks.remove(at: idx)
            }
        }
        let restore = { (ids: Set<String>) in
            for entry in removed where ids.contains(entry.task.id) {
                let at = min(entry.index, self.tasks.count)
                self.tasks.insert(entry.task, at: at)
            }
        }
        do {
            let result = try await transport.batchDeleteTasks(taskIds: taskIds, force: force)
            let deletedIds = Set(result.deleted.map(\.id))
            // Rows the server did NOT delete come back.
            restore(Set(taskIds).subtracting(deletedIds))
            if isActive { DiskCache.save(tasks, key: "tasks-list") }
            if result.failed.isEmpty { return nil }
            let reason = result.failed.first?.error ?? "unknown error"
            return "\(result.deleted.count) deleted, \(result.failed.count) failed — \(reason)"
        } catch {
            restore(Set(taskIds))
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
        // Calendar renders its own month grid straight from the store; the
        // flat-list slice is unused (mirrors .sessions).
        case .sessions, .calendar: rows = []
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
        // Give a previously "unsupported" feed one fresh chance per
        // foreground: 401/403 can be transient (cloud box mid-restart, proxy
        // hiccup), and latching it for the app's lifetime silently downgraded
        // live status to 30s polling forever — a top staleness mechanism.
        // A genuinely old server (404) just re-latches after one request.
        feedUnsupported = false
        connectFeed()
        // The feed snapshot covers tasks+sessions, but reconnect can lag —
        // fire one REST refresh so the lists are fresh immediately.
        Task { [weak self] in
            guard let self else { return }
            async let t: Void = self.loadTasks()
            async let s: Void = self.loadSessions()
            async let f: Void = self.loadFocusTiers()
            _ = await (t, s, f)
        }
    }
}

/// The Reminders-style smart lists (+ the Sessions tab).
enum TaskFilter: String, CaseIterable, Identifiable {
    // Declaration order IS the card order: Sessions leads — live agent work
    // is the primary daily surface, task lists follow.
    case sessions, today, calendar, inProgress, allOpen, done
    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: return "Today"
        case .calendar: return "Calendar"
        case .inProgress: return "In Progress"
        case .sessions: return "Sessions"
        case .allOpen: return "All Open"
        case .done: return "Done"
        }
    }

    var systemImage: String {
        switch self {
        case .today: return "calendar"
        case .calendar: return "calendar.badge.clock"
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
        case .calendar: return "calendarview"
        case .inProgress: return "inprogress"
        case .sessions: return "sessions"
        case .allOpen: return "all"
        case .done: return "done"
        }
    }
}
