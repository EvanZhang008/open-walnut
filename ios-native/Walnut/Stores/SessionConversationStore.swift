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
    private func reconcile(_ transcript: SessionTranscript) {
        historyMessages = transcript.messages.enumerated().map { offset, m in
            ChatMessage(
                id: "t-\(offset)",
                role: m.role,
                text: m.text,
                createdAt: m.timestamp,
                kind: Self.mapKind(m.kind)
            )
        }
        let seen = Set(transcript.messages.filter { $0.role == "user" }.map(\.text))
        pendingUser.removeAll { seen.contains($0.text) }
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
    private func finalizeTurn() {
        streaming = false
        liveText = ""
        activity = nil
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
