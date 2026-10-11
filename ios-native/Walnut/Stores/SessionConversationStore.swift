import Foundation
import Observation

/// One-shot handoff of a NEW session's first message from the create sheet to
/// the conversation store. The message rides SESSION_START server-side and only
/// reaches the transcript after the CLI spawns (seconds, more over SSH) — so
/// without this the just-pushed conversation page renders EMPTY through the
/// whole spawn gap. Same colocated-singleton pattern as MediaContext.
@MainActor
enum SessionLaunchContext {
    private static var pending: [String: (message: String, stashedAt: Date)] = [:]
    /// Matches the server's spawn grace (SPAWN_GRACE_MS): past it the session
    /// either has a real transcript or was reaped — either way the stash is
    /// stale and painting it would show a phantom launch state.
    private static let ttl: TimeInterval = 120

    static func stash(sessionId: String, message: String) {
        guard !message.isEmpty else { return }
        // Sweep expired entries here (no timers needed): a stash whose push
        // never happened (sheet swiped away mid-create) must not resurface as
        // a phantom "Starting session" hours later when the user opens that
        // session from the list.
        pending = pending.filter { Date().timeIntervalSince($0.value.stashedAt) < ttl }
        pending[sessionId] = (message, Date())
    }

    /// Removes and returns the stashed message — one shot, so a RE-open after
    /// the first turn never repaints the launch bubble on top of the
    /// transcript row. Accepted cost: pop-and-repush INSIDE the spawn gap
    /// loses the bubble too (consume already happened); do not "fix" that by
    /// making this a non-destructive read — that reintroduces the duplicate.
    /// Expired entries are dropped, not returned.
    static func consume(_ sessionId: String) -> String? {
        guard let entry = pending.removeValue(forKey: sessionId) else { return nil }
        return Date().timeIntervalSince(entry.stashedAt) < ttl ? entry.message : nil
    }
}

/// State for one session's conversation page — the transcript tail as history
/// plus a live turn assembled from the session SSE stream.
///
/// Two data sources, kept from duplicating each other:
///  - `historyMessages` = the persisted transcript (completed turns). Assistant
///    text only lands in the transcript at turn end, so mid-turn it never
///    overlaps the live turn.
///  - live turn = `liveText` + `activity`, fed by SSE deltas. The snapshot seeds
///    it from the buffer's live region (blocks after `completedLen`); turn-end
///    refetches the transcript to fold the finished turn into history and clears
///    the live accumulation.
///
/// Fallback ladder: SSE 404 (older server, no stream route) → 5s `fresh=1`
/// transcript polling; a bridge that stays offline past the reconnect grace:
/// keep polling. The composer never locks for a bridge outage: text sends are
/// banked durably by the replica and image sends ride the retry ladder.
///
/// Stream replay and transcript refresh: see SessionStreamGate.swift for why a
/// new connection resumes with Last-Event-ID, why replayed frames are never
/// applied, and why every stream-driven transcript read is single-flight.
@Observable
@MainActor
final class SessionConversationStore {
    private let api: SessionSendTransport
    private let sessionId: String
    private let clock: SessionStreamClock
    private let resumeIDs: SessionStreamResumeIDs
    /// Where this session's CLI runs — "Mac" or the remote host alias. The
    /// offline notices name THIS host: a clouddev session going read-only is
    /// a clouddev bridge problem, and saying "Mac offline" there sent the
    /// user debugging the wrong machine.
    let hostLabel: String
    private var sse: SSEClient?
    private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var trackedTasks: [UUID: Task<Void, Never>] = [:]
    /// In-flight automatic send retries, keyed by optimistic bubble id (one per
    /// bubble). Cancelled on suspend/close and re-armed on resume, which is how
    /// "pause in the background, continue in the foreground" is implemented.
    @ObservationIgnored private var retryTasks: [String: Task<Void, Never>] = [:]
    /// Bubbles that were spoken in voice mode: their sends carry `voice: true`.
    @ObservationIgnored private var voiceBubbleIDs: Set<String> = []
    private var isActive = true
    /// Set by close() (view gone), cleared by open(). Blocks LifecycleHub
    /// resumeAll from reviving a store whose screen was dismissed.
    private var viewClosed = false

    /// Bumps once per successful stream connection (first connect and every
    /// reconnect). Read only by the composer's model pill, which re-asks the
    /// session's model catalog then. Edge-rate (per connection), never event-rate.
    private(set) var streamConnects = 0

    /// Persisted transcript (completed turns), mapped to ChatMessage rows.
    private(set) var historyMessages: [ChatMessage] = []
    /// Optimistic user bubbles not yet reflected in the transcript.
    private var pendingUser: [ChatMessage] = []
    /// The user rows on the page when each bubble's send went out (their stable ids),
    /// keyed by bubble id and kept across retries: a bubble gives way only to a row
    /// its own send made (`bubblesAbsorbed`).
    @ObservationIgnored private var sendBaselines: [String: Set<String>] = [:]

    /// Live turn accumulation (mirrors ChatStore.streamText / .activity).
    var streaming = false
    /// Bounded at ~LiveMarkdownWindow.liveTextCap Characters (see
    /// flushPendingDelta / seedFromSnapshot): the render window fix bounded
    /// per-tick RENDER cost, but retaining the whole in-flight reply here kept
    /// every append + segments() O(reply) — at tens of MB that alone
    /// saturated the main thread (build-34 0x8BADF00D field crashes).
    var liveText = ""
    /// True when liveText dropped its head to stay under the cap. The window's
    /// omitted-prefix chip stays visible for free (cap = 2x windowMax, so a
    /// truncated liveText is always past the window threshold); the flag's job
    /// is finalizeTurn: a PREFIX clip of a tail-trimmed string no longer equals
    /// the reply's start, so the provisional row must be skipped.
    private(set) var liveTextTruncated = false
    /// Reasoning the CLI has emitted during the in-flight turn — published on the
    /// same coalesced cadence as `liveText`, from the shared `LiveAgentActivity`
    /// below. Empty = nothing to show. This is what replaced throwing the
    /// `thinking { delta }` payload away and showing one blinking word.
    private(set) var liveThinking = ""
    /// The `thinking` / `tool` / `tool-result` arms, shared with ChatStore. NOT
    /// observed: the cloud bridge forwards CLI thinking_deltas 1:1 with no
    /// coalescing (measured 10.7 ev/s sustained, microbursts to ~700/s), so the
    /// accumulation must stay off the observation graph and only
    /// `flushLiveThinking` may publish it.
    @ObservationIgnored private var live = LiveAgentActivity()
    /// Every tool call THIS TURN has made, UNFOLDED — see `ChatStore.liveTools`.
    /// The timeline builds real tool rows from the parts; `activity` keeps carrying
    /// the folded label for the shimmer (and for the non-tool statuses only this
    /// store has, e.g. "Starting session…").
    private(set) var liveTools: [LiveToolCall] = []
    var activity: String?
    /// Delta coalescing (freeze fix, mirrors ChatStore): re-rendering the live
    /// markdown row per SSE delta saturated the main thread on long replies.
    /// Deltas buffer here and flush to `liveText` on a ~8Hz cadence.
    @ObservationIgnored private var pendingDelta = ""
    @ObservationIgnored private var deltaFlushTask: Task<Void, Never>?

    /// Equality-gated writes for the per-SSE-event flags (build-36 field
    /// freeze, 2026-08-08). @Observable has NO same-value suppression: every
    /// `streaming = true` / `activity = "Thinking"` fires objectWillChange
    /// even when the value is unchanged — and the conversation page's
    /// messageList body reads `streaming`, so each write invalidates the
    /// WHOLE LazyVStack (105-150 rows), not just the live row. The cloud
    /// bridge forwards CLI thinking_deltas 1:1 with no coalescing (measured
    /// 10.7 ev/s sustained, microbursts to ~700/s on a fable plan session),
    /// so redundant writes at event rate became an unbounded full-page
    /// layout storm — the 0x8BADF00D compute-loop fingerprint. Deltas were
    /// already coalesced (8Hz flush); these two flags were the leak.
    private func setStreaming(_ value: Bool) {
        if streaming != value { streaming = value }
    }

    private func setActivity(_ value: String?) {
        if activity != value { activity = value }
    }

    /// Mirror the shared handler's tool list onto the observed field,
    /// equality-gated for the same reason `setActivity` is.
    private func setLiveTools(_ tools: [LiveToolCall]) {
        if liveTools != tools { liveTools = tools }
    }

    var processStatus: String
    /// How many statuses the live stream has applied (status frames, attach
    /// snapshots). The page's detail read captures it before asking and gives it
    /// back with the answer: a stream status that landed while the read was in
    /// flight is newer than the record, so the record must not overwrite it.
    @ObservationIgnored private(set) var streamStatusCount = 0
    /// Sticky USER intent, independent of transient geometry changes from
    /// streaming, keyboard resizing, or canonical history reconciliation.
    /// `@ObservationIgnored` for the same reason as ChatStore's: it is written
    /// from inside the scroll view's layout pass and never read by a view body.
    @ObservationIgnored var bottomPinned = true {
        didSet { if bottomPinned { readerLoadedHead = false } }
    }
    /// The oldest rows held came from the reader's own Load earlier taps. While
    /// they read them (unpinned), reconcile keeps them; back at the bottom the
    /// usual cap applies again.
    @ObservationIgnored private var readerLoadedHead = false
    /// Bumped when a layout-shifting mutation should restore pinned intent.
    private(set) var scrollToBottomSignal = 0
    /// What the page says about the link to the session's host. Only CONTINUOUS
    /// absence raises it (see SessionConnectionNotice): a bridge redial is ~1.3 s,
    /// and the old immediate banner flashed for every one of them.
    private(set) var connectionNotice: SessionConnectionNotice = .none
    /// The full "unreachable" banner is up (10 s of continuous absence).
    var offline: Bool { connectionNotice == .unreachable }
    /// Raw link state: a bridge-offline frame or a 503 bridge_offline said the
    /// host is gone and nothing has said it is back. Drives the grace timers and
    /// the polling fallback; the UI reads `connectionNotice` instead.
    @ObservationIgnored private(set) var bridgeDown = false
    @ObservationIgnored private var bridgeDownSince: TimeInterval?
    @ObservationIgnored private var bridgeGraceTask: Task<Void, Never>?
    /// The CLI process is gone (409 session_dead / terminal status).
    var dead = false
    var errorMessage: String?
    var transcriptMissing = false
    var loadedOnce = false

