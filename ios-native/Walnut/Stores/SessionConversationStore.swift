import Foundation
import Observation

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
    private var sse: SSEClient?
    private var pollTask: Task<Void, Never>?

    /// Persisted transcript (completed turns), mapped to ChatMessage rows.
    private(set) var historyMessages: [ChatMessage] = []
    /// Optimistic user bubbles not yet reflected in the transcript.
    private var pendingUser: [ChatMessage] = []

    /// Live turn accumulation (mirrors ChatStore.streamText / .activity).
    var streaming = false
    var liveText = ""
    var activity: String?

    var processStatus: String
    /// No live bridge to this session's host (503 / bridge-offline event).
    var offline = false
    /// The CLI process is gone (409 session_dead / terminal status).
    var dead = false
    var errorMessage: String?
    var transcriptMissing = false
    var loadedOnce = false

    private static let pollSeconds: Double = 5

    init(session: WalnutSession) {
        self.sessionId = session.id
        self.processStatus = session.processStatus
    }

    // MARK: - Derived

    /// History + still-pending optimistic bubbles.
    var messages: [ChatMessage] { historyMessages + pendingUser }

    var statusKind: SessionStatus { SessionStatus(processStatus) }

    /// Send is allowed only to a live session with a working bridge.
    var canSend: Bool { statusKind.isAlive && !offline && !dead }

    /// Notice shown under the composer when it can't send.
    var composerNotice: String? {
        if offline { return "Mac offline — read-only" }
        if dead || !statusKind.isAlive { return "Session ended — reopen it from your desktop" }
        return nil
    }

    // MARK: - Lifecycle

    /// Two-phase open for instant paint. The exported/synced transcript file
    /// is served from disk (fast); `fresh=1` re-reads the live history (slow:
    /// whale JSONL, SSH, or the bridge) — so render the cached tail first,
    /// attach the stream immediately, and reconcile with fresh in the
    /// background. Called from `.task`.
    func open() async {
        connectStream()
        await loadTranscript(fresh: false)
        await loadTranscript(fresh: true)
    }

    func close() {
        sse?.stop()
        sse = nil
        pollTask?.cancel()
        pollTask = nil
    }

    // MARK: - Transcript

    private func loadTranscript(fresh: Bool) async {
        do {
            let next = try await api.sessionTranscript(id: sessionId, fresh: fresh)
            reconcile(next)
            transcriptMissing = false
            loadedOnce = true
        } catch {
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
        let incoming = transcript.messages.map { m in
            ChatMessage(
                id: "", // positional ids assigned after the merge (must be unique across it)
                role: m.role,
                text: m.text,
                createdAt: m.timestamp,
                kind: Self.mapKind(m.kind)
            )
        }
        let merged: [ChatMessage]
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
        // STABLE ids, not positional. A positional "t-<i>" scheme changes every
        // row's identity whenever the list length shifts (turn-end refetch, 5s
        // poll), so SwiftUI tears down and rebuilds EVERY row — the visible
        // flash + the "one message at a time" feel (the smooth live bubble gets
        // yanked and the whole list re-renders). A content-derived id keeps
        // unchanged rows identical across fetches, so only the tail diffs.
        historyMessages = Self.assignStableIDs(merged)
        let seen = Set(transcript.messages.filter { $0.role == "user" }.map(\.text))
        pendingUser.removeAll { seen.contains($0.text) }
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
                               createdAt: m.createdAt, kind: m.kind)
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
    /// mid-turn messages). Returns false so the composer restores the draft.
    @discardableResult
    func send(_ text: String) async -> Bool {
        guard canSend else { return false }
        errorMessage = nil
        var optimistic = ChatMessage(
            id: "pending-\(Date().timeIntervalSince1970)",
            role: "user", text: text,
            createdAt: ISO8601DateFormatter().string(from: .now), kind: nil
        )
        optimistic.pending = true
        pendingUser.append(optimistic)
        do {
            _ = try await api.sendSessionMessage(id: sessionId, text: text)
            if let idx = pendingUser.firstIndex(where: { $0.id == optimistic.id }) {
                pendingUser[idx].pending = false
            }
            return true
        } catch let error as APIError where error.isBridgeOffline {
            pendingUser.removeAll { $0.id == optimistic.id }
            offline = true
            startPolling()
            return false
        } catch let error as APIError where error.isSessionDead {
            pendingUser.removeAll { $0.id == optimistic.id }
            dead = true
            return false
        } catch {
            pendingUser.removeAll { $0.id == optimistic.id }
            errorMessage = error.localizedDescription
            return false
        }
    }

    // MARK: - SSE

    private func connectStream() {
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
    private struct ToolPayload: Codable { let name: String }
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
        let data = Data(event.data.utf8)
        switch event.event {
        case "snapshot":
            if let snap = try? JSONDecoder().decode(SnapshotPayload.self, from: data) {
                seedFromSnapshot(snap)
            }
        case "turn-start":
            streaming = true
            liveText = ""
            activity = nil
        case "text-delta":
            if let p = try? JSONDecoder().decode(DeltaPayload.self, from: data) {
                streaming = true
                liveText += p.delta
            }
        case "thinking":
            streaming = true
            activity = "Thinking"
        case "tool":
            if let p = try? JSONDecoder().decode(ToolPayload.self, from: data) {
                streaming = true
                activity = p.name
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
            Task { await loadTranscript(fresh: true) }
        default:
            break
        }
    }

    /// Seed the live turn from the buffer snapshot. Only the region after
    /// `completedLen` is the in-flight turn — the rest is already in the
    /// transcript, so rendering it here would duplicate history.
    private func seedFromSnapshot(_ snap: SnapshotPayload) {
        applyStatus(snap.processStatus)
        streaming = snap.isStreaming
        let live = snap.completedLen < snap.blocks.count
            ? Array(snap.blocks[snap.completedLen...]) : []
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
            streaming = false
            activity = nil
        }
    }

    /// Turn ended — fold the finished turn into history and clear the live turn.
    /// Append the streamed text as a PROVISIONAL bubble first, then refetch. The
    /// old code cleared `liveText` and awaited the transcript reload, so the
    /// assistant's reply blinked out for the round-trip (visible flash + a
    /// "message appears all at once" feel). Keeping the text on screen makes the
    /// live bubble settle in place; the refetch quietly swaps in canonical rows.
    private func finalizeTurn() {
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
        Task { await loadTranscript(fresh: true) }
    }

    // MARK: - Polling fallback

    /// 5s `fresh=1` transcript polling. Two callers: SSE 404 (older server —
    /// drop the stream for good) and bridge-offline (keep the stream: it's the
    /// carrier for bridge-online). Idempotent: a second call is a no-op.
    private func startPolling(keepStream: Bool = false) {
        guard pollTask == nil else { return }
        if !keepStream {
            sse?.stop()
            sse = nil
        }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.loadTranscript(fresh: true)
                try? await Task.sleep(for: .seconds(Self.pollSeconds))
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }
}
