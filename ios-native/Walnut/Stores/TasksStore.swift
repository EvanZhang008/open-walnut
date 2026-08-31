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

    // MARK: - Which sessions a task HAS (taskId → session_ids)
    //
    // The slim list projection carries no `session_ids`, so "this task has sessions"
    // is only answerable from a task's DETAIL (`GET /v1/tasks/:id`). This is where
    // every detail read deposits that answer, so the board can act on it without
    // re-asking: a row whose session is missing from `sessions` (retention, or the
    // projection cap that shipped as a bug) is still a row that can OPEN its session
    // by id instead of falling through to a New Session draft.
    //
    // A MISSING KEY IS NOT AN EMPTY ARRAY, and the distinction is the whole value of
    // this table: missing = "nobody has asked", `[]` = "asked, and this task has never
    // had a session". The first is worth one request on tap; the second is not.
    // See `BoardRow.knownSessionIds` for what each value routes to.
    //
    // In memory only, deliberately: it is a cache of a server answer that changes
    // whenever a session is created, and a stale copy restored from disk would be a
    // row claiming history a deleted task never had.

    /// taskId → the ids that task's detail reported, newest LAST (link order).
    var sessionIdsByTask: [String: [String]] = [:] {
        didSet { detailsGen &+= 1 }
    }

    /// Record what a task detail said. Cheap and idempotent — every detail read calls
    /// it, and an unchanged answer must not publish (the board's memo is keyed on a
    /// generation counter this setter bumps).
    func noteSessionIds(taskId: String, ids: [String]) {
        guard !taskId.isEmpty else { return }
        let cleaned = ids
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard sessionIdsByTask[taskId] != cleaned else { return }
        sessionIdsByTask[taskId] = cleaned
    }

    /// What the phone knows about this task's sessions: nil = never asked.
    func knownSessionIds(for taskId: String) -> [String]? { sessionIdsByTask[taskId] }

    // MARK: - Focus tier state (GET /focus/tasks + /focus/tiers)
    //
    // The slim task projection carries `pinned` but NOT `focus_tier`, so the
    // phone joins the tier split endpoint by task id. Satellite entries are
    // explicit in the map so every pinned row resolves a label.

    /// taskId → tier id ("focus" | "satellite" | "backlog" | "wait" | "ct_*")
    /// for every currently pinned task.
    var taskTiers: [String: String] = [:] {
        didSet { tiersGen &+= 1 }
    }
    /// tier id → task ids IN PIN ORDER, straight from the split. Kept alongside
    /// the map (not derived from it) because a dictionary has no order and the
    /// board's "a new task lands at the foot of its band" promise is exactly
    /// that order — see TasksStore.tierOrder.
    var taskTierOrder: [String: [String]] = [:] {
        didSet { tiersGen &+= 1 }
    }
    /// Custom tier registry (ct_* id → label), refreshed with the split.
    var customTiers: [FocusTierInfo] = [] {
        didSet { tiersGen &+= 1 }
    }

    // MARK: - The project→folder hierarchy (GET /tasks/groups)
    //
    // The board's `By project` grouping nests folders inside their project, the same
    // way the desktop console does. The slim task projection carries no `group_id`, so
    // task→folder is answered by inverting `member_ids` ONCE per adoption here, never
    // per row and never per body pass — see `BoardFolderIndex`.
    //
    // Best-effort by contract: an old server, a failed request or an empty answer all
    // mean "no hierarchy", and the board degrades to the flat project bands it drew
    // before. There is no error state for this — a blank board would be a far worse
    // answer to "the folder list didn't load" than one without folder headings.

    /// Every folder the server knows, empty folders included.
    var taskFolders: [TaskFolder] = [] {
        didSet {
            foldersGen &+= 1
            folderIndexCache = BoardFolderIndex.build(taskFolders)
        }
    }
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
                // Folders ride the same poll as the lists (one small request, and it
                // no-ops on an unchanged tree) so a folder created on the console shows
                // up on the phone without waiting for a foreground cycle.
                async let g: Void = self.loadTaskFolders()
                _ = await (t, s, g)
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
        // The folder hierarchy is cached for the same reason the lists are: the board
        // renders from cache before any request finishes, and adopting the tasks
        // without their folders would draw a FLAT board that re-nests a second later.
        if let cachedFolders = await DiskCache.loadAsync([TaskFolder].self, key: "task-folders"),
           isActive, taskFolders.isEmpty {
            taskFolders = cachedFolders
        }
        // Live feed + one REST refresh in parallel: the feed's snapshot frame
        // usually lands first, and the REST answers are then no-ops.
        connectFeed()
        async let t: Void = loadTasks()
        async let s: Void = loadSessions()
        async let f: Void = loadFocusTiers()
        async let g: Void = loadTaskFolders()
        _ = await (t, s, f, g)
    }

    /// Fetch the folder hierarchy. Best-effort, exactly like `loadFocusTiers`: an old
    /// server (404), a replica hiccup or an offline phone leaves the last known tree in
    /// place and the board keeps drawing. Never sets `errorMessage` — a missing
    /// hierarchy is a quieter board, not a failure the user can act on.
    ///
    /// Called ONCE per board load / refresh (initialize, foreground, the REST poll,
    /// pull-to-refresh) and never from a body pass: the tree changes when someone edits
    /// folders on the console, which is orders of magnitude rarer than a re-render.
    func loadTaskFolders() async {
        guard isActive else { return }
        do {
            let folders = try await transport.taskFolders()
            guard isActive else { return }
            // Same-value guard: the poll re-fetches an unchanged tree every 30-120s, and
            // adopting it anyway would bump `boardInputsGen` and throw away the band memo
            // for nothing.
            guard folders != taskFolders else { return }
            taskFolders = folders
            DiskCache.save(folders, key: "task-folders")
        } catch {
            AppLog.debug("tasks", "task folder load failed", [
                "error": error.localizedDescription,
            ])
        }
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
    ///
    /// `pin` files the task on the pinned board IN THE CREATE CALL (one write,
    /// no create-then-pin pair). Two things it changes here:
    ///
    ///  - The row is inserted with the tier ALREADY in `taskTiers`, so a task
    ///    born in Focus renders under the Focus header on the very first frame
    ///    instead of appearing in Satellite and hopping once the background
    ///    tier refresh lands.
    ///  - Nothing to roll back on failure by construction: the whole placement
    ///    rode the one request, so a 400 (unknown tier) throws before any local
    ///    state is written. That is the point of doing it in one call.
    @discardableResult
    func createTask(
        title: String, project: String? = nil, priority: String? = nil,
        dueDate: String? = nil, startDate: String? = nil, endDate: String? = nil,
        description: String? = nil, pin: TaskPinChoice = .unspecified
    ) async throws -> WalnutTask {
        // Through the transport seam (not `api`): WalnutTests drive the REAL
        // optimistic placement + rollback against a scripted create.
        let created = try await transport.createTask(
            title: title, project: project, priority: priority,
            dueDate: dueDate, startDate: startDate, endDate: endDate,
            description: description, pin: pin
        )

        if isActive {
            // The 201 for an explicit 'satellite' comes back with NO focus_tier
            // (that absence IS Satellite server-side), so the local tier comes
            // from the CHOICE, not from a field the response is right to omit.
            // `pinned` likewise: the projection carries it, but a tier the user
            // picked is authoritative for the row we render right now.
            let row = pin.optimisticPinned.map { Self.withPinned(created, $0) } ?? created
            if let tier = pin.optimisticTier {
                taskTiers[created.id] = tier
                // The FOOT of the band it was born into — the server already
                // agrees (pin_order = max + 1), so this is not a guess, it is
                // the same answer arriving a round trip earlier.
                taskTierOrder[tier, default: []].append(created.id)
            }
            pendingCreated.append(PendingCreated(task: row, createdAt: Date()))
            persistPending()
            if !tasks.contains(where: { $0.id == row.id }) {
                tasks.insert(row, at: 0)
                DiskCache.save(tasks, key: "tasks-list")
            }
            // Locate-me signal: the list scrolls to + highlights this row.
            lastCreatedTaskId = created.id
            // Reconcile the tier map in the background — same debounce the
            // pin/tier-move paths use, never a blocking refetch.
            if pin.namesTier { scheduleTierRefresh() }
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
        let originalOrder = taskTierOrder
        apply(pinned)
        // New pins land in satellite (the server default tier), at the FOOT of
        // that band — the server's pin_order is max+1, so the optimistic row
        // must go last or it would visibly hop when the split lands.
        taskTiers[task.id] = pinned ? "satellite" : nil
        if pinned {
            taskTierOrder["satellite", default: []].append(task.id)
        } else {
            for (key, ids) in taskTierOrder where ids.contains(task.id) {
                taskTierOrder[key] = ids.filter { $0 != task.id }
            }
        }
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
            taskTierOrder = originalOrder
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
    /// Bumped by the three tier-split properties (`taskTiers`, `taskTierOrder`,
    /// `customTiers`), which the board's bands read alongside the two lists.
    @ObservationIgnored private var tiersGen: UInt64 = 0
    /// Bumped by `taskFolders`, which the board's project grouping nests by.
    @ObservationIgnored private var foldersGen: UInt64 = 0
    /// Bumped by `sessionIdsByTask`: the board reads it per row, so a detail that
    /// lands while the board is on screen has to invalidate the band memo — otherwise
    /// the row keeps saying "no session yet" about a task we now know has one.
    @ObservationIgnored private var detailsGen: UInt64 = 0

    /// taskId → folder, rebuilt ONCE per `taskFolders` adoption.
    ///
    /// `@ObservationIgnored` and rebuilt in the setter rather than derived in a getter:
    /// the board asks for this on every rebuild, and inverting ~60 folders' membership
    /// there would be a walk per rebuild for an answer that changes a few times a day.
    @ObservationIgnored private var folderIndexCache = BoardFolderIndex.empty

    /// The board's folder index. Reads the OBSERVED array first so a SwiftUI body that
    /// only consults the index still re-renders when folders land (the same order every
    /// memoized slice getter below uses, for the same reason).
    var boardFolderIndex: BoardFolderIndex {
        _ = taskFolders.count
        return folderIndexCache
    }

    /// ONE number that changes whenever anything the board's bands are built from
    /// changes: the task list, the session list, or either half of the tier split.
    ///
    /// It exists so `TasksView` can memoize `BoardModel.bands` on a comparison of a few
    /// Ints instead of ~3,000 rows (see `BoardBandsKey`). Monotonic because each part
    /// only ever increases, so the sum cannot return to a value a stale cache holds.
    ///
    /// NOT observable, on purpose: a reader that took a cache hit on this number and
    /// never touched the arrays would register no SwiftUI dependency and would stop
    /// updating. Every caller reads the observed collections it is about to derive from
    /// FIRST, exactly as the slice getters below do.
    ///
    /// The FOLDER list is one of those parts: it decides which bands the project
    /// grouping emits, so a hierarchy that lands after the first board render has to
    /// invalidate the memo or the board would stay flat until something else changed.
    var boardInputsGen: UInt64 {
        tasksGen &+ sessionsGen &+ tiersGen &+ foldersGen &+ detailsGen
    }
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

    /// Open tasks that CARRY A DATE — exactly what the calendar surfaces can
    /// place. The Calendar card counted the (always empty) flat slice and so
    /// read "0" while the grid below it was full of dots (dogfood R18).
    var datedTasks: [WalnutTask] {
        openTasks.filter { task in
            task.dueDate?.isEmpty == false
                || task.startDate?.isEmpty == false
                || task.endDate?.isEmpty == false
        }
    }

    /// Tasks for a smart-list filter, already sorted for section rendering.
    /// (.sessions renders its own list — returns [] here.) Memoized per
    /// tasks-generation; the `.today` slice additionally keys on the local
    /// day so "due today / overdue" rolls over at midnight like it used to.
    func tasks(for filter: TaskFilter) -> [WalnutTask] {
        guard filter != .sessions else { return [] }
        // NOTE: .calendar deliberately falls through to the memoized path — the
        // card's count needs the real dated slice (see the switch below).
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
        // Calendar renders its own grid straight from the store, so this slice
        // is not what gets drawn — but it IS what the card counts, so it must
        // be the tasks the calendar can place, not [] (dogfood R18: the card
        // said 0 above a grid full of dots).
        case .calendar: rows = WalnutTask.openSorted(datedTasks)
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
        switch filter {
        // The board renders the PINNED board (tier bands), so that is what its
        // card counts. It used to be `sessions.count`, which was right when the
        // filter was a session list and is a lie now: it would read "351" over a
        // board of 44 rows. `taskTiers` is the tier map, i.e. exactly one entry
        // per pinned task, so this is O(1); before the split lands, fall back to
        // the projection's own pin flag rather than showing 0.
        case .sessions:
            return taskTiers.isEmpty ? tasks.filter { $0.pinned == true }.count : taskTiers.count
        // The calendar renders its own grid, so its flat slice is empty by
        // design — count what it actually PLACES instead of that empty slice.
        case .calendar: return tasks(for: .calendar).count
        default: return tasks(for: filter).count
        }
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
            async let g: Void = self.loadTaskFolders()
            _ = await (t, s, f, g)
        }
    }
}

// MARK: - Opening a session the session LIST does not carry
//
// The board's rows join `sessions` (the slim list) by task id, so a session missing
// from that list leaves a row with `session == nil`. Two ways that happens, and both
// end here rather than in a New Session draft: a server-side projection cap (fixed on
// the server, and this is the second line of defence) and RETENTION — a session old
// enough to leave the list legitimately is still a real session, still openable by id.
//
// Both lookups are bounded. A tap is a gesture, not a background job: the row shows a
// spinner while one is in flight, so the wait is visible, and it must END — the
// URLSession default here is 30s, which as a spinner on a row is indistinguishable
// from a hang.

extension TasksStore {
    /// How long a board tap may spend asking the server where it should go.
    ///
    /// Long enough for a cloud round trip on a phone network, short enough that the
    /// answer still belongs to the tap that asked for it. On expiry the caller opens
    /// the draft (attached to the task) rather than leaving the row spinning: a wrong
    /// destination the user can back out of beats no destination at all.
    static let boardLookupDeadline: Double = 6

    /// Ask the task's own detail which sessions it has, and remember the answer.
    ///
    /// Returns nil ONLY when the request failed (offline, timeout, 404) — an empty
    /// array is a real answer ("this task has never had a session") and is cached as
    /// one, which is what keeps the next tap on that row instant.
    func fetchSessionIds(for taskId: String) async -> [String]? {
        guard !taskId.isEmpty else { return nil }
        let work = Task { try await self.transport.taskDetail(id: taskId) }
        let deadline = Task {
            try? await Task.sleep(for: .seconds(Self.boardLookupDeadline))
            work.cancel()
        }
        defer { deadline.cancel() }
        do {
            let detail = try await work.value
            noteSessionIds(taskId: taskId, ids: detail.sessionIds ?? [])
            return knownSessionIds(for: taskId)
        } catch {
            AppLog.debug("board", "session id lookup failed", [
                "taskId": taskId, "error": error.localizedDescription,
            ])
            return nil
        }
    }

    /// Fetch ONE session by id and shape it like a list row, so the existing
    /// conversation destination can take it unchanged.
    ///
    /// `task` is the board row's own task when there is one: it supplies the owning
    /// task id / title / project that the DEGRADED cloud reply omits, so the pushed
    /// page still links back to the task it belongs to.
    ///
    /// The result is deliberately NOT inserted into `sessions`. That array is a server
    /// projection, and a synthesized row would disappear on the next snapshot — the row
    /// would flip between "hydrated" and "earlier session" for no reason the user can
    /// see. The ledger (`sessionIdsByTask`) is the durable half.
    func resolveSession(id: String, task: WalnutTask?) async -> WalnutSession? {
        guard !id.isEmpty else { return nil }
        let work = Task { try await self.api.sessionDetail(id: id) }
        let deadline = Task {
            try? await Task.sleep(for: .seconds(Self.boardLookupDeadline))
            work.cancel()
        }
        defer { deadline.cancel() }
        do {
            let detail = try await work.value
            return WalnutSession.fromDetail(detail, requestedId: id, task: task)
        } catch {
            AppLog.info("board", "session by id failed", [
                "sessionId": id, "error": error.localizedDescription,
            ])
            return nil
        }
    }
}

extension WalnutSession {
    /// A LIST-shaped session row built from the by-id DETAIL reply.
    ///
    /// Pure, and separate from the fetch, because the mapping is where this can go
    /// quietly wrong: the detail record's shape is the server's INTERNAL one and its
    /// degraded variant carries four fields, so every absence needs an answer that is
    /// true rather than convenient.
    ///
    ///  - `id` prefers the id we ASKED for. The record echoes it, but a row keyed by
    ///    anything other than the id the caller resolved would send the conversation
    ///    page to a different session than the tap.
    ///  - `host` falls back to `""` (the primary box) because that is what the wire
    ///    means by an absent host — and it is display-only here: every send goes to
    ///    `POST /v1/sessions/:id/messages`, which resolves the host server-side.
    ///  - `lastActiveAt` falls back to EMPTY, never to "now". The row's age token
    ///    parses this, and a synthetic "now" would print "0s" on a session that last
    ///    ran in June; an unparseable stamp drops the token instead (`meta`).
    ///  - `pinned` is nil, not `true`: the pin lives on the TASK, and claiming a pin
    ///    here would put a session-only row on the board that nothing pinned.
    static func fromDetail(
        _ detail: SessionDetail, requestedId: String, task: WalnutTask?
    ) -> WalnutSession {
        let record = detail.session
        let taskId = [record.taskId, task?.id]
            .compactMap { $0 }.first { !$0.isEmpty }
        return WalnutSession(
            id: requestedId.isEmpty ? record.claudeSessionId : requestedId,
            title: record.title,
            taskId: taskId,
            taskTitle: task?.title,
            project: record.project ?? task?.project,
            host: record.host ?? "",
            // "unknown" reads as `.unknown` → the row says "session ended", which is
            // the honest answer for a session whose liveness the reply didn't state.
            processStatus: record.processStatus ?? "unknown",
            model: record.model,
            mode: record.mode,
            startedAt: record.startedAt ?? "",
            lastActiveAt: record.lastActiveAt ?? "",
            messageCount: record.messageCount ?? 0,
            cwd: record.cwd,
            pinned: nil,
            focusTier: nil,
            description: record.description
        )
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
        // "Board", not "Sessions": the filter no longer shows a session list, it
        // shows the pinned board where a session is a task that has one. The
        // enum case keeps its name so every stored preference, accessibility id
        // ("tasks.card.sessions") and Maestro flow keeps working.
        case .sessions: return "Board"
        case .allOpen: return "All Open"
        case .done: return "Done"
        }
    }

    var systemImage: String {
        switch self {
        case .today: return "calendar"
        case .calendar: return "calendar.badge.clock"
        case .inProgress: return "arrow.triangle.2.circlepath"
        case .sessions: return "square.stack.3d.up"
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