    private static let pollSeconds: Double = 5
    /// Stream-driven transcript reads wait this long so a burst of triggers
    /// (a replay, rapid turn-ends, a turn-end right after bridge-online) costs
    /// ONE read. Invisible: the provisional row already shows the finished reply.
    static let refreshDebounceSeconds: TimeInterval = 0.5

    /// Single flight for `fresh=1` transcript reads (the 512 KB bridge read).
    /// A trigger while a read is running marks it dirty; exactly one follow-up
    /// runs after it, debounced. See requestTranscriptRefresh / runFreshLoad.
    @ObservationIgnored private var refreshInFlight = false
    @ObservationIgnored private var refreshDirty = false
    @ObservationIgnored private var refreshDebounce: Task<Void, Never>?
    /// Bumped by suspend(): a read cancelled there must not, on its late
    /// completion, clear a NEWER read's in-flight flag.
    @ObservationIgnored private var refreshGen = 0

    /// Replay filter for the stream (see SessionStreamReplayGate).
    @ObservationIgnored private var gate = SessionStreamReplayGate()
    @ObservationIgnored private var gateExpiryTask: Task<Void, Never>?
    /// Which server the stream talks to, from its attach frame. Decides whether a
    /// new connection resumes with Last-Event-ID (cloud) or asks for the turn's
    /// full replay after its snapshot (primary, unchanged behaviour).
    @ObservationIgnored private(set) var streamKind: SessionStreamKind = .unknown
    /// Caps on what is kept for rendering (see reconcile(): unbounded merge
    /// growth was the root cause of the watchdog freeze-kills on builds 16-20).
    /// Counted in timeline PARTS, what the reader sees: a folded run of 80 tool
    /// calls is one line, and a cap of 150 raw rows kept a busy session to a few
    /// lines with the user's own messages cut off above them (2026-10-04). The
    /// row ceilings bound memory and the per-build fold for the same reason.
    static let pinnedRenderParts = 150
    static let unpinnedRenderParts = 400
    static let pinnedRenderRows = 1_500
    static let unpinnedRenderRows = 3_000
    /// Text rows the first open asks the server to reach back to (`visible`):
    /// enough to read on, small enough to paint at once. A Load earlier page is
    /// larger, because each one costs the reader a tap (a 2,300-row session took
    /// 12 taps at 20 lines a page).
    static let openVisibleRows = 20
    static let pageVisibleRows = 50

    /// Older pages. `canPage`: the server said it answers `before=` pages (only a
    /// rich live read on the primary does). `olderExists`: the oldest row held is
    /// not the conversation's first. The row shows only when both hold.
    private(set) var canPage = false
    private(set) var olderExists = false
    private(set) var loadingEarlier = false
    private(set) var loadEarlierFailed = false
    var showsLoadEarlier: Bool { canPage && olderExists && !historyMessages.isEmpty }
    /// Equality-gated, like `setStreaming`: reconcile runs per poll and turn end.
    private func setCanPage(_ value: Bool) { if canPage != value { canPage = value } }
    private func setOlderExists(_ value: Bool) { if olderExists != value { olderExists = value } }
    var loadEarlierState: TimelineLoadEarlierState {
        loadingEarlier ? .loading : (loadEarlierFailed ? .failed : .ready)
    }

    /// True from "created with a first message" until the first turn-start or
    /// a terminal status. Keeps the Starting-session live row alive across the
    /// SSE snapshot, which truthfully reports isStreaming=false in the
    /// pre-spawn gap and would otherwise kill the indicator instantly.
    @ObservationIgnored private var awaitingFirstTurn = false
    private static let startingActivity = "Starting session"

    /// `transport` is the WalnutTests seam (nil = the real WalnutAPI) — same
    /// injection pattern as TasksStore's WalnutTaskTransport.
    init(
        session: WalnutSession,
        transport: SessionSendTransport? = nil,
        clock: SessionStreamClock = SystemSessionStreamClock(),
        resumeIDs: SessionStreamResumeIDs? = nil
    ) {
        self.api = transport ?? WalnutAPI()
        self.sessionId = session.id
        self.clock = clock
        self.resumeIDs = resumeIDs ?? .shared
        self.hostLabel = session.isLocal ? "Mac" : session.host
        self.processStatus = session.processStatus
        LifecycleHub.shared.register(self)
    }

    /// Paint a brand-new session's first message + Starting-session row.
    /// Called from open(), NOT init: SwiftUI evaluates navigationDestination
    /// builders speculatively, so View.init (and a store built inside
    /// State(initialValue:)) can run for throwaway instances — a discarded
    /// instance consuming the one-shot stash would leave the installed store
    /// with nil and the page blank (the exact bug this feature fixes). open()
    /// runs via .task only on the installed view, exactly once per screen.
    private func adoptLaunchStash() {
        guard !loadedOnce, let launch = SessionLaunchContext.consume(sessionId) else { return }
        // A brand-new session's first message rode SESSION_START server-side;
        // it reaches the transcript only after the CLI spawns (seconds — more
        // over SSH). Paint it NOW as a normal user bubble (it was accepted,
        // not pending) and run a Starting-session row so the page never opens
        // blank. reconcile() absorbs the bubble once the transcript has it.
        pendingUser.append(ChatMessage(
            id: "launch-\(sessionId)", role: "user", text: launch,
            createdAt: ISO8601DateFormatter().string(from: AppClock.now()), kind: nil
        ))
        awaitingFirstTurn = true
        streaming = true
        activity = Self.startingActivity
    }

    // MARK: - Derived

    /// History + still-pending optimistic bubbles.
    var messages: [ChatMessage] { historyMessages + pendingUser }

    var statusKind: SessionStatus { SessionStatus(processStatus) }

    /// Only a session the server declared unresumable (409 session_dead) locks
    /// the composer. An ENDED session is still sendable (the server resumes it),
    /// and so is one whose bridge is down: the replica banks a text send durably
    /// and delivers it when the bridge returns (core/send-queue.ts), and an image
    /// send rides the retry ladder under the same `qm-*` id. Locking the composer
    /// for a bridge outage (the old behaviour) did it for every ~1.3 s redial.
    var canSend: Bool { !dead }

    /// Notice shown under the composer when it can't send.
    var composerNotice: String? {
        if dead { return "Session can't be woken. Reopen it from your desktop." }
        return nil
    }

    // MARK: - Lifecycle

    /// Two-phase open for instant paint. The exported/synced transcript file
    /// is served from disk (fast); `fresh=1` re-reads the live history (slow:
    /// whale JSONL, SSH, or the bridge) — so render the cached tail first,
    /// attach the stream immediately, and reconcile with fresh in the
    /// background. Called from `.task`.
    func open() async {
        // Re-opening is an explicit user action: reactivate a store that a
        // pop-away onDisappear (close → isActive=false) left closed, or the
        // page comes back permanently dead (guards block every reconnect).
        viewClosed = false
        isActive = true
        // Open-sequence timeline on the tape: all three "enter a session page,
        // freeze 5-20s later" field kills die INSIDE this window, so each step
        // gets a crumb — the next report shows exactly how far open() got and
        // how long each leg took, instead of only "screen: session:xxxx".
        let openedAt = FreezeContext.uptimeNow()
        FreezeContext.shared.note("sc-open")
        adoptLaunchStash()
        connectStream()
        await loadTranscript(fresh: false, rich: false)
        FreezeContext.shared.note("sc-open-cached", Int((FreezeContext.uptimeNow() - openedAt) * 1_000))
        await runFreshLoad(rich: true, visible: Self.openVisibleRows)
        FreezeContext.shared.note("sc-open-fresh", Int((FreezeContext.uptimeNow() - openedAt) * 1_000))
    }

    /// View-close is TERMINAL until the next open(): unlike a background
    /// suspend, a foreground resumeAll must NOT revive this store — a store
    /// retained by a dismissed screen would otherwise reconnect its SSE
    /// stream off-screen (the leak this batch exists to kill).
    func close() {
        viewClosed = true
        suspend()
    }

    /// Backgrounding enters a closed state before cancelling work, so late URL
    /// callbacks and fetch completions cannot revive polling or mutate the UI.
    func suspend() {
        isActive = false
        rememberResumeID()
        sse?.stop()
        sse = nil
        pollTask?.cancel()
        pollTask = nil
        // Refresh single flight: the cancelled read's completion is fenced by
        // refreshGen, so the next open/resume starts clean.
        refreshDebounce?.cancel()
        refreshDebounce = nil
        refreshInFlight = false
        refreshDirty = false
        refreshGen += 1
        // Held replay candidates die with their connection; the next one
        // replays or delivers them again.
        gate.dropHeld()
        gateExpiryTask?.cancel()
        gateExpiryTask = nil
        // The link state is KEPT across a suspend (only its timer stops): an
        // outage that was on screen must not vanish on return and reappear 10 s
        // later. resume() re-arms the timer from the original start, and the new
        // connection's attach frame settles it either way.
        bridgeGraceTask?.cancel()
        bridgeGraceTask = nil
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        pendingDelta = ""
        snapshotDecodeTask?.cancel()
        snapshotDecodeTask = nil
        snapshotDecodeGen += 1 // invalidate any in-flight decode completion
        queuedWhileDecoding = []
        cancelTrackedTasks()
        // Pause (never abandon) automatic send retries: a backgrounded app gets
        // no reliable network or execution time, so burning attempts there just
        // spends the budget on nothing. The bubbles keep their waiting notice
        // and resume() re-arms them.
        cancelRetryTasks()
        streaming = false
        clearLiveThinking()
        activity = nil
    }

    /// Foregrounding revives the stream and catches up on missed turns.
    /// Never revives a view-closed store (see close()).
    func resume() {
        guard !isActive, !viewClosed else { return }
        isActive = true
        connectStream()
        rearmPendingRetries()
        scheduleBridgeGrace()
        trackTask { [weak self] in await self?.runFreshLoad(rich: true) }
    }

    /// Route switch (RouteCoordinator): the same Walnut at another origin, so the
    /// stream is rebuilt there (connectStream reads the new URL) and the
    /// transcript is reloaded fresh from it.
    func restartForRouteChange() {
        guard isActive, !viewClosed else { return }
        suspend()
        resume()
    }

