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
    private let api = WalnutAPI()
    private let sessionId: String
    /// Where this session's CLI runs — "Mac" or the remote host alias. The
    /// offline notices name THIS host: a clouddev session going read-only is
    /// a clouddev bridge problem, and saying "Mac offline" there sent the
    /// user debugging the wrong machine.
    let hostLabel: String
    private var sse: SSEClient?
    private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var trackedTasks: [UUID: Task<Void, Never>] = [:]
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
    var liveText = ""
    var activity: String?
    /// Delta coalescing (freeze fix, mirrors ChatStore): re-rendering the live
    /// markdown row per SSE delta saturated the main thread on long replies.
    /// Deltas buffer here and flush to `liveText` on a ~8Hz cadence.
    @ObservationIgnored private var pendingDelta = ""
    @ObservationIgnored private var deltaFlushTask: Task<Void, Never>?

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

    init(session: WalnutSession) {
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
        adoptLaunchStash()
        connectStream()
        await loadTranscript(fresh: false)
        await loadTranscript(fresh: true)
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
        cancelTrackedTasks()
        streaming = false
        activity = nil
    }

    /// Foregrounding revives the stream and catches up on missed turns.
    /// Never revives a view-closed store (see close()).
    func resume() {
        guard !isActive, !viewClosed else { return }
        isActive = true
        connectStream()
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
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            guard isActive, !Task.isCancelled else { return }
            if !loadedOnce { transcriptMissing = true }
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
    private func reconcile(_ transcript: SessionTranscript) {
        guard isActive else { return }
        let wasPinned = bottomPinned
        let incoming = transcript.messages.map { m in
            ChatMessage(
                id: "", // positional ids assigned after the merge (must be unique across it)
                role: m.role,
                text: m.text,
                createdAt: m.timestamp,
                kind: Self.mapKind(m.kind),
                detail: m.detail,
                resultPreview: m.resultPreview
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
        historyMessages = next
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
        pendingUser.removeAll { bubble in
            guard bubble.failed != true else { return false }
            if seen.contains(bubble.text) { return true }
            return seen.contains { row in
                row.hasSuffix("…") && bubble.text.hasPrefix(row.dropLast())
            }
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
                               detail: m.detail, resultPreview: m.resultPreview)
        }
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
        // Carry thumbnails so the bubble shows them at once and a failed send
        // retains them for retry (the user's attachments never vanish).
        if !jpegDatas.isEmpty { optimistic.localImages = jpegDatas }
        pendingUser.append(optimistic)
        // Sending explicitly accepts a re-pin: the user wants to see their own
        // message land even if they were reading history.
        bottomPinned = true
        if isActive { scrollToBottomSignal += 1 }
        let payloads = await Self.buildImagePayloads(jpegDatas)
        // Encoding is a real suspension point (5 large photos take a moment).
        // If the store went inactive meanwhile, do NOT fire the request: leave
        // the text as a retryable failed bubble instead of writing UI state
        // into a store whose screen is gone / whose process is suspended.
        guard isActive, !Task.isCancelled else {
            if let idx = pendingUser.firstIndex(where: { $0.id == optimistic.id }) {
                pendingUser[idx].pending = false
                pendingUser[idx].failed = true
            }
            return false
        }
        do {
            _ = try await api.sendSessionMessage(id: sessionId, text: text, images: payloads)
            guard isActive, !Task.isCancelled else { return true }
            if let idx = pendingUser.firstIndex(where: { $0.id == optimistic.id }) {
                pendingUser[idx].pending = false
            }
            return true
        } catch {
            // Cancelled/suspended sends settle silently but must NOT leave a
            // forever-pending bubble: the draft is already cleared, so the
            // failed bubble (tap to retry) is the only copy of the text.
            if !isActive || (error as? APIError)?.isCancelled == true {
                if let idx = pendingUser.firstIndex(where: { $0.id == optimistic.id }) {
                    pendingUser[idx].pending = false
                    pendingUser[idx].failed = true
                }
                return false
            }
            if let idx = pendingUser.firstIndex(where: { $0.id == optimistic.id }) {
                pendingUser[idx].pending = false
                pendingUser[idx].failed = true
            }
            if let apiError = error as? APIError, apiError.isBridgeOffline {
                offline = true
                startPolling()
            } else if let apiError = error as? APIError, apiError.isSessionDead {
                dead = true
            } else if let apiError = error as? APIError, apiError.code == "images_not_supported_cloud" {
                errorMessage = "Images can only be sent to sessions while your Mac is online."
            } else {
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    /// Sequential, budgeted, off-MainActor — see SelectedImage.buildPayloads.
    private nonisolated static func buildImagePayloads(_ datas: [Data]) async -> [ImagePayload] {
        await SelectedImage.buildPayloads(datas)
    }

    // MARK: - Failed-bubble actions

    /// Re-send a failed bubble with the same text. Precondition-guarded —
    /// send()'s canSend guard returns without appending, so removing the
    /// bubble first while offline/dead would LOSE the text.
    func retry(_ message: ChatMessage) async {
        guard message.failed == true, canSend else { return }
        // Rebuild attached images from the retained JPEG datas so retry
        // re-sends them; drop any that no longer decode.
        let images = (message.localImages ?? []).compactMap { SelectedImage(jpegData: $0) }
        pendingUser.removeAll { $0.id == message.id }
        errorMessage = nil
        await send(message.text, images: images)
    }

    func discardFailed(_ message: ChatMessage) {
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

    private func handle(_ event: SSEEvent) {
        guard isActive else { return }
        let data = Data(event.data.utf8)
        switch event.event {
        case "snapshot":
            if let snap = try? JSONDecoder().decode(SnapshotPayload.self, from: data) {
                seedFromSnapshot(snap)
            }
        case "turn-start":
            awaitingFirstTurn = false // the real turn takes over the indicator
            streaming = true
            liveText = ""
            pendingDelta = ""
            activity = nil
        case "text-delta":
            if let p = try? JSONDecoder().decode(DeltaPayload.self, from: data) {
                streaming = true
                appendDelta(p.delta)
            }
        case "thinking":
            streaming = true
            activity = "Thinking"
        case "tool":
            if let p = try? JSONDecoder().decode(ToolPayload.self, from: data) {
                streaming = true
                activity = p.detail.map { "\(p.name) · \($0)" } ?? p.name
            }
        case "tool-result":
            activity = nil
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

    /// Seed the live turn from the buffer snapshot. Only the region after
    /// `completedLen` is the in-flight turn — the rest is already in the
    /// transcript, so rendering it here would duplicate history.
    private func seedFromSnapshot(_ snap: SnapshotPayload) {
        // Snapshot content is PROOF a turn ran — retire the pre-spawn wait
        // BEFORE applyStatus so a terminal status in the same snapshot (app
        // backgrounded through the whole spawn→run→idle-reap arc) doesn't
        // synthesize the died-before-start banner over a finished session,
        // and so the blocks below actually seed instead of the early-return.
        if awaitingFirstTurn && !snap.blocks.isEmpty {
            awaitingFirstTurn = false
        }
        applyStatus(snap.processStatus)
        // Pre-spawn gap of a just-created session: the buffer truthfully says
        // "not streaming" because the CLI isn't up yet — but the first turn IS
        // coming (the launch message rode SESSION_START). Keep the Starting-
        // session row instead of letting the snapshot blank the page.
        if awaitingFirstTurn && !snap.isStreaming {
            streaming = true
            if activity == nil { activity = Self.startingActivity }
            return
        }
        // Gate on liveness, not the buffer flag alone: a CLI that dies MID-turn
        // never emits turn-end, so the server buffer's isStreaming stays true
        // forever. Trusting it painted an eternal "Thinking…" row on a session
        // whose nav bar already said "Ended" (applyStatus above cleared
        // streaming; the unguarded assignment put it right back).
        streaming = snap.isStreaming && SessionStatus(snap.processStatus).isAlive
        pendingDelta = "" // snapshot resets the live region wholesale
        // completedLen is server-supplied — clamp both ends so a malformed
        // (negative / oversized) value can't index-crash the slice.
        let liveStart = max(0, min(snap.completedLen, snap.blocks.count))
        let live = Array(snap.blocks[liveStart...])
        // Main lane only (no parentToolUseId) — subagent lanes aren't shown here.
        liveText = live
            .filter { $0.type == "text" && $0.parentToolUseId == nil }
            .compactMap { $0.content }
            .joined(separator: "\n\n")
        if let calling = live.last(where: { $0.type == "tool_call" && $0.parentToolUseId == nil && $0.status == "calling" }) {
            activity = calling.name
        } else {
            activity = nil
        }
    }

    private func applyStatus(_ status: String) {
        guard !status.isEmpty else { return }
        processStatus = status
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
            streaming = false
            activity = nil
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

    private func flushPendingDelta() {
        guard !pendingDelta.isEmpty else { return }
        liveText += pendingDelta
        pendingDelta = ""
        reassertPinnedFollow()
    }

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
        awaitingFirstTurn = false // covers a turn-end with no observed turn-start
        flushPendingDelta() // `finished` below must include the delta tail
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        let wasPinned = bottomPinned
        streaming = false
        activity = nil
        let finished = liveText
        liveText = ""
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
