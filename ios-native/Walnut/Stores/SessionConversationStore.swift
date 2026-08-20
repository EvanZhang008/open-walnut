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
/// transcript polling; bridge-offline → keep polling + disable the composer.
@Observable
@MainActor
final class SessionConversationStore {
    private let api: SessionSendTransport
    private let sessionId: String
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
    private var isActive = true
    /// Set by close() (view gone), cleared by open(). Blocks LifecycleHub
    /// resumeAll from reviving a store whose screen was dismissed.
    private var viewClosed = false

    /// Persisted transcript (completed turns), mapped to ChatMessage rows.
    private(set) var historyMessages: [ChatMessage] = []
    /// Optimistic user bubbles not yet reflected in the transcript.
    private var pendingUser: [ChatMessage] = []

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

    var processStatus: String
    /// Sticky USER intent, independent of transient geometry changes from
    /// streaming, keyboard resizing, or canonical history reconciliation.
    /// `@ObservationIgnored` for the same reason as ChatStore's: it is written
    /// from inside the scroll view's layout pass and never read by a view body.
    @ObservationIgnored var bottomPinned = true
    /// Bumped when a layout-shifting mutation should restore pinned intent.
    private(set) var scrollToBottomSignal = 0
    /// No live bridge to this session's host (503 / bridge-offline event).
    var offline = false
    /// The CLI process is gone (409 session_dead / terminal status).
    var dead = false
    var errorMessage: String?
    var transcriptMissing = false
    var loadedOnce = false

    private static let pollSeconds: Double = 5
    /// Hard cap on rows kept for rendering (see reconcile() — unbounded merge
    /// growth was the root cause of the watchdog freeze-kills on builds 16-20).
    private static let maxRenderedRows = 150
    private static let hardMaxRenderedRows = 400

    /// True from "created with a first message" until the first turn-start or
    /// a terminal status. Keeps the Starting-session live row alive across the
    /// SSE snapshot, which truthfully reports isStreaming=false in the
    /// pre-spawn gap and would otherwise kill the indicator instantly.
    @ObservationIgnored private var awaitingFirstTurn = false
    private static let startingActivity = "Starting session"