    // MARK: - Transcript

    /// `rich` asks for the tool-input / reasoning fields. It is REQUIRED, not
    /// defaulted: the fields only arrive with `fresh` (the sweep file is slim), and
    /// they cost ~4 KB gzipped per read — fine on open / resume / turn end, ~48
    /// KB/min from the 5s degraded poll, which is the same URL. See
    /// `WalnutAPI.sessionTranscriptPath`.
    ///
    /// A rich fresh read is a PAGE read (`sessionTranscriptPage`): `visible` on
    /// the first open, so a busy turn's folded tool calls are not all there is,
    /// and otherwise `since` = the newest row held, so the answer overlaps what
    /// is on screen and stitching the two cannot leave a hole (see reconcile).
    private func loadTranscript(fresh: Bool, rich: Bool, visible: Int? = nil) async {
        guard isActive else { return }
        do {
            let next: SessionTranscript
            if fresh && rich {
                let since = visible == nil
                    ? historyMessages.last(where: { !Self.isProvisional($0) })?.createdAt : nil
                next = try await api.sessionTranscriptPage(
                    id: sessionId, before: nil, since: since, visible: visible ?? 0)
            } else {
                next = try await api.sessionTranscript(id: sessionId, fresh: fresh, rich: rich)
            }
            guard isActive, !Task.isCancelled else { return }
            reconcile(next)
            // Only a rich answer can say it pages; a slim poll's silence is not a
            // no, and neither is a replica's fallback (`rich: false`, the Mac was
            // out of reach for this one read): the row stays as it was.
            if fresh && rich && next.rich != false { setCanPage(next.pageable == true) }
            transcriptMissing = false
            loadedOnce = true
            // Failure-fallback polling (below) has done its job once a load
            // lands and the normal delivery paths are healthy again. Keep
            // polling while the bridge is down (it IS the data path then) or
            // when SSE was abandoned (404 fallback, sse == nil): those own
            // their lifecycle.
            if !bridgeDown && sse != nil { stopPolling() }
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            guard isActive, !Task.isCancelled else { return }
            if !loadedOnce { transcriptMissing = true }
            // Self-heal: nothing retried a failed transcript load unless the
            // page happened to be in a polling fallback already — a transient
            // network error on open()/resume() left "No transcript yet" on
            // screen FOREVER while the server had the data (2026-08-16 field
            // report: healthy transcript on both boxes, phone stuck empty).
            // Poll until a load succeeds; the success path above stops it.
            startPolling(keepStream: true)
        }
    }

    /// Rebuild history from the transcript and drop optimistic bubbles that the
    /// transcript now contains (each by its own send, see `bubblesAbsorbed`).
    ///
    /// MERGE, don't replace: the two sources cover different windows. The
    /// exported file tail = last ~100 rows of the FULL history; the bridge
    /// fresh read = last 512KB of raw jsonl, which can decode to far fewer
    /// visible rows (heavy tool output) or even zero. Adopting a shorter
    /// fresh result wholesale ERASED already-rendered history (blank page).
    /// Keep existing rows older than the incoming window, append the rest.
    ///
    /// Internal (not private) for WalnutTests: the event-storm and first-paint
    /// regression tests seed a store with a field-scale transcript through the
    /// REAL merge path instead of poking historyMessages directly.
    func reconcile(_ transcript: SessionTranscript) {
        guard isActive else { return }
        // Forensics: reconcile is the page's biggest single main-thread apply
        // (rebuild + merge + stable-id pass + the SwiftUI diff its writes
        // schedule). Every field freeze so far died in an anonymous layout
        // stack; the ledger names this site and its row count in the report.
        MainWork.track("sc.reconcile", count: transcript.messages.count) {
            reconcileTracked(transcript)
        }
    }

    private func reconcileTracked(_ transcript: SessionTranscript) {
        let wasPinned = bottomPinned
        let incoming = transcript.messages.map { Self.row(from: $0) }
        var merged: [ChatMessage]
        // Whether the head of what is held is still the head after the merge:
        // then `olderExists` keeps describing it. Otherwise the window decides.
        var keptHead = false
        if incoming.isEmpty && !historyMessages.isEmpty {
            merged = historyMessages // a zero-row tail never beats shown content
            keptHead = true
        } else if let firstIncoming = transcript.messages.first?.timestamp,
                  transcript.truncated || historyMessages.count > incoming.count,
                  historyMessages.contains(where: { !Self.isProvisional($0) && $0.createdAt >= firstIncoming }) {
            // ISO-8601 strings compare lexicographically. Rows before the
            // incoming window survive; the window itself is authoritative. Only
            // when the two OVERLAP: a window that starts after everything held
            // may have skipped rows in between, and stitching across that would
            // show the conversation with a hole in it.
            let older = Self.rowsBefore(firstIncoming, held: historyMessages, incoming: incoming)
            keptHead = !older.isEmpty
            merged = older + incoming
        } else {
            merged = incoming
        }
        if !keptHead { setOlderExists(transcript.truncated) }
        // A head trim is invisible only while pinned at the bottom. Defer most
        // of it for a history reader; keep a hard cap so a page cannot grow
        // without bound if it remains unpinned for hours. What is trimmed is
        // one Load earlier away. Never while the reader is up in rows they
        // loaded themselves: the trim would take the very rows on screen.
        if wasPinned || !readerLoadedHead {
            let start = Self.renderStart(
                merged,
                maxParts: wasPinned ? Self.pinnedRenderParts : Self.unpinnedRenderParts,
                maxRows: wasPinned ? Self.pinnedRenderRows : Self.unpinnedRenderRows)
            if start > 0 {
                merged = Array(merged[start...])
                setOlderExists(true)
            }
        }
        // STABLE ids, not positional. A positional "t-<i>" scheme changes every
        // row's identity whenever the list length shifts (turn-end refetch, 5s
        // poll), so SwiftUI tears down and rebuilds EVERY row — the visible
        // flash + the "one message at a time" feel (the smooth live bubble gets
        // yanked and the whole list re-renders). A content-derived id keeps
        // unchanged rows identical across fetches, so only the tail diffs.
        let next = Self.assignStableIDs(merged)
        let changed = next.count != historyMessages.count || next.last?.id != historyMessages.last?.id
        let firstPaint = !loadedOnce
        // Equality-gated reassignment (build-36 freeze battle, measured): the
        // @Observable macro suppresses same-VALUE scalar writes, but a whole-
        // array reassignment with EQUAL content still fires objectWillChange —
        // so every 5s poll (bridge-offline fallback) re-diffed the entire
        // 150-row ForEach even when nothing changed. Stable ids make unchanged
        // polls literally equal; one O(n) compare (~150 rows) buys skipping a
        // full-page invalidation. ChatMessage is Equatable.
        if next != historyMessages {
            historyMessages = next
        }
        // HANDOFF: the live reasoning region retires HERE, in the same
        // synchronous block that installs the fetched `kind:"thinking"` rows —
        // so the same reasoning is never rendered twice, and a transcript load
        // that fails or arrives late leaves the reasoning on screen instead of
        // blanking the spot it occupied. Gated on `streaming` because reconcile
        // also runs from the 5s poll, and a mid-turn load must not wipe
        // reasoning that is still accumulating.
        if !streaming { clearLiveThinking() }
        // Freeze-report context: row count of what SwiftUI is being asked to
        // lay out. Written per reconcile (transcript fetch / 5s poll), not per row.
        FreezeContext.shared.setHistoryRows(next.count)
        // Polling-fallback path (no SSE turn events): the CLI's reply landing
        // in the transcript is the proof the first turn ran — retire the
        // Starting-session row here or it would shimmer forever.
        if awaitingFirstTurn && next.contains(where: { $0.role == "assistant" }) {
            awaitingFirstTurn = false
            streaming = false
            activity = nil
        }
        // Canonical row heights can displace the viewport; restore only sticky
        // intent captured before mutation. First paint always establishes bottom.
        if isActive && (firstPaint || (changed && wasPinned)) { scrollToBottomSignal += 1 }
        absorbDelivered()
    }

    /// Drop the bubbles whose own row the page now shows. Runs on every transcript
    /// read and when a send is accepted (its row can land before the answer does).
    /// Check-before-mutate: a mutating method on an @Observable array registers a
    /// mutation even when it removes nothing, so an unconditional removeAll
    /// re-invalidated `messages` readers on every 5s poll.
    private func absorbDelivered() {
        guard !pendingUser.isEmpty else { return }
        let gone = Self.bubblesAbsorbed(pendingUser, baselines: sendBaselines, rows: historyMessages)
        guard !gone.isEmpty else { return }
        pendingUser.removeAll { gone.contains($0.id) }
        for id in gone { sendBaselines[id] = nil }
    }

    /// The bubbles the page's rows now show, each matched by its OWN send:
    ///  - a bubble whose POST is still out, or failed, is never absorbed: the server
    ///    holds no message under its id yet (or never will), and absorbing a failed
    ///    one would silently lose its retry;
    ///  - an accepted one gives way only to a user row that was not on the page when
    ///    its send went out (`baselines`), of its own shape: a photo row (the
    ///    server's "[Images attached" header and saved paths, cloud-images.ts
    ///    withImagePaths) with the same words for a photo (or the words alone, when
    ///    the server could not save the photo), a plain row with the same text for a
    ///    text;
    ///  - each row stands for one bubble, oldest first, so a second "ok" waits for
    ///    its own row.
    /// Equal text alone never matches, empty words included (App Store r7 gate: a
    /// photo sent with no words was absorbed by an earlier photo's empty words while
    /// its POST was out, and when the POST failed no "Not sent" was left on screen).
    private static func bubblesAbsorbed(
        _ bubbles: [ChatMessage], baselines: [String: Set<String>], rows: [ChatMessage]
    ) -> Set<String> {
        let userRows = rows.filter { $0.isUser && $0.kind == nil }
        var used = Set<String>()
        var gone = Set<String>()
        for bubble in bubbles where bubble.pending != true && bubble.failed != true {
            let before = baselines[bubble.id] ?? []
            guard let row = userRows.first(where: {
                !used.contains($0.id) && !before.contains($0.id) && rowShows(bubble, row: $0)
            }) else { continue }
            used.insert(row.id)
            gone.insert(bubble.id)
        }
        return gone
    }

    /// Whether a transcript row has this bubble's shape and words.
    private static func rowShows(_ bubble: ChatMessage, row: ChatMessage) -> Bool {
        let parts = MessageRow.imageSendParts(row.text)
        guard bubble.localImages?.isEmpty == false else {
            return parts == nil && sameWords(row.text, bubble.text)
        }
        let words = bubble.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let parts { return sameWords(parts.text, words) }
        // A server that could not save the photo sends the words alone
        // (session-send-v1.ts), so a new plain row with them is this send too.
        return !words.isEmpty && sameWords(row.text.trimmingCharacters(in: .whitespacesAndNewlines), words)
    }

    /// Equal, or the transcript's clip of it: user text is clipped at 4 KB + "…"
    /// (session-projection TEXT_MAX), so a long bubble never equals its row.
    private static func sameWords(_ row: String, _ bubble: String) -> Bool {
        if row == bubble { return true }
        guard row.hasSuffix("…"), row.count > 1 else { return false }
        return bubble.hasPrefix(row.dropLast())
    }

    /// Held rows the incoming window does not cover: every row strictly older
    /// than its first row, plus the rows AT that timestamp it cut off. A tail can
    /// start inside a run of messages that share one timestamp (measured: 65 such
    /// runs in a 16k-line session); its first rows are then the run's later ones,
    /// and a strict `<` alone dropped the earlier ones from the screen. Matched by
    /// what a row IS (role, time, kind, text, detail), never by payload: a slim
    /// poll and a rich read of the same row differ only in payload.
    static func rowsBefore(_ firstIncoming: String, held: [ChatMessage],
                           incoming: [ChatMessage]) -> [ChatMessage] {
        // A provisional reply is stamped by the PHONE's clock and is replaced by
        // its canonical row in the window, so it is never "older" than it.
        let settled = held.filter { !isProvisional($0) }
        var older = settled.filter { $0.createdAt < firstIncoming }
        let atBoundary = settled.filter { $0.createdAt == firstIncoming }
        guard !atBoundary.isEmpty else { return older }
        func identity(_ m: ChatMessage) -> String {
            "\(m.role)|\(m.kind?.rawValue ?? "")|\(m.text)|\(m.detail ?? "")"
        }
        var covered: [String: Int] = [:]
        for row in incoming where row.createdAt == firstIncoming { covered[identity(row), default: 0] += 1 }
        for row in atBoundary {
            let key = identity(row)
            if let n = covered[key], n > 0 { covered[key] = n - 1 } else { older.append(row) }
        }
        return older
    }

    /// The finished reply finalizeTurn paints until the refetch lands. Its time is
    /// the phone's, so it says nothing about where the server's rows are.
    private static func isProvisional(_ m: ChatMessage) -> Bool { m.id.hasPrefix("provisional-") }

    /// Where the kept list starts: the newest `maxParts` timeline parts (a folded
    /// run of tool and thinking rows is one part, the way the reader sees it),
    /// within the newest `maxRows` rows. The cut never splits a run, and moves
    /// forward past a run of rows that share one timestamp, because the next
    /// Load earlier asks for rows strictly OLDER than the first one kept and
    /// would never return the rest of that run.
    static func renderStart(_ rows: [ChatMessage], maxParts: Int, maxRows: Int) -> Int {
        let floor = max(0, rows.count - maxRows)
        var start = rows.count
        var parts = 0
        while start > floor {
            var head = start - 1
            if TimelineToolRunFold.isRunMember(rows[head]) {
                while head > floor, TimelineToolRunFold.isRunMember(rows[head - 1]) { head -= 1 }
            }
            parts += 1
            if parts > maxParts { break }
            start = head
        }
        guard start > 0, start < rows.count else { return start < rows.count ? start : 0 }
        var clean = start
        while clean < rows.count, clean - start < 50, rows[clean].createdAt == rows[clean - 1].createdAt {
            clean += 1
        }
        return clean < rows.count && rows[clean].createdAt != rows[clean - 1].createdAt ? clean : start
    }

    /// Load earlier: one older page, prepended above what is held. Single
    /// flight. The viewport stays where it was (the timeline anchors an unpinned
    /// reader), so the new rows wait above the reader instead of pushing them.
    /// A failure leaves the row as a retry; a server that says it no longer
    /// pages (the route moved to a replica) removes it.
    func loadEarlier() async {
        guard isActive, showsLoadEarlier, !loadingEarlier,
              let cursor = historyMessages.first?.createdAt else { return }
        loadingEarlier = true
        loadEarlierFailed = false
        defer { loadingEarlier = false }
        do {
            let page = try await api.sessionTranscriptPage(
                id: sessionId, before: cursor, since: nil, visible: Self.pageVisibleRows)
            guard isActive, !Task.isCancelled else { return }
            // The head moved while the page was in flight (a reconcile replaced
            // or trimmed it): this page belongs to a cursor nobody holds now.
            guard historyMessages.first?.createdAt == cursor else { return }
            MainWork.track("sc.loadEarlier", count: page.messages.count) {
                prependOlder(page, cursor: cursor)
            }
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            guard isActive, !Task.isCancelled else { return }
            if let api = error as? APIError, case .server(409, "page_unavailable", _, _, _) = api {
                setCanPage(false)
            } else {
                loadEarlierFailed = true
            }
            AppLog.info("session-chat", "load earlier failed", [
                "sessionId": sessionId, "error": String(describing: error),
            ])
        }
    }

    private func prependOlder(_ page: SessionTranscript, cursor: String) {
        let older = page.messages
            .filter { $0.timestamp < cursor }
            .map { Self.row(from: $0) }
        // An empty page that claims more would leave a row that never loads.
        setOlderExists(page.truncated && !older.isEmpty)
        guard !older.isEmpty else { return }
        readerLoadedHead = true
        let next = Self.assignStableIDs(older + historyMessages)
        if next != historyMessages { historyMessages = next }
        FreezeContext.shared.setHistoryRows(next.count)
    }

    /// Derive a stable id per row from its content so re-fetches don't churn
    /// identities. Same (role, timestamp, kind, text) → same id across loads; a
    /// per-key occurrence suffix disambiguates true duplicates.
    private static func assignStableIDs(_ rows: [ChatMessage]) -> [ChatMessage] {
        var counts: [String: Int] = [:]
        return rows.map { m in
            // The PAYLOAD rides the digest, not just `text`. A tool row appears
            // in a live transcript read BEFORE its `resultPreview` exists
            // (running → finished), and a thinking row's excerpt can arrive with
            // a later read. The row id is what keys TimelineLayoutActor's
            // per-message row memo, so an id that ignored the payload would keep
            // serving the older rows — the expanded card would say "Running…"
            // for ever, and a reasoning row would never grow its excerpt.
            var digest = Hasher()
            digest.combine(m.text)
            digest.combine(m.detail)
            digest.combine(m.inputPreview)
            digest.combine(m.resultPreview)
            digest.combine(m.thinkingText)
            digest.combine(m.agent)
            digest.combine(m.isError)
            let base = "\(m.role)|\(m.createdAt)|\(m.kind?.rawValue ?? "")|\(digest.finalize())"
            let n = counts[base, default: 0]
            counts[base] = n + 1
            return ChatMessage(id: "\(base)#\(n)", role: m.role, text: m.text,
                               createdAt: m.createdAt, kind: m.kind,
                               detail: m.detail, resultPreview: m.resultPreview,
                               agent: m.agent, thinkingText: m.thinkingText,
                               inputPreview: m.inputPreview, isError: m.isError)
        }
    }

    /// One transcript row as a timeline message. Ids are assigned after a merge
    /// (`assignStableIDs`), because they must be unique across it.
    private static func row(from m: SessionTranscript.Message) -> ChatMessage {
        ChatMessage(
            id: "",
            role: m.role,
            text: m.text,
            createdAt: m.timestamp,
            kind: mapKind(m.kind),
            detail: m.detail,
            resultPreview: m.resultPreview,
            agent: m.agent,
            thinkingText: m.thinkingText,
            inputPreview: m.inputPreview,
            isError: m.isError
        )
    }

    /// Mirror of the server transcript clip (session-projection TEXT_MAX):
    /// keep the FIRST 4K chars + "…" so the provisional row is byte-identical
    /// to the canonical row the refetch swaps in (identical text → identical
    /// stable id → no visible flash).
    static func clipProvisional(_ text: String) -> String {
        text.count > 4_000 ? String(text.prefix(4_000)) + "…" : text
    }

    private static func mapKind(_ raw: String?) -> ChatMessage.Kind? {
        switch raw {
        case "tool": return .tool
        case "thinking": return .thinking
        default: return nil
        }
    }

    // MARK: - Send

    /// Optimistic user bubble → POST. Composer stays enabled (sessions accept
    /// mid-turn messages). On failure the bubble STAYS in the timeline marked
    /// failed (tap to retry / copy / delete) — the user's text never vanishes.
    ///
    /// Idempotency: the bubble carries a `qm-mobile-*` id minted ONCE here, and
    /// every re-send of it (automatic backoff below, or a manual tap) POSTs the
    /// SAME id. The server's durable queue dedupes on it, so a retry after a
    /// lost ack collapses onto the original row instead of delivering the turn
    /// twice. See SendRetryPolicy.
    ///
    /// The page need not be on screen. Voice mode's words are often in hand only
    /// after the person locked the phone or switched apps (the recorder holds
    /// background time for exactly that), and a guard on the page state here
    /// returned before any bubble existed: the words went nowhere, and their
    /// recording was already deleted (App Store gate r9, finding 1). The bubble
    /// and the POST are this store's own state, an acceptance while away is
    /// written as any other (`deliver`), and a failure leaves the failed bubble,
    /// to retry under the same id when the page is back.
    @discardableResult
    func send(_ text: String, images: [SelectedImage] = [], voice: Bool = false) async -> Bool {
        guard canSend else { return false }
        errorMessage = nil
        let jpegDatas = images.map(\.jpegData)
        var optimistic = ChatMessage(
            id: "pending-\(Date().timeIntervalSince1970)",
            role: "user", text: text,
            createdAt: ISO8601DateFormatter().string(from: AppClock.now()), kind: nil
        )
        optimistic.pending = true
        optimistic.clientMessageId = SendRetryPolicy.newMessageId()
        // Spoken (voice mode): every attempt of this bubble, retries included,
        // goes out with `voice: true`.
        if voice { voiceBubbleIDs.insert(optimistic.id) }
        // Carry thumbnails so the bubble shows them at once and a failed send
        // retains them for retry (the user's attachments never vanish).
        if !jpegDatas.isEmpty { optimistic.localImages = jpegDatas }
        sendBaselines[optimistic.id] = Set(historyMessages.lazy.filter(\.isUser).map(\.id))
        pendingUser.append(optimistic)
        // Sending explicitly accepts a re-pin: the user wants to see their own
        // message land even if they were reading history.
        bottomPinned = true
        if isActive { scrollToBottomSignal += 1 }
        return await deliver(
            bubbleID: optimistic.id, messageId: optimistic.clientMessageId,
            text: text, jpegDatas: jpegDatas, attempt: 0, firstFailureAt: nil
        )
    }