    /// `transport` is the WalnutTests seam (nil = the real WalnutAPI) — same
    /// injection pattern as TasksStore's WalnutTaskTransport.
    init(session: WalnutSession, transport: SessionSendTransport? = nil) {
        self.api = transport ?? WalnutAPI()
        self.sessionId = session.id
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
            createdAt: ISO8601DateFormatter().string(from: .now), kind: nil
        ))
        awaitingFirstTurn = true
        streaming = true
        activity = Self.startingActivity
    }

    // MARK: - Derived

    /// History + still-pending optimistic bubbles.
    var messages: [ChatMessage] { historyMessages + pendingUser }

    var statusKind: SessionStatus { SessionStatus(processStatus) }

    /// Send needs a working bridge, nothing more. An ENDED session is still
    /// sendable — the server resumes it (`--resume` respawn on its host), so
    /// gating on isAlive here wrongly bricked the composer for every idle/
    /// stopped session. `dead` flips only after the server itself answers
    /// 409 session_dead (no resumable record on that host).
    var canSend: Bool { !offline && !dead }

    /// Notice shown under the composer when it can't send.
    var composerNotice: String? {
        if offline { return "\(hostLabel) unreachable — read-only" }
        if dead { return "Session can't be woken — reopen it from your desktop" }
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
        await loadTranscript(fresh: false)
        FreezeContext.shared.note("sc-open-cached", Int((FreezeContext.uptimeNow() - openedAt) * 1_000))
        await loadTranscript(fresh: true)
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
        sse?.stop()
        sse = nil
        pollTask?.cancel()
        pollTask = nil
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
        activity = nil
    }

    /// Foregrounding revives the stream and catches up on missed turns.
    /// Never revives a view-closed store (see close()).
    func resume() {
        guard !isActive, !viewClosed else { return }
        isActive = true
        connectStream()
        rearmPendingRetries()
        trackTask { [weak self] in await self?.loadTranscript(fresh: true) }
    }

    // MARK: - Transcript

    private func loadTranscript(fresh: Bool) async {
        guard isActive else { return }
        do {
            let next = try await api.sessionTranscript(id: sessionId, fresh: fresh)
            guard isActive, !Task.isCancelled else { return }
            reconcile(next)
            transcriptMissing = false
            loadedOnce = true
            // Failure-fallback polling (below) has done its job once a load
            // lands and the normal delivery paths are healthy again. Keep
            // polling while offline (it IS the data path then) or when SSE was
            // abandoned (404 fallback, sse == nil) — those own their lifecycle.
            if !offline && sse != nil { stopPolling() }
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
    /// transcript now contains (matched by user text — robust to reordering).
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
        let incoming = transcript.messages.map { m in
            ChatMessage(
                id: "", // positional ids assigned after the merge (must be unique across it)
                role: m.role,
                text: m.text,
                createdAt: m.timestamp,
                kind: Self.mapKind(m.kind),
                detail: m.detail,
                resultPreview: m.resultPreview,
                agent: m.agent
            )
        }
        var merged: [ChatMessage]
        if incoming.isEmpty && !historyMessages.isEmpty {
            merged = historyMessages // a zero-row tail never beats shown content
        } else if let firstIncoming = transcript.messages.first?.timestamp,
                  historyMessages.count > incoming.count {
            // ISO-8601 strings compare lexicographically. Rows strictly before
            // the incoming window survive; the window itself is authoritative.
            merged = historyMessages.filter { $0.createdAt < firstIncoming } + incoming
        } else {
            merged = incoming
        }
        // A 150-row head trim is invisible only while pinned at the bottom.
        // Defer it for a history reader; retain a 400-row hard cap so a page
        // cannot grow without bound if it remains unpinned for hours.
        let renderCap = wasPinned ? Self.maxRenderedRows : Self.hardMaxRenderedRows
        if merged.count > renderCap {
            merged = Array(merged.suffix(renderCap))
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
        let seen = Set(transcript.messages.filter { $0.role == "user" }.map(\.text))
        // Failed bubbles are exempt: their text was NOT delivered — a match
        // here is an older identical message, and absorbing the failed bubble
        // would silently lose the pending retry.
        //
        // Prefix fallback: the transcript clips user text at 4 KB + "…"
        // (session-projection TEXT_MAX), so a long bubble never equals its
        // transcript row — exact-match alone left the message on screen twice
        // forever. A clipped row (trailing "…") whose body prefixes the bubble
        // is the same message.
        // Check-before-mutate: a mutating method on an @Observable array
        // registers a mutation even when it removes nothing, so an
        // unconditional removeAll re-invalidated `messages` readers on every
        // 5s poll. Compute the survivors first; write only on a real change.
        let survivors = pendingUser.filter { bubble in
            guard bubble.failed != true else { return true }
            if seen.contains(bubble.text) { return false }
            return !seen.contains { row in
                row.hasSuffix("…") && bubble.text.hasPrefix(row.dropLast())
            }
        }
        if survivors.count != pendingUser.count {
            pendingUser = survivors
        }
    }

    /// Derive a stable id per row from its content so re-fetches don't churn
    /// identities. Same (role, timestamp, kind, text) → same id across loads; a
    /// per-key occurrence suffix disambiguates true duplicates.
    private static func assignStableIDs(_ rows: [ChatMessage]) -> [ChatMessage] {
        var counts: [String: Int] = [:]
        return rows.map { m in
            let base = "\(m.role)|\(m.createdAt)|\(m.kind?.rawValue ?? "")|\(m.text.hashValue)"
            let n = counts[base, default: 0]
            counts[base] = n + 1
            return ChatMessage(id: "\(base)#\(n)", role: m.role, text: m.text,
                               createdAt: m.createdAt, kind: m.kind,
                               detail: m.detail, resultPreview: m.resultPreview,
                               agent: m.agent)
        }
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
    @discardableResult
    func send(_ text: String, images: [SelectedImage] = []) async -> Bool {
        guard isActive, canSend else { return false }
        errorMessage = nil
        let jpegDatas = images.map(\.jpegData)
        var optimistic = ChatMessage(
            id: "pending-\(Date().timeIntervalSince1970)",
            role: "user", text: text,
            createdAt: ISO8601DateFormatter().string(from: .now), kind: nil
        )
        optimistic.pending = true
        optimistic.clientMessageId = SendRetryPolicy.newMessageId()
        // Carry thumbnails so the bubble shows them at once and a failed send
        // retains them for retry (the user's attachments never vanish).
        if !jpegDatas.isEmpty { optimistic.localImages = jpegDatas }
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
        // If the store went inactive meanwhile, do NOT fire the request: leave
        // the text as a retryable failed bubble instead of writing UI state
        // into a store whose screen is gone / whose process is suspended.
        guard isActive, !Task.isCancelled else {
            settleFailed(bubbleID)
            return false
        }
        do {
            _ = try await api.sendSessionMessage(
                id: sessionId, text: text, images: payloads, messageId: messageId
            )
            guard isActive, !Task.isCancelled else { return true }
            if let idx = pendingUser.firstIndex(where: { $0.id == bubbleID }) {
                pendingUser[idx].pending = false
                pendingUser[idx].failed = false
                pendingUser[idx].retryNotice = nil
            }
            // A 202 proves the bridge is up: clear a sticky offline banner a
            // previous attempt raised, same reasoning as a delivered snapshot.
            if offline {
                offline = false
                stopPolling()
            }
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
                    offline = true
                    startPolling()
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
    /// Deliberately NOT gated on `canSend`. `canSend` is false while `offline`,
    /// and a bridge_offline is the single most likely reason a bubble is sitting
    /// here failed — so gating on it made "tap to retry" a no-op in precisely
    /// the case it exists for, leaving the bubble un-retryable until a
    /// bridge-online frame happened to arrive. Attempting the POST is also how
    /// we FIND OUT the bridge is back (a 202 clears `offline` in deliver()).
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

    func discardFailed(_ message: ChatMessage) {
        // Deleting the bubble must also kill its pending automatic retry, or a
        // timer would re-deliver text the user just threw away.
        retryTasks[message.id]?.cancel()
        retryTasks[message.id] = nil
        pendingUser.removeAll { $0.id == message.id }
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
        sse = SSEClient(
            url: url,
            token: token,
            onEvent: { [weak self] event in
                Task { @MainActor in self?.handle(event) }
            },
            onConnectionChange: { _ in },
            onHTTPError: { [weak self] status in
                // Older server without the stream route: abandon SSE, poll.
                if status == 404 {
                    Task { @MainActor in self?.startPolling() }
                }
            }
        )
        sse?.start()
        AppLog.info("session-chat", "stream attached", ["sessionId": sid])
    }

    private struct DeltaPayload: Codable { let delta: String }
    private struct ToolPayload: Codable { let name: String; let detail: String? }
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
        switch event.event {
        case "snapshot":
            if let snap = try? JSONDecoder().decode(SnapshotPayload.self, from: data) {
                applySeed(Self.computeSeed(snap))
            }
        case "turn-start":
            awaitingFirstTurn = false // the real turn takes over the indicator
            setStreaming(true)
            liveText = ""
            liveTextTruncated = false
            pendingDelta = ""
            setActivity(nil)
        case "text-delta":
            if let p = try? JSONDecoder().decode(DeltaPayload.self, from: data) {
                setStreaming(true)
                appendDelta(p.delta)
            }
        case "thinking":
            setStreaming(true)
            setActivity("Thinking")
        case "tool":
            if let p = try? JSONDecoder().decode(ToolPayload.self, from: data) {
                setStreaming(true)
                setActivity(p.detail.map { "\(p.name) · \($0)" } ?? p.name)
            }
        case "tool-result":
            setActivity(nil)
        case "status":
            if let p = try? JSONDecoder().decode(StatusPayload.self, from: data) {
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
            offline = true
            // Keep the SSE socket: it reaches the CLOUD fine — it's the
            // cloud→daemon bridge that dropped, and bridge-online arrives on
            // THIS stream. Killing it here (the old behavior) meant the page
            // stayed "offline" forever after a bridge blip.
            startPolling(keepStream: true)
        case "bridge-online":
            offline = false
            stopPolling()
            trackTask { [weak self] in await self?.loadTranscript(fresh: true) }
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
        // "unreachable — read-only" on a healthy session (2026-08-16 field
        // report, plain claude session).
        if offline { offline = false }
        // Snapshot content is PROOF a turn ran — retire the pre-spawn wait
        // BEFORE applyStatus so a terminal status in the same snapshot (app
        // backgrounded through the whole spawn→run→idle-reap arc) doesn't
        // synthesize the died-before-start banner over a finished session,
        // and so the seed below actually applies instead of the early-return.
        if awaitingFirstTurn && seed.hasBlocks {
            awaitingFirstTurn = false
        }
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
                handle(queuedWhileDecoding.removeFirst())
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
                errorMessage = "The session ended before it could start — open it on your desktop to see why."
            }
            awaitingFirstTurn = false
            setStreaming(false)
            setActivity(nil)
        }
    }

    /// Buffer a streamed text delta and schedule a coalesced flush — SwiftUI
    /// sees `liveText` change at a bounded cadence regardless of delta rate.
    private func appendDelta(_ delta: String) {
        pendingDelta += delta
        guard deltaFlushTask == nil else { return }
        deltaFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard let self else { return }
            self.deltaFlushTask = nil
            self.flushPendingDelta()
        }
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
                    text: finished, createdAt: ISO8601DateFormatter().string(from: .now), kind: nil
                )
                historyMessages.append(provisional)
            }
        }
        // The live row disappearing + provisional row appearing shifts layout;
        // keep the reader glued to the end of the reply they were watching.
        if isActive && wasPinned { scrollToBottomSignal += 1 }
        trackTask { [weak self] in await self?.loadTranscript(fresh: true) }
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
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.isActive else { return }
                await self.loadTranscript(fresh: true)
                try? await Task.sleep(for: .seconds(Self.pollSeconds))
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
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