    /// One delivery attempt for an existing bubble. `attempt` counts AUTOMATIC
    /// retries already made (0 = the user's original send); `firstFailureAt`
    /// anchors the retry budget so the whole ladder is bounded in wall-clock
    /// time, not just in attempts.
    @discardableResult
    private func deliver(
        bubbleID: String, messageId: String?, text: String, jpegDatas: [Data],
        attempt: Int, firstFailureAt: Date?
    ) async -> Bool {
        let payloads = await Self.buildImagePayloads(jpegDatas)
        // Encoding is a real suspension point (5 large photos take a moment).
        // If this attempt was cancelled meanwhile, do NOT fire the request:
        // leave it as a retryable failed bubble. A page that went away does not
        // stop it: the message is the person's, the bubble is this store's own
        // state (see `send`), and a running process can post it. Automatic
        // retries never start while away (`scheduleRetry`, `cancelRetryTasks`).
        guard !Task.isCancelled else {
            settleFailed(bubbleID)
            return false
        }
        do {
            let receipt = try await api.sendSessionMessage(
                id: sessionId, text: text, images: payloads, messageId: messageId,
                voice: voiceBubbleIDs.contains(bubbleID)
            )
            voiceBubbleIDs.remove(bubbleID)
            // Accepted: the server holds the message under this bubble's id, so
            // what follows is written whatever the page is doing: on screen, in the
            // background, closed, or this attempt's task cancelled (a manual retry
            // superseded an automatic one). All three steps are the store's own
            // state and start nothing. An early return here once skipped them while
            // the page was away, and a bubble left pending is never absorbed
            // (`bubblesAbsorbed`) and cannot be retried: its row and a grey copy
            // both stayed on the page for good (App Store gate r8, finding 1).
            //
            // 1. The bubble stops "sending".
            if let idx = pendingUser.firstIndex(where: { $0.id == bubbleID }) {
                pendingUser[idx].pending = false
                pendingUser[idx].failed = false
                pendingUser[idx].retryNotice = nil
            }
            // 2. Its row may already be on the page: the turn can write it before
            // the answer to the POST arrives. Otherwise the next transcript read
            // (resume, open) absorbs it.
            absorbDelivered()
            // 3. A relayed 202 proves the bridge is up: clear an outage a previous
            // attempt raised, same reasoning as a delivered snapshot, so a page that
            // comes back shows no stale outage. A BANKED 202 proves the opposite
            // (the replica queued it because the bridge is down), so it leaves the
            // link state alone. Away, there is no stream and no grace timer to stop.
            if !receipt.queued { noteBridgeUp() }
            return true
        } catch {
            // Cancelled/suspended sends settle silently but must NOT leave a
            // forever-pending bubble: the draft is already cleared, so the
            // failed bubble (tap to retry) is the only copy of the text.
            if !isActive || (error as? APIError)?.isCancelled == true {
                settleFailed(bubbleID)
                return false
            }
            // Two shapes ride the same ladder, for the same reason — nothing is
            // wrong with the message and the condition clears on its own:
            //  - 503 bridge_offline: the host's bridge is down right now.
            //  - a TRANSPORT failure (timeout / connection lost): the request
            //    never got an answer. This was the 2026-08-20 gap — the phone
            //    abandoned two 30s POSTs mid-outage and jumped straight to the
            //    red "Not sent" while the session was healthy and streaming,
            //    because the ladder only reacted to a 503 RESPONSE. Safe to
            //    retry only because the bubble's `qm-*` id makes the send
            //    idempotent end-to-end (see SendRetryPolicy).
            if SendRetryPolicy.isRetryable(error) {
                if (error as? APIError)?.isBridgeOffline == true {
                    noteBridgeDown()
                }
                // Retryable: ride it out on the backoff ladder rather than
                // making the user the retry loop. The bubble stays visible and
                // manually retryable throughout (same id, so a manual tap
                // racing the timer still can't double-deliver).
                let failedAt = firstFailureAt ?? Date()
                let next = attempt + 1
                let elapsed = Date().timeIntervalSince(failedAt)
                if SendRetryPolicy.shouldRetry(attempt: next, elapsed: elapsed) {
                    markWaitingForRetry(bubbleID)
                    scheduleRetry(
                        bubbleID: bubbleID, messageId: messageId, text: text,
                        jpegDatas: jpegDatas, attempt: next, firstFailureAt: failedAt
                    )
                    return false
                }
                // Budget spent — settle on the honest "Not sent" copy.
                settleFailed(bubbleID)
                return false
            }
            settleFailed(bubbleID)
            if let apiError = error as? APIError, apiError.isSessionDead {
                dead = true
            } else if let apiError = error as? APIError, apiError.code == "images_not_supported_cloud" {
                errorMessage = "Images can only be sent to sessions while your Mac is online."
            } else {
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    /// Terminal failed state: red bubble + "Not sent — tap to retry".
    private func settleFailed(_ bubbleID: String) {
        guard let idx = pendingUser.firstIndex(where: { $0.id == bubbleID }) else { return }
        pendingUser[idx].pending = false
        pendingUser[idx].failed = true
        pendingUser[idx].retryNotice = nil
    }

    /// Non-terminal failed state: still red (the message is genuinely not
    /// delivered, and pretending otherwise is the ghost-bubble bug) but the
    /// notice says an automatic retry is coming, and tapping it retries NOW.
    private func markWaitingForRetry(_ bubbleID: String) {
        guard let idx = pendingUser.firstIndex(where: { $0.id == bubbleID }) else { return }
        pendingUser[idx].pending = false
        pendingUser[idx].failed = true
        pendingUser[idx].retryNotice = SendRetryPolicy.waitingNotice(host: hostLabel)
    }

    /// Sleep, then re-attempt. Tracked so backgrounding/close cancels it —
    /// which is exactly the "app goes to background → pause" requirement: the
    /// bubble stays a visible failed one, and `resume()` re-arms the ladder for
    /// any bubble still waiting (see rearmPendingRetries).
    private func scheduleRetry(
        bubbleID: String, messageId: String?, text: String, jpegDatas: [Data],
        attempt: Int, firstFailureAt: Date
    ) {
        let delay = SendRetryPolicy.delay(forAttempt: attempt)
        let id = UUID()
        retryTasks[bubbleID]?.cancel()
        let task = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            guard let self, self.isActive else { return }
            // Bubble gone (user deleted it, or the transcript absorbed it):
            // nothing left to deliver.
            guard self.pendingUser.contains(where: { $0.id == bubbleID }) else {
                self.retryTasks[bubbleID] = nil
                return
            }
            self.retryTasks[bubbleID] = nil
            await self.deliver(
                bubbleID: bubbleID, messageId: messageId, text: text,
                jpegDatas: jpegDatas, attempt: attempt, firstFailureAt: firstFailureAt
            )
        }
        retryTasks[bubbleID] = task
        _ = id
    }

    /// Cancel every pending automatic retry (suspend / close). Bubbles keep
    /// their `retryNotice`, so a foregrounded app re-arms them.
    private func cancelRetryTasks() {
        for task in retryTasks.values { task.cancel() }
        retryTasks.removeAll()
    }

    /// Foreground: resume the ladder for bubbles that were mid-backoff when the
    /// app suspended. Attempt counting restarts (a background stretch is not
    /// evidence about the bridge), which is the forgiving direction — the id is
    /// stable, so extra attempts still can't double-deliver.
    private func rearmPendingRetries() {
        let waiting = pendingUser.filter { $0.retryNotice != nil && $0.failed == true }
        for bubble in waiting {
            guard retryTasks[bubble.id] == nil else { continue }
            scheduleRetry(
                bubbleID: bubble.id, messageId: bubble.clientMessageId, text: bubble.text,
                jpegDatas: bubble.localImages ?? [], attempt: 1, firstFailureAt: Date()
            )
        }
    }

    /// Sequential, budgeted, off-MainActor — see SelectedImage.buildPayloads.
    private nonisolated static func buildImagePayloads(_ datas: [Data]) async -> [ImagePayload] {
        await SelectedImage.buildPayloads(datas)
    }

    // MARK: - Failed-bubble actions

    /// Re-send a failed bubble. Reuses the bubble's ORIGINAL `qm-mobile-*` id:
    /// the server's queue is idempotent by that id, so if the first attempt
    /// actually landed and only its ack was lost, this retry collapses onto the
    /// same queued row instead of delivering the message twice. Minting a fresh
    /// id here would bypass the dedupe entirely.
    ///
    /// Deliberately NOT gated on the link state. A bridge_offline is the single
    /// most likely reason a bubble is sitting here failed, and gating on it (as
    /// `canSend` once did) made "tap to retry" a no-op in precisely the case it
    /// exists for. Attempting the POST is also how we FIND OUT the bridge is back
    /// (a relayed 202 clears the outage in deliver()).
    /// Only a session the server itself declared unresumable (409 → `dead`) is
    /// hopeless enough to refuse.
    func retry(_ message: ChatMessage) async {
        guard message.failed == true, !dead else { return }
        // A manual tap supersedes any scheduled automatic attempt for this
        // bubble (and resets the budget: the user asked for it now).
        retryTasks[message.id]?.cancel()
        retryTasks[message.id] = nil
        errorMessage = nil
        guard let idx = pendingUser.firstIndex(where: { $0.id == message.id }) else { return }
        pendingUser[idx].pending = true
        pendingUser[idx].failed = false
        pendingUser[idx].retryNotice = nil
        // Backfill an id for a bubble that predates this field (a failed send
        // from an older build restored into this session) so the retry is still
        // idempotent from here on.
        let messageId = message.clientMessageId ?? SendRetryPolicy.newMessageId()
        pendingUser[idx].clientMessageId = messageId
        await deliver(
            bubbleID: message.id, messageId: messageId, text: message.text,
            jpegDatas: message.localImages ?? [], attempt: 0, firstFailureAt: nil
        )
    }

    /// The page shows these words as a failed message the person can retry (or
    /// delete): voice mode then keeps no second copy of them.
    func showsFailedSend(of text: String) -> Bool {
        pendingUser.contains { $0.failed == true && $0.text == text }
    }

    func discardFailed(_ message: ChatMessage) {
        // Deleting the bubble must also kill its pending automatic retry, or a
        // timer would re-deliver text the user just threw away.
        retryTasks[message.id]?.cancel()
        retryTasks[message.id] = nil
        voiceBubbleIDs.remove(message.id)
        pendingUser.removeAll { $0.id == message.id }
        sendBaselines[message.id] = nil
    }

    // MARK: - SSE

    private func connectStream() {
        guard isActive else { return }
        sse?.stop()
        sse = nil
        guard let url = WalnutAPI.sessionStreamURL(id: sessionId),
              let token = AppConfig.token
        else { return }
        let sid = sessionId
        streamKey = url.absoluteString
        let resumeFrom = resumeIDForNextConnection()
        if gate.lastAppliedID == nil, let resumeFrom { gate = SessionStreamReplayGate(lastAppliedID: resumeFrom) }
        sse = SSEClient(
            url: url,
            token: token,
            lastEventID: resumeFrom.map(String.init),
            onEvent: { [weak self] event in
                Task { @MainActor in self?.handle(event) }
            },
            // Counted for the composer's model pill only (see `streamConnects`).
            onConnectionChange: { [weak self] ok in
                guard ok else { return }
                Task { @MainActor in self?.streamConnects &+= 1 }
            },
            onHTTPError: { [weak self] status in
                // Older server without the stream route: abandon SSE, poll.
                if status == 404 {
                    Task { @MainActor in self?.startPolling() }
                }
            }
        )
        sse?.start()
        AppLog.info("session-chat", "stream attached", [
            "sessionId": sid, "resumedFrom": resumeFrom.map(String.init) ?? "-",
        ])
    }

    /// The stream URL the resume id is stored under (server + session).
    @ObservationIgnored private var streamKey: String?

    /// The Last-Event-ID the live stream client will send on its next connect.
    /// Internal for WalnutTests.
    var currentStreamResumeID: String? { sse?.resumeEventID }

    /// Last-Event-ID for the next connection. Only a CLOUD stream resumes: the
    /// primary's attach snapshot plus its turn-scoped replay is already exact,
    /// and a resumed primary connection would append the missed deltas on top
    /// of a snapshot that already contains them. Internal for WalnutTests.
    func resumeIDForNextConnection() -> Int? {
        switch streamKind {
        case .primary: return nil
        case .cloud: return gate.lastAppliedID
        case .unknown:
            // A fresh page: the id this device last applied on this stream,
            // which is only ever stored for a cloud stream.
            return gate.lastAppliedID ?? streamKey.flatMap { resumeIDs.id(for: $0) }
        }
    }

    private func rememberResumeID() {
        guard streamKind == .cloud, let key = streamKey, let id = gate.lastAppliedID else { return }
        resumeIDs.save(id, for: key)
    }

    private struct DeltaPayload: Codable { let delta: String }
    private struct StatusPayload: Codable { let processStatus: String }
    private struct ErrorPayload: Codable { let message: String }
    private struct SnapshotPayload: Codable {
        let blocks: [SnapshotBlock]
        let isStreaming: Bool
        let completedLen: Int
        let processStatus: String
    }
    /// The subset of a StreamingBlock the phone renders (see session-stream-buffer.ts).
    private struct SnapshotBlock: Codable {
        let type: String
        let content: String?
        let name: String?
        let status: String?
        let parentToolUseId: String?
    }

    /// Payloads at or above this many JSON bytes decode OFF the MainActor
    /// (handle → decodeSnapshotAsync). Below it the fully synchronous path is
    /// kept — zero behavior change for normal-size sessions.
    private static let asyncSnapshotBytes = 262_144

    /// Non-nil while a large snapshot decodes off-main. Internal (not
    /// private(set)-only) so WalnutTests can await deterministic completion.
    @ObservationIgnored private(set) var snapshotDecodeTask: Task<Void, Never>?
    /// Generation gate for decode completions: a task cancelled by suspend()
    /// must not, on late completion, clear a NEWER task's pointer or replay
    /// its queue (same late-arrival-needs-a-generation lesson as turnGen).
    @ObservationIgnored private var snapshotDecodeGen = 0
    /// Events that arrive mid-decode. The snapshot RESETS the live region, so
    /// a delta must never apply before the snapshot it follows — buffering
    /// everything and replaying after application preserves arrival order.
    @ObservationIgnored private var queuedWhileDecoding: [SSEEvent] = []

    /// Internal (not private) for WalnutTests: WatchdogRegressionTests drives
    /// the store with scripted SSE events (snapshot / text-delta) to measure
    /// main-thread cost of the attach + live-tick paths against real payloads.
    func handle(_ event: SSEEvent) {
        guard isActive else { return }
        let admitted = gate.admit(event, now: clock.now())
        armGateExpiry()
        for frame in admitted { process(frame) }
    }

    /// Release held replay candidates once the gate's window has passed (a
    /// restarted server's new frames never present the old anchor).
    private func armGateExpiry() {
        guard let deadline = gate.holdDeadline else {
            gateExpiryTask?.cancel()
            gateExpiryTask = nil
            return
        }
        guard gateExpiryTask == nil else { return }
        let clock = self.clock
        gateExpiryTask = Task { [weak self] in
            try? await clock.sleep(seconds: deadline - clock.now())
            guard !Task.isCancelled, let self, self.isActive else { return }
            self.gateExpiryTask = nil
            let released = self.gate.expire(now: clock.now())
            if !released.isEmpty {
                AppLog.info("session-chat", "stream ids restarted, applying held frames", [
                    "sessionId": self.sessionId, "count": String(released.count),
                ])
            }
            for frame in released { self.process(frame) }
            self.armGateExpiry()
        }
    }

    /// Apply one admitted frame. Internal only through handle(); the decode
    /// queue below replays through here so a frame is never gated twice.
    private func process(_ event: SSEEvent) {
        guard isActive else { return }
        if snapshotDecodeTask != nil {
            queuedWhileDecoding.append(event)
            return
        }
        // Giant in-flight live regions (the build-34 field crash attached to
        // a 206MB one) made the synchronous decode the single biggest
        // main-thread stall of the attach path — push it off-main. Checked
        // BEFORE the Data conversion below: even that copy is O(payload).
        // (utf8.count is O(1) on Swift-native strings.)
        if event.event == "snapshot", event.data.utf8.count >= Self.asyncSnapshotBytes {
            decodeSnapshotAsync(event.data)
            return
        }
        let data = Data(event.data.utf8)
        // The three arms both live streams share. This store DOES honour
        // `impliesStreaming` (a CLI tool call is proof its own turn is running,
        // which is why the page has always flipped `streaming` here); the chat
        // store deliberately does not — see the note there.
        if let handled = LiveStreamEvents.apply(event: event.event, data: data, to: &live) {
            if handled.impliesStreaming { setStreaming(true) }
            setActivity(live.activityLabel)
            setLiveTools(live.tools)
            if handled.needsFlush { scheduleLiveFlush() }
            return
        }
        switch event.event {
        case "snapshot":
            streamKind = .primary
            if let snap = try? JSONDecoder().decode(SnapshotPayload.self, from: data) {
                applySeed(Self.computeSeed(snap))
            }
        case "turn-start":
            awaitingFirstTurn = false // the real turn takes over the indicator
            setStreaming(true)
            liveText = ""
            liveTextTruncated = false
            pendingDelta = ""
            clearLiveThinking()
            setActivity(nil)
        case "text-delta":
            if let p = try? JSONDecoder().decode(DeltaPayload.self, from: data) {
                setStreaming(true)
                appendDelta(p.delta)
            }
        case "status":
            if let p = try? JSONDecoder().decode(StatusPayload.self, from: data) {
                if !p.processStatus.isEmpty { streamStatusCount += 1 }
                applyStatus(p.processStatus)
            }
        case "turn-end":
            finalizeTurn()
        case "error":
            let p = try? JSONDecoder().decode(ErrorPayload.self, from: data)
            awaitingFirstTurn = false
            streaming = false
            activity = nil
            errorMessage = p?.message ?? "The session turn failed."
        case "bridge-offline":
            if event.id == nil { streamKind = .cloud }
            // Keep the SSE socket: it reaches the CLOUD fine, it is the
            // cloud-to-daemon bridge that dropped, and bridge-online arrives on
            // THIS stream. The notice waits for continuous absence (see
            // noteBridgeDown); polling starts with the chip.
            noteBridgeDown()
        case "bridge-online":
            let attachFrame = event.id == nil
            if attachFrame { streamKind = .cloud }
            let wasDown = noteBridgeUp()
            // Catch up on what the bridge gap hid. Not on the attach frame of a
            // stream's FIRST connection: open()/resume() is already reading.
            if wasDown || !attachFrame || event.reconnect {
                requestTranscriptRefresh()
            }
        default:
            break
        }
    }

    /// Pure result of digesting a snapshot payload — everything applySeed
    /// needs, computed WITHOUT touching MainActor state so the giant-payload
    /// path can run it off-main.
    private struct SnapshotSeed {
        let liveText: String
        let liveTextTruncated: Bool
        let activityName: String?
        let isStreaming: Bool
        let processStatus: String
        let hasBlocks: Bool
    }

    /// Digest a snapshot into a seed. Only the region after `completedLen` is
    /// the in-flight turn — the rest is already in the transcript, so seeding
    /// it would duplicate history. nonisolated + pure: safe to run detached.
    ///
    /// Bounded join: walk the live text blocks from the END and keep only
    /// enough to fill the liveText cap — a 200MB live region must never be
    /// joined into one giant string just to throw most of it away.
    private nonisolated static func computeSeed(_ snap: SnapshotPayload) -> SnapshotSeed {
        // completedLen is server-supplied — clamp both ends so a malformed
        // (negative / oversized) value can't index-crash the slice.
        let liveStart = max(0, min(snap.completedLen, snap.blocks.count))
        let live = snap.blocks[liveStart...]
        // Main lane only (no parentToolUseId) — subagent lanes aren't shown here.
        let texts = live
            .filter { $0.type == "text" && $0.parentToolUseId == nil }
            .compactMap { $0.content }
        var kept: [String] = []
        var keptBytes = 0
        let budget = LiveMarkdownWindow.liveTextCap + LiveMarkdownWindow.liveTextTrimSlack
        for t in texts.reversed() {
            kept.append(t)
            keptBytes += t.utf8.count + 2
            if keptBytes > budget { break }
        }
        let (joined, trimmed) = LiveMarkdownWindow.boundedTail(kept.reversed().joined(separator: "\n\n"))
        let activityName = live.last(where: {
            $0.type == "tool_call" && $0.parentToolUseId == nil && $0.status == "calling"
        })?.name
        return SnapshotSeed(
            liveText: joined,
            liveTextTruncated: trimmed || kept.count < texts.count,
            activityName: activityName,
            isStreaming: snap.isStreaming,
            processStatus: snap.processStatus,
            hasBlocks: !snap.blocks.isEmpty
        )
    }

    /// Apply a digested snapshot to the live region (MainActor).
    private func applySeed(_ seed: SnapshotSeed) {
        MainWork.track("sc.applySeed", count: seed.liveText.utf8.count) {
            applySeedTracked(seed)
        }
    }

    private func applySeedTracked(_ seed: SnapshotSeed) {
        // A snapshot only rides the PRIMARY box's stream attach (the cloud
        // path emits bridge-online/offline instead) — receiving one is proof
        // this store talks to the session's host right now. A sticky offline
        // flag from an earlier bridge-offline must not survive it: nothing on
        // the primary stream ever cleared the flag, so the page stayed
        // "unreachable, read-only" on a healthy session (2026-08-16 field
        // report, plain claude session).
        noteBridgeUp()
        // Snapshot content is PROOF a turn ran — retire the pre-spawn wait
        // BEFORE applyStatus so a terminal status in the same snapshot (app
        // backgrounded through the whole spawn→run→idle-reap arc) doesn't
        // synthesize the died-before-start banner over a finished session,
        // and so the seed below actually applies instead of the early-return.
        if awaitingFirstTurn && seed.hasBlocks {
            awaitingFirstTurn = false
        }
        if !seed.processStatus.isEmpty { streamStatusCount += 1 }
        applyStatus(seed.processStatus)
        // Pre-spawn gap of a just-created session: the buffer truthfully says
        // "not streaming" because the CLI isn't up yet — but the first turn IS
        // coming (the launch message rode SESSION_START). Keep the Starting-
        // session row instead of letting the snapshot blank the page.
        if awaitingFirstTurn && !seed.isStreaming {
            setStreaming(true)
            if activity == nil { setActivity(Self.startingActivity) }
            return
        }
        // Gate on liveness, not the buffer flag alone: a CLI that dies MID-turn
        // never emits turn-end, so the server buffer's isStreaming stays true
        // forever. Trusting it painted an eternal "Thinking…" row on a session
        // whose nav bar already said "Ended" (applyStatus above cleared
        // streaming; the unguarded assignment put it right back).
        setStreaming(seed.isStreaming && SessionStatus(seed.processStatus).isAlive)
        pendingDelta = "" // snapshot resets the live region wholesale
        // Reasoning is part of that live region, and the snapshot carries none
        // (the buffer keeps text and tool_call blocks only) — so a stale
        // accumulation must go rather than be stitched under a fresh seed. A
        // mid-turn re-attach refills it from the CLI's next thinking delta.
        clearLiveThinking()
        liveText = seed.liveText
        liveTextTruncated = seed.liveTextTruncated
        setActivity(seed.activityName)
        FreezeContext.shared.setLiveText(chars: liveText.utf8.count, truncated: liveTextTruncated)
        FreezeContext.shared.note("snapshot-seeded", liveText.utf8.count)
    }

    /// Large-payload attach: JSON decode + block join run OFF the MainActor;
    /// only applySeed (cheap, bounded) hops back. Events arriving mid-decode
    /// are queued and replayed after application so a delta can never land
    /// before the snapshot that resets the live region (arrival order holds).
    private func decodeSnapshotAsync(_ json: String) {
        snapshotDecodeGen += 1
        let gen = snapshotDecodeGen
        snapshotDecodeTask = Task { [weak self] in
            // nonisolated async → runs on the global executor, off-main
            // (including the String→Data copy, itself O(payload)).
            let seed = await Self.decodeSeed(json)
            guard let self, self.snapshotDecodeGen == gen else { return }
            self.streamKind = .primary
            self.snapshotDecodeTask = nil
            if self.isActive, !Task.isCancelled, let seed { self.applySeed(seed) }
            self.replayQueuedEvents()
        }
    }

    private nonisolated static func decodeSeed(_ json: String) async -> SnapshotSeed? {
        guard let snap = try? JSONDecoder().decode(SnapshotPayload.self, from: Data(json.utf8)) else { return nil }
        return computeSeed(snap)
    }

    /// Drain the mid-decode queue in order. handle() re-queues (and this loop
    /// stops) if a replayed event starts another async decode.
    private func replayQueuedEvents() {
        guard !queuedWhileDecoding.isEmpty else { return }
        MainWork.track("sc.replayQueued", count: queuedWhileDecoding.count) {
            while snapshotDecodeTask == nil, !queuedWhileDecoding.isEmpty {
                process(queuedWhileDecoding.removeFirst())
            }
            if snapshotDecodeTask == nil { queuedWhileDecoding = [] }
        }
    }

    private func applyStatus(_ status: String) {
        guard !status.isEmpty else { return }
        // Same-value gate: the daemon re-emits session_state on every bridge
        // reconcile, and processStatus feeds the nav-bar subtitle — redundant
        // writes invalidate that view for free.
        if processStatus != status { processStatus = status }
        if !SessionStatus(status).isAlive {
            // Terminal status ends the pre-spawn wait too: a failed spawn must
            // not leave "Starting session" shimmering forever. And since 201 =
            // accepted-not-spawned, a bad path/host surfaces exactly here — as
            // a session that dies before its first turn. Say so: bare "Ended"
            // right after tapping Start reads as a mystery.
            //
            // historyMessages.isEmpty guard: a terminal status with transcript
            // rows on screen is a session that RAN (e.g. backgrounded through
            // the spawn gap, turn completed, CLI idle-reaped; the resumed
            // snapshot's "stopped" races ahead of the transcript reload) — the
            // banner would be a lie there. Wording stays cause-neutral: the
            // phone can't distinguish bad-path from SSH failure from eviction.
            if awaitingFirstTurn && errorMessage == nil && historyMessages.isEmpty {
                errorMessage = "The session ended before it could start. Open it on your desktop to see why."
            }
            awaitingFirstTurn = false
            setStreaming(false)
            setActivity(nil)
        }
    }

    /// The session record's status, from the page's detail read (`GET /sessions/:id`,
    /// which the Mac answers, liveness-corrected).
    ///
    /// The stream alone cannot be trusted to say it: on the cloud companion it attaches
    /// with no status at all and only reports changes, so the page kept whatever its
    /// opener handed it, and an opener's copy can be days old. The Recently opened
    /// drawer reopens a session from the snapshot it saved, and an Ask Walnut session is
    /// never in the session list that would refresh it: "Ended" on a live session that
    /// had been resumed since (2026-10-10).
    ///
    /// Skipped when it cannot be the newer word: a stream status landed while the read
    /// was out (`streamStatusCountAtRead`), or a just-launched session is still waiting
    /// for its first turn (its record can read stopped until the CLI is up, and a
    /// terminal status there would raise the died-before-start banner). A `degraded`
    /// reply (the companion answering while the Mac is away) knows liveness only, so it
    /// corrects the page only where liveness disagrees.
    func adoptRecordStatus(_ status: String?, degraded: Bool, streamStatusCountAtRead: Int) {
        guard let status, SessionStatus(status) != .unknown, status != processStatus else { return }
        guard streamStatusCountAtRead == streamStatusCount, !awaitingFirstTurn else { return }
        if degraded, SessionStatus(status).isAlive == statusKind.isAlive { return }
        AppLog.info("session-chat", "status corrected from the session record", [
            "sessionId": sessionId, "from": processStatus, "to": status,
            "degraded": String(degraded),
        ])
        applyStatus(status)
    }

    /// Buffer a streamed text delta and schedule a coalesced flush — SwiftUI
    /// sees `liveText` change at a bounded cadence regardless of delta rate.
    private func appendDelta(_ delta: String) {
        pendingDelta += delta
        scheduleLiveFlush()
    }

    /// One coalescing timer for BOTH live buffers (reply text and reasoning):
    /// they arrive interleaved from the same stream, and two timers would just
    /// double the invalidation rate of the same views.
    private func scheduleLiveFlush() {
        guard deltaFlushTask == nil else { return }
        deltaFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard let self else { return }
            self.deltaFlushTask = nil
            self.flushPendingDelta()
            self.flushLiveThinking()
        }
    }

    /// Publish the shared handler's bounded reasoning accumulation.
    /// Equality-gated for the same reason `setActivity` is: an unconditional
    /// write at CLI thinking-delta rate is a full-page invalidation storm.
    /// Internal (not private) for WalnutTests, which flush deterministically
    /// rather than waiting on the 120ms coalesce timer.
    func flushLiveThinking() {
        guard live.flush() else { return }
        if liveThinking != live.thinkingText { liveThinking = live.thinkingText }
    }

    /// Drop the live reasoning region. Called at a turn boundary, on teardown,
    /// and — the load-bearing one — from `reconcile` once canonical transcript
    /// rows have landed, so the reasoning and the fetched `kind:"thinking"` rows
    /// are never both on screen.
    private func clearLiveThinking() {
        live.reset()
        if !liveThinking.isEmpty { liveThinking = "" }
        // `live.reset()` already dropped the turn's calls; the observed mirror has
        // to go with it or a finished turn's tool rows outlive their turn.
        setLiveTools([])
    }

    /// Internal (not private) for WalnutTests — lets the watchdog repro tests
    /// flush deterministically instead of waiting on the 120ms coalesce timer.
    ///
    /// Trims BEFORE appending: a giant retained liveText (e.g. seeded by an
    /// old code path, or grown past the cap) is cut to the bounded tail first,
    /// so the append never copy-on-writes a multi-MB string. boundedTail's
    /// fast path is O(1), so per-flush overhead is nil until a trim is due.
    func flushPendingDelta() {
        guard !pendingDelta.isEmpty else { return }
        MainWork.track("sc.deltaFlush", count: pendingDelta.utf8.count) {
            flushPendingDeltaTracked()
        }
    }

    private func flushPendingDeltaTracked() {
        let (bounded, trimmed) = liveTextBound.bound(liveText)
        if trimmed {
            liveText = bounded
            liveTextTruncated = true
        }
        liveText += pendingDelta
        pendingDelta = ""
        // Freeze-report context (counts only, O(1) utf8 length): the live turn's
        // size is the single most useful number for a layout/text-measurement
        // freeze. Runs at the coalesced ~8Hz flush rate, not per delta.
        FreezeContext.shared.setLiveText(chars: liveText.utf8.count, truncated: liveTextTruncated)
        reassertPinnedFollow()
    }

    /// Hysteresis state for the liveText retention cap (see TailBound).
    @ObservationIgnored private var liveTextBound = LiveMarkdownWindow.TailBound()

    @ObservationIgnored private var lastPinReassertAt: Date?
    /// Above the view's 250ms programmatic-geometry freeze — see the long note on
    /// ChatStore.pinReassertInterval.
    private static let pinReassertInterval: TimeInterval = 0.7

    /// Keep a PINNED reader following streamed growth. Mirrors ChatStore — see
    /// the long explanation there. Driven from the delta flush (store side), NEVER
    /// from ScrollBottomTracking's geometry callback, which must stay free of
    /// observable writes (P0-2).
    private func reassertPinnedFollow() {
        guard isActive, streaming, bottomPinned else { return }
        let now = Date()
        if let last = lastPinReassertAt, now.timeIntervalSince(last) < Self.pinReassertInterval {
            return
        }
        lastPinReassertAt = now
        scrollToBottomSignal += 1
    }

    /// Turn ended — fold the finished turn into history and clear the live turn.
    /// Append the streamed text as a PROVISIONAL bubble first, then refetch. The
    /// old code cleared `liveText` and awaited the transcript reload, so the
    /// assistant's reply blinked out for the round-trip (visible flash + a
    /// "message appears all at once" feel). Keeping the text on screen makes the
    /// live bubble settle in place; the refetch quietly swaps in canonical rows.
    private func finalizeTurn() {
        MainWork.track("sc.finalizeTurn", count: liveText.utf8.count) {
            finalizeTurnTracked()
        }
    }

    private func finalizeTurnTracked() {
        awaitingFirstTurn = false // covers a turn-end with no observed turn-start
        flushPendingDelta() // `finished` below must include the delta tail
        flushLiveThinking() // …and the reasoning row must show its last delta
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        let wasPinned = bottomPinned
        streaming = false
        activity = nil
        // Clip to the transcript's own row limit (session-projection TEXT_MAX =
        // 4KB + "…"): the refetch below replaces this row with the clipped
        // canonical version anyway, and parsing a multi-MB reply as ONE static
        // markdown row here was the second unbounded main-thread parse on the
        // page (the windowed live row being the first).
        // Truncated liveText lost the reply's HEAD — clipProvisional takes a
        // PREFIX, which would no longer match the canonical transcript row
        // (server clips the FIRST 4K), so the stable-id swap would flash a
        // mismatched bubble. Skip the provisional row and let the refetch
        // below paint the canonical one (a brief gap on multi-100KB replies
        // is acceptable; a wrong-text flash is not).
        let finished = liveTextTruncated ? "" : Self.clipProvisional(liveText)
        liveText = ""
        liveTextTruncated = false
        FreezeContext.shared.setLiveText(chars: 0, truncated: false)
        FreezeContext.shared.note("turn-end")
        if !finished.isEmpty {
            let dup = historyMessages.last.map { $0.role == "assistant" && $0.text == finished } ?? false
            if !dup {
                let provisional = ChatMessage(
                    id: "provisional-\(finished.hashValue)", role: "assistant",
                    text: finished, createdAt: ISO8601DateFormatter().string(from: AppClock.now()), kind: nil
                )
                historyMessages.append(provisional)
            }
        }
        // The live row disappearing + provisional row appearing shifts layout;
        // keep the reader glued to the end of the reply they were watching.
        if isActive && wasPinned { scrollToBottomSignal += 1 }
        requestTranscriptRefresh()
    }

    // MARK: - Polling fallback

    /// 5s `fresh=1` transcript polling. Two callers: SSE 404 (older server —
    /// drop the stream for good) and bridge-offline (keep the stream: it's the
    /// carrier for bridge-online). Idempotent: a second call is a no-op.
    private func startPolling(keepStream: Bool = false) {
        guard isActive, pollTask == nil else { return }
        if !keepStream {
            sse?.stop()
            sse = nil
        }
        let clock = self.clock
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.isActive else { return }
                // NOT rich: this loop runs every 5s while degraded, and the
                // fields it would add cost ~48 KB/min there. The chevron a
                // reader taps was already put on the row by the open / turn-end
                // read; a poll only has to keep the text current. A tick that
                // finds a read running or about to run skips (single flight).
                if !self.refreshInFlight && self.refreshDebounce == nil {
                    await self.runFreshLoad(rich: false)
                }
                try? await clock.sleep(seconds: Self.pollSeconds)
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    // MARK: - Transcript refresh (single flight)

    /// Every STREAM-driven transcript read comes through here: turn-end,
    /// bridge-online. At most one read runs; a trigger while it runs marks it
    /// dirty and exactly one follow-up runs after it. The first read of a burst
    /// waits `refreshDebounceSeconds`, so a replay or a run of turn-ends costs
    /// one read. Internal for WalnutTests.
    func requestTranscriptRefresh() {
        guard isActive else { return }
        if refreshInFlight {
            refreshDirty = true
            return
        }
        guard refreshDebounce == nil else { return }
        let clock = self.clock
        refreshDebounce = Task { [weak self] in
            try? await clock.sleep(seconds: Self.refreshDebounceSeconds)
            guard !Task.isCancelled, let self else { return }
            self.refreshDebounce = nil
            await self.runFreshLoad(rich: true)
        }
    }

    /// The one place a `fresh=1` read starts. A read that STARTS now reflects
    /// every trigger that arrived before it, so a rich read also satisfies a
    /// pending debounced one (open() racing the attach frame costs one read, not
    /// two). A non-rich poll does not: the turn-end read must carry the fields.
    private func runFreshLoad(rich: Bool, visible: Int? = nil) async {
        guard isActive else { return }
        if refreshInFlight {
            refreshDirty = true
            return
        }
        if rich {
            refreshDebounce?.cancel()
            refreshDebounce = nil
        }
        refreshInFlight = true
        let gen = refreshGen
        await loadTranscript(fresh: true, rich: rich, visible: visible)
        guard gen == refreshGen else { return }
        refreshInFlight = false
        if refreshDirty {
            refreshDirty = false
            requestTranscriptRefresh()
        }
    }

    /// True while a fresh read runs or waits on its debounce. Internal for
    /// WalnutTests.
    var transcriptRefreshPending: Bool { refreshInFlight || refreshDebounce != nil }

    // MARK: - Bridge grace

    /// The host's bridge is down (bridge-offline frame, 503 bridge_offline). The
    /// notice waits for CONTINUOUS absence: the chip after 3 s, the banner after
    /// 10 s, polling from the chip on. A second report while already down keeps
    /// the original start, so an outage is measured from its first evidence.
    private func noteBridgeDown() {
        guard !bridgeDown else { return }
        bridgeDown = true
        bridgeDownSince = clock.now()
        AppLog.info("session-chat", "bridge down, grace started", ["sessionId": sessionId])
        scheduleBridgeGrace()
    }

    /// The host is reachable again (bridge-online, a snapshot, a relayed 202).
    /// Returns whether it had been down.
    @discardableResult
    private func noteBridgeUp() -> Bool {
        bridgeGraceTask?.cancel()
        bridgeGraceTask = nil
        let wasDown = bridgeDown
        bridgeDown = false
        if wasDown, let since = bridgeDownSince {
            AppLog.info("session-chat", "bridge back", [
                "sessionId": sessionId, "downMs": String(Int((clock.now() - since) * 1_000)),
            ])
        }
        bridgeDownSince = nil
        setConnectionNotice(.none)
        if wasDown && sse != nil { stopPolling() }
        return wasDown
    }

    /// (Re)arm the notice timer from the outage's ORIGINAL start (resume() calls
    /// this after a suspend cancelled it).
    private func scheduleBridgeGrace() {
        bridgeGraceTask?.cancel()
        bridgeGraceTask = nil
        guard isActive, bridgeDown, let since = bridgeDownSince else { return }
        let clock = self.clock
        bridgeGraceTask = Task { [weak self] in
            let chipAt = since + SessionConnectionNotice.reconnectingAfter
            if clock.now() < chipAt { try? await clock.sleep(seconds: chipAt - clock.now()) }
            guard !Task.isCancelled, let self, self.isActive, self.bridgeDown else { return }
            if self.connectionNotice == .none { self.setConnectionNotice(.reconnecting) }
            self.startPolling(keepStream: true)
            let bannerAt = since + SessionConnectionNotice.unreachableAfter
            if clock.now() < bannerAt { try? await clock.sleep(seconds: bannerAt - clock.now()) }
            guard !Task.isCancelled, self.isActive, self.bridgeDown else { return }
            self.setConnectionNotice(.unreachable)
        }
    }

    private func setConnectionNotice(_ notice: SessionConnectionNotice) {
        if connectionNotice != notice { connectionNotice = notice }
    }

    private func trackTask(_ operation: @escaping @MainActor () async -> Void) {
        guard isActive else { return }
        let id = UUID()
        trackedTasks[id] = Task { [weak self] in
            await operation()
            self?.trackedTasks[id] = nil
        }
    }

    private func cancelTrackedTasks() {
        for task in trackedTasks.values { task.cancel() }
        trackedTasks.removeAll()
    }
}

extension SessionConversationStore: LifecycleSuspendable {
    func suspendForBackground() { suspend() }
    func resumeForForeground() { resume() }
}
